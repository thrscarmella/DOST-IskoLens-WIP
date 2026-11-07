'use strict';
/* KPI Reports (Administrator only): generate, history, download. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const audit = require('../lib/audit');
const { route, created } = require('../lib/http');
const { ApiError, now, iso } = require('../lib/util');
const S = require('../lib/security');
const D = require('../lib/data');
const { TYPES, toPdf, toCsvReport } = require('../lib/reports');

const router = express.Router();
const reportJson = async (k, r) => ({ id: r.id, report_type: r.report_type, title: r.title, period_label: r.period_label, format: r.format,
  size_bytes: r.size_bytes, generated_at: iso(r.generated_at), generated_by: (await D.userNames(k, [r.generated_by_id]))[r.generated_by_id] ?? null });

router.get('/kpi/types', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  return { ok: true, types: Object.entries(TYPES).map(([id, t]) => ({ id, title: t.title })),
    cycles: (await k('scholarship_cycles').orderBy('start_year', 'desc')).map((c) => ({ id: c.id, label: c.label })),
    note: 'These report layouts follow the data in the system. They will be matched to the official KPI format once DOST Davao Oriental provides it.' };
}, { tx: false }));

router.post('/kpi/reports', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const d = req.body || {};
  const type = TYPES[d.type];
  if (!type) throw new ApiError('Select a report type.', 422, { type: 'Select a report type.' });
  const format = d.format === 'csv' ? 'csv' : 'pdf';
  let cycle = null;
  if (d.cycle_id) { cycle = await trx('scholarship_cycles').where({ id: Number(d.cycle_id) }).first(); if (!cycle) throw new ApiError('Select a valid cycle.', 422, { cycle_id: 'Unknown cycle.' }); }
  const period = cycle ? `Scholarship cycle ${cycle.label}` : 'All cycles';
  const sections = await type.build(trx, { cycleId: cycle ? cycle.id : null });
  const subtitle = `${period} · Generated ${now().slice(0, 16)} UTC`;
  const buf = format === 'pdf' ? await toPdf(type.title, subtitle, sections, D.fullName(req.user)) : toCsvReport(type.title, subtitle, sections);
  fs.mkdirSync(config.REPORTS_DIR, { recursive: true });
  const stored = `${crypto.randomBytes(12).toString('hex')}.${format}`;
  fs.writeFileSync(path.join(config.REPORTS_DIR, stored), buf);
  const [id] = await trx('kpi_reports').insert({ report_type: d.type, title: type.title, period_label: period, format, stored_name: stored, size_bytes: buf.length,
    params_json: JSON.stringify({ cycle_id: cycle ? cycle.id : null }), generated_by_id: req.user.id, generated_at: now() });
  await audit.log(trx, req, 'report', 'KPI report generated', { targetType: 'kpi_report', targetId: id, targetLabel: `${type.title} (${period}, ${format.toUpperCase()})` });
  return created({ ok: true, report: await reportJson(trx, await trx('kpi_reports').where({ id }).first()) });
}));

router.get('/kpi/reports', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const rows = await k('kpi_reports').orderBy('id', 'desc').limit(200);
  return { ok: true, reports: await Promise.all(rows.map((r) => reportJson(k, r))) };
}, { tx: false }));

router.get('/kpi/reports/:id/download', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const r = await trx('kpi_reports').where({ id: Number(req.params.id) }).first();
  if (!r) throw new ApiError('Report not found.', 404);
  const p = path.join(config.REPORTS_DIR, r.stored_name);
  if (!fs.existsSync(p)) throw new ApiError('The report file is missing. Generate it again.', 410);
  await audit.log(trx, req, 'report', 'KPI report downloaded', { targetType: 'kpi_report', targetId: r.id, targetLabel: r.title });
  const name = `${r.title.replace(/[^A-Za-z0-9]+/g, '-')}-${String(r.generated_at).slice(0, 10)}.${r.format}`;
  return (resp) => resp.set('Content-Type', r.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8')
    .set('Content-Disposition', `${req.query.inline === '1' && r.format === 'pdf' ? 'inline' : 'attachment'}; filename="${name}"`).sendFile(p);
}));
module.exports = { router };
