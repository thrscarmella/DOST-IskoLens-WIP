'use strict';
/* Scholar Records: list/search/export, manual encoding, profile sections
   (personal, academic, stipend, graduation) and the termination workflow. */
const express = require('express');
const audit = require('../lib/audit');
const { route, created } = require('../lib/http');
const { ApiError, now, today, cleanText, bool } = require('../lib/util');
const { requireLogin, requireRole } = require('../lib/security');
const { notify, notifyAdmins, notifyOfficers, emailAcademicAlert } = require('../lib/notifications');
const { NOT_GOOD, computeStanding, consecutiveBelowRequirement, detectScale } = require('../lib/standing');
const V = require('../lib/validators');
const D = require('../lib/data');
const { toCsv, toXlsx } = require('../lib/files');
const db = require('../db');
const risk = require('../lib/risk');

const router = express.Router();
const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

async function getScholar(trx, req, code, allowDeactivated = false) {
  const s = await D.loadScholar(trx, { 's.scholar_code': code });
  if (!s || (bool(s.is_deactivated) && !(allowDeactivated || req.user.role === 'admin'))) throw new ApiError('Scholar record not found.', 404);
  return s;
}
function requireNotTerminated(s, what) {
  if (bool(s.is_anonymized)) throw new ApiError('This record has been anonymized, so it can no longer be changed.', 409, null, 'locked');
  if (s.status === 'terminated') throw new ApiError(`This scholar is terminated, so ${what} is locked.`, 409, null, 'locked');
  if (bool(s.is_deactivated)) throw new ApiError('This record is deactivated. An Administrator must restore it first.', 409);
}
async function nextScholarCode(trx) {
  const prefix = `SCH-${new Date().getFullYear()}-`;
  const row = await trx('scholars').where('scholar_code', 'like', `${prefix}%`).max({ m: 'scholar_code' }).first();
  const seq = row && row.m ? Number(row.m.split('-').pop()) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}
/* Inserts a validated scholar (with an On Track graduation record) in the current transaction. */
async function createScholar(trx, values, user, importBatchId = null) {
  const t = now();
  const code = await nextScholarCode(trx);
  const [id] = await trx('scholars').insert({
    ...values, scholar_code: code, status: 'active', created_by_id: user.id, updated_by_id: user.id,
    import_batch_id: importBatchId, is_deactivated: false, is_anonymized: false, created_at: t, updated_at: t,
  });
  await trx('graduation_records').insert({ scholar_id: id, status: 'On Track', updated_by_id: user.id, updated_at: t });
  return { id, scholar_code: code, ...values };
}
async function refreshStanding(trx, scholarId, userId = null) {
  const recs = await D.academicRecordsOf(trx, scholarId);
  const upd = { academic_standing: recs.length ? recs[recs.length - 1].standing : null, updated_at: now() };
  if (userId) upd.updated_by_id = userId;
  await trx('scholars').where({ id: scholarId }).update(upd);
  return recs;
}

/* ---------------- list, stats, export ---------------- */
function filtered(trx, req) {
  const q = D.scholarQuery(trx);
  const showDeactivated = req.query.deactivated === '1' && req.user.role === 'admin';
  q.whereIn('s.is_deactivated', showDeactivated ? [1, true] : [0, false]);
  const { status, municipality_id: muni, standing } = req.query;
  if (Object.keys(D.STATUS_LABELS).includes(status)) q.where('s.status', status);
  if (muni && /^\d+$/.test(muni)) q.where('s.municipality_id', Number(muni));
  if (standing === 'below') q.whereIn('s.academic_standing', NOT_GOOD);
  else if (['Good Standing', 'Probation', 'Failed'].includes(standing)) q.where('s.academic_standing', standing);
  else if (standing === 'none') q.whereNull('s.academic_standing');
  const text = cleanText(req.query.q, 80).toLowerCase();
  if (text) {
    const like = `%${text}%`;
    q.where((w) => {
      w.whereRaw('LOWER(s.scholar_code) LIKE ?', [like])
        .orWhereRaw('LOWER(m.name) LIKE ?', [like]).orWhereRaw('LOWER(ss.name) LIKE ?', [like]).orWhereRaw('LOWER(h.name) LIKE ?', [like]);
    });
  }
  return q;
}
const count = async (q) => Number((await q.clone().clearSelect().clearOrder().count({ n: '*' }).first()).n);

