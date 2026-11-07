'use strict';
/*
 * Tamper-evident audit log (NFR 15). Each entry's hash covers its content and
 * the previous entry's hash. The format is identical to v3, so a v3 audit log
 * keeps verifying after moving to v4.
 */
const crypto = require('crypto');
const db = require('../db');
const { now, pad } = require('./util');
const { clientIp } = require('./security');

const GENESIS_HASH = '0'.repeat(64);
const CATEGORIES = ['edit', 'access', 'report', 'security', 'system'];

/* Python strftime('%Y-%m-%dT%H:%M:%S.%f') of the stored value */
function pyTimestamp(stored) {
  const s = String(stored).replace('T', ' ');
  const [datePart, timePart = '00:00:00'] = s.split(' ');
  const [hms, frac = ''] = timePart.split('.');
  return `${datePart}T${hms}.${(frac + '000000').slice(0, 6)}`;
}
function digest(prevHash, e) {
  const payload = [prevHash, pyTimestamp(e.created_at), e.user_id ? String(e.user_id) : '', e.username || '', e.category,
    e.action, e.target_type || '', e.target_id || '', e.target_label || '', e.details_json || '', e.ip_address || ''].join('|');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}
/* Python json.dumps(obj, sort_keys=True, default=str) */
function pyJson(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (Array.isArray(v)) return '[' + v.map(pyJson).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => `${pyJson(k)}: ${pyJson(v[k])}`).join(', ') + '}';
  return pyJson(String(v));
}

/* Adds an entry inside the given transaction, so a rolled-back change never
   leaves a log entry behind. `actor` defaults to the signed-in user. */
async function log(trx, req, category, action, { targetType = null, targetId = null, targetLabel = null, details = null, actor } = {}) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown audit category: ${category}`);
  const user = actor !== undefined ? actor : (req ? req.user : null);
  let q = trx('audit_logs').orderBy('id', 'desc').first('entry_hash');
  if (db.isMySQL()) q = q.forUpdate();
  const last = await q;
  const prevHash = last ? last.entry_hash : GENESIS_HASH;
  const entry = {
    created_at: now(),
    user_id: user ? user.id : null,
    username: user ? user.username : 'system',
    category, action: String(action).slice(0, 80),
    target_type: targetType,
    target_id: targetId !== null && targetId !== undefined ? String(targetId) : null,
    target_label: targetLabel ? String(targetLabel).slice(0, 200) : null,
    details_json: details && Object.keys(details).length ? pyJson(details) : null,
    ip_address: req ? clientIp(req) : null,
    prev_hash: prevHash,
  };
  entry.entry_hash = digest(prevHash, entry);
  await trx('audit_logs').insert(entry);
  return entry;
}

async function verifyChain(k = db()) {
  let prev = GENESIS_HASH; let count = 0; let lastId = 0;
  for (;;) {
    const rows = await k('audit_logs').where('id', '>', lastId).orderBy('id').limit(500);
    if (!rows.length) break;
    for (const e of rows) {
      count += 1;
      if (e.prev_hash !== prev || digest(prev, e) !== e.entry_hash) return { ok: false, checked: count, badId: e.id };
      prev = e.entry_hash; lastId = e.id;
    }
  }
  return { ok: true, checked: count, badId: null };
}

/* {field: [old, new]} for values that actually change */
function changedFields(obj, values) {
  const diff = {};
  for (const [k, v] of Object.entries(values)) {
    const old = obj[k];
    const a = old === null || old === undefined ? null : String(old);
    const b = v === null || v === undefined ? null : String(v);
    if (a !== b && !(isNum(old) && isNum(v) && Number(old) === Number(v))) diff[k] = [old ?? null, v ?? null];
  }
  return diff;
}
const isNum = (x) => x !== null && x !== '' && x !== undefined && !Number.isNaN(Number(x)) && typeof x !== 'boolean';

module.exports = { log, verifyChain, changedFields, GENESIS_HASH, CATEGORIES, digest, pyJson };
