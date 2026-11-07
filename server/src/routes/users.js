'use strict';
/* User Management (Administrator only). */
const express = require('express');
const audit = require('../lib/audit');
const { route, created } = require('../lib/http');
const { ApiError, now, cleanText, bool, iso } = require('../lib/util');
const S = require('../lib/security');
const { notify } = require('../lib/notifications');
const { sendMail, mailConfigured } = require('../lib/mailer');
const V = require('../lib/validators');
const D = require('../lib/data');
const db = require('../db');
const { issuePasswordToken } = require('./auth');

const router = express.Router();
const n = async (q) => Number((await q.count({ n: '*' }).first()).n);

async function getUser(trx, req, id) {
  const u = await trx('users').where({ id: Number(id) }).first();
  if (!u || (u.status === 'rejected' && req.method !== 'GET')) throw new ApiError('User not found.', 404);
  return u;
}
const activeAdminCount = (trx, excludeId) => n(trx('users').where({ role: 'admin', status: 'active' }).whereIn('is_locked', [0, false]).whereNot({ id: excludeId || 0 }));
async function uniqueUsername(trx, email) {
  const base = (email.split('@')[0].replace(/[^A-Za-z0-9._]/g, '').slice(0, 30)) || 'user';
  let candidate = base; let i = 1;
  while (await trx('users').whereRaw('LOWER(username) = ?', [candidate.toLowerCase()]).first()) { i += 1; candidate = `${base}${i}`; }
  return candidate;
}

router.get('/', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const q = cleanText(req.query.q, 80).toLowerCase();
  const { role, status } = req.query;
  const tab = req.query.tab || 'all';
  const query = k('users').whereNot({ status: 'rejected' });
  if (tab === 'admin') query.where({ role: 'admin' });
  else if (tab === 'officer') query.where({ role: 'officer' });
  else if (tab === 'pending') query.where({ status: 'pending' });
  else if (tab === 'inactive') query.where({ status: 'inactive' });
  else if (tab === 'locked') query.whereIn('is_locked', [1, true]);
  if (['admin', 'officer'].includes(role)) query.where({ role });
  if (['active', 'inactive', 'pending'].includes(status)) query.where({ status });
  if (q) {
    const like = `%${q}%`;
    query.where((w) => w.whereRaw('LOWER(first_name) LIKE ?', [like]).orWhereRaw('LOWER(last_name) LIKE ?', [like])
      .orWhereRaw('LOWER(username) LIKE ?', [like]).orWhereRaw('LOWER(email) LIKE ?', [like])
      .orWhereRaw(`LOWER(${db.concat('first_name', "' '", 'last_name')}) LIKE ?`, [like]));
  }
  const users = await query.orderBy([{ column: 'status', order: 'desc' }, { column: 'last_name' }, { column: 'first_name' }]);
  const base = () => k('users').whereNot({ status: 'rejected' });
  const stats = {
    total: await n(base()), admins: await n(base().where({ role: 'admin' })), officers: await n(base().where({ role: 'officer' })),
    pending: await n(base().where({ status: 'pending' })), inactive: await n(base().where({ status: 'inactive' })),
    locked: await n(base().whereIn('is_locked', [1, true])),
  };
  return { ok: true, users: users.map((u) => D.userPublic(u, true)), stats, me: req.user.id };
}, { tx: false }));

router.get('/:id', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const u = await getUser(k, req, req.params.id);
  const weekAgo = now(-7 * 86400000);
  const stats = {
    scholars_encoded: await n(k('scholars').where({ created_by_id: u.id })),
    academic_records: await n(k('academic_records').where({ encoded_by_id: u.id })),
    stipend_records: await n(k('stipend_disbursements').where({ encoded_by_id: u.id })),
    accounts_approved: await n(k('users').where({ approved_by_id: u.id })),
    encoded_this_week: await n(k('scholars').where({ created_by_id: u.id }).where('created_at', '>=', weekAgo)),
  };
  const last = await k('user_sessions').where({ user_id: u.id }).max({ m: 'last_seen_at' }).first();
  return { ok: true, user: D.userPublic(u, true), stats, last_active_at: iso(last && last.m) };
}, { tx: false }));

