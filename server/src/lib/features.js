'use strict';
/*
 * Describes each scholar in the database with the same features the Python
 * model uses (analytics/features.py): the first two terms only (early-warning
 * design), plus the outcome label used for training:
 *   High = terminated, Moderate = graduation delayed / at risk, Low = graduated on time.
 */
const { NOT_GOOD } = require('./standing');
const WINDOW = 2;

function labelFor(s, grad) {
  if (s.status === 'terminated') return 'High';
  if (grad && ['Delayed', 'At Risk of Delay'].includes(grad.status)) return 'Moderate';
  if (s.status === 'graduated') return 'Low';
  return null;
}

async function buildTable(k, { scholarIds = null } = {}) {
  let q = k('scholars as s').leftJoin('municipalities as m', 'm.id', 's.municipality_id').leftJoin('heis as h', 'h.id', 's.hei_id')
    .leftJoin('scholarship_programs as p', 'p.id', 's.program_id').leftJoin('scholarship_cycles as c', 'c.id', 's.cycle_id')
    .whereIn('s.is_deactivated', [0, false])
    .select('s.id', 's.scholar_code', 's.gender', 's.birth_date', 's.status', 'm.name as municipality', 'h.name as hei', 'p.name as program', 'c.start_year');
  if (scholarIds) q = q.whereIn('s.id', scholarIds);
  const scholars = await q;
  const ids = scholars.map((s) => s.id);
  const byScholar = (rows) => rows.reduce((m, r) => { (m[r.scholar_id] = m[r.scholar_id] || []).push(r); return m; }, {});
  const chunk = async (table, order) => {
    const out = [];
    for (let i = 0; i < ids.length; i += 500) out.push(...await k(table).whereIn('scholar_id', ids.slice(i, i + 500)).orderBy(order));
    return byScholar(out);
  };
  const acad = await chunk('academic_records', [{ column: 'academic_year' }, { column: 'semester_order' }]);
  const sti = await chunk('stipend_disbursements', ['id']);
  const grads = Object.fromEntries(Object.entries(await chunk('graduation_records', ['id'])).map(([id, rows]) => [id, rows[0]]));
  return scholars.map((s) => {
    const a = (acad[s.id] || []).slice(0, WINDOW);
    const below = a.map((r) => NOT_GOOD.includes(r.standing));
    let run = 0; let best = 0;
    below.forEach((b) => { run = b ? run + 1 : 0; best = Math.max(best, run); });
    const grade = a.filter((r) => r.gwa_scale === 'grade').map((r) => Number(r.gwa));
    const units = a.map((r) => r.units_enrolled).filter((x) => x !== null && x !== undefined).map(Number);
    const st = (sti[s.id] || []).slice(0, WINDOW);
    const mean = (xs) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
    return {
      scholar_id: s.id, scholar_ref: s.scholar_code, status: s.status,
      sex: s.gender, municipality: s.municipality, program: s.program, hei: s.hei,
      birth_year: s.birth_date ? Number(String(s.birth_date).slice(0, 4)) : null, cycle_start: s.start_year ?? null,
      n_below_requirement: below.filter(Boolean).length, n_failed: a.filter((r) => r.standing === 'Failed').length,
      max_consecutive_below: best, share_below_requirement: a.length ? below.filter(Boolean).length / a.length : null,
      gwa_mean_grade: mean(grade), gwa_last_grade: grade.length ? grade[grade.length - 1] : null, units_mean: mean(units),
      failed_subjects_total: a.some((r) => r.failed_subjects !== null && r.failed_subjects !== undefined) ? a.reduce((x, r) => x + Number(r.failed_subjects || 0), 0) : null,
      n_irregular_or_leave: a.filter((r) => /irregular|leave|loa/i.test(r.enrollment_status || '')).length,
      n_inconsistent: st.filter((r) => r.status === 'Inconsistent').length, n_pending: st.filter((r) => r.status === 'Pending').length,
      risk_label: labelFor(s, grads[s.id]), n_terms_on_record: (acad[s.id] || []).length,
    };
  });
}
module.exports = { buildTable, labelFor, WINDOW };
