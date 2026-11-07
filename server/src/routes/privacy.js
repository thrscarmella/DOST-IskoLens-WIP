'use strict';
/* Printable scholar record (PDF), personal-data export (right of access),
   view-only retention review, and the public privacy information. */
const express = require('express');
const PDFDocument = require('pdfkit');
const config = require('../config');
const audit = require('../lib/audit');
const { route } = require('../lib/http');
const { ApiError, iso, bool, today, addDays, now } = require('../lib/util');
const S = require('../lib/security');
const D = require('../lib/data');
const { getScholar } = require('./scholars');
const { docJson } = require('./documents');

const router = express.Router();

/* ---------------- printable record ---------------- */
const fmtDate = (v) => {
  if (!v) return '—';
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' });
};
const yearLabel = (n) => (n ? `${['1st', '2nd', '3rd', '4th', '5th'][n - 1]} Year` : '—');

function buildPdf(d, user) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 46, left: 42, right: 42 }, info: { Title: `Scholar Record ${d.code}`, Author: 'DOST-IskoLens' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const W = doc.page.width - 84; const L = 42;
    const navy = '#0d1526'; const blue = '#1e5fd9'; const grey = '#4c576e'; const line = '#cbd3e1';
    const ensure = (h) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
    const h2 = (t) => { ensure(40); doc.moveDown(0.6).font('Helvetica-Bold').fontSize(10.5).fillColor(blue).text(t, L); doc.moveDown(0.25); };
    const kv = (pairs) => {
      const colW = W / 2; const labelW = 88;
      for (let i = 0; i < pairs.length; i += 2) {
        ensure(28); const y = doc.y; let maxH = 0;
        pairs.slice(i, i + 2).forEach(([label, value], j) => {
          const x = L + j * colW;
          doc.font('Helvetica-Bold').fontSize(8.5).fillColor(navy).text(label, x, y, { width: labelW });
          doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(value === null || value === undefined || value === '' ? '—' : String(value), x + labelW, y, { width: colW - labelW - 8 });
          maxH = Math.max(maxH, doc.y - y);
        });
        doc.y = y + maxH + 3;
        doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.3).strokeColor(line).stroke();
        doc.y += 3;
      }
    };
    const table = (head, rows, widths) => {
      const draw = (cells, isHead) => {
        const heights = cells.map((c, i) => doc.font(isHead ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(String(c), { width: widths[i] - 6 }));
        const h = Math.max(...heights) + 6; ensure(h + 2); const y = doc.y; let x = L;
        cells.forEach((c, i) => {
          if (isHead) doc.rect(x, y, widths[i], h).fill(navy);
          doc.rect(x, y, widths[i], h).lineWidth(0.4).strokeColor(line).stroke();
          doc.font(isHead ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(isHead ? '#fff' : '#000').text(String(c), x + 3, y + 3, { width: widths[i] - 6 });
          x += widths[i];
        });
        doc.y = y + h; doc.x = L;
      };
      draw(head, true); rows.forEach((r) => draw(r, false));
    };
    const footer = () => {
      const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor('#6b7791').text(`DOST-IskoLens · ${d.code} · Confidential`, L, doc.page.height - 30, { lineBreak: false });
      doc.page.margins.bottom = bottom;
    };
    doc.on('pageAdded', footer);

    doc.font('Helvetica').fontSize(8).fillColor(grey).text('DOST Davao Oriental · DOST-IskoLens', L);
    doc.font('Helvetica-Bold').fontSize(15).fillColor(navy).text(`Scholar Record: ${d.code}`, L);
    doc.font('Helvetica').fontSize(8).fillColor(grey).text(`Scholar ID ${d.code} · Status: ${d.status_label} · Academic standing: ${d.academic_standing || 'No GWA record yet'}`, L);
    h2('Personal and scholarship details');
    kv([['Sex', d.gender], ['Date of birth', fmtDate(d.birth_date)], ['Mobile', d.mobile_number], ['Email', d.email],
      ['Municipality', d.municipality], ['Secondary school', d.secondary_school], ['Program', d.program], ['Cycle', d.cycle],
      ['Enrolled', fmtDate(d.enrollment_date)], ['HEI', d.hei], ['Degree program', d.degree_program], ['Year level', yearLabel(d.year_level)]]);
    h2('Academic performance');
    if (d.academic_records.length) {
      table(['Academic Year', 'Semester', 'Year Level', 'GWA', 'Standing', 'Recorded'],
        d.academic_records.map((r) => [r.academic_year, r.semester, yearLabel(r.year_level_at_record), `${r.gwa.toFixed(2)}${r.gwa_scale === 'percent' ? '%' : ''}`, r.standing, fmtDate(r.date_recorded)]),
        [82, 80, 70, 52, 86, 74].map((w) => (w * W) / 444));
    } else doc.font('Helvetica').fontSize(9).fillColor('#000').text('No academic records.', L);
    h2('Stipend disbursements');
    if (d.stipends.length) {
      table(['Period', 'Amount (PHP)', 'Status', 'Released', 'Remarks'],
        d.stipends.map((r) => [r.period, r.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), r.status, fmtDate(r.date_released), r.remarks || '']),
        [125, 74, 62, 68, 181].map((w) => (w * W) / 510));
    } else doc.font('Helvetica').fontSize(9).fillColor('#000').text('No stipend records.', L);
    const gr = d.graduation || {};
    h2('Graduation');
    kv([['Expected', gr.expected_graduation || 'Not set'], ['Status', gr.status], ['Actual graduation', fmtDate(gr.actual_graduation)], ['Delay reason', gr.delay_reason]]);
    const t = d.termination;
    if (t.pending || t.approved || t.reversed) {
      h2('Termination');
      doc.font('Helvetica').fontSize(9).fillColor('#000');
      if (t.pending) doc.text(`Pending review: ${t.pending.grounds} (recommended by ${t.pending.requested_by}, ${fmtDate(t.pending.requested_at)}).`, L, doc.y, { width: W });
      if (t.approved) doc.text(`Approved: ${t.approved.grounds}. Approved by ${t.approved.reviewed_by} on ${fmtDate(t.approved.reviewed_at)}, effective ${fmtDate(t.approved.proposed_effective_date)}.`, L, doc.y, { width: W });
      if (t.reversed) doc.text(`Reversed (reinstated) by ${t.reversed.reversed_by} on ${fmtDate(t.reversed.reversed_at)}: ${t.reversed.reversal_remarks}`, L, doc.y, { width: W });
    }
    doc.moveDown(1).font('Helvetica').fontSize(8).fillColor(grey).text(
      `Generated ${now().slice(0, 16)} UTC by ${D.fullName(user)}. CONFIDENTIAL: contains personal information protected under the Data Privacy Act of 2012 (RA 10173). For official use of DOST Davao Oriental only.`, L, doc.y, { width: W });
    footer();
    doc.end();
  });
}