router.get('/scholars', route(async (req, res, trx) => {
  requireLogin(req);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.per_page, 10) || 25, 5), 100);
  const q = filtered(trx, req);
  const total = await count(q);
  const rows = await q.clone().orderBy('s.scholar_code').offset((page - 1) * perPage).limit(perPage);
  // Tab counts use the same search and filters as the table (all statuses), so the numbers match what is listed.
  const tabReq = { ...req, query: { ...req.query, status: undefined } };
  const tabRows = await filtered(trx, tabReq).clearSelect().clearOrder().select('s.status').count({ n: '*' }).groupBy('s.status');
  const tabBy = Object.fromEntries(tabRows.map((r) => [r.status, Number(r.n)]));
  const tabCounts = { all: Object.values(tabBy).reduce((a, b) => a + b, 0), active: tabBy.active || 0,
    pending_termination: tabBy.pending_termination || 0, graduated: tabBy.graduated || 0, terminated: tabBy.terminated || 0 };
  const live = () => trx('scholars').whereIn('is_deactivated', [0, false]);
  const byStatus = Object.fromEntries((await live().select('status').count({ n: '*' }).groupBy('status')).map((r) => [r.status, Number(r.n)]));
  const n = async (qq) => Number((await qq.count({ n: '*' }).first()).n);
  const stats = {
    total: await n(live()), active: byStatus.active || 0, pending_termination: byStatus.pending_termination || 0,
    graduated: byStatus.graduated || 0, terminated: byStatus.terminated || 0,
    below_requirement: await n(live().where({ status: 'active' }).whereIn('academic_standing', NOT_GOOD)),
    deactivated: await n(trx('scholars').whereIn('is_deactivated', [1, true])),
  };
  const withRisk = await risk.attach(trx, rows);
  return { ok: true, scholars: withRisk.map((r) => ({ ...D.scholarRow(r), risk: r.risk })), total, page, per_page: perPage, pages: Math.max(Math.ceil(total / perPage), 1), stats, tab_counts: tabCounts };
}, { tx: false }));

const EXPORT_COLUMNS = ['Scholar ID', 'Sex', 'Date of Birth', 'Mobile Number', 'Email',
  'Program', 'Cycle', 'Municipality', 'Secondary School', 'Enrollment Date', 'HEI', 'Degree Program', 'Year Level', 'Status', 'Academic Standing'];
const exportRow = (s) => [s.scholar_code, s.gender, s.birth_date, s.mobile_number,
  s.email || '', s.program_name, s.cycle_label, s.municipality_name, s.school_name, s.enrollment_date, s.hei_name, s.degree_program,
  s.year_level, D.STATUS_LABELS[s.status] || s.status, s.academic_standing || ''];

router.get('/scholars/export', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const fmt = req.query.format || 'csv';
  const rows = await filtered(trx, req).orderBy('s.scholar_code');
  const filters = Object.fromEntries(Object.entries(req.query).filter(([k]) => k !== 'format'));
  await audit.log(trx, req, 'report', 'Exported scholar list', { targetType: 'scholar', targetLabel: `${rows.length} records`, details: { format: fmt, filters } });
  const stamp = today();
  if (fmt === 'xlsx') {
    const buf = await toXlsx('Scholars', EXPORT_COLUMNS, rows.map(exportRow));
    return (r) => r.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="iskolens-scholars-${stamp}.xlsx"`).send(buf);
  }
  const csv = toCsv([EXPORT_COLUMNS, ...rows.map(exportRow)]);
  return (r) => r.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="iskolens-scholars-${stamp}.csv"`).send(csv);
}));

