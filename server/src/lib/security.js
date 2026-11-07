'use strict';
/*
 * Authentication, session, CSRF and role-based access control.
 *
 * How a request is authenticated (same design as v3):
 *  1. A signed, HttpOnly cookie holds a random session id and the CSRF token.
 *  2. The sha256 of the session id is looked up in user_sessions; the row must
 *     not be revoked and must have been active within 30 minutes.
 *  3. The user must still be active and not locked.
 * State-changing API calls must send the X-CSRF-Token header.
 */
const crypto = require('crypto');
// Native bcrypt checks passwords in a background thread so other requests are not blocked.
// If it cannot load on a computer, the pure-JavaScript bcryptjs (also asynchronous) is used.
let bcrypt;
try { bcrypt = require('bcrypt'); } catch { bcrypt = require('bcryptjs'); }
const config = require('../config');
const db = require('../db');
const { ApiError, now, sha256, newToken, parseDT } = require('./util');

const COOKIE = 'iskolens_session';

/* ---------------- passwords ---------------- */
const hashPassword = (plain) => bcrypt.hash(plain, config.BCRYPT_ROUNDS);
async function checkPassword(plain, hashed) {
  if (!plain || !hashed) return false;
  try { return await bcrypt.compare(plain, hashed); } catch { return false; }
}
let dummyHash = null;
async function dummyPasswordCheck(plain) { // same timing for unknown accounts
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password');
  await checkPassword(plain || 'x', dummyHash);
}
function passwordProblems(plain) {
  const p = plain || ''; const problems = [];
  if (p.length < config.PASSWORD_MIN_LENGTH) problems.push(`at least ${config.PASSWORD_MIN_LENGTH} characters`);
  if (!/[A-Z]/.test(p)) problems.push('an uppercase letter');
  if (!/[a-z]/.test(p)) problems.push('a lowercase letter');
  if (!/\d/.test(p)) problems.push('a number');
  if (!/[^A-Za-z0-9\s]/.test(p)) problems.push('a symbol (such as ! @ # $)');
  if (p.length > 128) problems.push('no more than 128 characters');
  return problems;
}
function requireValidPassword(plain, field = 'password') {
  const problems = passwordProblems(plain);
  if (problems.length) {
    const msg = `Password must have ${problems.join(', ')}.`;
    throw new ApiError(msg, 422, { [field]: msg });
  }
}

/* ---------------- signed cookie session ---------------- */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.SECRET_KEY).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function unsign(value) {
  if (!value || !value.includes('.')) return {};
  const [body, mac] = value.split('.');
  const good = crypto.createHmac('sha256', config.SECRET_KEY).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return {};
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (data.exp && Date.now() > data.exp) return {};
    return data;
  } catch { return {}; }
}
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
/* Middleware: req.session is a plain object; any change is written back as a
   signed cookie just before the response headers are sent. */
