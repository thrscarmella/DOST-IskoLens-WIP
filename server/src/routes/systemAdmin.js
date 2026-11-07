'use strict';
/* Data Protection page (Administrator): backups and active sessions. */
const path = require('path');
const multer = require('multer');
const express = require('express');
const config = require('../config');
const audit = require('../lib/audit');
const backups = require('../lib/backups');
const { route, created } = require('../lib/http');
const { ApiError, now, sha256, iso, parseDT } = require('../lib/util');
const S = require('../lib/security');
const D = require('../lib/data');

const router = express.Router();
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } }).single('file');

function device(ua = '') {
  ua = ua || '';
  const browser = [['Edg/', 'Edge'], ['OPR/', 'Opera'], ['Firefox/', 'Firefox'], ['Chrome/', 'Chrome'], ['Safari/', 'Safari']].find(([k]) => ua.includes(k));
  const system = [['Windows', 'Windows'], ['Android', 'Android'], ['iPhone', 'iPhone'], ['iPad', 'iPad'], ['Mac OS', 'macOS'], ['Linux', 'Linux']].find(([k]) => ua.includes(k));
  const b = browser ? browser[1] : 'Browser';
  return system ? `${b} on ${system[1]}` : b;
}
const REASONS = { logout: 'Signed out', idle_timeout: 'Timed out (30 min idle)', admin_signout: 'Signed out by Administrator', password_changed: 'Password changed',
  password_reset: 'Password reset', deactivated: 'Account deactivated', role_changed: 'Role changed', account_disabled: 'Account locked or disabled', restore: 'Data restored from backup' };

/* ---------------- active sessions ---------------- */
router.get('/sessions', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const idleMs = config.SESSION_IDLE_MINUTES * 60000;
  const current = req.session.sid ? sha256(req.session.sid) : null;
  const rows = await k('user_sessions as us').join('users as u', 'u.id', 'us.user_id').whereNull('us.revoked_at').where('us.last_seen_at', '>=', now(-idleMs))
    .orderBy('us.last_seen_at', 'desc').select('us.*', 'u.first_name', 'u.last_name', 'u.username', 'u.role');
  const sessions = rows.map((r) => ({
    id: r.id.slice(0, 16), user_id: r.user_id, name: D.fullName(r), username: r.username, role_label: D.roleLabel(r), ip_address: r.ip_address,
    device: device(r.user_agent), started_at: iso(r.created_at), last_seen_at: iso(r.last_seen_at),
    expires_at: new Date(parseDT(r.last_seen_at).getTime() + idleMs).toISOString().slice(0, 19), is_current: r.id === current,
  }));
  const recent = await k('user_sessions as us').join('users as u', 'u.id', 'us.user_id').whereNotNull('us.revoked_at').orderBy('us.revoked_at', 'desc').limit(15)
    .select('us.*', 'u.first_name', 'u.last_name');
  return { ok: true, sessions, users_online: new Set(sessions.map((s) => s.user_id)).size, supported: 30, idle_minutes: config.SESSION_IDLE_MINUTES,
    recent: recent.map((r) => ({ name: D.fullName(r), ended_at: iso(r.revoked_at), reason: REASONS[r.revoke_reason] || r.revoke_reason, device: device(r.user_agent), ip_address: r.ip_address })) };
}, { tx: false }));

router.post('/sessions/:prefix/revoke', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const { prefix } = req.params;
  if (!/^[0-9a-f]{16}$/.test(prefix || '')) throw new ApiError('Session not found.', 404);
  const row = await trx('user_sessions').where('id', 'like', `${prefix}%`).whereNull('revoked_at').first();
  if (!row) throw new ApiError('That session has already ended.', 404);
  if (req.session.sid && row.id === sha256(req.session.sid)) throw new ApiError('This is your own session. Use Log Out instead.', 409);
  await trx('user_sessions').where({ id: row.id }).update({ revoked_at: now(), revoke_reason: 'admin_signout' });
  const u = await trx('users').where({ id: row.user_id }).first();
  await audit.log(trx, req, 'security', 'Session ended by Administrator', { targetType: 'user', targetId: row.user_id, targetLabel: u.username,
    details: { device: device(row.user_agent), ip: row.ip_address } });
  return { ok: true };
}));
router.post('/users/:id/sign-out-everywhere', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const u = await trx('users').where({ id: Number(req.params.id) }).first();
  if (!u) throw new ApiError('User not found.', 404);
  if (u.id === req.user.id) throw new ApiError('Use Change Password on My Profile to sign out your other devices.', 409);
  await S.revokeUserSessions(u.id, 'admin_signout', { trx });
  await audit.log(trx, req, 'security', 'User signed out everywhere by Administrator', { targetType: 'user', targetId: u.id, targetLabel: u.username });
  return { ok: true };
}));