/* ---------------- create ---------------- */
router.post('/scholars', route(async (req, res, trx) => {
  requireLogin(req);
  const d = V.requireJson(req);
  const [values, errors] = V.validateScholar(d, await V.LookupCache.load(trx));
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  const s = await createScholar(trx, values, req.user);
  await audit.log(trx, req, 'edit', 'Scholar record created', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s) });
  return created({ ok: true, scholar: D.scholarRow(await D.loadScholar(trx, { 's.id': s.id })) });
}));

/* ---------------- profile ---------------- */
router.get('/scholars/:code', route(async (req, res, trx) => {
  requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  // Viewing personal data is logged for Data Privacy Act accountability.
  await audit.log(trx, req, 'access', 'Viewed scholar profile', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s) });
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));

const EDITABLE = ['gender', 'birth_date', 'mobile_number', 'email', 'program', 'cycle',
  'municipality', 'secondary_school', 'enrollment_date', 'hei', 'degree_program', 'year_level'];

router.patch('/scholars/:code', route(async (req, res, trx) => {
  requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  if (bool(s.is_deactivated)) throw new ApiError('This record is deactivated. An Administrator must restore it first.', 409);
  if (bool(s.is_anonymized)) throw new ApiError('This record has been anonymized, so it can no longer be changed.', 409);
  const d = Object.fromEntries(Object.entries(V.requireJson(req)).filter(([k]) => EDITABLE.includes(k)));
  if (!Object.keys(d).length) throw new ApiError('Nothing to update.', 400);
  if ('secondary_school' in d && !('municipality' in d)) d.municipality = s.municipality_id;
  const keep = { program: s.program_id, cycle: s.cycle_id, school: s.secondary_school_id, hei: s.hei_id };
  const [values, errors] = V.validateScholar(d, await V.LookupCache.load(trx, keep), true);
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  if ('municipality_id' in values && !('secondary_school_id' in values)) {
    const school = await trx('secondary_schools').where({ id: s.secondary_school_id }).first();
    if (school && school.municipality_id !== values.municipality_id) {
      throw new ApiError('Choose a secondary school in the new municipality.', 422, { secondary_school: 'Select a secondary school in this municipality.' });
    }
  }
  if ('enrollment_date' in values && !('birth_date' in values) && values.enrollment_date <= s.birth_date) {
    throw new ApiError('Enrollment date must be after the date of birth.', 422, { enrollment_date: 'Enrollment date must be after the date of birth.' });
  }
  const changes = audit.changedFields(s, values);
  if (Object.keys(changes).length) {
    await trx('scholars').where({ id: s.id }).update({ ...values, updated_by_id: req.user.id, updated_at: now() });
    const after = { ...s, ...values };
    await audit.log(trx, req, 'edit', 'Scholar record updated', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s), details: changes });
  }
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));

router.post('/scholars/:code/deactivate', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const s = await getScholar(trx, req, req.params.code);
  if (bool(s.is_deactivated)) throw new ApiError('This record is already deactivated.', 409);
  await trx('scholars').where({ id: s.id }).update({ is_deactivated: true, deactivated_at: now(), deactivated_by_id: req.user.id, updated_at: now() });
  await audit.log(trx, req, 'edit', 'Scholar record deactivated', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s) });
  return { ok: true };
}));
router.post('/scholars/:code/restore', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const s = await getScholar(trx, req, req.params.code, true);
  if (!bool(s.is_deactivated)) throw new ApiError('This record is not deactivated.', 409);
  await trx('scholars').where({ id: s.id }).update({ is_deactivated: false, deactivated_at: null, deactivated_by_id: null, updated_at: now() });
  await audit.log(trx, req, 'edit', 'Scholar record restored', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s) });
  return { ok: true };
}));

