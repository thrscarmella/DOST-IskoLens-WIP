'use strict';
/*
 * Jest + Supertest tests for the Node.js backend (run: npm test).
 * Uses a throwaway SQLite database. The full v3 contract suite (17 groups,
 * run over HTTP) is in tests/contract; see the README.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iskolens-jest-'));
Object.assign(process.env, {
  DATABASE_URL: `sqlite:///${path.join(TMP, 'test.db')}`, INSTANCE_DIR: TMP, DOCUMENTS_DIR: path.join(TMP, 'documents'),
  BACKUP_DIR: path.join(TMP, 'backups'), BCRYPT_ROUNDS: '4', MAIL_SERVER: '', SECRET_KEY: 'jest-secret',
  RATE_LIMIT_FAILED_LOGINS: '1000', RATE_LIMIT_PASSWORD_RESETS: '1000', RATE_LIMIT_SIGNUPS: '1000',
});
const request = require('supertest');
const db = require('../src/db');
const { run } = require('../src/cli');
const { createApp } = require('../src/app');
const { computeStanding } = require('../src/lib/standing');

let app;
/* A signed-in browser: keeps cookies and the CSRF token */
async function agent(email, password) {
  const a = request.agent(app);
  let csrf = (await a.get('/api/auth/csrf')).body.csrf;
  const call = async (method, url, body) => {
    const r = await a[method](url).set('X-CSRF-Token', csrf).send(body);
    if (r.body && r.body.csrf) csrf = r.body.csrf;
    return r;
  };
  const login = await call('post', '/api/auth/login', { email, password });
  return { a, call, login, csrf: () => csrf };
}
async function lookups(c) {
  const b = (await c.call('get', '/api/lookups')).body;
  const muni = b.municipalities.find((m) => m.name === 'Mati City');
  return { b, muni, school: b.schools.find((s) => s.municipality_id === muni.id) };
}
async function payload(c, over = {}) {
  const { b, muni, school } = await lookups(c);
  return { gender: 'Male', birth_date: '2006-03-15',
    mobile_number: '09171234567', email: 'juan@example.com', program: b.programs[0].id, cycle: b.cycles[1].id, municipality: muni.id,
    secondary_school: school.id, enrollment_date: '2024-08-12', hei: b.heis[0].id, degree_program: 'BS Information Technology', year_level: 1, ...over };
}

beforeAll(async () => {
  await run(['init-db']);
  await run(['create-admin', '--email', 'admin@test.ph', '--first-name', 'Ana', '--last-name', 'Admin', '--username', 'admin', '--password', 'Admin1234']);
  app = createApp();
  const adm = await agent('admin@test.ph', 'Admin1234');
  const r = await adm.call('post', '/api/users', { first_name: 'Olive', last_name: 'Officer', email: 'olive@test.ph', role: 'officer' });
  const token = new URL(r.body.invite_link).searchParams.get('token');
  await request(app).get('/api/auth/csrf');
  const anon = request.agent(app);
  const csrf = (await anon.get('/api/auth/csrf')).body.csrf;
  await anon.post('/api/auth/reset-password').set('X-CSRF-Token', csrf).send({ token, password: 'Officer123', confirm_password: 'Officer123' });
});
afterAll(async () => { await db.reset(); });

test('sign-in, wrong password, CSRF and role checks', async () => {
  expect((await agent('admin@test.ph', 'Admin1234')).login.status).toBe(200);
  expect((await agent('admin@test.ph', 'wrong')).login.body.error).toBe('Incorrect email or password.');
  const anon = request(app);
  expect((await anon.post('/api/auth/login').send({ email: 'x', password: 'y' })).status).toBe(403);   // no CSRF token
  const off = await agent('olive@test.ph', 'Officer123');
  expect(off.login.status).toBe(200);
  expect((await off.call('get', '/api/users')).status).toBe(403);
  expect((await off.call('get', '/api/scholars/export')).status).toBe(403);
  const page = await off.a.get('/pages/user-management.html');
  expect(page.status).toBe(302);
});

test('account locks after 5 failed sign-ins', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const r = await adm.call('post', '/api/users', { first_name: 'Lock', last_name: 'Test', email: 'lock@test.ph', role: 'officer' });
  expect(r.status).toBe(201);
  const pw = await agent('lock@test.ph', 'x');
  for (let i = 0; i < 4; i++) await pw.call('post', '/api/auth/login', { email: 'lock@test.ph', password: 'bad' });
  const locked = await pw.call('post', '/api/auth/login', { email: 'lock@test.ph', password: 'bad' });
  expect([401, 423]).toContain(locked.status);
});

