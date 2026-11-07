'use strict';
/*
 * Analytics pages. Descriptive figures are computed here from the database.
 * Diagnostic tests, model training, predictions and forecasts run in the
 * Python service (../analytics). Every section reports whether it has enough
 * data, so the pages show "no data yet" instead of empty charts.
 */
const express = require('express');
const client = require('../lib/analyticsClient');
const risk = require('../lib/risk');
const { buildTable } = require('../lib/features');
const { route } = require('../lib/http');
const { ApiError } = require('../lib/util');
const S = require('../lib/security');
const D = require('../lib/data');
const { NOT_GOOD } = require('../lib/standing');

const router = express.Router();
const n = async (q) => Number((await q.count({ n: '*' }).first()).n);
const live = (k) => k('scholars').whereIn('scholars.is_deactivated', [0, false]);
const rate = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : null);
async function countBy(k, q, col) {
  return (await q.select(`${col} as name`).count({ n: '*' }).groupBy(col)).map((r) => ({ name: r.name || 'Unknown', count: Number(r.n) })).sort((a, b) => b.count - a.count);
}

router.get('/analytics/status', route(async (req) => {
  S.requireLogin(req);
  const st = await client.status();
  return { ok: true, ...st, message: st.available ? undefined : 'The analytics service is not running. Start it from the analytics folder (see README).' };
}, { tx: false }));

router.post('/analytics/predict', route(async (req) => {
  S.requireLogin(req);
  let r;
  try { r = await client.call('/predict', { method: 'POST', body: req.body || {} }); } catch { throw new ApiError('The analytics service is not available right now.', 503); }
  if (r.status !== 200) throw new ApiError(r.data && r.data.error ? r.data.error : 'Prediction failed.', r.status === 503 ? 503 : 422);
  return { ok: true, ...r.data };
}, { tx: false }));

/* ---------------- Descriptive ---------------- */
router.get('/analytics/descriptive', route(async (req, res, k) => {
  S.requireLogin(req);
  const total = await n(live(k));
  const join = (q) => q.leftJoin('municipalities as m', 'm.id', 'scholars.municipality_id').leftJoin('heis as h', 'h.id', 'scholars.hei_id')
    .leftJoin('scholarship_programs as p', 'p.id', 'scholars.program_id').leftJoin('scholarship_cycles as c', 'c.id', 'scholars.cycle_id')
    .leftJoin('secondary_schools as ss', 'ss.id', 'scholars.secondary_school_id');
  const out = { ok: true, total_scholars: total, enough_data: total > 0 };
  out.demographics = {
    enough_data: total > 0,
    by_sex: await countBy(k, live(k), 'scholars.gender'),
    by_municipality: await countBy(k, join(live(k)), 'm.name'),
    by_program: await countBy(k, join(live(k)), 'p.name'),
    by_status: (await countBy(k, live(k), 'scholars.status')).map((r) => ({ ...r, name: D.STATUS_LABELS[r.name] || r.name })),
  };
  const apps = await k('school_applicants').select('cycle_label', 'start_year').sum({ applicants: 'applicants', qualifiers: 'qualifiers', awardees: 'awardees' })
    .groupBy('cycle_label', 'start_year').orderBy('start_year');
  out.acceptance_rates = { enough_data: apps.length > 0, by_cycle: apps.map((a) => ({ cycle: a.cycle_label, applicants: Number(a.applicants), qualifiers: Number(a.qualifiers),
    awardees: Number(a.awardees), qualification_rate: rate(Number(a.qualifiers), Number(a.applicants)), acceptance_rate: rate(Number(a.awardees), Number(a.applicants)) })) };
  out.hei_distribution = { enough_data: total > 0, by_hei: await countBy(k, join(live(k)), 'h.name'),
    top_degrees: (await countBy(k, live(k), 'scholars.degree_program')).slice(0, 10) };
  const sti = await k('stipend_disbursements as st').join('scholars', 'scholars.id', 'st.scholar_id').whereIn('scholars.is_deactivated', [0, false])
    .select('st.status', 'st.date_released').select('st.amount');
  const byYear = {};
  sti.forEach((r) => {
    if (r.status !== 'Released' || !r.date_released) return;
    const y = String(r.date_released).slice(0, 4); byYear[y] = byYear[y] || { year: y, released: 0, amount: 0 };
    byYear[y].released += 1; byYear[y].amount += Number(r.amount);
  });
  out.stipend_disbursement = { enough_data: sti.length > 0, by_year: Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year)),
    by_status: ['Released', 'Pending', 'Inconsistent'].map((s) => ({ name: s, count: sti.filter((r) => r.status === s).length })) };
  const cycles = await join(live(k)).select('c.label as cycle', 'c.start_year', 'scholars.status').count({ n: '*' }).groupBy('c.label', 'c.start_year', 'scholars.status').orderBy('c.start_year');
  const byCycle = {};
  cycles.forEach((r) => { const c = r.cycle || 'Unknown'; byCycle[c] = byCycle[c] || { cycle: c, total: 0, graduated: 0, terminated: 0 }; byCycle[c].total += Number(r.n); if (r.status === 'graduated') byCycle[c].graduated += Number(r.n); if (r.status === 'terminated') byCycle[c].terminated += Number(r.n); });
  out.graduation_termination = { enough_data: total > 0, by_cycle: Object.values(byCycle).map((c) => ({ ...c, graduation_rate: rate(c.graduated, c.total), termination_rate: rate(c.terminated, c.total) })) };
  const schools = await k('school_applicants').select('school_name').sum({ applicants: 'applicants', qualifiers: 'qualifiers' }).groupBy('school_name');
  out.school_rankings = { enough_data: schools.length > 0,
    by_qualifiers: schools.map((s) => ({ school: s.school_name, applicants: Number(s.applicants), qualifiers: Number(s.qualifiers), qualification_rate: rate(Number(s.qualifiers), Number(s.applicants)) }))
      .sort((a, b) => b.qualifiers - a.qualifiers).slice(0, 15),
    by_scholars: (await countBy(k, join(live(k)), 'ss.name')).slice(0, 15) };
  return out;
}, { tx: false }));