/* ---------------- academic performance ---------------- */
function parseGwa(value, errors) {
  const g = Math.round(Number(value) * 100) / 100;
  const scale = value === null || value === undefined || value === '' || Number.isNaN(g) ? null : detectScale(g);
  if (!scale) { errors.gwa = 'Enter a GWA from 1.00 to 5.00 (or 50 to 100 for a percentage).'; return [null, null]; }
  return [g, scale];
}
router.post('/scholars/:code/academic-records', route(async (req, res, trx) => {
  requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  requireNotTerminated(s, 'academic performance');
  const d = V.requireJson(req);
  const errors = {};
  const ay = V.cycleLabel(d.academic_year);
  if (!ay) errors.academic_year = 'Select an academic year (e.g. 2024-2025).';
  const sem = d.semester;
  if (!(sem in D.SEMESTERS)) errors.semester = 'Select a semester.';
  const [gwa, scale] = parseGwa(d.gwa, errors);
  const recorded = V.parseDate(d.date_recorded) || today();
  if (recorded === 'invalid' || recorded > today()) errors.date_recorded = 'Date recorded must be a valid date, not in the future.';
  const yearLevel = V.parseYearLevel(d.year_level_at_record) || s.year_level;
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  if (await trx('academic_records').where({ scholar_id: s.id, academic_year: ay, semester: sem }).first()) {
    throw new ApiError(`A record for ${sem}, ${ay} already exists for this scholar.`, 409, { semester: 'This term already has a record.' });
  }
  const standing = computeStanding(gwa, yearLevel, scale);
  const [recId] = await trx('academic_records').insert({
    scholar_id: s.id, academic_year: ay, semester: sem, semester_order: D.SEMESTERS[sem], gwa, gwa_scale: scale,
    year_level_at_record: yearLevel, standing, date_recorded: recorded, encoded_by_id: req.user.id, created_at: now(),
  });
  const records = await refreshStanding(trx, s.id, req.user.id);
  await audit.log(trx, req, 'edit', 'Academic record added', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { term: `${sem} ${ay}`, gwa, scale, standing } });
  if (consecutiveBelowRequirement(records) && records[records.length - 1].id === recId) {
    const title = `${D.scholarLabel(s)} is below the GWA requirement for 2 consecutive semesters`;
    const link = `scholar-profile.html?id=${s.scholar_code}`;
    await notifyOfficers(trx, 'below_requirement', title, 'Review the case and consider a termination recommendation.', link, 'red');
    await notifyAdmins(trx, 'below_requirement', title, 'Officers have been notified.', link, 'amber');
    await emailAcademicAlert(trx, title, 'Review the case and consider a termination recommendation.', link);
  }
  const rec = await trx('academic_records').where({ id: recId }).first();
  return created({ ok: true, record: D.academicRecord(rec), scholar: await D.scholarDetail(trx, s.id) });
}));

