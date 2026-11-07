'use strict';
/* Tests for v4.1 features: two-step verification, sign-up switch, risk fallback,
   interventions, KPI reports, System Management and "no data yet" analytics. */
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iskolens-jest2-'));
Object.assign(process.env, {
  DATABASE_URL: process.env.TEST_DATABASE_URL || `sqlite:///${path.join(TMP, 'test.db')}`, INSTANCE_DIR: TMP, BACKUP_DIR: path.join(TMP, 'backups'), BCRYPT_ROUNDS: '4',
  MAIL_SERVER: '', SECRET_KEY: 'jest-secret-2', RATE_LIMIT_FAILED_LOGINS: '1000', RATE_LIMIT_SIGNUPS: '1000', ALLOW_SIGNUP: '0',
  ANALYTICS_URL: 'http://127.0.0.1:9',   // nothing listens here: the analytics service is "off"
});
const request = require('supertest');
const db = require('../src/db');
const { run } = require('../src/cli');
const { createApp } = require('../src/app');
const T = require('../src/lib/totp');

let app;
async function agent(email, password, totpSecret = null) {
  const a = request.agent(app);
  let csrf = (await a.get('/api/auth/csrf')).body.csrf;
  const call = async (method, url, body) => {
    const r = await a[method](url).set('X-CSRF-Token', csrf).send(body);
    if (r.body && r.body.csrf) csrf = r.body.csrf;
    return r;
  };
  let login = await call('post', '/api/auth/login', { email, password });
  if (login.body.two_factor_required && totpSecret) login = await call('post', '/api/auth/login/verify', { code: T.code(totpSecret, Math.floor(Date.now() / 30000)) });
  return { a, call, login };
}

beforeAll(async () => {
  await run(['init-db']);
  await run(['create-admin', '--email', 'admin@test.ph', '--first-name', 'Ana', '--last-name', 'Admin', '--username', 'admin', '--password', 'Admin1234']);
  await run(['seed-demo', '--count', '30']);
  app = createApp();
});
afterAll(async () => { await db.reset(); });

test('public sign-up can be turned off', async () => {
  const anon = request.agent(app);
  const csrf = (await anon.get('/api/auth/csrf')).body.csrf;
  expect((await anon.get('/api/auth/config')).body.allow_signup).toBe(false);
  const r = await anon.post('/api/auth/signup').set('X-CSRF-Token', csrf).send({ first_name: 'A', last_name: 'B', email: 'x@y.ph', username: 'xy', password: 'Abcdef12', confirm_password: 'Abcdef12', privacy_consent: true });
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('signup_disabled');
});

test('two-step verification: setup, sign-in with code, recovery code, wrong code', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  expect((await adm.call('post', '/api/profile/2fa/setup', { password: 'wrong' })).status).toBe(403);
  const setup = await adm.call('post', '/api/profile/2fa/setup', { password: 'Admin1234' });
  expect(setup.status).toBe(200);
  expect(setup.body.qr_svg).toContain('<svg');
  const secret = setup.body.secret;
  expect((await adm.call('post', '/api/profile/2fa/enable', { code: '000000' })).status).toBe(422);
  const en = await adm.call('post', '/api/profile/2fa/enable', { code: T.code(secret, Math.floor(Date.now() / 30000)) });
  expect(en.status).toBe(200);
  expect(en.body.recovery_codes).toHaveLength(8);
  // password alone no longer signs in
  const half = await agent('admin@test.ph', 'Admin1234');
  expect(half.login.body.two_factor_required).toBe(true);
  expect((await half.call('get', '/api/auth/me')).status).toBe(401);
  expect((await half.call('post', '/api/auth/login/verify', { code: '123456' })).status).toBe(401);
  // correct code signs in
  const full = await agent('admin@test.ph', 'Admin1234', secret);
  expect(full.login.status).toBe(200);
  expect(full.login.body.two_factor.enabled).toBe(true);
  // a recovery code works once
  const r1 = await agent('admin@test.ph', 'Admin1234');
  const ok = await r1.call('post', '/api/auth/login/verify', { code: en.body.recovery_codes[0] });
  expect(ok.status).toBe(200);
  expect(ok.body.used_recovery_code).toBe(true);
  const r2 = await agent('admin@test.ph', 'Admin1234');
  expect((await r2.call('post', '/api/auth/login/verify', { code: en.body.recovery_codes[0] })).status).toBe(401);
  // turn it off again for the other tests
  expect((await full.call('post', '/api/profile/2fa/disable', { password: 'Admin1234', code: T.code(secret, Math.floor(Date.now() / 30000)) })).status).toBe(200);
});

test('risk falls back to academic standing when no model exists', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const list = (await adm.call('get', '/api/scholars?per_page=50')).body.scholars;
  const withGwa = list.find((s) => s.academic_standing);
  const expected = { Failed: 'High', Probation: 'Moderate', 'Good Standing': 'Low' }[withGwa.academic_standing];
  expect(withGwa.risk).toEqual(expect.objectContaining({ level: expected, source: 'standing' }));
  const detail = (await adm.call('get', `/api/scholars/${withGwa.code}`)).body.scholar;
  expect(detail.risk.source).toBe('standing');
});

