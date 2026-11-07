'use strict';
/* DOST-IskoLens web application (Express). */
const path = require('path');
const express = require('express');
const config = require('./config');
const S = require('./lib/security');
const { ApiError } = require('./lib/util');
const { sessionPayload } = require('./routes/auth');

const PUBLIC_PAGES = new Set(['login.html', 'signup.html', 'forgot-password.html', 'reset-password.html', 'pending-approval.html', 'privacy-notice.html']);
const ADMIN_PAGES = new Set(['user-management.html', 'audit-logs.html', 'system-management.html', 'kpi-reports.html', 'kpi-report-view.html',
  'reference-lists.html', 'data-protection.html']);

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY ? 1 : false);

  // HTTPS only in production (behind Nginx/Apache that terminates TLS)
  if (config.FORCE_HTTPS) {
    app.use((req, res, next) => (req.secure ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)));
  }
  // Security headers (NFR 9-13)
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
    if (config.FORCE_HTTPS) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    // Content Security Policy: everything comes from this server only (no outside
    // scripts, styles, fonts or connections), no plugins, no framing by other sites.
    // 'unsafe-inline' is still needed because the pages use inline scripts and handlers.
    res.set('Content-Security-Policy', ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'self'",
      "form-action 'self'", "frame-ancestors 'none'"].join('; '));
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(S.sessionMiddleware);
  app.use(S.loadCurrentUser);
  app.use(S.verifyCsrf);
  // Administrators must set up two-step verification first when REQUIRE_ADMIN_2FA=1
  app.use((req, res, next) => {
    const u = req.user;
    if (!config.REQUIRE_ADMIN_2FA || !u || u.role !== 'admin' || Number(u.totp_enabled) || !req.path.startsWith('/api/')) return next();
    if (req.path.startsWith('/api/auth/') || req.path.startsWith('/api/profile') || req.path === '/api/session.js' || req.path === '/api/notifications') return next();
    return next(new ApiError('Set up two-step verification in My Profile > Security before continuing.', 403, null, 'two_factor_setup_required'));
  });

  // ---------------- API ----------------
  app.use('/api/auth', require('./routes/auth').router);
  app.use('/api/users', require('./routes/users').router);
  app.use('/api/profile', require('./routes/profile').router);
  const ref = require('./routes/reference');
  app.use('/api/lookups', ref.lookups);
  app.use('/api/admin/reference', ref.reference);
  const imports = require('./routes/imports');
  app.use('/api/scholars/import', imports.scholars);
  app.use('/api/records-import', imports.records);
  app.use('/api', require('./routes/scholars').router);
  app.use('/api', require('./routes/documents').router);
  app.use('/api', require('./routes/privacy').router);
  app.use('/api/admin', require('./routes/systemAdmin').router);
  app.use('/api', require('./routes/overview').router);
  app.use('/api', require('./routes/analytics').router);
  app.use('/api', require('./routes/interventions').router);
  app.use('/api', require('./routes/kpi').router);
  app.use('/api/admin', require('./routes/system').router);

  app.get('/api/session.js', (req, res) => {
    let body;
    if (!req.user) {
      body = `window.location.replace('/pages/login.html?next=' + encodeURIComponent(location.pathname)${req.sessionExpired ? " + '&reason=timeout'" : ''});`;
    } else {
      body = `window.ISKOLENS_SESSION = ${JSON.stringify(sessionPayload(req, req.user))};`;
    }
    res.set('Content-Type', 'application/javascript; charset=utf-8').set('Cache-Control', 'no-store').send(body);
  });
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

  // ---------------- pages and static files ----------------
  app.get('/', (req, res) => res.redirect(req.user ? '/pages/dashboard.html' : '/pages/login.html'));
  app.get('/pages/:name', (req, res, next) => {
    const { name } = req.params;
    if (!/^[A-Za-z0-9._-]+\.html$/.test(name)) return next();
    if (PUBLIC_PAGES.has(name)) {
      if (req.user && ['login.html', 'signup.html'].includes(name)) return res.redirect('/pages/dashboard.html');
    } else {
      if (!req.user) return res.redirect(`/pages/login.html?next=/pages/${name}${req.sessionExpired ? '&reason=timeout' : ''}`);
      if (ADMIN_PAGES.has(name) && req.user.role !== 'admin') return res.redirect('/pages/dashboard.html');   // server-side page guard
    }
    res.set('Cache-Control', 'no-store');
    return res.sendFile(path.join(config.FRONTEND_DIR, 'pages', name), (err) => { if (err) next(); });
  });
  for (const folder of ['css', 'js', 'assets', 'vendor']) app.use(`/${folder}`, express.static(path.join(config.FRONTEND_DIR, folder), { maxAge: 300000, index: false }));
  app.get('/favicon.ico', (req, res) => res.sendFile(path.join(config.FRONTEND_DIR, 'assets', 'images', 'dost-logo.png')));
  app.use((req, res) => res.status(404).send('Not found.'));

  // ---------------- errors: users only ever see plain messages ----------------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const api = req.path.startsWith('/api/');
    if (err instanceof ApiError) {
      const body = { ok: false, error: err.message };
      const fields = Object.fromEntries(Object.entries(err.fieldErrors || {}).filter(([, v]) => v));
      if (Object.keys(fields).length) body.field_errors = fields;
      if (err.code) body.code = err.code;
      return res.status(err.status).json(body);
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Send the form data as JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'The file is larger than the 10 MB limit.' });
    if (['ER_DUP_ENTRY', 'SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(err.code)) {
      console.warn('Integrity error:', err.message);
      return res.status(409).json({ ok: false, error: 'This record was changed by someone else at the same moment, or it duplicates an existing record. Refresh and try again.' });
    }
    console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
    if (api) return res.status(500).json({ ok: false, error: 'Something went wrong on the server. The error has been logged; try again, and contact the Administrator if it keeps happening.' });
    return res.status(500).send('Something went wrong on the server.');
  });
  return app;
}
module.exports = { createApp };