router.get('/scholars/:code/record.pdf', route(async (req, res, trx) => {
  S.requireLogin(req);
  const s = await getScholar(trx, req, req.params.code);
  if (bool(s.is_anonymized)) throw new ApiError('This record has been anonymized.', 409);
  const pdf = await buildPdf(await D.scholarDetail(trx, s.id), req.user);
  await audit.log(trx, req, 'report', 'Printed scholar record', { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s) });
  return (r) => r.set('Content-Type', 'application/pdf').set('Content-Disposition', `inline; filename="scholar-record-${s.scholar_code}.pdf"`)
    .set('Cache-Control', 'no-store').send(pdf);
}));

/* ---------------- personal data export (data subject access request) ---------------- */
router.get('/scholars/:code/data-export', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const s = await getScholar(trx, req, req.params.code, true);
  const detail = await D.scholarDetail(trx, s.id);
  const docs = await trx('scholar_documents').where({ scholar_id: s.id });
  const access = await trx('audit_logs').where({ target_type: 'scholar', target_id: s.scholar_code }).orderBy('id');
  const payload = {
    exported_at: `${now().replace(' ', 'T')}Z`, exported_by: D.fullName(req.user),
    notice: 'Personal data held by DOST Davao Oriental in DOST-IskoLens for this scholar, provided under the Data Privacy Act of 2012 (RA 10173), right of access.',
    scholar: detail,
    documents_on_file: await Promise.all(docs.map(async (d) => ({ ...(await docJson(trx, d)), removed: bool(d.is_deleted) }))),
    who_accessed_or_changed_this_record: access.map((e) => ({ when: iso(e.created_at), user: e.username, action: e.action })),
  };
  await audit.log(trx, req, 'report', "Exported scholar's personal data (data request)", { targetType: 'scholar', targetId: s.scholar_code, targetLabel: D.scholarLabel(s) });
  const body = JSON.stringify(payload, null, 2);
  return (r) => r.set('Content-Type', 'application/json').set('Content-Disposition', `attachment; filename="personal-data-${s.scholar_code}.json"`).send(body);
}));

/* ---------------- retention review (view only) ---------------- */
async function exitDate(k, s) {
  if (s.status === 'graduated') {
    const g = await k('graduation_records').where({ scholar_id: s.id }).first();
    if (g && g.actual_graduation) return String(g.actual_graduation).slice(0, 10);
  }
  if (s.status === 'terminated') {
    const t = await k('termination_requests').where({ scholar_id: s.id, status: 'approved' }).orderBy('reviewed_at', 'desc').first();
    if (t && t.reviewed_at) return String(t.reviewed_at).slice(0, 10);
  }
  return null;
}
router.get('/admin/privacy/retention', route(async (req, res, k) => {
  S.requireRole(req, 'admin');
  const years = config.RETENTION_YEARS;
  const span = Math.round(365.25 * years);
  const cutoff = addDays(today(), -span);
  const due = []; const upcoming = [];
  for (const s of await k('scholars').whereIn('status', ['graduated', 'terminated']).whereIn('is_anonymized', [0, false])) {
    const left = await exitDate(k, s);
    if (!left) continue;
    const row = { code: s.scholar_code, status: D.STATUS_LABELS[s.status], left_on: left, due_on: addDays(left, span) };
    (left <= cutoff ? due : upcoming).push(row);
  }
  due.sort((a, b) => a.left_on.localeCompare(b.left_on));
  upcoming.sort((a, b) => a.due_on.localeCompare(b.due_on));
  const anonymized = Number((await k('scholars').whereIn('is_anonymized', [1, true]).count({ n: '*' }).first()).n);
  return { ok: true, retention_years: years, due, upcoming: upcoming.slice(0, 50), anonymized, dpo: { name: config.DPO_NAME, email: config.DPO_EMAIL } };
}, { tx: false }));

router.get('/privacy-info', (req, res) => res.json({ ok: true, retention_years: config.RETENTION_YEARS, dpo_name: config.DPO_NAME, dpo_email: config.DPO_EMAIL }));

module.exports = { router, buildPdf };