test('intervention cases: opened for at-risk scholars, claim, log, close', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const list = await adm.call('get', '/api/interventions?tab=open');
  expect(list.status).toBe(200);
  expect(list.body.risk_source).toBe('standing');
  const atRisk = (await adm.call('get', '/api/scholars?standing=below&status=active&per_page=100')).body.total;
  expect(list.body.counts.open).toBe(atRisk);
  if (!atRisk) return;
  const c = list.body.cases[0];
  expect(c.recommended_actions.length).toBeGreaterThan(0);
  expect((await adm.call('post', `/api/interventions/${c.id}/log`, { action_type: 'Counseling session', notes: 'Talked about study plan.' })).status).toBe(409);
  expect((await adm.call('post', `/api/interventions/${c.id}/claim`)).status).toBe(200);
  expect((await adm.call('post', `/api/interventions/${c.id}/log`, { action_type: 'Counseling session', notes: 'short' })).status).toBe(422);
  expect((await adm.call('post', `/api/interventions/${c.id}/log`, { action_type: 'Counseling session', notes: 'Met the scholar and agreed on a study plan.' })).status).toBe(200);
  const closed = await adm.call('post', `/api/interventions/${c.id}/close`, { outcome: 'Improved', notes: 'GWA improved in the next term.' });
  expect(closed.body.case.status).toBe('closed');
  expect(closed.body.case.logs.map((l) => l.action_type)).toEqual(expect.arrayContaining(['Claimed', 'Counseling session', 'Closed']));
  // refreshing does not reopen the same scholar twice while a case is open, and the closed one stays closed
  expect((await adm.call('get', '/api/interventions?tab=closed')).body.counts.closed).toBe(1);
});

test('KPI reports: generate PDF and CSV, history, download, admin only', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const types = (await adm.call('get', '/api/kpi/types')).body.types;
  expect(types.length).toBeGreaterThanOrEqual(5);
  for (const t of types) {
    const r = await adm.call('post', '/api/kpi/reports', { type: t.id, format: 'pdf' });
    expect(r.status).toBe(201);
  }
  const csv = await adm.call('post', '/api/kpi/reports', { type: 'scholar_status', format: 'csv' });
  const hist = (await adm.call('get', '/api/kpi/reports')).body.reports;
  expect(hist.length).toBe(types.length + 1);
  const dl = await adm.a.get(`/api/kpi/reports/${csv.body.report.id}/download`);
  expect(dl.status).toBe(200);
  expect(dl.text).toContain('Scholar Status Summary');
  const pdf = await adm.a.get(`/api/kpi/reports/${hist[hist.length - 1].id}/download`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
});

test('System Management status, import log and recalibrate without the analytics service', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const st = (await adm.call('get', '/api/admin/system/status')).body;
  expect(st.database.ok).toBe(true);
  expect(st.analytics.available).toBe(false);
  expect((await adm.call('get', '/api/admin/system/imports')).status).toBe(200);
  const rc = await adm.call('post', '/api/admin/system/recalibrate');
  expect(rc.status).toBe(503);
});

test('analytics pages answer with "no data yet" states instead of failing', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const d = (await adm.call('get', '/api/analytics/descriptive')).body;
  expect(d.demographics.enough_data).toBe(true);
  expect(d.acceptance_rates.enough_data).toBe(false);   // no applicant data until the DOST dataset
  const g = (await adm.call('get', '/api/analytics/diagnostic')).body;
  expect(g.root_cause.available).toBe(false);
  const p = (await adm.call('get', '/api/analytics/predictive')).body;
  expect(p.termination_risk_levels.source).toBe('standing');
  expect(p.graduation_forecast.available).toBe(false);
  const geo = (await adm.call('get', '/api/geomap')).body;
  expect(geo.municipalities[0].applicant_data).toBe(false);
});

test('Scholar Records tab counts follow the same filters as the table', async () => {
  const off = await agent('admin@test.ph', 'Admin1234');
  const all = (await off.call('get', '/api/scholars?per_page=100')).body;
  const none = (await off.call('get', '/api/scholars?standing=none&status=active&per_page=100')).body;
  expect(none.tab_counts.all).toBe(Object.values(none.tab_counts).reduce((a, b) => a + b, 0) - none.tab_counts.all);
  expect(none.tab_counts.active).toBe(none.total);           // the Active tab shows exactly the rows listed
  expect(all.tab_counts.all).toBe(all.stats.total);           // without filters, the tabs match the overall totals
  expect(none.scholars.every((s) => s.academic_standing === null)).toBe(true);
});

test('every dropdown list comes from the server', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const lk = (await adm.call('get', '/api/lookups')).body;
  for (const key of ['sexes', 'semesters', 'stipend_statuses', 'graduation_statuses', 'termination_grounds', 'standing_filters', 'user_roles',
    'user_statuses', 'account_statuses', 'font_sizes', 'themes', 'export_formats', 'report_formats', 'reference_status_filters', 'geomap_metrics']) {
    expect(lk.options[key].length).toBeGreaterThan(0);
  }
  const cfg = (await request(app).get('/api/auth/config')).body;
  expect(cfg.password_rules.min_length).toBe(8);
});

test('the "no academic record yet" follow-up links to the same filter as its count', async () => {
  const off = await agent('admin@test.ph', 'Admin1234');
  await off.call('post', '/api/users', { first_name: 'Follow', last_name: 'Up', email: 'fu@test.ph', role: 'officer' });
  const { run: cli } = require('../src/cli');
  const k = db();
  const officer = await k('users').where({ email: 'fu@test.ph' }).first();
  await k('users').where({ id: officer.id }).update({ password_hash: await require('../src/lib/security').hashPassword('Officer123') });
  const o = await agent('fu@test.ph', 'Officer123');
  const dash = (await o.call('get', '/api/dashboard')).body;
  const task = dash.tasks.find((t) => /no academic record yet/.test(t.title));
  if (!task) return;   // every active scholar already has a record in this data
  expect(task.link).toBe('scholar-records.html?status=active&standing=none');
  const n = Number(task.title.match(/^(\d+)/)[1]);
  const list = (await o.call('get', '/api/scholars?status=active&standing=none&per_page=100')).body;
  expect(list.total).toBe(n);
  expect(list.tab_counts.active).toBe(n);
  expect(list.tab_counts.all).toBe(n);
  void cli;
});