/* ---------------- backups ---------------- */
const fail = (err) => { if (err instanceof backups.BackupError) throw new ApiError(err.message, 422); throw err; };

router.get('/backups', route(async (req) => {
  S.requireRole(req, 'admin');
  const items = backups.listBackups();
  return { ok: true, backups: items, keep_scheduled: config.BACKUP_KEEP, folder: backups.backupDir(), using_separate_key: !!config.BACKUP_KEY,
    last_backup: items.length ? items[0].created_at : null };
}, { tx: false }));
router.post('/backups', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const note = String((req.body || {}).note || '').slice(0, 200) || null;
  // The backup reads every table itself, so it runs outside the request transaction.
  const m = await backups.createBackup('manual', req.user, note);
  await k.transaction((t) => audit.log(t, req, 'system', 'Manual backup created', { targetType: 'backup', targetLabel: m.name, details: { scholars: m.scholars, bytes: m.size_bytes } }));
  return created({ ok: true, backup: m });
}, { tx: false }));
router.post('/backups/upload', (req, res, next) => backupUpload(req, res, (err) => (err ? next(new ApiError('The upload could not be read.', 400)) : next())),
  route(async (req, res, trx) => {
    S.requireRole(req, 'admin');
    const f = req.file;
    if (!f || !f.originalname.toLowerCase().endsWith('.iskb')) throw new ApiError('Choose an IskoLens backup file (.iskb).', 422, { file: 'Only .iskb backup files.' });
    let m;
    try { m = backups.importUploaded(f.buffer, f.originalname); } catch (e) { fail(e); }
    await audit.log(trx, req, 'system', 'Backup file uploaded', { targetType: 'backup', targetLabel: m.name });
    return created({ ok: true, backup: m });
  }));
router.get('/backups/:name/download', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  let p;
  try { p = backups.backupPath(req.params.name); } catch (e) { throw new ApiError(e.message, 404); }
  await audit.log(trx, req, 'report', 'Backup downloaded', { targetType: 'backup', targetLabel: req.params.name });
  return (r) => r.download(p, path.basename(p));
}));
router.post('/backups/:name/verify', route(async (req) => {
  S.requireRole(req, 'admin');
  try { return { ok: true, backup: backups.verify(req.params.name) }; } catch (e) { return fail(e); }
}, { tx: false }));
router.post('/backups/:name/restore', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const d = req.body || {};
  if (String(d.confirm || '').trim().toUpperCase() !== 'RESTORE') throw new ApiError('Type RESTORE to confirm.', 422, { confirm: 'Type RESTORE to confirm.' });
  if (!await S.checkPassword(d.password || '', req.user.password_hash)) throw new ApiError('Your password is incorrect.', 403, { password: 'Enter your own password to confirm.' });
  const { name } = req.params;
  try { backups.verify(name); } catch (e) { fail(e); }
  const actorName = req.user.username;
  const safety = await backups.createBackup('pre-restore', req.user, `Automatic safety copy before restoring ${name}`);
  let manifest;
  try { manifest = await backups.restore(name); } catch (e) { fail(e); }
  const actor = await k('users').where({ username: actorName }).first();
  await k.transaction((t) => audit.log(t, req, 'system', 'Data restored from backup', { targetType: 'backup', targetLabel: name, actor: actor || null,
    details: { backup_created_at: manifest.created_at, safety_backup: safety.name, restored_by: actorName } }));
  req.session = {};   // everyone signs in again: accounts in the restored data may differ
  return { ok: true, backup: manifest, safety_backup: safety.name, signed_out: true };
}, { tx: false }));

module.exports = { router, device };
