'use strict';
/* Loaders and serializers: the JSON shapes are identical to v3, so the front end is unchanged. */
const { iso, bool } = require('./util');
const { NOT_GOOD, consecutiveBelowRequirement } = require('./standing');

const STATUS_LABELS = { active: 'Active', pending_termination: 'Pending Termination Review', graduated: 'Graduated', terminated: 'Terminated' };
const SEMESTERS = { '1st Semester': 1, '2nd Semester': 2, Summer: 3 };
const STIPEND_STATUSES = ['Released', 'Pending', 'Inconsistent'];
const GRADUATION_STATUSES = ['On Track', 'At Risk of Delay', 'Delayed', 'Graduated'];
const DOCUMENT_TYPES = ['Grade report', 'Certificate of Registration', 'Termination evidence', 'Appeal or reinstatement document', 'Other'];
const TERMINATION_GROUNDS = [
  'Academic failure — below minimum GWA for 2nd consecutive semester',
  'Failure to enroll on time',
  'Change of course/school without DOST approval',
  'Failure to submit required reports or documents within deadline',
  'Falsification of documents or misrepresentation',
  'Voluntary withdrawal',
  'Conviction of a crime involving moral turpitude',
  'Other (specify in notes)',
];

const fullName = (u) => (u ? `${u.first_name} ${u.last_name}`.trim() : null);
const initials = (u) => ((u.first_name || '').slice(0, 1) + (u.last_name || '').slice(0, 1)).toUpperCase();
const roleLabel = (u) => (u.role === 'admin' ? 'Administrator' : 'Scholarship Officer');
/* Scholars are identified only by their Scholar ID (no names are collected or shown). */
const scholarLabel = (s) => s.scholar_code;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function userPublic(u, admin = false) {
  const data = {
    id: u.id, first_name: u.first_name, last_name: u.last_name, name: fullName(u), initials: initials(u),
    email: u.email, username: u.username, role: u.role, role_label: roleLabel(u), status: u.status,
    contact_number: u.contact_number, office: u.office, created_at: iso(u.created_at), last_login_at: iso(u.last_login_at),
  };
  if (admin) Object.assign(data, {
    is_locked: bool(u.is_locked), locked_at: iso(u.locked_at), failed_login_attempts: Number(u.failed_login_attempts || 0),
    has_password: !!u.password_hash, approved_at: iso(u.approved_at), two_factor_enabled: bool(u.totp_enabled),
  });
  return data;
}
function userPreferences(u) {
  return {
    font_size: u.pref_font_size, theme: u.pref_theme || 'light',
    default_municipality_id: u.pref_default_municipality_id ?? null, export_format: u.pref_export_format,
    email_high_risk: bool(u.pref_email_high_risk), weekly_digest: bool(u.pref_weekly_digest),
  };
}

/* scholars joined with the names of their lookups */
function scholarQuery(k) {
  return k('scholars as s')
    .leftJoin('municipalities as m', 'm.id', 's.municipality_id')
    .leftJoin('secondary_schools as ss', 'ss.id', 's.secondary_school_id')
    .leftJoin('heis as h', 'h.id', 's.hei_id')
    .leftJoin('scholarship_cycles as c', 'c.id', 's.cycle_id')
    .leftJoin('scholarship_programs as p', 'p.id', 's.program_id')
    .select('s.*', 'm.name as municipality_name', 'ss.name as school_name', 'h.name as hei_name',
      'c.label as cycle_label', 'p.name as program_name');
}
function scholarRow(s) {
  return {
    id: s.id, code: s.scholar_code, municipality: s.municipality_name ?? null, secondary_school: s.school_name ?? null,
    hei: s.hei_name ?? null, cycle: s.cycle_label ?? null, program: s.program_name ?? null, year_level: s.year_level,
    status: s.status, status_label: STATUS_LABELS[s.status] || s.status, academic_standing: s.academic_standing,
    is_deactivated: bool(s.is_deactivated), is_anonymized: bool(s.is_anonymized),
  };
}
const academicRecord = (r) => ({
  id: r.id, academic_year: r.academic_year, semester: r.semester, gwa: Number(r.gwa), gwa_scale: r.gwa_scale,
  year_level_at_record: r.year_level_at_record, standing: r.standing, date_recorded: iso(r.date_recorded), semester_order: r.semester_order,
});
const stipend = (r) => ({
  id: r.id, period: r.period, amount: Number(r.amount), status: r.status, date_released: iso(r.date_released),
  remarks: r.remarks, created_at: iso(r.created_at),
});
const graduation = (g) => (g ? {
  expected_graduation: g.expected_graduation ? String(g.expected_graduation).slice(0, 7) : null,
  actual_graduation: iso(g.actual_graduation), status: g.status, delay_reason: g.delay_reason, updated_at: iso(g.updated_at),
} : null);