async function getRecord(trx, s, id) {
  const rec = await trx('academic_records').where({ id: Number(id), scholar_id: s.id }).first();
  if (!rec) throw new ApiError('Academic record not found.', 404);
  return rec;
}
router.patch('/scholars/:code/academic-records/:id', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const s = await getScholar(trx, req, req.params.code);
  requireNotTerminated(s, 'academic performance');
  const rec = await getRecord(trx, s, req.params.id);
  const d = V.requireJson(req);
  const errors = {};
  const ay = V.cycleLabel(d.academic_year ?? rec.academic_year);
  if (!ay) errors.academic_year = 'Select an academic year (e.g. 2024-2025).';
  const sem = d.semester ?? rec.semester;
  if (!(sem in D.SEMESTERS)) errors.semester = 'Select a semester.';
  const [gwa, scale] = parseGwa(d.gwa ?? rec.gwa, errors);
  const yearLevel = V.parseYearLevel(d.year_level_at_record ?? rec.year_level_at_record);
  if (yearLevel === null) errors.year_level_at_record = 'Year level must be 1st to 5th year.';
  const recorded = d.date_recorded ? V.parseDate(d.date_recorded) : rec.date_recorded;
  if (recorded === 'invalid' || recorded > today()) errors.date_recorded = 'Date recorded must be a valid date, not in the future.';
  const reason = cleanText(d.reason, 255);
  if (reason.length < 5) errors.reason = 'Say briefly why the record is being corrected (e.g. typo in GWA).';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  const clash = await trx('academic_records').where({ scholar_id: s.id, academic_year: ay, semester: sem }).whereNot({ id: rec.id }).first();
  if (clash) throw new ApiError(`Another record already exists for ${sem}, ${ay}.`, 409, { semester: 'This term already has a record.' });
  const values = { academic_year: ay, semester: sem, semester_order: D.SEMESTERS[sem], gwa, gwa_scale: scale,
    year_level_at_record: yearLevel, standing: computeStanding(gwa, yearLevel, scale), date_recorded: recorded };
  const changes = audit.changedFields(rec, values);
  delete changes.semester_order;
  if (Object.keys(changes).length) {
    await trx('academic_records').where({ id: rec.id }).update(values);
    await refreshStanding(trx, s.id);
    await audit.log(trx, req, 'edit', 'Academic record corrected', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
      details: { record_id: rec.id, reason, ...changes } });
  }
  const after = await trx('academic_records').where({ id: rec.id }).first();
  return { ok: true, record: D.academicRecord(after), scholar: await D.scholarDetail(trx, s.id) };
}));
router.delete('/scholars/:code/academic-records/:id', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const s = await getScholar(trx, req, req.params.code);
  requireNotTerminated(s, 'academic performance');
  const rec = await getRecord(trx, s, req.params.id);
  const reason = cleanText(body(req).reason, 255);
  if (reason.length < 5) throw new ApiError('Say briefly why the record is being deleted.', 422, { reason: 'Say briefly why the record is being deleted (e.g. encoded twice).' });
  const snapshot = D.academicRecord(rec);
  await trx('academic_records').where({ id: rec.id }).delete();
  await refreshStanding(trx, s.id);
  await audit.log(trx, req, 'edit', 'Academic record deleted', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { reason, deleted_record: snapshot } });
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));