test('scholar encoding validates input; scholars are identified by Scholar ID only', async () => {
  const off = await agent('olive@test.ph', 'Officer123');
  const bad = await off.call('post', '/api/scholars', await payload(off, { mobile_number: '123', gender: 'X' }));
  expect(bad.status).toBe(422);
  expect(Object.keys(bad.body.field_errors)).toEqual(expect.arrayContaining(['mobile_number', 'gender']));
  const ok = await off.call('post', '/api/scholars', await payload(off));
  expect(ok.status).toBe(201);
  expect(ok.body.scholar.code).toMatch(/^SCH-\d{4}-\d{3}$/);
  expect(ok.body.scholar).not.toHaveProperty('last_name');
  expect(ok.body.scholar).not.toHaveProperty('name');
  const second = await off.call('post', '/api/scholars', await payload(off, { last_name: 'Ignored' }));
  expect(second.status).toBe(201);
  expect(second.body.scholar.code).not.toBe(ok.body.scholar.code);
  expect(second.body.scholar).not.toHaveProperty('last_name');
});

test('academic standing follows the revised BPMN rule', () => {
  expect(computeStanding(1.75, 1)).toBe('Good Standing');
  expect(computeStanding(2.25, 2)).toBe('Probation');
  expect(computeStanding(3.5, 1)).toBe('Failed');
  expect(computeStanding(2.75, 3)).toBe('Good Standing');
  expect(computeStanding(88, 1)).toBe('Good Standing');
  expect(computeStanding(80, 2)).toBe('Probation');
});

test('GWA records: two semesters below the requirement notify the office', async () => {
  const off = await agent('olive@test.ph', 'Officer123');
  const s = (await off.call('post', '/api/scholars', await payload(off, { birth_date: '2006-05-05' }))).body.scholar;
  await off.call('post', `/api/scholars/${s.code}/academic-records`, { academic_year: '2024-2025', semester: '1st Semester', gwa: 2.4 });
  const r = await off.call('post', `/api/scholars/${s.code}/academic-records`, { academic_year: '2024-2025', semester: '2nd Semester', gwa: 2.6 });
  expect(r.status).toBe(201);
  expect(r.body.scholar.below_requirement_two_semesters).toBe(true);
  expect(r.body.scholar.eligible_for_termination_recommendation).toBe(true);
  const adm = await agent('admin@test.ph', 'Admin1234');
  expect((await adm.call('get', '/api/notifications')).body.unread).toBeGreaterThan(0);
});

test('spreadsheet import validates every row and saves only after confirmation', async () => {
  const off = await agent('olive@test.ph', 'Officer123');
  const csv = 'Sex,Date of Birth,Mobile Number,Scholarship Program,Scholarship Cycle,Municipality,Secondary School,Enrollment Date,HEI,Degree Program,Year Level\n'
    + 'Female,2006-02-02,09175550000,Merit,2025-2026,Lupon,Lupon National High School,2025-08-10,DOSCST — Main Campus,BS Math,1\n'
    + 'X,1990,1,Merit,2025,Nowhere,,2025-08-10,x,,\n';
  const prev = await off.a.post('/api/scholars/import/preview').set('X-CSRF-Token', off.csrf()).attach('file', Buffer.from(csv), 'batch.csv');
  expect(prev.status).toBe(200);
  expect(prev.body.valid_rows).toBe(1);
  expect(prev.body.error_rows).toBe(1);
  const commit = await off.call('post', `/api/scholars/import/${prev.body.batch_id}/commit`);
  expect(commit.body.created).toBe(1);
  const exe = await off.a.post('/api/scholars/import/preview').set('X-CSRF-Token', off.csrf()).attach('file', Buffer.from('x'), 'evil.exe');
  expect(exe.status).toBe(422);
});

test('audit log is complete and tamper-evident', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const v = await adm.call('get', '/api/audit-logs/verify');
  expect(v.body.intact).toBe(true);
  expect(v.body.checked).toBeGreaterThan(5);
  await db()('audit_logs').where({ id: 1 }).update({ action: 'edited by attacker' });
  expect((await adm.call('get', '/api/audit-logs/verify')).body.intact).toBe(false);
  await db()('audit_logs').where({ id: 1 }).update({ action: 'Administrator created from command line' });
  expect((await adm.call('get', '/api/audit-logs/verify')).body.intact).toBe(true);
});

test('encrypted backup can be verified and restored', async () => {
  const adm = await agent('admin@test.ph', 'Admin1234');
  const before = (await adm.call('get', '/api/scholars?per_page=5')).body.stats.total;
  const b = await adm.call('post', '/api/admin/backups', { note: 'jest' });
  expect(b.status).toBe(201);
  expect((await adm.call('post', `/api/admin/backups/${b.body.backup.name}/verify`)).status).toBe(200);
  const off = await agent('olive@test.ph', 'Officer123');
  await off.call('post', '/api/scholars', await payload(off, { birth_date: '2006-09-09' }));
  const r = await adm.call('post', `/api/admin/backups/${b.body.backup.name}/restore`, { confirm: 'RESTORE', password: 'Admin1234' });
  expect(r.status).toBe(200);
  const adm2 = await agent('admin@test.ph', 'Admin1234');
  expect((await adm2.call('get', '/api/scholars?per_page=5')).body.stats.total).toBe(before);
  expect((await adm2.call('get', '/api/audit-logs/verify')).body.intact).toBe(true);
});
