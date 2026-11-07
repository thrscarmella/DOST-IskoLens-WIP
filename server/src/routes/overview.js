'use strict';
/* Dashboard (role-based), notifications, audit logs and GeoMap data. */
const express = require('express');
const audit = require('../lib/audit');
const { route } = require('../lib/http');
const { ApiError, now, today, cleanText, iso, bool, parseDT } = require('../lib/util');
const S = require('../lib/security');
const D = require('../lib/data');
const { NOT_GOOD } = require('../lib/standing');
const { toCsv } = require('../lib/files');

const router = express.Router();
const n = async (q) => Number((await q.count({ n: '*' }).first()).n);
const live = (k) => k('scholars').whereIn('is_deactivated', [0, false]);

async function municipalitySummary(k) {
  const munis = await k('municipalities').orderBy('name');
  const rows = await live(k).select('municipality_id', 'program_id', 'status', 'academic_standing');
  const programs = Object.fromEntries((await k('scholarship_programs')).map((p) => [p.id, p.name]));
  // Applicant data (from the DOST dataset): acceptance rate and outreach priority per municipality
  const apps = await k('school_applicants');
  const appsBy = {};
  apps.forEach((a) => { (appsBy[a.municipality_id] = appsBy[a.municipality_id] || []).push(a); });
  const latestYear = apps.length ? Math.max(...apps.map((a) => a.start_year)) : null;
  const summary = munis.map((m) => {
    const mine = rows.filter((r) => r.municipality_id === m.id);
    const byProgram = {};
    mine.filter((r) => ['active', 'pending_termination'].includes(r.status)).forEach((r) => {
      const name = programs[r.program_id] || 'Other'; byProgram[name] = (byProgram[name] || 0) + 1;
    });
    return {
      id: m.id, name: m.name, psgc: m.psgc_code, is_capital: bool(m.is_capital), total: mine.length,
      active: mine.filter((r) => r.status === 'active').length, graduated: mine.filter((r) => r.status === 'graduated').length,
      terminated: mine.filter((r) => r.status === 'terminated').length, pending_review: mine.filter((r) => r.status === 'pending_termination').length,
      below_requirement: mine.filter((r) => r.status === 'active' && NOT_GOOD.includes(r.academic_standing)).length, active_by_program: byProgram,
    };
  });
  if (!apps.length) return summary.map((m) => ({ ...m, applicant_data: false, acceptance_rate: null, priority: null }));
  // Priority score (0-100, higher = needs more outreach): low qualification rate, few active
  // scholars, and falling applications each add to the score. Weights are adjustable.
  const scored = summary.map((m) => {
    const a = appsBy[m.id] || [];
    const sum = (rowsX, key) => rowsX.reduce((x, r) => x + Number(r[key] || 0), 0);
    const latest = a.filter((r) => r.start_year === latestYear); const prev = a.filter((r) => r.start_year === latestYear - 1);
    const applicants = sum(latest, 'applicants'); const qualifiers = sum(latest, 'qualifiers'); const awardees = sum(latest, 'awardees');
    const growth = sum(prev, 'applicants') ? (applicants - sum(prev, 'applicants')) / sum(prev, 'applicants') : 0;
    return { ...m, applicant_data: a.length > 0, applicants, qualifiers, awardees, acceptance_rate: applicants ? Math.round((awardees * 1000) / applicants) / 10 : null,
      qualification_rate: applicants ? qualifiers / applicants : 0, applicant_growth: Math.round(growth * 1000) / 10 };
  });
  const maxQ = Math.max(...scored.map((r) => r.qualification_rate), 0.0001); const maxA = Math.max(...scored.map((r) => r.active), 1);
  return scored.map((r) => {
    const score = Math.round(100 * (0.45 * (1 - r.qualification_rate / maxQ) + 0.35 * (1 - r.active / maxA) + 0.2 * Math.min(Math.max(-r.applicant_growth / 100, 0), 1)));
    const { qualification_rate, ...rest } = r;
    return { ...rest, priority_score: score, priority: score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low', applicant_year: latestYear };
  });
}
async function belowRequirementScholars(k, limit = 6) {
  const base = () => D.scholarQuery(k).whereIn('s.is_deactivated', [0, false]).where('s.status', 'active').whereIn('s.academic_standing', NOT_GOOD);
  const total = await n(base().clearSelect());
  const rows = await base().orderByRaw("CASE WHEN s.academic_standing = 'Failed' THEN 0 ELSE 1 END").orderBy('s.updated_at', 'desc').limit(limit);
  return [total, rows.map(D.scholarRow)];
}
async function recentActivity(k, userId = null, limit = 8) {
  let q = k('audit_logs').whereIn('category', ['edit', 'security', 'report']).whereNotIn('action', ['Signed in', 'Signed out']);
  if (userId) q = q.where({ user_id: userId });
  return (await q.orderBy('id', 'desc').limit(limit)).map(D.auditEntry);
}
async function adminActionItems(k) {
  const items = [];
  for (const u of await k('users').where({ status: 'pending' }).orderBy('created_at')) {
    items.push({ type: 'account', urgency: 'amber', link: 'user-management.html?tab=pending', title: `New officer account request: ${D.fullName(u)}`, sub: `Submitted ${String(u.created_at).slice(0, 10)}` });
  }
  for (const u of await k('users').whereIn('is_locked', [1, true])) {
    items.push({ type: 'locked', urgency: 'red', link: 'user-management.html?tab=locked', title: `Locked account: ${D.fullName(u)}`, sub: 'Locked after repeated failed sign-ins. Unlock if this was the owner.' });
  }
  for (const t of await k('termination_requests').where({ status: 'pending' }).orderBy('requested_at')) {
    const s = await k('scholars').where({ id: t.scholar_id }).first();
    const names = await D.userNames(k, [t.requested_by_id]);
    items.push({ type: 'termination', urgency: 'red', link: `scholar-profile.html?id=${s.scholar_code}`, title: `Termination recommendation: ${D.scholarLabel(s)}`, sub: `By ${names[t.requested_by_id]} · ${t.grounds}` });
  }
  const inconsistent = await n(k('stipend_disbursements as st').join('scholars as s', 's.id', 'st.scholar_id').where('st.status', 'Inconsistent').whereIn('s.is_deactivated', [0, false]));
  if (inconsistent) items.push({ type: 'stipend', urgency: 'amber', link: 'scholar-records.html', title: `${inconsistent} stipend record(s) flagged as inconsistent`, sub: 'Needs correction before the records are final.' });
  return items;
}
async function officerTasks(k, user) {
  const tasks = [];
  for (const t of await k('termination_requests').where({ status: 'returned', requested_by_id: user.id }).orderBy('reviewed_at', 'desc').limit(10)) {
    const s = await k('scholars').where({ id: t.scholar_id }).first();
    const newer = await k('termination_requests').where({ scholar_id: t.scholar_id }).where('requested_at', '>', t.requested_at).first();
    if (s.status === 'active' && !newer) tasks.push({ urgency: 'amber', link: `scholar-profile.html?id=${s.scholar_code}`, title: `Termination request returned: ${D.scholarLabel(s)}`, sub: (t.review_remarks || '').slice(0, 120) });
  }
  for (const s of await D.scholarQuery(k).whereIn('s.is_deactivated', [0, false]).where('s.status', 'active').where('s.academic_standing', 'Failed').limit(10)) {
    tasks.push({ urgency: 'red', link: `scholar-profile.html?id=${s.scholar_code}`, title: `Follow up: ${D.scholarLabel(s)} has a failing GWA`, sub: `${s.hei_name} · ${s.year_level} year` });
  }
  const noRecord = await n(live(k).where({ status: 'active' }).whereNull('academic_standing'));
  if (noRecord) tasks.push({ urgency: 'gray', link: 'scholar-records.html?status=active&standing=none', title: `${noRecord} active scholar(s) have no academic record yet`, sub: 'Encode their latest GWA from the academic report form.' });
  return tasks;
}
async function encodedSince(k, userId, since) {
  return (await n(k('scholars').where({ created_by_id: userId }).where('created_at', '>=', since)))
    + (await n(k('academic_records').where({ encoded_by_id: userId }).where('created_at', '>=', since)))
    + (await n(k('stipend_disbursements').where({ encoded_by_id: userId }).where('created_at', '>=', since)));
}

router.get('/dashboard', route(async (req, res, k) => {
  S.requireLogin(req);
  const user = req.user;
  const weekAgo = now(-7 * 86400000);
  const munis = await municipalitySummary(k);
  const [belowCount, belowList] = await belowRequirementScholars(k);
  const common = {
    municipalities: munis,
    totals: {
      scholars: await n(live(k)), active: await n(live(k).where({ status: 'active' })), graduated: await n(live(k).where({ status: 'graduated' })),
      terminated: await n(live(k).where({ status: 'terminated' })), below_requirement: belowCount, municipalities_with_scholars: munis.filter((m) => m.total).length,
    },
    below_requirement: belowList,
  };
  if (user.role === 'admin') {
    const staff = await k('users').where({ status: 'active' }).orderBy([{ column: 'role' }, { column: 'last_name' }]);
    const activity = [];
    for (const o of staff) {
      const last = await k('user_sessions').where({ user_id: o.id }).max({ m: 'last_seen_at' }).first();
      activity.push({ id: o.id, name: D.fullName(o), role_label: D.roleLabel(o), is_me: o.id === user.id, encoded_this_week: await encodedSince(k, o.id, weekAgo),
        pending_review: await n(k('termination_requests').where({ requested_by_id: o.id, status: 'pending' })), last_active_at: iso(last && last.m) });
    }
    return { ok: true, role: 'admin', ...common,
      users: { admins: await n(k('users').where({ role: 'admin', status: 'active' })), officers: await n(k('users').where({ role: 'officer', status: 'active' })) },
      added_this_week: await n(live(k).where('created_at', '>=', weekAgo)), action_items: await adminActionItems(k), officer_activity: activity, recent_activity: await recentActivity(k) };
  }
  return { ok: true, role: 'officer', ...common, tasks: await officerTasks(k, user), encoded_this_week: await encodedSince(k, user.id, weekAgo), recent_activity: await recentActivity(k, user.id, 5) };
}, { tx: false }));

/* ---------------- notifications ---------------- */
router.get('/notifications', route(async (req, res, k) => {
  S.requireLogin(req);
  const unread = await n(k('notifications').where({ user_id: req.user.id }).whereIn('is_read', [0, false]));
  const rows = await k('notifications').where({ user_id: req.user.id }).orderBy([{ column: 'is_read' }, { column: 'id', order: 'desc' }]).limit(30);
  return { ok: true, unread, notifications: rows.map((x) => ({ id: x.id, kind: x.kind, title: x.title, body: x.body, link: x.link, urgency: x.urgency, is_read: bool(x.is_read), created_at: iso(x.created_at) })) };
}, { tx: false }));
router.post('/notifications/read-all', route(async (req, res, trx) => {
  S.requireLogin(req);
  await trx('notifications').where({ user_id: req.user.id }).whereIn('is_read', [0, false]).update({ is_read: true });
  return { ok: true };
}));
router.post('/notifications/:id/read', route(async (req, res, trx) => {
  S.requireLogin(req);
  const row = await trx('notifications').where({ id: Number(req.params.id), user_id: req.user.id }).first();
  if (!row) throw new ApiError('Notification not found.', 404);
  await trx('notifications').where({ id: row.id }).update({ is_read: true });
  return { ok: true };
}));

/* ---------------- audit log ---------------- */
function auditQuery(k, req) {
  const q = k('audit_logs');
  if (audit.CATEGORIES.includes(req.query.category)) q.where({ category: req.query.category });
  const text = cleanText(req.query.q, 80).toLowerCase();
  if (text) {
    const like = `%${text}%`;
    q.where((w) => w.whereRaw('LOWER(username) LIKE ?', [like]).orWhereRaw('LOWER(action) LIKE ?', [like])
      .orWhereRaw('LOWER(target_label) LIKE ?', [like]).orWhereRaw('LOWER(target_id) LIKE ?', [like]));
  }
  const day = req.query.date;
  if (day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ApiError('Date must be YYYY-MM-DD.', 422);
    // Philippine time (UTC+8) day -> UTC range
    const start = new Date(`${day}T00:00:00Z`).getTime() - 8 * 3600000;
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    q.where('created_at', '>=', fmt(start)).where('created_at', '<', fmt(start + 86400000));
  }
  return q;
}
router.get('/audit-logs', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 50, 10), 200);
  const total = await n(auditQuery(k, req));
  const rows = await auditQuery(k, req).orderBy('id', 'desc').offset((page - 1) * perPage).limit(perPage);
  const deactivated = new Set((await k('scholars').whereIn('is_deactivated', [1, true]).select('scholar_code')).map((s) => s.scholar_code));
  const entries = rows.map((e) => ({ ...D.auditEntry(e), can_restore: e.action === 'Scholar record deactivated' && deactivated.has(e.target_id) }));
  return { ok: true, entries, total, page, per_page: perPage, pages: Math.max(Math.ceil(total / perPage), 1) };
}, { tx: false }));
router.get('/audit-logs/export', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const rows = await auditQuery(trx, req).orderBy('id', 'asc');
  await audit.log(trx, req, 'report', 'Exported audit log', { targetType: 'audit_log', targetLabel: `${rows.length} entries` });
  const csv = toCsv([['ID', 'Time (UTC)', 'User', 'Category', 'Action', 'Target Type', 'Target ID', 'Target', 'Details', 'IP Address', 'Entry Hash'],
    ...rows.map((e) => [e.id, String(e.created_at).slice(0, 19), e.username, e.category, e.action, e.target_type || '', e.target_id || '', e.target_label || '', e.details_json || '', e.ip_address || '', e.entry_hash])]);
  return (r) => r.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="iskolens-audit-log-${today()}.csv"`).send(csv);
}));
router.get('/audit-logs/verify', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const r = await audit.verifyChain(k);
  return { ok: true, intact: r.ok, checked: r.checked, first_broken_entry: r.badId };
}, { tx: false }));

/* ---------------- GeoMap ---------------- */
router.get('/geomap', route(async (req, res, k) => {
  S.requireLogin(req);
  const munis = await municipalitySummary(k);
  const totals = Object.fromEntries(['total', 'active', 'graduated', 'terminated', 'pending_review', 'below_requirement'].map((key) => [key, munis.reduce((a, m) => a + m[key], 0)]));
  return { ok: true, municipalities: munis, totals };
}, { tx: false }));

module.exports = { router, municipalitySummary };