function sessionMiddleware(req, res, next) {
  req.session = unsign(readCookie(req, COOKIE));
  const original = JSON.stringify(req.session);
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const current = JSON.stringify(req.session || {});
    if (current !== original) {
      const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax'];
      if (config.FORCE_HTTPS) attrs.push('Secure');
      if (!req.session || !Object.keys(req.session).length) {
        res.appendHeader('Set-Cookie', `${COOKIE}=; ${attrs.join('; ')}; Max-Age=0`);
      } else {
        const maxAge = config.SESSION_MAX_HOURS * 3600;
        req.session.exp = req.session.exp || Date.now() + maxAge * 1000;
        res.appendHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sign(req.session))}; ${attrs.join('; ')}; Max-Age=${maxAge}`);
      }
    }
    return writeHead.apply(this, args);
  };
  next();
}

function clientIp(req) {
  // Behind a reverse proxy (TRUST_PROXY / FORCE_HTTPS), Express derives req.ip
  // from X-Forwarded-For set by the proxy; otherwise the header is ignored so
  // it cannot be faked to get around the per-address limits.
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 45);
}

async function startSession(req, user, trx = db()) {
  const rawSid = newToken();
  const t = now();
  await trx('user_sessions').insert({
    id: sha256(rawSid), user_id: user.id, created_at: t, last_seen_at: t,
    ip_address: clientIp(req), user_agent: String(req.headers['user-agent'] || '').slice(0, 255),
  });
  req.session = { sid: rawSid, csrf: newToken(24) };   // fresh id and token: prevents session fixation
}
async function endSession(req, reason = 'logout', trx = db()) {
  if (req.session && req.session.sid) {
    await trx('user_sessions').where({ id: sha256(req.session.sid) }).whereNull('revoked_at')
      .update({ revoked_at: now(), revoke_reason: reason });
  }
  req.session = {};
}
async function revokeUserSessions(userId, reason, { keepCurrent = false, req = null, trx = db() } = {}) {
  let q = trx('user_sessions').where({ user_id: userId }).whereNull('revoked_at');
  if (keepCurrent && req && req.session && req.session.sid) q = q.whereNot({ id: sha256(req.session.sid) });
  await q.update({ revoked_at: now(), revoke_reason: reason });
}

/* Runs before every request: sets req.user (or null) and req.sessionExpired. */
async function loadCurrentUser(req, res, next) {
  try {
    req.user = null; req.sessionRow = null; req.sessionExpired = false;
    const rawSid = req.session && req.session.sid;
    if (!rawSid) return next();
    const k = db();
    const row = await k('user_sessions').where({ id: sha256(rawSid) }).first();
    const t = now();
    if (!row || row.revoked_at) {
      req.session = {};
      req.sessionExpired = !!row;
      return next();
    }
    if (Date.now() - parseDT(row.last_seen_at).getTime() > config.SESSION_IDLE_MINUTES * 60000) {
      await k('user_sessions').where({ id: row.id }).update({ revoked_at: t, revoke_reason: 'idle_timeout' });
      req.session = {};
      req.sessionExpired = true;
      return next();
    }
    const user = await k('users').where({ id: row.user_id }).first();
    if (!user || user.status !== 'active' || Number(user.is_locked)) {
      await k('user_sessions').where({ id: row.id }).update({ revoked_at: t, revoke_reason: 'account_disabled' });
      req.session = {};
      return next();
    }
    // The background notification poll must not keep an idle session alive.
    if (req.headers['x-passive-request'] !== '1') await k('user_sessions').where({ id: row.id }).update({ last_seen_at: t });
    req.user = user;
    req.sessionRow = row;
    return next();
  } catch (err) { return next(err); }
}

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = newToken(24);
  return req.session.csrf;
}
function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.path.startsWith('/api/')) return next();
  const sent = String(req.headers['x-csrf-token'] || '');
  const expected = String((req.session && req.session.csrf) || '');
  const ok = expected && sent.length === expected.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return next(new ApiError('Your session security token is missing or out of date. Refresh the page and try again.', 403, null, 'csrf'));
  return next();
}

/* ---------------- RBAC ---------------- */
function requireLogin(req) {
  if (!req.user) {
    if (req.sessionExpired) throw new ApiError('Your session expired after 30 minutes of inactivity. Sign in again.', 401, null, 'session_expired');
    throw new ApiError('Sign in to continue.', 401, null, 'unauthenticated');
  }
}
function requireRole(req, ...roles) {
  requireLogin(req);
  if (!roles.includes(req.user.role)) throw new ApiError('Your role does not have access to this action.', 403, null, 'forbidden');
}

module.exports = {
  hashPassword, checkPassword, dummyPasswordCheck, passwordProblems, requireValidPassword,
  sessionMiddleware, startSession, endSession, revokeUserSessions, loadCurrentUser, csrfToken, verifyCsrf,
  requireLogin, requireRole, clientIp, COOKIE,
};
