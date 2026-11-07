'use strict';
/*
 * Command-line tools (run inside the server folder):
 *   npm run cli -- init-db                     create tables and the lookup lists
 *   npm run cli -- create-admin                first Administrator (asks for details)
 *   npm run cli -- seed-demo --count 60        fictional scholars for testing (never on real data)
 *   npm run cli -- load-lookups schools file.csv   official lists (CSV: name,municipality | name)
 *   npm run cli -- backup [--kind manual]      encrypted backup (schedule daily)
 *   npm run cli -- restore NAME --yes          replace all data with a backup (safety copy first)
 *   npm run cli -- send-digest                 weekly summary emails
 *   npm run cli -- verify-audit                check the audit log has not been altered
 *   npm run cli -- upgrade-db                  add new tables/columns after an update
 */
const fs = require('fs');
const readline = require('readline');
const db = require('./db');
const audit = require('./lib/audit');
const backups = require('./lib/backups');
const { createSchema, installAuditTriggers } = require('./schema');
const { seedLookups, seedDemo } = require('./lib/seed');
const { hashPassword, passwordProblems } = require('./lib/security');
const { now } = require('./lib/util');
const { sendAll } = require('./lib/digest');
const { LookupCache } = require('./lib/validators');

function opts(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) { o[key] = args[i + 1]; i++; } else o[key] = true;
    } else o._.push(args[i]);
  }
  return o;
}
function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const commands = {
  async 'init-db'() {
    const k = db();
    await createSchema();
    await seedLookups(k);
    if (db.isMySQL()) await installAuditTriggers();
    return 'Database ready. Next: npm run cli -- create-admin';
  },
  async 'upgrade-db'() {
    const added = await createSchema();
    return added.length ? `Added: ${added.join(', ')}` : 'Database already up to date.';
  },
  async 'create-admin'(o) {
    const k = db();
    const email = (o.email || await ask('Email: ')).toLowerCase();
    const first = o['first-name'] || await ask('First name: ');
    const last = o['last-name'] || await ask('Last name: ');
    const username = o.username || await ask('Username: ');
    let password = o.password;
    if (!password) {
      password = await ask('Password: ', true);
      if (password !== await ask('Repeat password: ', true)) throw new Error('Passwords do not match.');
    }
    const problems = passwordProblems(password);
    if (problems.length) throw new Error(`Password must have ${problems.join(', ')}.`);
    if (await k('users').where({ email }).orWhere({ username }).first()) throw new Error('A user with that email or username already exists.');
    const t = now();
    let msg;
    await k.transaction(async (trx) => {
      const [id] = await trx('users').insert({ first_name: first.trim(), last_name: last.trim(), email, username: username.trim(), password_hash: await hashPassword(password),
        role: 'admin', status: 'active', approved_at: t, password_changed_at: t, created_at: t, updated_at: t, office: 'DOST Davao Oriental',
        failed_login_attempts: 0, is_locked: false, pref_font_size: 'medium', pref_theme: 'light', pref_export_format: 'pdf', pref_email_high_risk: true, pref_weekly_digest: false });
      await audit.log(trx, null, 'system', 'Administrator created from command line', { targetType: 'user', targetId: id, targetLabel: username, actor: null });
      msg = `Administrator ${username} created.`;
    });
    return msg;
  },
  async 'seed-demo'(o) {
    const k = db();
    const actor = await k('users').where({ role: 'admin', status: 'active' }).first();
    if (!actor) throw new Error('Create an Administrator first.');
    const { createScholar } = require('./routes/scholars');
    let made;
    await k.transaction(async (trx) => {
      made = await seedDemo(trx, Number(o.count || 60), createScholar, actor);
      await audit.log(trx, null, 'system', 'Fictional demo scholars added', { targetType: 'scholar', targetLabel: `${made} records`, actor: null });
    });
    return `Added ${made} fictional scholars.`;
  },
  async 'load-lookups'(o) {
    const [kind, file] = o._;
    if (!['schools', 'heis'].includes(kind) || !file || !fs.existsSync(file)) throw new Error('Usage: load-lookups schools|heis file.csv');
    const { parse } = require('csv-parse/sync');
    const rows = parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''), { columns: true, skip_empty_lines: true });
    const k = db(); const lookups = await LookupCache.load(k); let added = 0;
    for (const r of rows) {
      const name = String(r.name || '').trim();
      if (!name) continue;
      if (kind === 'heis') { if (!(await k('heis').where({ name }).first())) { await k('heis').insert({ name, is_active: true }); added++; } continue; }
      const m = lookups.municipality(r.municipality);
      if (!m) { console.log(`Skipped ${name}: unknown municipality '${r.municipality}'`); continue; }
      if (!(await k('secondary_schools').where({ name, municipality_id: m.id }).first())) { await k('secondary_schools').insert({ name, municipality_id: m.id, is_active: true }); added++; }
    }
    return `Added ${added} ${kind}.`;
  },
  async backup(o) {
    const kind = o.kind === 'manual' ? 'manual' : 'scheduled';
    const m = await backups.createBackup(kind, null);
    await db().transaction((trx) => audit.log(trx, null, 'system', kind === 'scheduled' ? 'Scheduled backup created' : 'Manual backup created',
      { targetType: 'backup', targetLabel: m.name, actor: null, details: { scholars: m.scholars, bytes: m.size_bytes } }));
    return `Backup written: ${m.name}.iskb (${m.size_bytes.toLocaleString()} bytes, ${m.scholars} scholars)`;
  },
  async restore(o) {
    const name = String(o._[0] || '').replace(/\.iskb$/, '');
    backups.verify(name);
    if (!o.yes && (await ask(`Replace ALL current data with ${name}? A safety backup is made first. Type yes: `)) !== 'yes') return 'Cancelled.';
    const safety = await backups.createBackup('pre-restore', null, `Automatic safety copy before restoring ${name}`);
    await backups.restore(name);
    await db().transaction((trx) => audit.log(trx, null, 'system', 'Data restored from backup (command line)', { targetType: 'backup', targetLabel: name, actor: null, details: { safety_backup: safety.name } }));
    return `Restored ${name}. Safety copy of the previous data: ${safety.name}`;
  },
  async 'send-digest'() {
    const n = await sendAll(db());
    await db().transaction((trx) => audit.log(trx, null, 'system', 'Weekly digest sent', { targetType: 'user', targetLabel: `${n} recipient(s)`, actor: null }));
    return `Weekly digest sent to ${n} user(s).`;
  },
  async 'verify-audit'() {
    const r = await audit.verifyChain(db());
    if (!r.ok) throw new Error(`Audit log BROKEN at entry #${r.badId} (checked ${r.checked}).`);
    return `Audit log intact: ${r.checked} entries verified.`;
  },
  async 'install-audit-triggers'() {
    if (!db.isMySQL()) throw new Error('Triggers are only installed on MySQL.');
    await installAuditTriggers();
    return 'Audit log triggers installed.';
  },
};

async function run(argv) {
  const [name, ...rest] = argv;
  if (!commands[name]) throw new Error(`Unknown command. Available: ${Object.keys(commands).join(', ')}`);
  return commands[name](opts(rest));
}
module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2))
    .then((msg) => { if (msg) console.log(msg); return db.reset(); })
    .catch(async (err) => { console.error(`Error: ${err.message}`); await db.reset(); process.exit(1); });
}
