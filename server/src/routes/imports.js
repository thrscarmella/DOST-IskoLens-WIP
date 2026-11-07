'use strict';
/*
 * Spreadsheet imports (.xlsx or Google Sheets .csv), Scope 1.5, NFR 3 and 7.
 * Two steps, so nothing is saved until the officer has seen the result:
 *   1. preview: parse and validate every row; nothing is written to the records
 *   2. commit:  save all valid rows in ONE transaction (all or none)
 * Kinds: new scholars (/api/scholars/import) and GWA or stipend records matched
 * by Scholar ID (/api/records-import/academic|stipends).
 */
const path = require('path');
const express = require('express');
const audit = require('../lib/audit');
const { route } = require('../lib/http');
const { ApiError, now, today, cleanText, norm, bool } = require('../lib/util');
const S = require('../lib/security');
const V = require('../lib/validators');
const D = require('../lib/data');
const { computeStanding, consecutiveBelowRequirement, detectScale } = require('../lib/standing');
const { notifyAdmins, notifyOfficers, emailAcademicAlert } = require('../lib/notifications');
const { toCsv, toXlsx, readSpreadsheet, cellText } = require('../lib/files');
const { singleFile } = require('../lib/upload');
const { createScholar, refreshStanding } = require('./scholars');

const MAX_ROWS = 5000;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* ---------------- shared ---------------- */
async function readUpload(req) {
  const f = req.file;
  if (!f) throw new ApiError('Choose a file to upload.', 422, { file: 'No file selected.' });
  const filename = path.basename(f.originalname || '');
  const ext = path.extname(filename).toLowerCase();
  if (!['.csv', '.xlsx'].includes(ext)) throw new ApiError('Upload a .csv or .xlsx file.', 422, { file: 'Only .csv and .xlsx files are accepted.' });
  if (!f.buffer || !f.buffer.length) throw new ApiError('The uploaded file is empty.', 422, { file: 'The file is empty.' });
  try {
    return { filename, ...(await readSpreadsheet(f.buffer, ext)) };
  } catch {
    throw new ApiError('The file could not be read. Save it again as .xlsx or .csv and retry.', 422, { file: 'Unreadable spreadsheet.' });
  }
}
function mapHeaders(headers, aliases, labels, required, allowed = null) {
  const lookup = {};
  for (const [key, names] of Object.entries(aliases)) for (const a of names) lookup[a] = key;
  const mapping = {}; const unknown = [];
  headers.forEach((h, i) => {
    const key = lookup[norm(h)];
    if (key && (!allowed || allowed.includes(key)) && !Object.values(mapping).includes(key)) mapping[i] = key;
    else if (h !== '') unknown.push(String(h));
  });
  const missing = [...required].filter((k) => !Object.values(mapping).includes(k)).sort().map((k) => labels[k]);
  if (missing.length) {
    throw new ApiError(`The file is missing required columns: ${missing.join(', ')}. Download the template to see the expected headers.`, 422,
      { file: `Missing columns: ${missing.join(', ')}` });
  }
  return { mapping, unknown };
}
function rawRows(rows, mapping) {
  const out = [];
  rows.forEach((r, i) => {
    const d = {};
    for (const [idx, key] of Object.entries(mapping)) d[key] = cellText(r[Number(idx)]);
    if (Object.values(d).some((v) => v !== '')) out.push([i + 2, d]);   // +2: header is row 1
  });
  if (out.length > MAX_ROWS) throw new ApiError(`The file has ${out.length} rows. Split it into files of at most ${MAX_ROWS} rows.`, 422);
  return out;
}
async function getBatch(trx, req, id, kinds) {
  const b = await trx('import_batches').where({ id: Number(id) }).first();
  if (!b || b.uploaded_by_id !== req.user.id || !kinds.includes(b.kind || 'scholars')) throw new ApiError('Import not found.', 404);
  if (b.status !== 'previewed') throw new ApiError('This import has already been saved or cancelled.', 409);
  return b;
}
async function saveBatch(trx, req, filename, kind, total, valid, problems) {
  const badRows = [...new Set(problems.map((p) => p.row))];
  const [id] = await trx('import_batches').insert({
    filename: filename.slice(0, 255), uploaded_by_id: req.user.id, uploaded_at: now(), kind, total_rows: total,
    valid_rows: valid.length, error_rows: badRows.length, status: 'previewed',
    errors_json: JSON.stringify(problems.slice(0, 2000)), payload_json: JSON.stringify(valid.map(([n, d]) => [n, d])),
  });
  return [id, badRows.length];
}
const sendTemplate = (name, buf, csv, fmt) => (fmt === 'xlsx'
  ? (r) => r.set('Content-Type', XLSX_TYPE).set('Content-Disposition', `attachment; filename="${name}.xlsx"`).send(buf)
  : (r) => r.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${name}.csv"`).send(csv));

/* ================= new scholars ================= */
const SCHOLAR_COLUMNS = [['gender', 'Sex'],
  ['birth_date', 'Date of Birth'], ['mobile_number', 'Mobile Number'], ['email', 'Email'], ['program', 'Scholarship Program'],
  ['cycle', 'Scholarship Cycle'], ['municipality', 'Municipality'], ['secondary_school', 'Secondary School'],
  ['enrollment_date', 'Enrollment Date'], ['hei', 'HEI'], ['degree_program', 'Degree Program'], ['year_level', 'Year Level']];
const SCHOLAR_LABELS = Object.fromEntries(SCHOLAR_COLUMNS);
const SCHOLAR_ALIASES = {
  gender: ['gender', 'sex'],
  birth_date: ['date of birth', 'birth date', 'birthdate', 'dob', 'birthday'],
  mobile_number: ['mobile number', 'mobile', 'contact number', 'cellphone number', 'phone', 'contact no'],
  email: ['email', 'email address', 'e mail'], program: ['scholarship program', 'program', 'scholarship'],
  cycle: ['scholarship cycle', 'cycle', 'academic year', 'school year'],
  municipality: ['municipality', 'municipality of origin', 'town', 'city municipality'],
  secondary_school: ['secondary school', 'secondary school attended', 'high school', 'school'],
  enrollment_date: ['enrollment date', 'date of scholarship enrollment', 'date enrolled', 'date of enrollment'],
  hei: ['hei', 'higher education institution', 'college', 'university'],
  degree_program: ['degree program', 'course', 'degree', 'program of study'], year_level: ['year level', 'current year level', 'year'],
};
const SCHOLAR_REQUIRED = ['gender', 'birth_date', 'mobile_number', 'program', 'cycle', 'municipality',
  'secondary_school', 'enrollment_date', 'hei', 'degree_program', 'year_level'];

async function validateScholarRows(trx, rows) {
  const lookups = await V.LookupCache.load(trx);
  const valid = []; const errors = [];
  for (const [rowNo, d] of rows) {
    const [values, rowErrors] = V.validateScholar(d, lookups);
    if (Object.keys(rowErrors).length) {
      for (const [field, message] of Object.entries(rowErrors)) errors.push({ row: rowNo, column: SCHOLAR_LABELS[field] || field, message, value: String(d[field] ?? '').slice(0, 60) });
    } else valid.push([rowNo, d, values]);
  }
  return [valid, errors];
}

const scholars = express.Router();
scholars.get('/template.:fmt', route(async (req) => {
  S.requireLogin(req);
  const { fmt } = req.params;
  if (!['xlsx', 'csv'].includes(fmt)) throw new ApiError('Template format must be xlsx or csv.', 404);
  const headers = SCHOLAR_COLUMNS.map(([, l]) => l);
  const example = ['Male', '2006-03-15', '0917 123 4567', 'juan.santos@example.com', 'RA 7687', '2024-2025',
    'Mati City', 'Mati National High School', '2024-08-12', 'DOrSU — Main Campus', 'BS Information Technology', '1st Year'];
  const buf = fmt === 'xlsx' ? await toXlsx('Scholars', headers, [example], { freeze: false, notes: [
    'Fill one scholar per row on the Scholars sheet. Delete the example row before uploading. Each saved scholar gets a Scholar ID; names are not collected.',
    'Dates: YYYY-MM-DD (e.g. 2006-03-15) or MM/DD/YYYY.', 'Sex: Male or Female. Year Level: 1st Year to 5th Year.',
    'Scholarship Program, Cycle, Municipality, Secondary School and HEI must match the lists in IskoLens.',
    'Mobile Number: 11 digits starting with 09.', 'Middle Name and Email are optional. Maximum file size: 10 MB.'] }) : null;
  return sendTemplate('iskolens-scholar-template', buf, toCsv([headers, example]), fmt);
}, { tx: false }));

scholars.post('/preview', singleFile(), route(async (req, res, trx) => {
  S.requireLogin(req);
  const { filename, headers, rows } = await readUpload(req);
  const { mapping, unknown } = mapHeaders(headers, SCHOLAR_ALIASES, SCHOLAR_LABELS, SCHOLAR_REQUIRED);
  const raw = rawRows(rows, mapping);
  if (!raw.length) throw new ApiError('The file has headers but no scholar rows.', 422, { file: 'No data rows found.' });
  const [valid, errors] = await validateScholarRows(trx, raw);
  const [batchId, errorRows] = await saveBatch(trx, req, filename, 'scholars', raw.length, valid, errors);
  await audit.log(trx, req, 'edit', 'Spreadsheet validated', { targetType: 'import', targetId: batchId, targetLabel: filename,
    details: { rows: raw.length, valid: valid.length, with_errors: errorRows } });
  return { ok: true, batch_id: batchId, filename, total_rows: raw.length, valid_rows: valid.length, error_rows: errorRows,
    errors: errors.slice(0, 500), ignored_columns: unknown,
    preview: valid.slice(0, 10).map(([n, d]) => ({ row: n, municipality: d.municipality, program: d.program, cycle: d.cycle })) };
}));
scholars.post('/:id/commit', route(async (req, res, trx) => {
  S.requireLogin(req);
  const b = await getBatch(trx, req, req.params.id, ['scholars']);
  const raw = JSON.parse(b.payload_json || '[]');
  if (!raw.length) throw new ApiError('There are no valid rows to save.', 422);
  const [valid, errors] = await validateScholarRows(trx, raw);   // re-check: records may have changed since the preview
  if (errors.length) throw new ApiError('Some rows are no longer valid (records changed since validation). Upload the file again to see the current result.', 409);
  const created = [];
  for (const [, , values] of valid) created.push(await createScholar(trx, values, req.user, b.id));
  await trx('import_batches').where({ id: b.id }).update({ status: 'committed', committed_at: now(), payload_json: null });
  await audit.log(trx, req, 'edit', 'Spreadsheet import saved', { targetType: 'import', targetId: b.id, targetLabel: b.filename,
    details: { scholars_created: created.length, codes: created.map((s) => s.scholar_code).slice(0, 50) } });
  return { ok: true, created: created.length, skipped: b.error_rows };
}));
scholars.post('/:id/cancel', route(async (req, res, trx) => {
  S.requireLogin(req);
  const b = await getBatch(trx, req, req.params.id, ['scholars']);
  await trx('import_batches').where({ id: b.id }).update({ status: 'cancelled', payload_json: null });
  await audit.log(trx, req, 'edit', 'Spreadsheet import cancelled', { targetType: 'import', targetId: b.id, targetLabel: b.filename });
  return { ok: true };
}));

/* ================= GWA and stipend records ================= */
const COLUMNS = {
  academic: [['scholar_id', 'Scholar ID'], ['academic_year', 'Academic Year'], ['semester', 'Semester'], ['gwa', 'GWA'], ['year_level', 'Year Level'], ['date_recorded', 'Date Recorded']],
  stipends: [['scholar_id', 'Scholar ID'], ['period', 'Disbursement Period'], ['amount', 'Amount'], ['status', 'Status'], ['date_released', 'Date Released'], ['remarks', 'Remarks']],
};
const REQUIRED = { academic: ['scholar_id', 'academic_year', 'semester', 'gwa'], stipends: ['scholar_id', 'period', 'amount', 'status'] };
const ALIASES = {
  scholar_id: ['scholar id', 'scholar code', 'id', 'scholar no', 'scholar number'], academic_year: ['academic year', 'school year', 'ay', 'sy'],
  semester: ['semester', 'sem', 'term'], gwa: ['gwa', 'general weighted average', 'grade'], year_level: ['year level', 'year'],
  date_recorded: ['date recorded', 'date', 'date encoded'], period: ['disbursement period', 'period', 'stipend period'],
  amount: ['amount', 'stipend amount', 'amount php'], status: ['status', 'disbursement status'],
  date_released: ['date released', 'release date', 'released on'], remarks: ['remarks', 'notes'],
};
const SEMESTER_WORDS = { '1st semester': '1st Semester', '1st sem': '1st Semester', '1st': '1st Semester', 'first semester': '1st Semester',
  first: '1st Semester', 1: '1st Semester', '2nd semester': '2nd Semester', '2nd sem': '2nd Semester', '2nd': '2nd Semester',
  'second semester': '2nd Semester', second: '2nd Semester', 2: '2nd Semester', summer: 'Summer', midyear: 'Summer', 'mid year': 'Summer' };
const STATUS_WORDS = { released: 'Released', pending: 'Pending', inconsistent: 'Inconsistent' };
const EXAMPLES = {
  academic: ['SCH-2025-001', '2025-2026', '1st Semester', '1.75', '2nd Year', '2026-01-20'],
  stipends: ['SCH-2025-001', '1st Semester 2025-2026', '20000', 'Released', '2025-09-10', ''],
};
async function scholarsByCode(trx, rows) {
  const codes = [...new Set(rows.map(([, d]) => cleanText(d.scholar_id).toUpperCase()).filter(Boolean))];
  if (!codes.length) return {};
  const found = await trx('scholars').whereIn(trx.raw('UPPER(scholar_code)'), codes);
  return Object.fromEntries(found.map((s) => [s.scholar_code.toUpperCase(), s]));
}
function checkScholar(s, code, errors) {
  if (!code) errors.scholar_id = 'Scholar ID is required.';
  else if (!s) errors.scholar_id = `No scholar has the ID ${code}.`;
  else if (bool(s.is_deactivated)) errors.scholar_id = `${code} is deactivated.`;
  else if (bool(s.is_anonymized)) errors.scholar_id = `${code} has been anonymized.`;
  else if (s.status === 'terminated') errors.scholar_id = `${code} is terminated, so new records are locked.`;
}
const problem = (kind, rowNo, d, f, m) => ({ row: rowNo, column: Object.fromEntries(COLUMNS[kind])[f] || f, message: m, value: String(d[f] ?? '').slice(0, 60) });

async function validateAcademic(trx, rows) {
  const sch = await scholarsByCode(trx, rows);
  const ids = Object.values(sch).map((s) => s.id);
  const existing = new Set((ids.length ? await trx('academic_records').whereIn('scholar_id', ids) : []).map((r) => `${r.scholar_id}|${r.academic_year}|${r.semester}`));
  const seen = new Map(); const valid = []; const problems = []; const t = today();
  for (const [rowNo, d] of rows) {
    const errors = {};
    const code = cleanText(d.scholar_id).toUpperCase();
    const s = sch[code];
    checkScholar(s, code, errors);
    const ay = V.cycleLabel(d.academic_year);
    if (!ay) errors.academic_year = 'Academic Year must look like 2025-2026.';
    const sem = SEMESTER_WORDS[norm(d.semester)];
    if (!sem) errors.semester = 'Semester must be 1st Semester, 2nd Semester or Summer.';
    let gwa = Math.round(Number(String(d.gwa).replace('%', '')) * 100) / 100;
    let scale = d.gwa === '' || Number.isNaN(gwa) ? null : detectScale(gwa);
    if (!scale) { errors.gwa = 'GWA must be 1.00 to 5.00, or 50 to 100 for a percentage.'; gwa = null; scale = null; }
    const level = d.year_level ? V.parseYearLevel(d.year_level) : (s ? s.year_level : null);
    if (d.year_level && level === null) errors.year_level = 'Year Level must be 1st to 5th Year (or leave it blank).';
    const recorded = d.date_recorded ? V.parseDate(d.date_recorded) : t;
    if (recorded === 'invalid' || recorded > t) errors.date_recorded = 'Date Recorded must be a valid date, not in the future (or leave it blank).';
    if (!Object.keys(errors).length) {
      const key = `${s.id}|${ay}|${sem}`;
      if (existing.has(key)) errors.semester = `${s.scholar_code} already has a ${sem} ${ay} record. Use Correct on the profile instead.`;
      else if (seen.has(key)) errors.semester = `Same scholar and term as row ${seen.get(key)}.`;
      else seen.set(key, rowNo);
    }
    if (Object.keys(errors).length) for (const [f, m] of Object.entries(errors)) problems.push(problem('academic', rowNo, d, f, m));
    else valid.push([rowNo, d, { scholar: s, academic_year: ay, semester: sem, gwa, gwa_scale: scale, year_level: level, date_recorded: recorded, standing: computeStanding(gwa, level, scale) }]);
  }
  return [valid, problems];
}
async function validateStipends(trx, rows) {
  const sch = await scholarsByCode(trx, rows);
  const ids = Object.values(sch).map((s) => s.id);
  const existing = new Set((ids.length ? await trx('stipend_disbursements').whereIn('scholar_id', ids) : []).map((r) => `${r.scholar_id}|${r.period.toLowerCase()}`));
  const seen = new Map(); const valid = []; const problems = []; const t = today();
  for (const [rowNo, d] of rows) {
    const errors = {};
    const code = cleanText(d.scholar_id).toUpperCase();
    const s = sch[code];
    checkScholar(s, code, errors);
    const period = cleanText(d.period, 60);
    if (!period) errors.period = 'Disbursement Period is required.';
    let amount = Math.round(Number(String(d.amount).replace(/,/g, '').replace('₱', '').trim()) * 100) / 100;
    if (d.amount === '' || Number.isNaN(amount) || amount <= 0 || amount > 1000000) { errors.amount = 'Amount must be a number greater than 0.'; amount = null; }
    const status = STATUS_WORDS[norm(d.status)];
    if (!status) errors.status = 'Status must be Released, Pending or Inconsistent.';
    const released = d.date_released ? V.parseDate(d.date_released) : null;
    if (released === 'invalid' || (released && released > t)) errors.date_released = 'Date Released must be a valid date, not in the future.';
    if (status === 'Released' && !released && !errors.date_released) errors.date_released = 'Date Released is required when the status is Released.';
    const remarks = cleanText(d.remarks, 255) || null;
    if (status === 'Inconsistent' && !remarks) errors.remarks = 'Remarks are required when the status is Inconsistent.';
    if (!Object.keys(errors).length) {
      const key = `${s.id}|${period.toLowerCase()}`;
      if (existing.has(key)) errors.period = `${s.scholar_code} already has a record for ${period}. Edit it on the profile instead.`;
      else if (seen.has(key)) errors.period = `Same scholar and period as row ${seen.get(key)}.`;
      else seen.set(key, rowNo);
    }
    if (Object.keys(errors).length) for (const [f, m] of Object.entries(errors)) problems.push(problem('stipends', rowNo, d, f, m));
    else valid.push([rowNo, d, { scholar: s, period, amount, status, date_released: released && released !== 'invalid' ? released : null, remarks }]);
  }
  return [valid, problems];
}
const VALIDATORS = { academic: validateAcademic, stipends: validateStipends };
const kindOf = (k) => { if (!COLUMNS[k]) throw new ApiError('Unknown import type.', 404); return k; };

const records = express.Router();
records.get('/:kind/template.:fmt', route(async (req) => {
  S.requireLogin(req);
  const kind = kindOf(req.params.kind);
  const { fmt } = req.params;
  if (!['xlsx', 'csv'].includes(fmt)) throw new ApiError('Template format must be xlsx or csv.', 404);
  const headers = COLUMNS[kind].map(([, l]) => l);
  const name = kind === 'academic' ? 'gwa-records' : 'stipend-records';
  const notes = (kind === 'academic'
    ? ['One GWA per row. Delete the example row before uploading.', 'Scholar ID must match IskoLens exactly (e.g. SCH-2025-001).',
      'Semester: 1st Semester, 2nd Semester or Summer. GWA: 1.00-5.00, or 50-100 for a percentage.',
      "Year Level and Date Recorded are optional (default: the scholar's current year level, and today)."]
    : ['One disbursement per row. Delete the example row before uploading.', 'Scholar ID must match IskoLens exactly (e.g. SCH-2025-001).',
      'Status: Released, Pending or Inconsistent. Date Released is required for Released.', 'Remarks are required for Inconsistent.'])
    .concat(['Maximum file size: 10 MB.']);
  const buf = fmt === 'xlsx' ? await toXlsx('Records', headers, [EXAMPLES[kind]], { freeze: false, notes, widths: headers.map((h) => Math.max(16, h.length + 6)) }) : null;
  return sendTemplate(`iskolens-${name}-template`, buf, toCsv([headers, EXAMPLES[kind]]), fmt);
}, { tx: false }));

records.post('/:kind/preview', singleFile(), route(async (req, res, trx) => {
  S.requireLogin(req);
  const kind = kindOf(req.params.kind);
  const { filename, headers, rows } = await readUpload(req);
  const labels = Object.fromEntries(COLUMNS[kind]);
  const { mapping, unknown } = mapHeaders(headers, ALIASES, labels, REQUIRED[kind], COLUMNS[kind].map(([k]) => k));
  const raw = rawRows(rows, mapping);
  if (!raw.length) throw new ApiError('The file has headers but no rows.', 422, { file: 'No data rows found.' });
  const [valid, problems] = await VALIDATORS[kind](trx, raw);
  const [batchId, errorRows] = await saveBatch(trx, req, filename, kind, raw.length, valid, problems);
  await audit.log(trx, req, 'edit', kind === 'academic' ? 'GWA spreadsheet validated' : 'Stipend spreadsheet validated', { targetType: 'import', targetId: batchId, targetLabel: filename,
    details: { rows: raw.length, valid: valid.length, with_errors: errorRows } });
  const summary = (n, v) => {
    const base = { row: n, code: v.scholar.scholar_code };
    return kind === 'academic' ? { ...base, term: `${v.semester} ${v.academic_year}`, gwa: v.gwa, standing: v.standing }
      : { ...base, period: v.period, amount: v.amount, status: v.status };
  };
  return { ok: true, batch_id: batchId, kind, filename, total_rows: raw.length, valid_rows: valid.length, error_rows: errorRows,
    errors: problems.slice(0, 500), ignored_columns: unknown, preview: valid.slice(0, 15).map(([n, , v]) => summary(n, v)) };
}));

records.post('/:id/commit', route(async (req, res, trx) => {
  S.requireLogin(req);
  const b = await getBatch(trx, req, req.params.id, ['academic', 'stipends']);
  const raw = JSON.parse(b.payload_json || '[]');
  if (!raw.length) throw new ApiError('There are no valid rows to save.', 422);
  const [valid, problems] = await VALIDATORS[b.kind](trx, raw);
  if (problems.length) throw new ApiError('Some rows are no longer valid (records changed since validation). Upload the file again to see the current result.', 409);
  const touched = new Map(); const t = now();
  for (const [, , v] of valid) {
    touched.set(v.scholar.id, v.scholar);
    if (b.kind === 'academic') {
      await trx('academic_records').insert({ scholar_id: v.scholar.id, academic_year: v.academic_year, semester: v.semester,
        semester_order: D.SEMESTERS[v.semester], gwa: v.gwa, gwa_scale: v.gwa_scale, year_level_at_record: v.year_level,
        standing: v.standing, date_recorded: v.date_recorded, encoded_by_id: req.user.id, created_at: t });
    } else {
      await trx('stipend_disbursements').insert({ scholar_id: v.scholar.id, period: v.period, amount: v.amount, status: v.status,
        date_released: v.date_released, remarks: v.remarks, encoded_by_id: req.user.id, created_at: t, updated_at: t });
    }
  }
  const belowTwice = [];
  if (b.kind === 'academic') {
    for (const s of touched.values()) if (consecutiveBelowRequirement(await refreshStanding(trx, s.id))) belowTwice.push(s);
  }
  const inconsistent = b.kind === 'stipends' ? valid.filter(([, , v]) => v.status === 'Inconsistent').length : 0;
  await trx('import_batches').where({ id: b.id }).update({ status: 'committed', committed_at: now(), payload_json: null });
  await audit.log(trx, req, 'edit', b.kind === 'academic' ? 'GWA spreadsheet import saved' : 'Stipend spreadsheet import saved', { targetType: 'import', targetId: b.id,
    targetLabel: b.filename, details: { records_created: valid.length, scholars: touched.size, below_requirement_twice: belowTwice.map((s) => s.scholar_code).slice(0, 50) } });
  if (belowTwice.length) {   // one summary notification instead of one per scholar
    const names = belowTwice.slice(0, 5).map((s) => s.scholar_code).join(', ');
    const more = belowTwice.length > 5 ? ` and ${belowTwice.length - 5} more` : '';
    const title = `${belowTwice.length} scholar(s) below the GWA requirement for 2 consecutive semesters`;
    const link = 'scholar-records.html?standing=below&status=active';
    await notifyOfficers(trx, 'below_requirement', title, names + more, link, 'red');
    await notifyAdmins(trx, 'below_requirement', title, names + more, link, 'amber');
    await emailAcademicAlert(trx, title, `Scholars: ${names}${more}`, link);
  }
  if (inconsistent) await notifyAdmins(trx, 'stipend_inconsistent', `${inconsistent} imported stipend record(s) flagged as inconsistent`, `From ${b.filename}.`, 'scholar-records.html', 'amber');
  return { ok: true, created: valid.length, skipped: b.error_rows, scholars: touched.size, below_requirement_twice: belowTwice.length };
}));
records.post('/:id/cancel', route(async (req, res, trx) => {
  S.requireLogin(req);
  const b = await getBatch(trx, req, req.params.id, ['academic', 'stipends']);
  await trx('import_batches').where({ id: b.id }).update({ status: 'cancelled', payload_json: null });
  await audit.log(trx, req, 'edit', 'Spreadsheet import cancelled', { targetType: 'import', targetId: b.id, targetLabel: b.filename });
  return { ok: true };
}));

module.exports = { scholars, records };
