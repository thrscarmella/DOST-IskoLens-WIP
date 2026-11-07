'use strict';
/* Sign-in, sign-out, sign-up with approval, password reset and invitations. */
const express = require('express');
const config = require('../config');
const db = require('../db');
const audit = require('../lib/audit');
const ratelimit = require('../lib/ratelimit');
const { route, created } = require('../lib/http');
const { ApiError, now, cleanText, sha256, newToken, bool, parseDT } = require('../lib/util');
const S = require('../lib/security');
const { notifyAdmins } = require('../lib/notifications');
const { sendMail } = require('../lib/mailer');
const V = require('../lib/validators');
const D = require('../lib/data');
const T = require('../lib/totp');

const router = express.Router();
const GENERIC = 'Incorrect email or password.';

function sessionPayload(req, user) {
  return { user: D.userPublic(user), preferences: D.userPreferences(user), csrf: S.csrfToken(req), idle_timeout_minutes: config.SESSION_IDLE_MINUTES,
    two_factor: { enabled: bool(user.totp_enabled), required: config.REQUIRE_ADMIN_2FA && user.role === 'admin' } };
}
const twoFactorAttempts = new Map();   // user id -> failed codes for the current sign-in

/* Public settings the sign-in and sign-up pages need */
router.get('/config', (req, res) => res.json({ ok: true, allow_signup: config.ALLOW_SIGNUP, require_admin_2fa: config.REQUIRE_ADMIN_2FA,
  password_rules: { min_length: config.PASSWORD_MIN_LENGTH, max_length: 128, needs_uppercase: true, needs_lowercase: true, needs_number: true, needs_symbol: true } }));

router.get('/csrf', (req, res) => res.json({ ok: true, csrf: S.csrfToken(req) }));

router.post('/login', route(async (req, res, k) => {
  const d = V.requireJson(req);
  const identifier = cleanText(d.email, 160).toLowerCase();
  const password = d.password || '';
  if (!identifier || !password) {
    const fe = {}; if (!identifier) fe.email = 'Email is required.'; if (!password) fe.password = 'Password is required.';
    throw new ApiError('Enter your email and password.', 422, fe);
  }
  ratelimit.check(req, 'login', 'RATE_LIMIT_FAILED_LOGINS', 15 * 60, 'Too many failed sign-in attempts from this computer.');
  const user = await k('users').whereRaw('LOWER(email) = ?', [identifier]).orWhereRaw('LOWER(username) = ?', [identifier]).first();
  if (!user) {
    ratelimit.hit(req, 'login');
    await S.dummyPasswordCheck(password);
    await k.transaction((t) => audit.log(t, req, 'security', 'Failed sign-in (unknown account)', { targetType: 'user', targetLabel: identifier, actor: null }));
    throw new ApiError(GENERIC, 401);
  }
  if (bool(user.is_locked)) {
    await k.transaction((t) => audit.log(t, req, 'security', 'Sign-in blocked (account locked)', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user }));
    throw new ApiError('This account is locked after too many failed sign-in attempts. Ask an Administrator to unlock it.', 423, null, 'locked');
  }
  if (!await S.checkPassword(password, user.password_hash)) {
    ratelimit.hit(req, 'login');
    const attempts = Number(user.failed_login_attempts || 0) + 1;
    const limit = config.MAX_FAILED_LOGINS;
    if (attempts >= limit) {
      await k.transaction(async (t) => {
        await t('users').where({ id: user.id }).update({ failed_login_attempts: attempts, is_locked: true, locked_at: now(), updated_at: now() });
        await audit.log(t, req, 'security', 'Account locked', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user, details: { failed_attempts: attempts } });
        await notifyAdmins(t, 'account_locked', `Account locked: ${D.fullName(user)}`,
          `${limit} failed sign-in attempts. Unlock it in User Management if this was the account owner.`, 'user-management.html', 'red');
      });
      throw new ApiError('This account is now locked after too many failed sign-in attempts. Ask an Administrator to unlock it.', 423, null, 'locked');
    }
    await k.transaction(async (t) => {
      await t('users').where({ id: user.id }).update({ failed_login_attempts: attempts, updated_at: now() });
      await audit.log(t, req, 'security', 'Failed sign-in', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user, details: { failed_attempts: attempts } });
    });
    throw new ApiError(GENERIC, 401);
  }
  if (user.status === 'pending') throw new ApiError('Your account is waiting for Administrator approval.', 403, null, 'pending');
  if (user.status === 'rejected') throw new ApiError('Your account request was declined. Contact your DOST Davao Oriental Administrator.', 403, null, 'rejected');
  if (user.status !== 'active') throw new ApiError('This account is deactivated. Contact your DOST Davao Oriental Administrator.', 403, null, 'inactive');
  if (bool(user.totp_enabled)) {
    // Password is right; the session starts only after the authenticator code.
    await k('users').where({ id: user.id }).update({ failed_login_attempts: 0, updated_at: now() });
    req.session = { csrf: newToken(24), pending2fa: { uid: user.id, exp: Date.now() + 5 * 60000 } };
    twoFactorAttempts.set(user.id, 0);
    return { ok: true, two_factor_required: true, csrf: req.session.csrf };
  }
  await k.transaction(async (t) => {
    await t('users').where({ id: user.id }).update({ failed_login_attempts: 0, last_login_at: now(), updated_at: now() });
    await S.startSession(req, user, t);
    await audit.log(t, req, 'security', 'Signed in', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user });
  });
  const fresh = await k('users').where({ id: user.id }).first();
  return { ok: true, ...sessionPayload(req, fresh) };
}, { tx: false }));

