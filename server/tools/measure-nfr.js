'use strict';
/*
 * Measures DOST-IskoLens against the performance NFRs and writes
 * tools/nfr-results.md for Chapter 4. Uses a SEPARATE test database filled
 * with FICTIONAL scholars; your real data is never touched.
 *
 *   node tools/measure-nfr.js                       (SQLite test file)
 *   node tools/measure-nfr.js --scholars 2000 --users 30
 *   node tools/measure-nfr.js --mysql "mysql://root:@localhost:3306/iskolens_nfr"   (create the empty DB first)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : def; };
const SCHOLARS = Number(arg('scholars', 1000)); const USERS = Number(arg('users', 30)); const ROUNDS = Number(arg('rounds', 5));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'iskolens-nfr-'));
Object.assign(process.env, {
  DATABASE_URL: arg('mysql', `sqlite:///${path.join(TMP, 'nfr.db')}`), INSTANCE_DIR: TMP, DOCUMENTS_DIR: path.join(TMP, 'docs'),
  BACKUP_DIR: path.join(TMP, 'backups'), MAIL_SERVER: '', RATE_LIMIT_FAILED_LOGINS: '100000', SECRET_KEY: 'nfr-secret',
});
const db = require('../src/db');
const { createSchema } = require('../src/schema');
const { seedLookups } = require('../src/lib/seed');
const { hashPassword } = require('../src/lib/security');
const { computeStanding } = require('../src/lib/standing');
const { now } = require('../src/lib/util');
const { createApp } = require('../src/app');
const config = require('../src/config');

const PASSWORD = 'Measure1234';
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); return { median: s[Math.floor(s.length / 2)], p95: s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))], max: s[s.length - 1], n: s.length }; };

async function seed() {
  const k = db();
  await createSchema(); await seedLookups(k);
  const pw = await hashPassword(PASSWORD);   // real bcrypt cost, so sign-in times are realistic
  const t = now();
  const user = (u) => ({ ...u, password_hash: pw, status: 'active', approved_at: t, created_at: t, updated_at: t, failed_login_attempts: 0, is_locked: false,
    pref_font_size: 'medium', pref_theme: 'light', pref_export_format: 'pdf', pref_email_high_risk: false, pref_weekly_digest: false });
  await k('users').insert(user({ first_name: 'Nfr', last_name: 'Admin', email: 'nfr-admin@test.ph', username: 'nfradmin', role: 'admin' }));
  for (let i = 0; i < USERS; i++) await k('users').insert(user({ first_name: 'Officer', last_name: `No${i}`, email: `officer${i}@test.ph`, username: `officer${i}`, role: 'officer' }));
  const admin = await k('users').where({ username: 'nfradmin' }).first();
  const munis = await k('municipalities'); const heis = await k('heis'); const progs = await k('scholarship_programs');
  const cycles = (await k('scholarship_cycles')).filter((c) => c.start_year >= 2018);
  let r = 7; const rnd = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const year = new Date().getFullYear();
  await k.transaction(async (trx) => {
    for (let n = 0; n < SCHOLARS; n++) {
      const m = pick(munis); const c = pick(cycles);
      const school = await trx('secondary_schools').where({ municipality_id: m.id }).first();
      const [id] = await trx('scholars').insert({ scholar_code: `SCH-${year}-${String(n + 1).padStart(4, '0')}`, gender: pick(['Male', 'Female']), birth_date: `${c.start_year - 18}-05-15`, mobile_number: '0917 000 0000', program_id: pick(progs).id, cycle_id: c.id,
        municipality_id: m.id, secondary_school_id: school.id, enrollment_date: `${c.start_year}-08-10`, hei_id: pick(heis).id, degree_program: 'BS Information Technology',
        year_level: 1 + Math.floor(rnd() * 4), status: 'active', is_deactivated: false, is_anonymized: false, created_by_id: admin.id, created_at: t, updated_at: t });
      await trx('graduation_records').insert({ scholar_id: id, status: 'On Track', updated_at: t });
      let st = null;
      for (let j = 0; j < 1 + Math.floor(rnd() * 4); j++) {
        const g = Math.round((1.2 + rnd() * 2.2) * 100) / 100; const lvl = Math.floor(j / 2) + 1; st = computeStanding(g, lvl, 'grade');
        await trx('academic_records').insert({ scholar_id: id, academic_year: `${c.start_year + Math.floor(j / 2)}-${c.start_year + Math.floor(j / 2) + 1}`, semester: j % 2 ? '2nd Semester' : '1st Semester',
          semester_order: j % 2 + 1, gwa: g, gwa_scale: 'grade', year_level_at_record: lvl, standing: st, date_recorded: '2025-01-01', encoded_by_id: admin.id, created_at: t });
        await trx('stipend_disbursements').insert({ scholar_id: id, period: `Term ${j + 1}`, amount: 20000, status: 'Released', date_released: '2025-01-02', encoded_by_id: admin.id, created_at: t, updated_at: t });
      }
      await trx('scholars').where({ id }).update({ academic_standing: st });
    }
  });
}

class Browser {   // one signed-in browser window: keeps its cookie and CSRF token
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, p, { json, form } = {}) {
    const t0 = performance.now();
    const headers = { Cookie: this.cookie, 'X-CSRF-Token': this.csrf };
    if (json) headers['Content-Type'] = 'application/json';
    const r = await fetch(this.base + p, { method, headers, body: json ? JSON.stringify(json) : form });
    const set = r.headers.get('set-cookie'); if (set) this.cookie = set.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    const dt = (performance.now() - t0) / 1000;
    let body = null; try { body = JSON.parse(buf.toString()); } catch { /* file */ }
    if (body && body.csrf) this.csrf = body.csrf;
    return { status: r.status, body, buf, dt };
  }
  async login(username) {
    await this.req('GET', '/api/auth/csrf');
    const r = await this.req('POST', '/api/auth/login', { json: { email: username, password: PASSWORD } });
    if (r.status !== 200) throw new Error(`login failed ${r.status}`);
    return r.dt;
  }
}

