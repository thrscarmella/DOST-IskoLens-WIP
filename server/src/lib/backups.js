'use strict';
/*
 * Encrypted backups and tested restore.
 * A backup file (.iskb) is gzip-compressed JSON (every table's rows plus the
 * uploaded documents), encrypted with AES-256-GCM using a key derived from
 * BACKUP_KEY (or SECRET_KEY). A small .json file beside it holds the manifest
 * (no personal data) so the list can be shown without decrypting.
 * The format works on SQLite and MySQL alike. Sessions and password links are
 * not backed up: they are short-lived and restoring them could revive old sign-ins.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');
const { DEPENDENCY_ORDER, dropAuditTriggers, installAuditTriggers } = require('../schema');
const { now } = require('./util');

const MAGIC = Buffer.from('ISKB2\n');
const SKIP = new Set(['user_sessions', 'password_tokens']);
class BackupError extends Error {}

const key = () => crypto.createHash('sha256').update(config.BACKUP_KEY || config.SECRET_KEY, 'utf8').digest();
const backupDir = () => { fs.mkdirSync(config.BACKUP_DIR, { recursive: true }); return config.BACKUP_DIR; };
const tables = () => DEPENDENCY_ORDER.filter((t) => !SKIP.has(t));

function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}
function decrypt(blob) {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupError('This is not a DOST-IskoLens v4 backup file. (Backups made by the earlier Python version must be restored with that version.)');
  }
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(blob.subarray(MAGIC.length + 28)), d.final()]);
  } catch {
    throw new BackupError('This backup cannot be decrypted. It was made with a different BACKUP_KEY/SECRET_KEY, or the file is damaged.');
  }
}
function open(blob) {
  try { return JSON.parse(zlib.gunzipSync(decrypt(blob)).toString('utf8')); } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('The backup file is damaged.');
  }
}

async function createBackup(kind = 'manual', user = null, note = null) {
  const k = db();
  const stamp = now().replace(/[-:]/g, '').replace(' ', '-');
  const name = `iskolens-${stamp}-${kind}`;
  const data = {}; const counts = {};
  for (const t of tables()) { data[t] = await k(t).select(); counts[t] = data[t].length; }
  const documents = {};
  if (fs.existsSync(config.DOCUMENTS_DIR)) {
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else documents[path.relative(config.DOCUMENTS_DIR, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    });
    walk(config.DOCUMENTS_DIR);
  }
  const manifest = { format: 2, name, kind, created_at: `${now().replace(' ', 'T')}Z`, created_by: user ? user.username : 'system', note,
    database: db.isMySQL() ? 'mysql' : 'sqlite', row_counts: counts, scholars: counts.scholars || 0, users: counts.users || 0,
    document_files: Object.keys(documents).length };
  const blob = encrypt(zlib.gzipSync(Buffer.from(JSON.stringify({ manifest, data, documents }))));
  manifest.size_bytes = blob.length;
  manifest.sha256 = crypto.createHash('sha256').update(blob).digest('hex');
  fs.writeFileSync(path.join(backupDir(), `${name}.iskb`), blob);
  fs.writeFileSync(path.join(backupDir(), `${name}.json`), JSON.stringify(manifest, null, 2));
  if (kind === 'scheduled') pruneScheduled();
  return manifest;
}
function pruneScheduled() {
  const files = fs.readdirSync(backupDir()).filter((f) => /^iskolens-.*-scheduled\.iskb$/.test(f)).sort().reverse();
  for (const f of files.slice(config.BACKUP_KEEP)) {
    fs.rmSync(path.join(backupDir(), f), { force: true });
    fs.rmSync(path.join(backupDir(), f.replace(/\.iskb$/, '.json')), { force: true });
  }
}
function listBackups() {
  return fs.readdirSync(backupDir()).filter((f) => f.startsWith('iskolens-') && f.endsWith('.json')).sort().reverse()
    .filter((f) => fs.existsSync(path.join(backupDir(), f.replace(/\.json$/, '.iskb'))))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(backupDir(), f), 'utf8')); } catch { return null; } }).filter(Boolean);
}
function backupPath(name) {
  if (!name || /[\\/]|\.\./.test(name) || !name.startsWith('iskolens-')) throw new BackupError('Backup not found.');
  const p = path.join(backupDir(), `${name}.iskb`);
  if (!fs.existsSync(p)) throw new BackupError('Backup not found.');
  return p;
}
function verify(name) {
  const payload = open(fs.readFileSync(backupPath(name)));
  const known = new Set(tables());
  for (const t of Object.keys(payload.data)) if (!known.has(t)) throw new BackupError('The backup contains tables this version does not know.');
  for (const [t, rows] of Object.entries(payload.data)) {
    if (payload.manifest.row_counts[t] !== rows.length) throw new BackupError('Row counts in the backup do not match its manifest.');
  }
  return payload.manifest;
}
function importUploaded(blob, filename) {
  const payload = open(blob);
  const manifest = { ...payload.manifest };
  let name = manifest.name || `iskolens-${now().replace(/[-:]/g, '').replace(' ', '-')}-uploaded`;
  if (fs.existsSync(path.join(backupDir(), `${name}.iskb`))) name = `${name}-copy`;
  manifest.name = name;
  manifest.size_bytes = blob.length;
  manifest.sha256 = crypto.createHash('sha256').update(blob).digest('hex');
  manifest.uploaded_from = path.basename(filename);
  fs.writeFileSync(path.join(backupDir(), `${name}.iskb`), blob);
  fs.writeFileSync(path.join(backupDir(), `${name}.json`), JSON.stringify(manifest, null, 2));
  return manifest;
}

/* Replaces ALL current data with the backup in one transaction. The caller makes a safety backup first. */
async function restore(name) {
  const payload = open(fs.readFileSync(backupPath(name)));
  const k = db();
  const order = tables();
  if (db.isSQLite()) await k.raw('PRAGMA foreign_keys = OFF');
  await dropAuditTriggers();
  try {
    await k.transaction(async (trx) => {
      if (db.isMySQL()) await trx.raw('SET FOREIGN_KEY_CHECKS=0');
      for (const t of SKIP) await trx(t).delete();
      for (const t of [...order].reverse()) await trx(t).delete();
      for (const t of order) {
        const rows = payload.data[t] || [];
        for (let i = 0; i < rows.length; i += 200) await trx(t).insert(rows.slice(i, i + 200));
      }
      if (db.isMySQL()) await trx.raw('SET FOREIGN_KEY_CHECKS=1');
    });
  } finally {
    if (db.isSQLite()) await k.raw('PRAGMA foreign_keys = ON');
    if (db.isMySQL()) await installAuditTriggers();
  }
  // Documents: replace the folder's contents with the backup's files.
  fs.rmSync(config.DOCUMENTS_DIR, { recursive: true, force: true });
  fs.mkdirSync(config.DOCUMENTS_DIR, { recursive: true });
  for (const [rel, b64] of Object.entries(payload.documents || {})) {
    if (rel.split('/').includes('..') || path.isAbsolute(rel)) continue;
    const target = path.join(config.DOCUMENTS_DIR, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(b64, 'base64'));
  }
  return payload.manifest;
}
module.exports = { createBackup, listBackups, backupPath, verify, importUploaded, restore, backupDir, BackupError };