/* Second step: the 6-digit code from the authenticator app, or a one-time recovery code */
router.post('/login/verify', route(async (req, res, k) => {
  const pending = req.session && req.session.pending2fa;
  if (!pending || Date.now() > pending.exp) throw new ApiError('Your sign-in expired. Enter your email and password again.', 401, null, 'two_factor_expired');
  ratelimit.check(req, 'twofa', 'RATE_LIMIT_FAILED_LOGINS', 15 * 60, 'Too many wrong codes from this computer.');
  const user = await k('users').where({ id: pending.uid }).first();
  if (!user || user.status !== 'active' || bool(user.is_locked) || !bool(user.totp_enabled)) throw new ApiError('Sign-in failed. Start again.', 401);
  const entered = String(V.requireJson(req).code || '').trim();
  let ok = false; let usedRecovery = false;
  try { ok = T.verify(T.decrypt(user.totp_secret), entered); } catch { ok = false; }
  if (!ok && entered.length > 6) {
    const codes = JSON.parse(user.totp_recovery_json || '[]');
    const idx = codes.indexOf(T.hashCode(entered));
    if (idx > -1) { codes.splice(idx, 1); ok = true; usedRecovery = true; await k('users').where({ id: user.id }).update({ totp_recovery_json: JSON.stringify(codes) }); }
  }
  if (!ok) {
    ratelimit.hit(req, 'twofa');
    const tries = (twoFactorAttempts.get(user.id) || 0) + 1;
    twoFactorAttempts.set(user.id, tries);
    await k.transaction((t) => audit.log(t, req, 'security', 'Wrong two-step verification code', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user }));
    if (tries >= 5) { req.session = {}; throw new ApiError('Too many wrong codes. Enter your email and password again.', 401, null, 'two_factor_expired'); }
    throw new ApiError('That code is not correct. Check the time on your phone and try the newest code.', 401, { code: 'Wrong code.' });
  }
  twoFactorAttempts.delete(user.id);
  await k.transaction(async (t) => {
    await t('users').where({ id: user.id }).update({ last_login_at: now(), updated_at: now() });
    await S.startSession(req, user, t);
    await audit.log(t, req, 'security', usedRecovery ? 'Signed in with a recovery code' : 'Signed in (two-step verification)', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user });
  });
  return { ok: true, used_recovery_code: usedRecovery, ...sessionPayload(req, await k('users').where({ id: user.id }).first()) };
}, { tx: false }));