/* ---------------- stipends ---------------- */
function stipendValues(d) {
  const errors = {};
  const period = cleanText(d.period, 60);
  if (!period) errors.period = 'Disbursement period is required (e.g. 1st Semester 2024-2025).';
  let amount = Math.round(Number(d.amount) * 100) / 100;
  if (d.amount === null || d.amount === undefined || d.amount === '' || Number.isNaN(amount) || amount <= 0 || amount > 1000000) {
    errors.amount = 'Enter an amount greater than 0.'; amount = null;
  }
  const { status } = d;
  if (!D.STIPEND_STATUSES.includes(status)) errors.status = 'Select Released, Pending or Inconsistent.';
  const released = d.date_released ? V.parseDate(d.date_released) : null;
  if (released === 'invalid' || (released && released > today())) errors.date_released = 'Release date must be a valid date, not in the future.';
  if (status === 'Released' && !released && !errors.date_released) errors.date_released = 'Enter the release date for a Released stipend.';
  const remarks = cleanText(d.remarks, 255) || null;
  if (status === 'Inconsistent' && !remarks) errors.remarks = 'Describe the inconsistency so it can be corrected.';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  return { period, amount, status, date_released: released && released !== 'invalid' ? released : null, remarks };
}
router.post('/scholars/:code/stipends', route(async (req, res, trx) => {
  requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  requireNotTerminated(s, 'stipend disbursement');
  const values = stipendValues(V.requireJson(req));
  if (await trx('stipend_disbursements').where({ scholar_id: s.id }).whereRaw('LOWER(period) = ?', [values.period.toLowerCase()]).first()) {
    throw new ApiError('A disbursement for this period already exists. Edit that record instead.', 409, { period: 'This period already has a record.' });
  }
  const t = now();
  const [id] = await trx('stipend_disbursements').insert({ ...values, scholar_id: s.id, encoded_by_id: req.user.id, created_at: t, updated_at: t });
  await audit.log(trx, req, 'edit', 'Stipend record added', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s), details: { ...values } });
  if (values.status === 'Inconsistent') {
    await notifyAdmins(trx, 'stipend_inconsistent', `Stipend flagged as inconsistent: ${D.scholarLabel(s)}`, values.remarks,
      `scholar-profile.html?id=${s.scholar_code}&tab=stipend`, 'amber');
  }
  const row = await trx('stipend_disbursements').where({ id }).first();
  return created({ ok: true, stipend: D.stipend(row), scholar: await D.scholarDetail(trx, s.id) });
}));
router.patch('/scholars/:code/stipends/:id', route(async (req, res, trx) => {
  requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  requireNotTerminated(s, 'stipend disbursement');
  const row = await trx('stipend_disbursements').where({ id: Number(req.params.id), scholar_id: s.id }).first();
  if (!row) throw new ApiError('Stipend record not found.', 404);
  const values = stipendValues(V.requireJson(req));
  const clash = await trx('stipend_disbursements').where({ scholar_id: s.id }).whereNot({ id: row.id }).whereRaw('LOWER(period) = ?', [values.period.toLowerCase()]).first();
  if (clash) throw new ApiError('Another record already uses this period.', 409, { period: 'This period already has a record.' });
  const changes = audit.changedFields(row, values);
  if (Object.keys(changes).length) {
    await trx('stipend_disbursements').where({ id: row.id }).update({ ...values, updated_at: now() });
    await audit.log(trx, req, 'edit', 'Stipend record updated', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s), details: changes });
  }
  const after = await trx('stipend_disbursements').where({ id: row.id }).first();
  return { ok: true, stipend: D.stipend(after), scholar: await D.scholarDetail(trx, s.id) };
}));
router.delete('/scholars/:code/stipends/:id', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const s = await getScholar(trx, req, req.params.code);
  requireNotTerminated(s, 'stipend disbursement');
  const row = await trx('stipend_disbursements').where({ id: Number(req.params.id), scholar_id: s.id }).first();
  if (!row) throw new ApiError('Stipend record not found.', 404);
  const reason = cleanText(body(req).reason, 255);
  if (reason.length < 5) throw new ApiError('Say briefly why the record is being deleted.', 422, { reason: 'Say briefly why the record is being deleted (e.g. saved by mistake).' });
  const snapshot = D.stipend(row);
  await trx('stipend_disbursements').where({ id: row.id }).delete();
  await audit.log(trx, req, 'edit', 'Stipend record deleted', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s), details: { reason, deleted_record: snapshot } });
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));

/* ---------------- graduation ---------------- */
router.put('/scholars/:code/graduation', route(async (req, res, trx) => {
  requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  requireNotTerminated(s, 'the graduation record');
  const d = V.requireJson(req);
  const errors = {};
  const { status } = d;
  if (!D.GRADUATION_STATUSES.includes(status)) errors.status = 'Select a graduation status.';
  const expected = d.expected_graduation ? V.parseMonth(d.expected_graduation) : null;
  if (expected === 'invalid') errors.expected_graduation = 'Enter the expected month and year.';
  const actual = d.actual_graduation ? V.parseDate(d.actual_graduation) : null;
  if (actual === 'invalid' || (actual && actual > today())) errors.actual_graduation = 'Actual graduation date must be a valid date, not in the future.';
  if (status === 'Graduated' && !actual && !errors.actual_graduation) errors.actual_graduation = 'Enter the actual graduation date.';
  const reason = cleanText(d.delay_reason, 255) || null;
  if (['At Risk of Delay', 'Delayed'].includes(status) && !reason) errors.delay_reason = 'Give the reason for the delay.';
  if (status === 'Graduated' && s.status === 'pending_termination') errors.status = 'Resolve the pending termination review before marking the scholar as graduated.';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  const grad = (await trx('graduation_records').where({ scholar_id: s.id }).first()) || null;
  const values = { status, expected_graduation: expected && expected !== 'invalid' ? expected : null,
    actual_graduation: status === 'Graduated' ? actual : null, delay_reason: status !== 'On Track' ? reason : null };
  const changes = audit.changedFields(grad || {}, values);
  if (grad) await trx('graduation_records').where({ id: grad.id }).update({ ...values, updated_by_id: req.user.id, updated_at: now() });
  else await trx('graduation_records').insert({ ...values, scholar_id: s.id, updated_by_id: req.user.id, updated_at: now() });
  let newStatus = s.status;
  if (status === 'Graduated' && s.status === 'active') newStatus = 'graduated';
  else if (status !== 'Graduated' && s.status === 'graduated') newStatus = 'active';
  if (newStatus !== s.status) {
    changes.scholar_status = [s.status, newStatus];
    await trx('scholars').where({ id: s.id }).update({ status: newStatus, updated_at: now() });
  }
  if (Object.keys(changes).length) {
    await audit.log(trx, req, 'edit', 'Graduation record updated', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s), details: changes });
  }
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));

