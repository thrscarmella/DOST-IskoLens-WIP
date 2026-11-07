'use strict';
/*
 * KPI report engine (Administrator only, FR1). Each report type is a function
 * that returns sections (a heading plus a table or text) computed from the
 * live records; the same sections are rendered as PDF or CSV. When DOST Davao
 * Oriental provides its official KPI format, the layouts below are adjusted;
 * the engine, storage and history stay the same.
 */
const PDFDocument = require('pdfkit');
const { toCsv } = require('./files');
const { NOT_GOOD } = require('./standing');
const D = require('./data');

const n = async (q) => Number((await q.count({ n: '*' }).first()).n);
const pct = (a, b) => (b ? `${((a * 100) / b).toFixed(1)}%` : '—');
function live(k, cycleId) {
  const q = k('scholars').whereIn('scholars.is_deactivated', [0, false]);
  if (cycleId) q.where('scholars.cycle_id', cycleId);
  return q;
}
async function groupCount(k, cycleId, joinTable, joinCol, label) {
  const rows = await live(k, cycleId).leftJoin(`${joinTable} as j`, 'j.id', `scholars.${joinCol}`)
    .select(`j.${label} as name`, 'scholars.status').count({ n: '*' }).groupBy(`j.${label}`, 'scholars.status');
  const by = {};
  rows.forEach((r) => { const k2 = r.name || 'Unknown'; by[k2] = by[k2] || { active: 0, pending_termination: 0, graduated: 0, terminated: 0 }; by[k2][r.status] = Number(r.n); });
  return Object.entries(by).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, c]) => [name, c.active + c.pending_termination, c.graduated, c.terminated, c.active + c.pending_termination + c.graduated + c.terminated]);
}

async function sexCount(k, cycleId) {
  const rows = await live(k, cycleId).select('gender', 'status').count({ n: '*' }).groupBy('gender', 'status');
  const by = {};
  rows.forEach((r) => { by[r.gender] = by[r.gender] || { active: 0, pending_termination: 0, graduated: 0, terminated: 0 }; by[r.gender][r.status] = Number(r.n); });
  return Object.entries(by).sort().map(([name, c]) => [name, c.active + c.pending_termination, c.graduated, c.terminated, c.active + c.pending_termination + c.graduated + c.terminated]);
}