router.post('/logout', route(async (req, res, trx) => {
  if (req.user) await audit.log(trx, req, 'security', 'Signed out', { targetType: 'user', targetId: req.user.id, targetLabel: req.user.username });
  await S.endSession(req, 'logout', trx);
  return { ok: true };
}));
router.get('/me', route(async (req) => { S.requireLogin(req); return { ok: true, ...sessionPayload(req, req.user) }; }, { tx: false }));
router.post('/ping', route(async (req) => { S.requireLogin(req); return { ok: true }; }, { tx: false }));

/* ---------------- sign-up with Administrator approval ---------------- */
router.post('/signup', route(async (req, res, trx) => {
  if (!config.ALLOW_SIGNUP) throw new ApiError('Sign-up is turned off. Ask your DOST Davao Oriental Administrator to create your account.', 403, null, 'signup_disabled');
  ratelimit.check(req, 'signup', 'RATE_LIMIT_SIGNUPS', 3600, 'Too many sign-up requests from this computer.');
  ratelimit.hit(req, 'signup');
  const d = V.requireJson(req);
  const errors = {};
  const first = V.checkName(errors, 'first_name', d.first_name, 'First name');
  const last = V.checkName(errors, 'last_name', d.last_name, 'Last name');
  const email = V.checkEmail(errors, 'email', d.email, true);
  const username = cleanText(d.username, 40);
  if (!V.USERNAME_RE.test(username || '')) errors.username = 'Username must be 3 to 40 letters, numbers, periods or underscores.';
  const password = d.password || '';
  if (password !== (d.confirm_password || '')) errors.confirm_password = 'Passwords do not match.';
  if (!d.privacy_consent) errors.privacy_consent = 'Confirm the Data Privacy terms to continue.';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  S.requireValidPassword(password);
  if (await trx('users').whereRaw('LOWER(email) = ?', [email]).first()) throw new ApiError('An account with this email already exists.', 409, { email: 'This email is already registered.' });
  if (await trx('users').whereRaw('LOWER(username) = ?', [username.toLowerCase()]).first()) throw new ApiError('This username is already taken.', 409, { username: 'This username is already taken.' });
  const statusToken = newToken();
  const t = now();
  const [id] = await trx('users').insert({
    first_name: first, last_name: last, email, username, password_hash: await S.hashPassword(password), role: 'officer', status: 'pending',
    privacy_consent_at: t, signup_status_token: sha256(statusToken), password_changed_at: t, created_at: t, updated_at: t,
    office: 'DOST Davao Oriental', failed_login_attempts: 0, is_locked: false, pref_font_size: 'medium', pref_theme: 'light',
    pref_export_format: 'pdf', pref_email_high_risk: true, pref_weekly_digest: false,
  });
  const user = await trx('users').where({ id }).first();
  await audit.log(trx, req, 'security', 'Account requested', { targetType: 'user', targetId: id, targetLabel: username, actor: user });
  await notifyAdmins(trx, 'account_request', `New officer account request: ${D.fullName(user)}`, 'Awaiting your approval in User Management.', 'user-management.html', 'amber');
  return created({ ok: true, status_token: statusToken, name: D.fullName(user), email, username, submitted_at: t.replace(' ', 'T') });
}));
router.get('/signup-status', route(async (req, res, k) => {
  const token = req.query.token || '';
  const user = token ? await k('users').where({ signup_status_token: sha256(token) }).first() : null;
  if (!user) throw new ApiError('This sign-up request could not be found.', 404);
  const status = { pending: 'pending', active: 'approved', rejected: 'rejected' }[user.status] || 'inactive';
  return { ok: true, status, name: D.fullName(user), email: user.email, username: user.username, submitted_at: String(user.created_at).replace(' ', 'T') };
}, { tx: false }));