/* ---------------- Diagnostic ---------------- */
router.get('/analytics/diagnostic', route(async (req, res, k) => {
  S.requireLogin(req);
  const out = { ok: true };
  const st = await client.status();
  if (!st.available) out.root_cause = { available: false, enough_data: false };
  else {
    try { const r = await client.call('/diagnostic', { method: 'POST', body: { scholars: await buildTable(k) }, timeoutMs: 60000 }); out.root_cause = { available: true, ...r.data }; } catch {
      out.root_cause = { available: false, enough_data: false };
    }
  }
  const terms = k('termination_requests as t').join('scholars as s', 's.id', 't.scholar_id').where('t.status', 'approved');
  const totalTerm = await n(terms.clone());
  out.termination_breakdown = { enough_data: totalTerm > 0, total: totalTerm,
    by_grounds: (await terms.clone().select('t.grounds as name').count({ n: '*' }).groupBy('t.grounds')).map((r) => ({ name: r.name, count: Number(r.n) })).sort((a, b) => b.count - a.count),
    by_year_level: (await terms.clone().select('s.year_level as name').count({ n: '*' }).groupBy('s.year_level')).map((r) => ({ name: `${r.name} year`, count: Number(r.n) })),
    by_hei: (await terms.clone().leftJoin('heis as h', 'h.id', 's.hei_id').select('h.name').count({ n: '*' }).groupBy('h.name')).map((r) => ({ name: r.name, count: Number(r.n) })) };
  const munis = await live(k).leftJoin('municipalities as m', 'm.id', 'scholars.municipality_id').select('m.name', 'scholars.status').count({ n: '*' }).groupBy('m.name', 'scholars.status');
  const mm = {};
  munis.forEach((r) => { mm[r.name] = mm[r.name] || { municipality: r.name, scholars: 0, terminated: 0, graduated: 0 }; mm[r.name].scholars += Number(r.n); if (r.status === 'terminated') mm[r.name].terminated += Number(r.n); if (r.status === 'graduated') mm[r.name].graduated += Number(r.n); });
  out.school_municipal_rates = { enough_data: totalTerm > 0 || Object.values(mm).some((m) => m.graduated),
    by_municipality: Object.values(mm).map((m) => ({ ...m, termination_rate: rate(m.terminated, m.scholars), graduation_rate: rate(m.graduated, m.scholars) })).sort((a, b) => (b.termination_rate || 0) - (a.termination_rate || 0)) };
  const schools = await live(k).leftJoin('secondary_schools as ss', 'ss.id', 'scholars.secondary_school_id').select('ss.name', 'scholars.academic_standing', 'scholars.status');
  const sm = {};
  schools.forEach((r) => { sm[r.name] = sm[r.name] || { school: r.name, scholars: 0, with_gwa: 0, below: 0, terminated: 0 }; const x = sm[r.name]; x.scholars += 1; if (r.academic_standing) x.with_gwa += 1; if (NOT_GOOD.includes(r.academic_standing)) x.below += 1; if (r.status === 'terminated') x.terminated += 1; });
  const schoolRows = Object.values(sm).filter((x) => x.with_gwa >= 1).map((x) => ({ ...x, below_rate: rate(x.below, x.with_gwa), termination_rate: rate(x.terminated, x.scholars) }));
  out.school_performance_diagnostic = { enough_data: schoolRows.length > 0, by_school: schoolRows.sort((a, b) => (b.below_rate || 0) - (a.below_rate || 0)).slice(0, 20) };
  return out;
}, { tx: false }));