/* ---------------- termination workflow ---------------- */
router.post('/scholars/:code/termination-requests', route(async (req, res, trx) => {
  requireRole(req, 'officer');
  const s = await getScholar(trx, req, req.params.code);
  if (s.status !== 'active' || bool(s.is_deactivated) || bool(s.is_anonymized)) throw new ApiError('Only Active scholars can be recommended for termination.', 409);
  if (await trx('termination_requests').where({ scholar_id: s.id, status: 'pending' }).first()) {
    throw new ApiError('A termination recommendation is already pending for this scholar.', 409);
  }
  const d = V.requireJson(req);
  const errors = {};
  const { grounds } = d;
  if (!D.TERMINATION_GROUNDS.includes(grounds)) errors.grounds = 'Select the grounds for termination.';
  const notes = cleanText(d.notes, 5000);
  if (notes.length < 30) errors.notes = 'Write at least 30 characters: interventions tried, dates, and why termination is recommended.';
  const effective = V.parseDate(d.proposed_effective_date);
  if (!effective || effective === 'invalid') errors.proposed_effective_date = 'Enter the proposed effective date.';
  else if (effective < today()) errors.proposed_effective_date = 'The proposed effective date cannot be in the past.';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  const [reqId] = await trx('termination_requests').insert({ scholar_id: s.id, grounds, notes, proposed_effective_date: effective,
    status: 'pending', requested_by_id: req.user.id, requested_at: now() });
  await trx('scholars').where({ id: s.id }).update({ status: 'pending_termination', updated_at: now() });
  await audit.log(trx, req, 'edit', 'Termination recommended', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { grounds, proposed_effective_date: effective, request_id: reqId } });
  await notifyAdmins(trx, 'termination_request', `Termination recommendation: ${D.scholarLabel(s)}`,
    `Recommended by ${D.fullName(req.user)}. ${grounds}`, `scholar-profile.html?id=${s.scholar_code}`, 'red');
  return created({ ok: true, scholar: await D.scholarDetail(trx, s.id) });
}));