/* ---------------- password reset and invitation links ---------------- */
async function issuePasswordToken(trx, user, purpose) {
  const t = now();
  await trx('password_tokens').where({ user_id: user.id, purpose }).whereNull('used_at').update({ used_at: t });
  const raw = newToken();
  const life = purpose === 'reset' ? config.RESET_TOKEN_MINUTES * 60000 : config.INVITE_TOKEN_HOURS * 3600000;
  await trx('password_tokens').insert({ user_id: user.id, token_hash: sha256(raw), purpose, expires_at: now(life), created_at: t });
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/pages/reset-password.html?token=${raw}`;
}
router.post('/forgot-password', route(async (req, res, trx) => {
  ratelimit.check(req, 'reset', 'RATE_LIMIT_PASSWORD_RESETS', 3600, 'Too many password reset requests from this computer.');
  ratelimit.hit(req, 'reset');
  const d = V.requireJson(req);
  const errors = {};
  const email = V.checkEmail(errors, 'email', d.email, true);
  if (Object.keys(errors).length) throw new ApiError('Enter a valid email address.', 422, errors);
  const user = await trx('users').whereRaw('LOWER(email) = ?', [email]).first();
  if (user && user.status === 'active' && user.password_hash) {
    const recent = Number((await trx('password_tokens').where({ user_id: user.id, purpose: 'reset' }).where('created_at', '>', now(-3600000)).count({ n: '*' }).first()).n);
    if (recent < 3) {
      const link = await issuePasswordToken(trx, user, 'reset');
      await sendMail(user.email, 'Reset your DOST-IskoLens password',
        `Hi ${user.first_name},\n\nUse this link to set a new password. It expires in ${config.RESET_TOKEN_MINUTES} minutes and can be used once:\n\n${link}\n\n` +
        'If you did not ask for this, ignore this email; your password will not change.\n\nDOST-IskoLens');
      await audit.log(trx, req, 'security', 'Password reset requested', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user });
    }
  }
  // Same answer whether or not the email exists (prevents account enumeration).
  return { ok: true, message: 'If an active account uses that email, a reset link has been sent to it.' };
}));
async function findToken(k, raw) {
  if (!raw) return null;
  const t = await k('password_tokens').where({ token_hash: sha256(raw) }).first();
  if (!t || t.used_at || parseDT(t.expires_at).getTime() < Date.now()) return null;
  const user = await k('users').where({ id: t.user_id }).first();
  if (!user || user.status !== 'active') return null;
  return { t, user };
}
router.get('/reset-password/validate', route(async (req, res, k) => {
  const f = await findToken(k, req.query.token || '');
  if (!f) throw new ApiError('This link is invalid or has expired. Request a new one.', 410);
  return { ok: true, purpose: f.t.purpose, name: f.user.first_name, email: f.user.email };
}, { tx: false }));
router.post('/reset-password', route(async (req, res, trx) => {
  const d = V.requireJson(req);
  const f = await findToken(trx, d.token || '');
  if (!f) throw new ApiError('This link is invalid or has expired. Request a new one.', 410);
  const password = d.password || '';
  if (password !== (d.confirm_password || '')) throw new ApiError('Passwords do not match.', 422, { confirm_password: 'Passwords do not match.' });
  S.requireValidPassword(password);
  const { t, user } = f;
  if (user.password_hash && await S.checkPassword(password, user.password_hash)) throw new ApiError('Choose a password different from your current one.', 422, { password: 'Use a different password.' });
  await trx('users').where({ id: user.id }).update({ password_hash: await S.hashPassword(password), password_changed_at: now(), updated_at: now() });
  await trx('password_tokens').where({ id: t.id }).update({ used_at: now() });
  await S.revokeUserSessions(user.id, 'password_reset', { trx });
  await audit.log(trx, req, 'security', t.purpose === 'invite' ? 'Password set via invitation' : 'Password reset', { targetType: 'user', targetId: user.id, targetLabel: user.username, actor: user });
  return { ok: true, locked: bool(user.is_locked) };
}));

module.exports = { router, issuePasswordToken, sessionPayload };