const TYPES = {
  scholar_status: {
    title: 'Scholar Status Summary',
    async build(k, { cycleId }) {
      const total = await n(live(k, cycleId));
      const st = async (s) => n(live(k, cycleId).where({ status: s }));
      const active = await st('active'); const pend = await st('pending_termination'); const grad = await st('graduated'); const term = await st('terminated');
      const head = ['', 'Active', 'Graduated', 'Terminated', 'Total'];
      return [
        { heading: 'Overall', table: { columns: ['Status', 'Scholars', 'Share'], rows: [['Active', active, pct(active, total)], ['Pending termination review', pend, pct(pend, total)],
          ['Graduated', grad, pct(grad, total)], ['Terminated', term, pct(term, total)], ['Total', total, '100%']] } },
        { heading: 'By scholarship program', table: { columns: ['Program', ...head.slice(1)], rows: await groupCount(k, cycleId, 'scholarship_programs', 'program_id', 'name') } },
        { heading: 'By municipality', table: { columns: ['Municipality', ...head.slice(1)], rows: await groupCount(k, cycleId, 'municipalities', 'municipality_id', 'name') } },
        { heading: 'By sex', table: { columns: ['Sex', ...head.slice(1)], rows: await sexCount(k, cycleId) } },
      ];
    },
  },
  academic_standing: {
    title: 'Academic Standing Summary',
    async build(k, { cycleId }) {
      const base = () => live(k, cycleId).whereIn('status', ['active', 'pending_termination']);
      const total = await n(base());
      const rows = [];
      for (const s of ['Good Standing', 'Probation', 'Failed']) { const c = await n(base().where({ academic_standing: s })); rows.push([s, c, pct(c, total)]); }
      const none = await n(base().whereNull('academic_standing')); rows.push(['No GWA record yet', none, pct(none, total)]);
      const byYear = [];
      for (let y = 1; y <= 5; y++) {
        const all = await n(base().where({ year_level: y })); if (!all) continue;
        const below = await n(base().where({ year_level: y }).whereIn('academic_standing', NOT_GOOD));
        byYear.push([`${['1st', '2nd', '3rd', '4th', '5th'][y - 1]} Year`, all, below, pct(below, all)]);
      }
      return [
        { heading: 'Active scholars by latest academic standing', table: { columns: ['Standing', 'Scholars', 'Share'], rows } },
        { heading: 'Below the GWA requirement by year level', table: { columns: ['Year level', 'Active scholars', 'Below requirement', 'Rate'], rows: byYear } },
        { text: 'Standing follows the year-level rule: 1st and 2nd year need at least 85% (2.00); 3rd year and up need a passing grade (75% / 3.00).' },
      ];
    },
  },
  stipends: {
    title: 'Stipend Disbursement Summary',
    async build(k, { cycleId }) {
      const q = k('stipend_disbursements as st').join('scholars as s', 's.id', 'st.scholar_id').whereIn('s.is_deactivated', [0, false]);
      if (cycleId) q.where('s.cycle_id', cycleId);
      const rows = await q.select('st.period', 'st.status').sum({ amount: 'st.amount' }).count({ n: '*' }).groupBy('st.period', 'st.status');
      const by = {};
      rows.forEach((r) => { by[r.period] = by[r.period] || { Released: [0, 0], Pending: [0, 0], Inconsistent: [0, 0] }; by[r.period][r.status] = [Number(r.n), Number(r.amount)]; });
      const peso = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const table = Object.entries(by).sort().map(([p, v]) => [p, v.Released[0], peso(v.Released[1]), v.Pending[0], v.Inconsistent[0]]);
      const tot = table.reduce((a, r) => [a[0] + r[1], a[1] + Number(String(r[2]).replace(/,/g, '')), a[2] + r[3], a[3] + r[4]], [0, 0, 0, 0]);
      if (table.length) table.push(['Total', tot[0], peso(tot[1]), tot[2], tot[3]]);
      return [{ heading: 'Disbursements by period', table: { columns: ['Period', 'Released', 'Amount released (PHP)', 'Pending', 'Inconsistent'], rows: table } }];
    },
  },
  graduation_termination: {
    title: 'Graduation and Termination Summary',
    async build(k, { cycleId }) {
      const cycles = await k('scholarship_cycles').orderBy('start_year');
      const rows = [];
      for (const c of cycles) {
        if (cycleId && c.id !== Number(cycleId)) continue;
        const total = await n(live(k, c.id)); if (!total) continue;
        const grad = await n(live(k, c.id).where({ status: 'graduated' })); const term = await n(live(k, c.id).where({ status: 'terminated' }));
        const delayed = await n(live(k, c.id).join('graduation_records as g', 'g.scholar_id', 'scholars.id').whereIn('g.status', ['Delayed', 'At Risk of Delay']));
        rows.push([c.label, total, grad, pct(grad, total), term, pct(term, total), delayed]);
      }
      const gq = k('termination_requests as t').join('scholars as s', 's.id', 't.scholar_id').where('t.status', 'approved');
      if (cycleId) gq.where('s.cycle_id', cycleId);
      const grounds = (await gq.select('t.grounds').count({ n: '*' }).groupBy('t.grounds')).map((r) => [r.grounds, Number(r.n)]).sort((a, b) => b[1] - a[1]);
      return [
        { heading: 'By scholarship cycle', table: { columns: ['Cycle', 'Scholars', 'Graduated', 'Graduation rate', 'Terminated', 'Termination rate', 'Delayed or at risk'], rows } },
        { heading: 'Approved terminations by grounds', table: { columns: ['Grounds', 'Terminations'], rows: grounds } },
      ];
    },
  },
  interventions: {
    title: 'Intervention Case Summary',
    async build(k) {
      const status = (await k('intervention_cases').select('status').count({ n: '*' }).groupBy('status')).map((r) => [r.status, Number(r.n)]);
      const outcomes = (await k('intervention_cases').where({ status: 'closed' }).select('outcome').count({ n: '*' }).groupBy('outcome')).map((r) => [r.outcome, Number(r.n)]);
      const actions = (await k('intervention_logs').whereNotIn('action_type', ['Claimed', 'Released', 'Closed']).select('action_type').count({ n: '*' }).groupBy('action_type')).map((r) => [r.action_type, Number(r.n)]);
      return [
        { heading: 'Cases by status', table: { columns: ['Status', 'Cases'], rows: status } },
        { heading: 'Closed cases by outcome', table: { columns: ['Outcome', 'Cases'], rows: outcomes } },
        { heading: 'Actions taken', table: { columns: ['Action', 'Times'], rows: actions } },
      ];
    },
  },
};

