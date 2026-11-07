'use strict';
/*
 * Server-side validation shared by manual encoding, editing and spreadsheet
 * import. Nothing reaches the database without passing these checks.
 */
const { ApiError, cleanText, norm, today, daysBetween, pad } = require('./util');

const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ][A-Za-zÀ-ÖØ-öø-ÿÑñ .'\-]*$/;
const EMAIL_RE = /^[^@\s<>"']+@[^@\s<>"']+\.[A-Za-z]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9._]{3,40}$/;
const CYCLE_RE = /(\d{4})\s*[-–—/]\s*(\d{4})/;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (s) => {
  const t = s.toLowerCase();
  const full = MONTHS.indexOf(t);
  if (full > -1) return full + 1;
  const abbr = MONTHS.findIndex((m) => m.slice(0, 3) === t);
  return abbr > -1 && t.length === 3 ? abbr + 1 : 0;
};
function validYMD(y, m, d) {
  if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
}
/* -> 'YYYY-MM-DD', null when empty, or 'invalid' */
function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const s = cleanText(value);
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?: \d{1,2}:\d{2}:\d{2})?$/.exec(s))) return validYMD(+m[1], +m[2], +m[3]) || 'invalid';
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return validYMD(+m[3], +m[1], +m[2]) || validYMD(+m[3], +m[2], +m[1]) || 'invalid';
  if ((m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(s))) { const mo = monthIndex(m[1]); return (mo && validYMD(+m[3], mo, +m[2])) || 'invalid'; }
  if ((m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s))) return validYMD(+m[1], +m[2], +m[3]) || 'invalid';
  return 'invalid';
}
/* 'YYYY-MM' or 'March 2026' -> 'YYYY-MM-01' */
function parseMonth(value) {
  if (!value) return null;
  const s = cleanText(value);
  let m;
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(s))) return validYMD(+m[1], +m[2], 1) || 'invalid';
  if ((m = /^([A-Za-z]+) (\d{4})$/.exec(s))) { const mo = monthIndex(m[1]); return (mo && validYMD(+m[2], mo, 1)) || 'invalid'; }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return validYMD(+m[1], +m[2], 1) && validYMD(+m[1], +m[2], +m[3]) ? validYMD(+m[1], +m[2], 1) : 'invalid';
  return 'invalid';
}
function normalizeMobile(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('63') && digits.length === 12) digits = '0' + digits.slice(2);
  if (digits.length === 10 && digits.startsWith('9')) digits = '0' + digits;
  if (!/^09\d{9}$/.test(digits)) return null;
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
}
function parseYearLevel(value) {
  const m = /\d/.exec(String(value ?? ''));
  if (!m) return null;
  const level = Number(m[0]);
  return level >= 1 && level <= 5 ? level : null;
}
function cycleLabel(value) {
  const m = CYCLE_RE.exec(String(value ?? ''));
  if (!m) return null;
  const start = Number(m[1]); const end = Number(m[2]);
  return end === start + 1 ? `${start}-${end}` : null;
}
function checkName(errors, field, value, label, required = true) {
  const v = cleanText(value, 80);
  if (!v) { if (required) errors[field] = `${label} is required.`; return null; }
  if (v.length > 80) errors[field] = `${label} must be 80 characters or fewer.`;
  else if (!NAME_RE.test(v)) errors[field] = `${label} can only contain letters, spaces, periods, hyphens and apostrophes.`;
  return v;
}
function checkEmail(errors, field, value, required = false) {
  const v = cleanText(value, 160).toLowerCase();
  if (!v) { if (required) errors[field] = 'Email is required.'; return null; }
  if (v.length > 160 || !EMAIL_RE.test(v)) errors[field] = 'Enter a valid email address.';
  return v;
}
const isDigits = (v) => typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v));

/* Lookup lists loaded once per request/import. `keep` lets a record keep a
   value that was deactivated later ({program, cycle, school, hei: id}). */
class LookupCache {
  static async load(k, keep = {}) {
    const c = new LookupCache();
    const usable = (rows, kind) => rows.filter((r) => Number(r.is_active) || r.id === keep[kind]);
    c.programs = usable(await k('scholarship_programs'), 'program');
    c.cycles = usable(await k('scholarship_cycles'), 'cycle');
    c.municipalities = await k('municipalities');
    c.allSchools = await k('secondary_schools');
    c.schools = usable(c.allSchools, 'school');
    c.heis = usable(await k('heis'), 'hei');
    return c;
  }
  static by(items, value, key) {
    if (value === null || value === undefined || value === '') return null;
    if (isDigits(value)) { const f = items.find((i) => i.id === Number(value)); if (f) return f; }
    const target = norm(value);
    return items.find((i) => norm(i[key]) === target) || null;
  }
  program(v) { return LookupCache.by(this.programs, v, 'name'); }
  cycle(v) {
    if (isDigits(v)) return LookupCache.by(this.cycles, v, 'label');
    const label = cycleLabel(v);
    return label ? this.cycles.find((c) => c.label === label) || null : null;
  }
  municipality(v) {
    const found = LookupCache.by(this.municipalities, v, 'name');
    if (found || v === null || v === undefined || v === '') return found;
    const k = (x) => norm(x).replace('city of ', '').replace(' city', '').replace('governor', 'gov');
    const key = k(v);
    return this.municipalities.find((m) => k(m.name) === key) || null;
  }
  school(v, municipality = null) {
    const pool = this.schools.filter((s) => !municipality || s.municipality_id === municipality.id);
    const found = LookupCache.by(pool, v, 'name');
    if (!found && municipality && LookupCache.by(this.allSchools, v, 'name')) return 'wrong_municipality';
    return found;
  }
  hei(v) { return LookupCache.by(this.heis, v, 'name'); }
}

