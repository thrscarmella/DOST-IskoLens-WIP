'use strict';
/* CSV / Excel helpers shared by exports and imports. */
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/* Same output as Python's csv.writer (CRLF line endings), with a UTF-8 BOM for Excel */
const toCsv = (rows) => '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

async function toXlsx(sheetName, header, rows, { notes = null, widths = null, freeze = true } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  if (freeze) ws.views = [{ state: 'frozen', ySplit: 1 }];
  header.forEach((h, i) => { ws.getColumn(i + 1).width = widths ? widths[i] : Math.max(14, String(h).length + 4); });
  if (notes) {
    const n = wb.addWorksheet('Instructions');
    notes.forEach((line) => n.addRow([line]));
    n.getColumn(1).width = 110;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* Reads the first sheet of an .xlsx or a .csv into {headers, rows}; rows keep cell values as given. */
async function readSpreadsheet(buffer, ext) {
  if (ext === '.csv') {
    let text = null;
    for (const enc of ['utf8', 'latin1']) {
      const t = buffer.toString(enc);
      if (enc === 'utf8' && t.includes('\ufffd')) continue;
      text = t; break;
    }
    text = text.replace(/^\ufeff/, '');
    const records = parse(text, { relax_column_count: true, skip_empty_lines: false });
    const headers = (records[0] || []).map((h) => String(h));
    return { headers, rows: records.slice(1) };
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  const out = [];
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      let v = row.getCell(c).value;
      if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? (v.richText ? v.richText.map((x) => x.text).join('') : v.hyperlink ?? '');
      vals.push(v);
    }
    out[n - 1] = vals;
  });
  const rows = [];
  for (let i = 1; i < out.length; i++) rows.push(out[i] || []);
  return { headers: (out[0] || []).map((h) => (h === null || h === undefined ? '' : String(h))), rows };
}
/* A cell as text, like the Python _cell(): dates become YYYY-MM-DD, whole floats lose .0 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}
module.exports = { toCsv, toXlsx, readSpreadsheet, cellText };