function toPdf(title, subtitle, sections, generatedBy) {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 42, bottom: 50, left: 42, right: 42 }, info: { Title: title, Author: 'DOST-IskoLens' } });
    const chunks = []; doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    const W = doc.page.width - 84; const L = 42; const navy = '#0d1526'; const line = '#cbd3e1';
    const ensure = (h) => { if (doc.y + h > doc.page.height - 60) doc.addPage(); };
    doc.font('Helvetica').fontSize(8).fillColor('#4c576e').text('DOST Davao Oriental · DOST-IskoLens KPI Report', L);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(navy).text(title, L);
    doc.font('Helvetica').fontSize(9).fillColor('#4c576e').text(subtitle, L).moveDown(0.6);
    for (const sec of sections) {
      if (sec.heading) { ensure(40); doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor('#1e5fd9').text(sec.heading, L).moveDown(0.2); }
      if (sec.text) { ensure(24); doc.font('Helvetica').fontSize(9).fillColor('#000').text(sec.text, L, doc.y, { width: W }); }
      if (sec.table) {
        const cols = sec.table.columns; const widths = cols.map((c, i) => (i === 0 ? W * 0.34 : (W * 0.66) / (cols.length - 1)));
        const draw = (cells, head) => {
          const hs = cells.map((c, i) => doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).heightOfString(String(c ?? ''), { width: widths[i] - 6 }));
          const h = Math.max(...hs) + 6; ensure(h); const y = doc.y; let x = L;
          cells.forEach((c, i) => {
            if (head) doc.rect(x, y, widths[i], h).fill(navy);
            doc.rect(x, y, widths[i], h).lineWidth(0.4).strokeColor(line).stroke();
            doc.font(head ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).fillColor(head ? '#fff' : '#000').text(String(c ?? ''), x + 3, y + 3, { width: widths[i] - 6, align: i === 0 ? 'left' : 'right' });
            x += widths[i];
          });
          doc.y = y + h; doc.x = L;
        };
        draw(cols, true);
        if (sec.table.rows.length) sec.table.rows.forEach((r) => draw(r, false));
        else { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#6b7791').text('No records yet.', L + 3, doc.y + 3); doc.moveDown(0.5); }
      }
    }
    doc.moveDown(1).font('Helvetica').fontSize(7.5).fillColor('#6b7791').text(`Generated by ${generatedBy}. Figures are computed from the records in DOST-IskoLens at the time of generation. For official use of DOST Davao Oriental.`, L, doc.y, { width: W });
    doc.end();
  });
}
function toCsvReport(title, subtitle, sections) {
  const rows = [[title], [subtitle], []];
  for (const sec of sections) {
    if (sec.heading) rows.push([sec.heading]);
    if (sec.text) rows.push([sec.text]);
    if (sec.table) { rows.push(sec.table.columns); sec.table.rows.forEach((r) => rows.push(r)); }
    rows.push([]);
  }
  return Buffer.from(toCsv(rows), 'utf8');
}
module.exports = { TYPES, toPdf, toCsvReport };