async function pendingRequest(trx, id) {
  const r = await trx('termination_requests').where({ id: Number(id) }).first();
  if (!r) throw new ApiError('Termination request not found.', 404);
  if (r.status !== 'pending') throw new ApiError('This request has already been decided.', 409);
  return [r, await D.loadScholar(trx, { 's.id': r.scholar_id })];
}
router.post('/termination-requests/:id/approve', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const [r, s] = await pendingRequest(trx, req.params.id);
  await trx('termination_requests').where({ id: r.id }).update({ status: 'approved', reviewed_by_id: req.user.id, reviewed_at: now(),
    review_remarks: cleanText(body(req).remarks, 2000) || null });
  await trx('scholars').where({ id: s.id }).update({ status: 'terminated', updated_at: now() });
  await audit.log(trx, req, 'edit', 'Termination approved', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { request_id: r.id, grounds: r.grounds } });
  await notify(trx, [r.requested_by_id], 'termination_approved', `Termination approved: ${D.scholarLabel(s)}`,
    `Approved by ${D.fullName(req.user)}.`, `scholar-profile.html?id=${s.scholar_code}`, 'gray');
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));
router.post('/termination-requests/:id/return', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const [r, s] = await pendingRequest(trx, req.params.id);
  const remarks = cleanText(body(req).remarks, 2000);
  if (remarks.length < 10) throw new ApiError('Tell the officer what information is needed.', 422, { remarks: 'Write what the officer needs to add (at least 10 characters).' });
  await trx('termination_requests').where({ id: r.id }).update({ status: 'returned', reviewed_by_id: req.user.id, reviewed_at: now(), review_remarks: remarks });
  await trx('scholars').where({ id: s.id }).update({ status: 'active', updated_at: now() });
  await audit.log(trx, req, 'edit', 'Termination request returned', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { request_id: r.id, remarks } });
  await notify(trx, [r.requested_by_id], 'termination_returned', `Termination request returned: ${D.scholarLabel(s)}`, remarks,
    `scholar-profile.html?id=${s.scholar_code}`, 'amber');
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));
router.post('/termination-requests/:id/withdraw', route(async (req, res, trx) => {
  requireRole(req, 'officer');
  const [r, s] = await pendingRequest(trx, req.params.id);
  if (r.requested_by_id !== req.user.id) throw new ApiError('Only the officer who submitted this recommendation can withdraw it.', 403);
  const reason = cleanText(body(req).reason, 2000);
  if (reason.length < 5) throw new ApiError('Say briefly why you are withdrawing it.', 422, { reason: 'Say briefly why you are withdrawing it.' });
  await trx('termination_requests').where({ id: r.id }).update({ status: 'withdrawn', withdrawn_at: now(), withdrawal_reason: reason });
  await trx('scholars').where({ id: s.id }).update({ status: 'active', updated_at: now() });
  await audit.log(trx, req, 'edit', 'Termination recommendation withdrawn', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { request_id: r.id, reason } });
  await notifyAdmins(trx, 'termination_withdrawn', `Termination recommendation withdrawn: ${D.scholarLabel(s)}`,
    `Withdrawn by ${D.fullName(req.user)}. ${reason}`, `scholar-profile.html?id=${s.scholar_code}`, 'gray');
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));
router.post('/scholars/:code/reinstate', route(async (req, res, trx) => {
  requireRole(req, 'admin');
  const s = await getScholar(trx, req, req.params.code);
  if (s.status !== 'terminated') throw new ApiError('Only a terminated scholar can be reinstated.', 409);
  const remarks = cleanText(body(req).remarks, 2000);
  if (remarks.length < 10) throw new ApiError('Give the basis for reinstatement.', 422, { remarks: 'Give the basis for reinstatement (at least 10 characters), e.g. approved appeal and its date.' });
  const r = await trx('termination_requests').where({ scholar_id: s.id, status: 'approved' }).orderBy('reviewed_at', 'desc').first();
  if (r) await trx('termination_requests').where({ id: r.id }).update({ status: 'reversed', reversed_at: now(), reversed_by_id: req.user.id, reversal_remarks: remarks });
  const grad = await trx('graduation_records').where({ scholar_id: s.id }).first();
  const newStatus = grad && grad.status === 'Graduated' ? 'graduated' : 'active';
  await trx('scholars').where({ id: s.id }).update({ status: newStatus, updated_at: now() });
  await audit.log(trx, req, 'edit', 'Scholar reinstated', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s),
    details: { remarks, request_id: r ? r.id : null, new_status: newStatus } });
  const link = `scholar-profile.html?id=${s.scholar_code}`;
  if (r) await notify(trx, [r.requested_by_id], 'scholar_reinstated', `Scholar reinstated: ${D.scholarLabel(s)}`, remarks, link, 'gray');
  await notifyOfficers(trx, 'scholar_reinstated', `Scholar reinstated: ${D.scholarLabel(s)}`, remarks, link, 'gray', r ? r.requested_by_id : null);
  return { ok: true, scholar: await D.scholarDetail(trx, s.id) };
}));

module.exports = { router, getScholar, createScholar, refreshStanding, requireNotTerminated };