router.post('/', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const d = V.requireJson(req);
  const errors = {};
  const first = V.checkName(errors, 'first_name', d.first_name, 'First name');
  const last = V.checkName(errors, 'last_name', d.last_name, 'Last name');
  const email = V.checkEmail(errors, 'email', d.email, true);
  const { role } = d;
  if (!['admin', 'officer'].includes(role)) errors.role = 'Select a role.';
  const office = cleanText(d.office, 160) || 'DOST Davao Oriental';
  const contact = d.contact_number;
  const contactClean = contact ? V.normalizeMobile(contact) : null;
  if (contact && !contactClean) errors.contact_number = 'Enter an 11-digit mobile number starting with 09.';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  if (await trx('users').whereRaw('LOWER(email) = ?', [email]).first()) throw new ApiError('An account with this email already exists.', 409, { email: 'This email is already registered.' });
  const t = now();
  const [id] = await trx('users').insert({
    first_name: first, last_name: last, email, username: await uniqueUsername(trx, email), role, status: 'active', office,
    contact_number: contactClean, approved_by_id: req.user.id, approved_at: t, created_at: t, updated_at: t,
    failed_login_attempts: 0, is_locked: false, pref_font_size: 'medium', pref_theme: 'light', pref_export_format: 'pdf',
    pref_email_high_risk: true, pref_weekly_digest: false,
  });
  const user = await trx('users').where({ id }).first();
  const link = await issuePasswordToken(trx, user, 'invite');
  const sent = await sendMail(user.email, 'Your DOST-IskoLens account',
    `Hi ${user.first_name},\n\nAn Administrator created a DOST-IskoLens account for you (${D.roleLabel(user)}). Your username is ${user.username}.\n\n` +
    `Set your password with this link (valid for 48 hours, single use):\n\n${link}\n\nDOST-IskoLens`);
  await audit.log(trx, req, 'security', 'User account created', { targetType: 'user', targetId: id, targetLabel: user.username, details: { role, email } });
  const out = { ok: true, user: D.userPublic(user, true), email_sent: sent };
  if (!sent && !mailConfigured()) out.invite_link = link;   // email not set up: show the link to the Admin once
  return created(out);
}));

async function setActive(trx, req, user, active, log = true) {
  if (user.status === 'pending') throw new ApiError('Approve or reject this request first.', 409);
  if (!active) {
    if (user.id === req.user.id) throw new ApiError('You cannot deactivate your own account.', 409);
    if (user.role === 'admin' && (await activeAdminCount(trx, user.id)) === 0) throw new ApiError('At least one active Administrator must remain.', 409);
    await trx('users').where({ id: user.id }).update({ status: 'inactive', updated_at: now() });
    await S.revokeUserSessions(user.id, 'deactivated', { trx });
  } else {
    await trx('users').where({ id: user.id }).update({ status: 'active', updated_at: now() });
  }
  if (log) await audit.log(trx, req, 'security', active ? 'User reactivated' : 'User deactivated', { targetType: 'user', targetId: user.id, targetLabel: user.username });
}

router.patch('/:id', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const user = await getUser(trx, req, req.params.id);
  const d = V.requireJson(req);
  const changes = {}; const errors = {}; const upd = {};
  if ('role' in d && d.role !== user.role) {
    if (!['admin', 'officer'].includes(d.role)) errors.role = 'Select a valid role.';
    else if (user.id === req.user.id) errors.role = 'You cannot change your own role.';
    else if (user.role === 'admin' && (await activeAdminCount(trx, user.id)) === 0) errors.role = 'At least one active Administrator must remain.';
    else { changes.role = [user.role, d.role]; upd.role = d.role; }
  }
  if ('office' in d) {
    const office = cleanText(d.office, 160);
    if (office !== (user.office || '')) { changes.office = [user.office, office]; upd.office = office || null; }
  }
  if ('contact_number' in d) {
    const contact = d.contact_number;
    const clean = contact ? V.normalizeMobile(contact) : null;
    if (contact && !clean) errors.contact_number = 'Enter an 11-digit mobile number starting with 09.';
    else if (clean !== user.contact_number) { changes.contact_number = [user.contact_number, clean]; upd.contact_number = clean; }
  }
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  if ('status' in d && d.status !== user.status) {
    if (!['active', 'inactive'].includes(d.status)) throw new ApiError('Check the highlighted fields.', 422, { status: 'Status must be Active or Inactive.' });
    await setActive(trx, req, { ...user, ...upd }, d.status === 'active', false);
    changes.status = [user.status, d.status];
  }
  if (Object.keys(upd).length) await trx('users').where({ id: user.id }).update({ ...upd, updated_at: now() });
  if (Object.keys(changes).length) {
    if (changes.role) await S.revokeUserSessions(user.id, 'role_changed', { trx });
    await audit.log(trx, req, 'security', 'User account updated', { targetType: 'user', targetId: user.id, targetLabel: user.username, details: changes });
  }
  return { ok: true, user: D.userPublic(await trx('users').where({ id: user.id }).first(), true) };
}));

