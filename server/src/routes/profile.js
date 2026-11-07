'use strict';
/* My Profile, Security and Settings. */
const express = require('express');
const audit = require('../lib/audit');
const { route } = require('../lib/http');
const { ApiError, now } = require('../lib/util');
const S = require('../lib/security');
const V = require('../lib/validators');
const D = require('../lib/data');
const { sendDigest } = require('../lib/digest');
const { mailConfigured } = require('../lib/mailer');
const QRCode = require('qrcode');
const T = require('../lib/totp');
const config = require('../config');
const { bool } = require('../lib/util');
const { values: optionValues } = require('../lib/options');

const router = express.Router();
const n = async (q) => Number((await q.count({ n: '*' }).first()).n);

router.get('/', route(async (req, res, k) => {
  S.requireLogin(req);
  const u = req.user;
  const stats = {
    scholars_encoded: await n(k('scholars').where({ created_by_id: u.id })),
    academic_records: await n(k('academic_records').where({ encoded_by_id: u.id })),
    stipend_records: await n(k('stipend_disbursements').where({ encoded_by_id: u.id })),
    member_since: String(u.created_at).replace(' ', 'T'),
  };
  return { ok: true, user: D.userPublic(u), preferences: D.userPreferences(u), stats,
    two_factor: { enabled: bool(u.totp_enabled), required: config.REQUIRE_ADMIN_2FA && u.role === 'admin', recovery_codes_left: JSON.parse(u.totp_recovery_json || '[]').length } };
}, { tx: false }));

router.patch('/', route(async (req, res, trx) => {
  S.requireLogin(req);
  const u = req.user;
  const d = V.requireJson(req);
  const errors = {};
  const first = V.checkName(errors, 'first_name', 'first_name' in d ? d.first_name : u.first_name, 'First name');
  const last = V.checkName(errors, 'last_name', 'last_name' in d ? d.last_name : u.last_name, 'Last name');
  const email = V.checkEmail(errors, 'email', 'email' in d ? d.email : u.email, true);
  const contactRaw = 'contact_number' in d ? d.contact_number : u.contact_number;
  const contact = contactRaw ? V.normalizeMobile(contactRaw) : null;
  if (contactRaw && !contact) errors.contact_number = 'Enter an 11-digit mobile number starting with 09.';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  if (email !== u.email) {
    if (!await S.checkPassword(d.current_password || '', u.password_hash)) {
      throw new ApiError('Enter your current password to change your email.', 403, { current_password: 'Current password is required to change your email.' });
    }
    if (await trx('users').whereRaw('LOWER(email) = ?', [email]).whereNot({ id: u.id }).first()) throw new ApiError('Another account already uses this email.', 409, { email: 'This email is already registered.' });
  }
  const values = { first_name: first, last_name: last, email, contact_number: contact };
  const changes = audit.changedFields(u, values);
  if (Object.keys(changes).length) {
    await trx('users').where({ id: u.id }).update({ ...values, updated_at: now() });
    await audit.log(trx, req, 'security', 'Profile updated', { targetType: 'user', targetId: u.id, targetLabel: u.username, details: changes });
  }
  return { ok: true, user: D.userPublic(await trx('users').where({ id: u.id }).first()) };
}));

router.post('/password', route(async (req, res, trx) => {
  S.requireLogin(req);
  const u = req.user;
  const d = V.requireJson(req);
  if (!await S.checkPassword(d.current_password || '', u.password_hash)) throw new ApiError('Your current password is incorrect.', 403, { current_password: 'Current password is incorrect.' });
  const fresh = d.new_password || '';
  if (fresh !== (d.confirm_password || '')) throw new ApiError('New passwords do not match.', 422, { confirm_password: 'Passwords do not match.' });
  S.requireValidPassword(fresh, 'new_password');
  if (await S.checkPassword(fresh, u.password_hash)) throw new ApiError('Choose a password different from your current one.', 422, { new_password: 'Use a different password.' });
  await trx('users').where({ id: u.id }).update({ password_hash: await S.hashPassword(fresh), password_changed_at: now(), updated_at: now() });
  await S.revokeUserSessions(u.id, 'password_changed', { keepCurrent: true, req, trx });   // signs out other devices
  await audit.log(trx, req, 'security', 'Password changed', { targetType: 'user', targetId: u.id, targetLabel: u.username });
  return { ok: true };
}));

router.put('/preferences', route(async (req, res, trx) => {
  S.requireLogin(req);
  const u = req.user;
  const d = V.requireJson(req);
  const errors = {}; const upd = {};
  if ('font_size' in d) { if (!optionValues('font_sizes').includes(d.font_size)) errors.font_size = 'Choose small, medium or large.'; else upd.pref_font_size = d.font_size; }
  if ('theme' in d) { if (!optionValues('themes').includes(d.theme)) errors.theme = 'Choose Light, Dark or Match device.'; else upd.pref_theme = d.theme; }
  if ('default_municipality_id' in d) {
    const mid = d.default_municipality_id;
    if (mid === null || mid === '' || mid === 0) upd.pref_default_municipality_id = null;
    else if (!(await trx('municipalities').where({ id: Number(mid) }).first())) errors.default_municipality_id = 'Choose a municipality from the list.';
    else upd.pref_default_municipality_id = Number(mid);
  }
  if ('export_format' in d) { if (!optionValues('export_formats').includes(d.export_format)) errors.export_format = 'Choose PDF or CSV.'; else upd.pref_export_format = d.export_format; }
  if ('email_high_risk' in d) upd.pref_email_high_risk = !!d.email_high_risk;
  if ('weekly_digest' in d) upd.pref_weekly_digest = !!d.weekly_digest;
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted settings.', 422, errors);
  if (Object.keys(upd).length) await trx('users').where({ id: u.id }).update({ ...upd, updated_at: now() });
  return { ok: true, preferences: D.userPreferences(await trx('users').where({ id: u.id }).first()) };
}));

