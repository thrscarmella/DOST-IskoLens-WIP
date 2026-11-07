'use strict';
const crypto = require('crypto');

class ApiError extends Error {
  /* Raised anywhere in a request to return a clean JSON error. The message is
     shown to the user, so it must never contain internals. */
  constructor(message, status = 400, fieldErrors = null, code = null) {
    super(message);
    this.status = status;
    this.fieldErrors = fieldErrors || {};
    this.code = code;
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/* UTC timestamp 'YYYY-MM-DD HH:MM:SS' (seconds precision, same as stored in MySQL) */
function now(offsetMs = 0) {
  const d = new Date(Date.now() + offsetMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
/* Local calendar date 'YYYY-MM-DD' (Python date.today()) */
function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function parseDT(value) {
  if (!value) return null;
  const s = String(value).replace('T', ' ').replace('Z', '');
  const [datePart, timePart = '00:00:00'] = s.split(' ');
  const [hms, frac = ''] = timePart.split('.');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, se] = hms.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h || 0, mi || 0, se || 0, Number((frac + '000').slice(0, 3))));
}
/* Stored datetime/date string -> ISO for the API ('YYYY-MM-DDTHH:MM:SS'), like Python isoformat() */
function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 19);
  const s = String(value);
  return s.length > 10 ? s.replace(' ', 'T') : s;
}
const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
const newToken = (nbytes = 32) => crypto.randomBytes(nbytes).toString('base64url');

/* Python clean_text: strip NUL, collapse whitespace, keep max_len + 1 chars so length checks still fail */
function cleanText(value, maxLen = 255) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(/\x00/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, maxLen + 1);
}
/* Loose comparison key for lookup names */
function norm(value) {
  let s = cleanText(value).toLowerCase().replace(/–/g, '-').replace(/—/g, '-');
  s = s.replace(/[^a-z0-9ñ]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function daysBetween(a, b) { // b - a in days, both 'YYYY-MM-DD'
  const pa = a.split('-').map(Number); const pb = b.split('-').map(Number);
  return (Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000;
}
function minutesAgo(min) { return now(-min * 60000); }

module.exports = { ApiError, now, today, parseDT, iso, bool, sha256, newToken, cleanText, norm, addDays, daysBetween, minutesAgo, pad };