for (const [path, active] of [['deactivate', false], ['reactivate', true]]) {
  router.post(`/:id/${path}`, route(async (req, res, trx) => {
    S.requireRole(req, 'admin');
    const user = await getUser(trx, req, req.params.id);
    await setActive(trx, req, user, active);
    return { ok: true, user: D.userPublic(await trx('users').where({ id: user.id }).first(), true) };
  }));
}

router.post('/:id/approve', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const user = await getUser(trx, req, req.params.id);
  if (user.status !== 'pending') throw new ApiError('This account is not waiting for approval.', 409);
  await trx('users').where({ id: user.id }).update({ status: 'active', approved_by_id: req.user.id, approved_at: now(), updated_at: now() });
  await audit.log(trx, req, 'security', 'Account request approved', { targetType: 'user', targetId: user.id, targetLabel: user.username });
  await sendMail(user.email, 'Your DOST-IskoLens account is approved',
    `Hi ${user.first_name},\n\nYour Scholarship Officer account has been approved. You can now sign in with your email and password.\n\nDOST-IskoLens`);
  return { ok: true, user: D.userPublic(await trx('users').where({ id: user.id }).first(), true) };
}));
router.post('/:id/reject', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const user = await getUser(trx, req, req.params.id);
  if (user.status !== 'pending') throw new ApiError('This account is not waiting for approval.', 409);
  await trx('users').where({ id: user.id }).update({ status: 'rejected', updated_at: now() });
  await audit.log(trx, req, 'security', 'Account request rejected', { targetType: 'user', targetId: user.id, targetLabel: user.username });
  await sendMail(user.email, 'Your DOST-IskoLens account request',
    `Hi ${user.first_name},\n\nYour account request could not be approved. Contact your DOST Davao Oriental Administrator for details.\n\nDOST-IskoLens`);
  return { ok: true };
}));
router.post('/:id/unlock', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const user = await getUser(trx, req, req.params.id);
  if (!bool(user.is_locked)) throw new ApiError('This account is not locked.', 409);
  await trx('users').where({ id: user.id }).update({ is_locked: false, locked_at: null, failed_login_attempts: 0, updated_at: now() });
  await audit.log(trx, req, 'security', 'Account unlocked', { targetType: 'user', targetId: user.id, targetLabel: user.username });
  await notify(trx, [user.id], 'account_unlocked', 'Your account was unlocked by an Administrator', 'If you forgot your password, use Forgot password on the sign-in page.', null, 'gray');
  return { ok: true, user: D.userPublic(await trx('users').where({ id: user.id }).first(), true) };
}));
router.post('/:id/resend-invite', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const user = await getUser(trx, req, req.params.id);
  if (user.password_hash) throw new ApiError('This user has already set a password.', 409);
  const link = await issuePasswordToken(trx, user, 'invite');
  const sent = await sendMail(user.email, 'Your DOST-IskoLens account',
    `Hi ${user.first_name},\n\nSet your DOST-IskoLens password with this link (valid for 48 hours, single use):\n\n${link}\n\nDOST-IskoLens`);
  await audit.log(trx, req, 'security', 'Invitation link re-sent', { targetType: 'user', targetId: user.id, targetLabel: user.username });
  const out = { ok: true, email_sent: sent };
  if (!sent && !mailConfigured()) out.invite_link = link;
  return out;
}));

/* Lost phone: the Administrator turns off another user's two-step verification */
router.post('/:id/reset-2fa', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const user = await getUser(trx, req, req.params.id);
  if (user.id === req.user.id) throw new ApiError('Use My Profile to change your own two-step verification.', 409);
  if (!bool(user.totp_enabled)) throw new ApiError('This user does not use two-step verification.', 409);
  await trx('users').where({ id: user.id }).update({ totp_enabled: false, totp_secret: null, totp_recovery_json: null, updated_at: now() });
  await S.revokeUserSessions(user.id, 'admin_signout', { trx });
  await audit.log(trx, req, 'security', 'Two-step verification reset by Administrator', { targetType: 'user', targetId: user.id, targetLabel: user.username });
  await notify(trx, [user.id], 'account_2fa_reset', 'Your two-step verification was reset by an Administrator', 'Set it up again in My Profile > Security.', 'profile.html', 'amber');
  return { ok: true, user: D.userPublic(await trx('users').where({ id: user.id }).first(), true) };
}));

module.exports = { router };