async function userNames(k, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return {};
  const rows = await k('users').whereIn('id', list).select('id', 'first_name', 'last_name');
  return Object.fromEntries(rows.map((u) => [u.id, fullName(u)]));
}
async function terminationRequest(k, t) {
  if (!t) return null;
  const names = await userNames(k, [t.requested_by_id, t.reviewed_by_id, t.reversed_by_id]);
  return {
    id: t.id, grounds: t.grounds, notes: t.notes, proposed_effective_date: iso(t.proposed_effective_date), status: t.status,
    requested_by: names[t.requested_by_id] ?? null, requested_by_id: t.requested_by_id, requested_at: iso(t.requested_at),
    reviewed_by: names[t.reviewed_by_id] ?? null, reviewed_at: iso(t.reviewed_at), review_remarks: t.review_remarks,
    withdrawn_at: iso(t.withdrawn_at), withdrawal_reason: t.withdrawal_reason,
    reversed_by: names[t.reversed_by_id] ?? null, reversed_at: iso(t.reversed_at), reversal_remarks: t.reversal_remarks,
  };
}
function auditEntry(e) {
  let details = null;
  if (e.details_json) { try { details = JSON.parse(e.details_json); } catch { details = e.details_json; } }
  return {
    id: e.id, created_at: iso(e.created_at), username: e.username, category: e.category, action: e.action,
    target_type: e.target_type, target_id: e.target_id, target_label: e.target_label, details, ip_address: e.ip_address,
  };
}

const academicRecordsOf = (k, scholarId) => k('academic_records').where({ scholar_id: scholarId }).orderBy([{ column: 'academic_year' }, { column: 'semester_order' }]);
const stipendsOf = (k, scholarId) => k('stipend_disbursements').where({ scholar_id: scholarId }).orderBy('id');

function completion(s, records, grad) {
  const items = [
    ['Basic info', !!(s.gender && s.birth_date)],
    ['Academic background', !!(s.hei_id && s.degree_program && s.year_level && s.secondary_school_id)],
    ['Scholarship details', !!(s.program_id && s.cycle_id && s.enrollment_date)],
    ['Mobile number on file', !!s.mobile_number],
    ['Email on file', !!s.email],
    ['Academic record on file', records.length > 0],
    ['Expected graduation set', !!(grad && grad.expected_graduation)],
  ];
  const done = items.filter(([, ok]) => ok).length;
  return { percent: Math.round((done * 100) / items.length), items: items.map(([label, d]) => ({ label, done: d })) };
}

async function loadScholar(k, where) {
  return scholarQuery(k).where(where).first();
}
async function scholarDetail(k, sid) {
  const s = await loadScholar(k, { 's.id': sid });
  const records = await academicRecordsOf(k, s.id);
  const stipends = await stipendsOf(k, s.id);
  const grad = await k('graduation_records').where({ scholar_id: s.id }).first();
  const latest = records.length ? records[records.length - 1] : null;
  const tr = (status, order) => k('termination_requests').where({ scholar_id: s.id, status }).orderBy(order || 'id', 'desc').first();
  const pending = await tr('pending'); const approved = await tr('approved', 'reviewed_at');
  const returned = await tr('returned', 'reviewed_at'); const reversed = await tr('reversed', 'reversed_at');
  const stamps = [s.updated_at, ...records.map((r) => r.created_at), ...stipends.map((x) => x.updated_at), grad && grad.updated_at]
    .filter(Boolean).map(String).sort();
  const createdBy = s.created_by_id ? (await userNames(k, [s.created_by_id]))[s.created_by_id] : null;
  const docs = await k('scholar_documents').where({ scholar_id: s.id }).whereIn('is_deleted', [0, false]).count({ n: '*' }).first();
  const riskInfo = await require('./risk').forOne(k, s);
  return {
    ...scholarRow(s),
    gender: s.gender, birth_date: iso(s.birth_date), mobile_number: s.mobile_number, email: s.email,
    program_id: s.program_id, cycle_id: s.cycle_id, municipality_id: s.municipality_id, secondary_school_id: s.secondary_school_id,
    hei_id: s.hei_id, enrollment_date: iso(s.enrollment_date), degree_program: s.degree_program,
    administering_office: 'DOST Davao Oriental', created_at: iso(s.created_at), created_by: createdBy ?? null,
    last_updated_at: iso(stamps[stamps.length - 1]),
    current_gwa: latest ? Number(latest.gwa) : null, current_gwa_scale: latest ? latest.gwa_scale : null,
    stipends_released: stipends.filter((x) => x.status === 'Released').length,
    academic_records: records.map(academicRecord), stipends: stipends.map(stipend), graduation: graduation(grad),
    termination: {
      pending: await terminationRequest(k, pending), approved: await terminationRequest(k, approved),
      returned: await terminationRequest(k, returned), reversed: await terminationRequest(k, reversed),
    },
    below_requirement_two_semesters: consecutiveBelowRequirement(records),
    risk: riskInfo,
    // Eligible when the latest GWA is below the requirement, or the trained model rates the scholar High risk.
    eligible_for_termination_recommendation: s.status === 'active' && !bool(s.is_deactivated)
      && ((!!latest && NOT_GOOD.includes(latest.standing)) || (riskInfo.source === 'model' && riskInfo.level === 'High')),
    completion: completion(s, records, grad),
    is_anonymized: bool(s.is_anonymized), anonymized_at: iso(s.anonymized_at), documents: Number(docs.n),
  };
}

module.exports = {
  STATUS_LABELS, SEMESTERS, STIPEND_STATUSES, GRADUATION_STATUSES, DOCUMENT_TYPES, TERMINATION_GROUNDS,
  fullName, scholarLabel, roleLabel, userPublic, userPreferences, scholarQuery, scholarRow, academicRecord, stipend,
  graduation, terminationRequest, auditEntry, academicRecordsOf, stipendsOf, loadScholar, scholarDetail, userNames, num,
};