/* ---------------- Predictive ---------------- */
router.get('/analytics/predictive', route(async (req, res, k) => {
  S.requireLogin(req);
  const st = await client.status();
  const active = await D.scholarQuery(k).whereIn('s.is_deactivated', [0, false]).whereIn('s.status', ['active', 'pending_termination']);
  const withRisk = await risk.attach(k, active);
  const dist = { High: 0, Moderate: 0, Low: 0, Unknown: 0 };
  withRisk.forEach((s) => { dist[s.risk.level || 'Unknown'] += 1; });
  const source = withRisk.some((s) => s.risk.source === 'model') ? 'model' : 'standing';
  const top = withRisk.filter((s) => s.risk.level === 'High').slice(0, 25).map((s) => ({ ...D.scholarRow(s), risk: s.risk }));
  const out = { ok: true, model: st, termination_risk_levels: { enough_data: active.length > 0, source, distribution: dist, high_risk: top } };
  // Forecast series
  const grads = await k('graduation_records as g').join('scholars as s', 's.id', 'g.scholar_id').leftJoin('scholarship_programs as p', 'p.id', 's.program_id')
    .where('g.status', 'Graduated').whereNotNull('g.actual_graduation').select('p.name as program', 'g.actual_graduation');
  const gradSeries = {};
  grads.forEach((r) => { const key = `${r.program}|${String(r.actual_graduation).slice(0, 4)}`; gradSeries[key] = (gradSeries[key] || 0) + 1; });
  const apps = await k('school_applicants as a').leftJoin('municipalities as m', 'm.id', 'a.municipality_id').select('m.name as municipality', 'a.school_name', 'a.start_year', 'a.applicants', 'a.qualifiers');
  const series = {
    graduation_forecast: Object.entries(gradSeries).map(([key, value]) => { const [group, year] = key.split('|'); return { group, year: Number(year), value }; }),
    applicant_volume_forecast: apps.map((a) => ({ group: a.municipality || 'Unknown', year: a.start_year, value: Number(a.applicants) })),
    school_performance_forecast: apps.map((a) => ({ group: a.school_name, year: a.start_year, value: Number(a.qualifiers) })),
  };
  if (!st.available) {
    for (const key of Object.keys(series)) out[key] = { available: false, enough_data: false };
  } else {
    try {
      const r = await client.call('/forecast', { method: 'POST', body: { series }, timeoutMs: 60000 });
      for (const key of Object.keys(series)) out[key] = { available: true, ...(r.data[key] || { enough_data: false }) };
    } catch { for (const key of Object.keys(series)) out[key] = { available: false, enough_data: false }; }
  }
  return out;
}, { tx: false }));

module.exports = { router };