router.post('/digest-preview', route(async (req, res, k) => {
  S.requireLogin(req);
  const sent = await sendDigest(k, req.user);
  const configured = mailConfigured();
  return { ok: true, sent, mail_configured: configured,
    message: sent ? `Sent to ${req.user.email}` : (!configured ? 'Email is not set up on this server, so the digest was saved to the instance/outbox folder.' : 'The email could not be sent. Check the mail settings.') };
}, { tx: false }));

/* ---------------- two-step verification ---------------- */
async function checkCodeOrRecovery(u, code) {
  try { if (T.verify(T.decrypt(u.totp_secret), code)) return true; } catch { /* no secret */ }
  return JSON.parse(u.totp_recovery_json || '[]').includes(T.hashCode(code || ''));
}
router.post('/2fa/setup', route(async (req, res, trx) => {
  S.requireLogin(req);
  const u = req.user;
  if (bool(u.totp_enabled)) throw new ApiError('Two-step verification is already on.', 409);
  if (!(await S.checkPassword(V.requireJson(req).password || '', u.password_hash))) throw new ApiError('Your password is incorrect.', 403, { password: 'Enter your current password.' });
  const secret = T.newSecret();
  await trx('users').where({ id: u.id }).update({ totp_secret: T.encrypt(secret), updated_at: now() });
  const uri = T.otpauthUri(secret, u.email);
  return { ok: true, secret, otpauth_uri: uri, qr_svg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 200 }) };
}));
router.post('/2fa/enable', route(async (req, res, trx) => {
  S.requireLogin(req);
  const u = req.user;
  if (bool(u.totp_enabled)) throw new ApiError('Two-step verification is already on.', 409);
  if (!u.totp_secret) throw new ApiError('Start the setup first.', 409);
  let ok = false;
  try { ok = T.verify(T.decrypt(u.totp_secret), V.requireJson(req).code); } catch { ok = false; }
  if (!ok) throw new ApiError('That code is not correct. Enter the 6-digit code your app shows now.', 422, { code: 'Wrong code.' });
  const codes = T.newRecoveryCodes();
  await trx('users').where({ id: u.id }).update({ totp_enabled: true, totp_recovery_json: JSON.stringify(codes.map(T.hashCode)), updated_at: now() });
  await audit.log(trx, req, 'security', 'Two-step verification turned on', { targetType: 'user', targetId: u.id, targetLabel: u.username });
  return { ok: true, recovery_codes: codes };   // shown once; only their hashes are stored
}));
router.post('/2fa/disable', route(async (req, res, trx) => {
  S.requireLogin(req);
  const u = req.user;
  if (!bool(u.totp_enabled)) throw new ApiError('Two-step verification is not on.', 409);
  if (config.REQUIRE_ADMIN_2FA && u.role === 'admin') throw new ApiError('Two-step verification is required for Administrators on this system.', 409);
  const d = V.requireJson(req);
  if (!(await S.checkPassword(d.password || '', u.password_hash))) throw new ApiError('Your password is incorrect.', 403, { password: 'Enter your current password.' });
  if (!(await checkCodeOrRecovery(u, d.code))) throw new ApiError('That code is not correct.', 422, { code: 'Wrong code.' });
  await trx('users').where({ id: u.id }).update({ totp_enabled: false, totp_secret: null, totp_recovery_json: null, updated_at: now() });
  await audit.log(trx, req, 'security', 'Two-step verification turned off', { targetType: 'user', targetId: u.id, targetLabel: u.username });
  return { ok: true };
}));
router.post('/2fa/recovery-codes', route(async (req, res, trx) => {
  S.requireLogin(req);
  const u = req.user;
  const d = V.requireJson(req);
  if (!bool(u.totp_enabled)) throw new ApiError('Two-step verification is not on.', 409);
  if (!(await S.checkPassword(d.password || '', u.password_hash))) throw new ApiError('Your password is incorrect.', 403, { password: 'Enter your current password.' });
  if (!(await checkCodeOrRecovery(u, d.code))) throw new ApiError('That code is not correct.', 422, { code: 'Wrong code.' });
  const codes = T.newRecoveryCodes();
  await trx('users').where({ id: u.id }).update({ totp_recovery_json: JSON.stringify(codes.map(T.hashCode)), updated_at: now() });
  await audit.log(trx, req, 'security', 'New recovery codes created', { targetType: 'user', targetId: u.id, targetLabel: u.username });
  return { ok: true, recovery_codes: codes };
}));

module.exports = { router };
