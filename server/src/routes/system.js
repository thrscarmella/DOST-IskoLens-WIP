'use strict';
/* System Management (Administrator): service status, import log, model recalibration. */
const fs = require('fs');
const os = require('os');
const express = require('express');
const config = require('../config');
const db = require('../db');
const audit = require('../lib/audit');
const backups = require('../lib/backups');
const client = require('../lib/analyticsClient');
const risk = require('../lib/risk');
const { buildTable } = require('../lib/features');
const { route } = require('../lib/http');
const { ApiError, iso } = require('../lib/util');
const S = require('../lib/security');
const D = require('../lib/data');

const router = express.Router();
const n = async (q) => Number((await q.count({ n: '*' }).first()).n);

router.get('/system/status', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  let dbOk = true;
  try { await k.raw('SELECT 1'); } catch { dbOk = false; }
  const analytics = await client.status();
  const items = backups.listBackups();
  let disk = null;
  try { const st = fs.statfsSync(config.INSTANCE_DIR); disk = { free_bytes: st.bavail * st.bsize, total_bytes: st.blocks * st.bsize }; } catch { /* not supported */ }
  const scored = await n(k('scholar_risk'));
  return { ok: true,
    web: { started_at: config.APP_STARTED_AT.toISOString().slice(0, 19), uptime_seconds: Math.round(process.uptime()), node: process.version, platform: `${os.type()} ${os.release()}` },
    database: { ok: dbOk, type: db.isMySQL() ? 'MySQL' : 'SQLite (test file)', users: await n(k('users')), scholars: await n(k('scholars')) },
    analytics: { ...analytics, scholars_scored: scored },
    backups: { count: items.length, last: items.length ? items[0].created_at : null, separate_key: !!config.BACKUP_KEY },
    security: { force_https: config.FORCE_HTTPS, require_admin_2fa: config.REQUIRE_ADMIN_2FA, allow_signup: config.ALLOW_SIGNUP,
      admins_with_2fa: await n(k('users').where({ role: 'admin', status: 'active' }).whereIn('totp_enabled', [1, true])),
      admins: await n(k('users').where({ role: 'admin', status: 'active' })), mail_configured: !!config.MAIL_SERVER },
    disk };
}, { tx: false }));

router.get('/system/imports', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const rows = await k('import_batches').orderBy('id', 'desc').limit(200);
  const names = await D.userNames(k, rows.map((r) => r.uploaded_by_id));
  const KIND = { scholars: 'New scholars', academic: 'GWA records', stipends: 'Stipend records', historical: 'DOST historical data' };
  return { ok: true, imports: rows.map((r) => ({ id: r.id, filename: r.filename, kind: KIND[r.kind] || r.kind, status: r.status, total_rows: r.total_rows,
    valid_rows: r.valid_rows, error_rows: r.error_rows, uploaded_by: names[r.uploaded_by_id] ?? null, uploaded_at: iso(r.uploaded_at), committed_at: iso(r.committed_at) })) };
}, { tx: false }));

/* Retrains the model on the records in the database, then rescores every active scholar. */
router.post('/system/recalibrate', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const st = await client.status();
  if (!st.available) throw new ApiError('The analytics service is not running. Start it from the analytics folder (see README), then try again.', 503);
  const table = await buildTable(k);
  let r;
  try { r = await client.call('/train', { method: 'POST', body: { scholars: table }, timeoutMs: 15 * 60000 }); } catch {
    throw new ApiError('The analytics service did not answer. Try again in a few minutes.', 503);
  }
  if (r.status === 409) throw new ApiError(r.data.error || 'Not enough data to train yet.', 409, null, 'not_enough_data');
  if (r.status !== 200) throw new ApiError(r.data.error || 'Training failed.', 422);
  const scoring = await risk.scoreAll(k);
  await k.transaction((t) => audit.log(t, req, 'system', 'Model recalibrated', { targetType: 'model', targetLabel: r.data.selected_model,
    details: { trained_at: r.data.trained_at, class_counts: r.data.class_counts, test_metrics: r.data.test_metrics, scored: scoring.scored || 0 } }));
  return { ok: true, training: r.data, scoring };
}, { tx: false }));

router.post('/system/score', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const scoring = await risk.scoreAll(k);
  if (scoring.skipped) throw new ApiError(scoring.skipped, 409);
  await k.transaction((t) => audit.log(t, req, 'system', 'Risk levels refreshed', { targetType: 'model', details: scoring }));
  return { ok: true, scoring };
}, { tx: false }));

module.exports = { router };