const SCHOLAR_REQUIRED = {
  gender: 'Sex', birth_date: 'Date of birth',
  mobile_number: 'Mobile number', program: 'Scholarship program', cycle: 'Scholarship cycle',
  municipality: 'Municipality of origin', secondary_school: 'Secondary school',
  enrollment_date: 'Date of scholarship enrollment', hei: 'Higher education institution',
  degree_program: 'Degree program', year_level: 'Current year level',
};

/* Returns [values for the scholars table, errors] */
function validateScholar(data, lookups, partial = false) {
  const errors = {}; const out = {};
  const present = (k) => (partial ? Object.prototype.hasOwnProperty.call(data, k) : true);
  const blank = (v) => v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim());
  if (!partial) for (const [k, label] of Object.entries(SCHOLAR_REQUIRED)) if (blank(data[k])) errors[k] = `${label} is required.`;

  if (present('gender') && !errors.gender) {
    const g = cleanText(data.gender).toLowerCase();
    const map = { m: 'Male', f: 'Female' };
    require('./options').values('sexes').forEach((v) => { map[v.toLowerCase()] = v; });
    if (!map[g]) errors.gender = 'Sex must be Male or Female.'; else out.gender = map[g];
  }
  const t = today();
  if (present('birth_date') && !errors.birth_date) {
    const dob = parseDate(data.birth_date);
    if (!dob || dob === 'invalid') errors.birth_date = 'Enter the date of birth as a valid date.';
    else {
      const age = daysBetween(dob, t) / 365.25;
      if (age < 14 || age > 40) errors.birth_date = 'Date of birth gives an age outside 14 to 40 years. Check the year.';
      else out.birth_date = dob;
    }
  }
  if (present('mobile_number') && !errors.mobile_number) {
    const mobile = normalizeMobile(data.mobile_number);
    if (!mobile) errors.mobile_number = 'Enter an 11-digit mobile number starting with 09 (e.g. 0917 123 4567).';
    else out.mobile_number = mobile;
  }
  if (present('email')) out.email = checkEmail(errors, 'email', data.email);
  if (present('program') && !errors.program) {
    const p = lookups.program(data.program);
    if (!p) errors.program = 'Select a scholarship program from the list.'; else out.program_id = p.id;
  }
  if (present('cycle') && !errors.cycle) {
    const c = lookups.cycle(data.cycle);
    if (!c) errors.cycle = 'Select a scholarship cycle from the list (e.g. 2024-2025).'; else out.cycle_id = c.id;
  }
  let muni = null;
  if (present('municipality') && !errors.municipality) {
    muni = lookups.municipality(data.municipality);
    if (!muni) errors.municipality = 'Select one of the 11 municipalities of Davao Oriental.'; else out.municipality_id = muni.id;
  }
  if (present('secondary_school') && !errors.secondary_school) {
    const s = lookups.school(data.secondary_school, muni);
    if (s === 'wrong_municipality') errors.secondary_school = 'This secondary school is not in the selected municipality.';
    else if (!s) errors.secondary_school = 'Select a secondary school from the list.';
    else out.secondary_school_id = s.id;
  }
  if (present('enrollment_date') && !errors.enrollment_date) {
    const e = parseDate(data.enrollment_date);
    if (!e || e === 'invalid') errors.enrollment_date = 'Enter the enrollment date as a valid date.';
    else if (e > t) errors.enrollment_date = 'Enrollment date cannot be in the future.';
    else if (out.birth_date && e <= out.birth_date) errors.enrollment_date = 'Enrollment date must be after the date of birth.';
    else out.enrollment_date = e;
  }
  if (present('hei') && !errors.hei) {
    const h = lookups.hei(data.hei);
    if (!h) errors.hei = 'Select a higher education institution from the list.'; else out.hei_id = h.id;
  }
  if (present('degree_program') && !errors.degree_program) {
    const d = cleanText(data.degree_program, 150);
    if (!d) errors.degree_program = 'Degree program is required.';
    else if (d.length > 150 || /[<>{}]/.test(d)) errors.degree_program = 'Degree program must be up to 150 characters with no special symbols.';
    else out.degree_program = d;
  }
  if (present('year_level') && !errors.year_level) {
    const lvl = parseYearLevel(data.year_level);
    if (lvl === null) errors.year_level = 'Year level must be 1st to 5th year.'; else out.year_level = lvl;
  }
  return [out, errors];
}


function currentAcademicStartYear(d = new Date()) { return d.getMonth() + 1 >= 6 ? d.getFullYear() : d.getFullYear() - 1; }
/* Creates the current and next academic-year cycles if missing */
async function ensureCycles(k, d = new Date()) {
  const start = currentAcademicStartYear(d);
  const created = [];
  for (const year of [start, start + 1]) {
    const label = `${year}-${year + 1}`;
    if (!(await k('scholarship_cycles').where({ label }).first())) {
      await k('scholarship_cycles').insert({ label, start_year: year, is_active: true });
      created.push(label);
    }
  }
  return created;
}
function requireJson(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ApiError('Send the form data as JSON.', 400);
  return req.body;
}

module.exports = {
  NAME_RE, EMAIL_RE, USERNAME_RE, parseDate, parseMonth, normalizeMobile, parseYearLevel, cycleLabel, checkName, checkEmail,
  LookupCache, validateScholar, currentAcademicStartYear, ensureCycles, requireJson, SCHOLAR_REQUIRED,
};