(async () => {
  let t0 = performance.now();
  console.log(`Building a test database with ${SCHOLARS} fictional scholars ...`);
  await seed();
  console.log(`  done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = new Browser(base); await admin.login('nfradmin');
  const results = [];
  const terms = ['sch-', 'mati', 'dorsu', 'lupon', 'national', 'baganga', 'cateel', 'doscst', 'boston', 'manay'];

  let times = [];
  for (let i = 0; i < 3; i++) for (const q of terms) times.push((await admin.req('GET', `/api/scholars?q=${encodeURIComponent(q)}&per_page=25`)).dt);
  for (const f of ['status=active', 'standing=below', 'municipality_id=1', 'status=active&standing=Probation']) times.push((await admin.req('GET', `/api/scholars?${f}&per_page=25`)).dt);
  let s = stats(times); results.push(['NFR 2', 'Search and filter results', '≤ 3 s', s, s.max <= 3]);

  times = [];
  for (let i = 0; i < 3; i++) { const r = await admin.req('GET', '/api/scholars/export?format=xlsx'); if (r.status !== 200) throw new Error('export failed'); times.push(r.dt); }
  s = stats(times); results.push(['NFR 1', `Report: full scholar list to Excel (${SCHOLARS} rows)`, '≤ 5 s', s, s.max <= 5]);
  const code = (await admin.req('GET', '/api/scholars?per_page=5')).body.scholars[0].code;
  times = [];
  for (let i = 0; i < 5; i++) { const r = await admin.req('GET', `/api/scholars/${code}/record.pdf`); if (!r.buf.subarray(0, 4).equals(Buffer.from('%PDF'))) throw new Error('pdf failed'); times.push(r.dt); }
  s = stats(times); results.push(['NFR 1', 'Report: one-page scholar record PDF', '≤ 5 s', s, s.max <= 5]);

  times = [];
  const letters = (n) => [0, 1, 2].map((i) => String.fromCharCode(97 + Math.floor(n / 26 ** i) % 26)).join('');
  for (let run = 0; run < 3; run++) {
    let csv = 'Sex,Date of Birth,Mobile Number,Scholarship Program,Scholarship Cycle,Municipality,Secondary School,Enrollment Date,HEI,Degree Program,Year Level\n';
    for (let i = 0; i < 100; i++) csv += `Female,2006-05-05,0917 123 4567,RA 7687,2025-2026,Lupon,Lupon National High School,2025-08-11,DOSCST — Main Campus,BS Biology,1st Year\n`;
    const fd = new FormData(); fd.append('file', new Blob([csv], { type: 'text/csv' }), 'nfr.csv');
    const t1 = performance.now();
    const prev = await admin.req('POST', '/api/scholars/import/preview', { form: fd });
    if (prev.status !== 200 || prev.body.valid_rows !== 100) throw new Error(`import preview: ${JSON.stringify(prev.body).slice(0, 300)}`);
    const com = await admin.req('POST', `/api/scholars/import/${prev.body.batch_id}/commit`, { json: {} });
    if (com.body.created !== 100) throw new Error('import commit failed');
    times.push((performance.now() - t1) / 1000);
  }
  s = stats(times); results.push(['NFR 3', 'Import 100 scholar records (validate + save)', '≤ 10 s', s, s.max <= 10]);

  console.log(`Running ${USERS} simultaneous users x ${ROUNDS} sessions ...`);
  const loginTimes = []; const reqTimes = []; const errors = [];
  t0 = performance.now();
  await Promise.all(Array.from({ length: USERS }, async (_, i) => {
    try {
      const b = new Browser(base);
      loginTimes.push(await b.login(`officer${i}`));
      for (let k2 = 0; k2 < ROUNDS; k2++) {
        for (const p of ['/api/dashboard', '/api/notifications', '/api/scholars?per_page=25', `/api/scholars?q=${terms[k2 % terms.length]}&per_page=25`, '/api/geomap', `/api/scholars/${code}`]) {
          const r = await b.req('GET', p); reqTimes.push(r.dt); if (r.status !== 200) errors.push(`${p} ${r.status}`);
        }
      }
    } catch (e) { errors.push(String(e.message)); }
  }));
  const wall = (performance.now() - t0) / 1000;
  results.push(['Scope', `${USERS} users signing in at once`, 'all succeed', stats(loginTimes), loginTimes.length === USERS]);
  s = stats(reqTimes);
  results.push(['Scope', `${USERS} users working at once (${reqTimes.length} requests, ${errors.length} errors)`, '0 errors, ≤ 3 s', s, !errors.length && s.p95 <= 3]);

  const dbName = config.DATABASE_URL.startsWith('mysql') ? 'MySQL/MariaDB' : 'SQLite (test file)';
  const lines = ['# DOST-IskoLens: NFR performance measurements (v4, Node.js)', '',
    `Measured ${new Date().toISOString().slice(0, 10)} with \`tools/measure-nfr.js\`. Dataset: ${SCHOLARS} fictional scholars (with GWA and stipend records), ${USERS} officer accounts. Database: ${dbName}. Server: Node.js ${process.version} (Express).`,
    `Computer: ${os.type()} ${os.release()}, ${os.cpus().length} CPU threads.`, '',
    '| NFR | What was measured | Target | Median | 95th percentile | Slowest | Samples | Result |', '|---|---|---|---|---|---|---|---|',
    ...results.map(([nfr, what, target, x, ok]) => `| ${nfr} | ${what} | ${target} | ${x.median.toFixed(3)} s | ${x.p95.toFixed(3)} s | ${x.max.toFixed(3)} s | ${x.n} | ${ok ? 'Pass' : 'FAIL'} |`),
    '', `The ${USERS}-user test took ${wall.toFixed(1)} s in total.`, '', 'Notes:',
    '- KPI report generation (NFR 1) cannot be measured until the KPI reports are built; the Excel export and the PDF record stand in for it.',
    '- Sign-in deliberately takes a fraction of a second because passwords are checked with bcrypt.',
    '- Times include the full HTTP round trip on the same computer. Re-run on the actual server for the final manuscript.'];
  fs.writeFileSync(path.join(__dirname, 'nfr-results.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  if (errors.length) console.log('First errors:', errors.slice(0, 5));
  server.close(); await db.reset();
})().catch(async (e) => { console.error(e); await db.reset(); process.exit(1); });
