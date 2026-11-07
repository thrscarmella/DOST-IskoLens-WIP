'use strict';
/* Lookups (dropdown lists) and Reference Lists management (Administrator). */
const express = require('express');
const audit = require('../lib/audit');
const { route, created } = require('../lib/http');
const { ApiError, cleanText, bool } = require('../lib/util');
const S = require('../lib/security');
const V = require('../lib/validators');
const D = require('../lib/data');
const { ruleSummary } = require('../lib/standing');
const { OPTIONS } = require('../lib/options');

const lookups = express.Router();
lookups.get('/', route(async (req, res, trx) => {
  S.requireLogin(req);
  await V.ensureCycles(trx);   // adds the new academic year automatically when it starts
  const active = (t) => trx(t).whereIn('is_active', [1, true]);
  return {
    ok: true,
    programs: (await active('scholarship_programs').orderBy('name')).map((p) => ({ id: p.id, name: p.name })),
    cycles: (await active('scholarship_cycles').orderBy('start_year', 'desc')).map((c) => ({ id: c.id, label: c.label })),
    municipalities: (await trx('municipalities').orderBy('name')).map((m) => ({ id: m.id, name: m.name, psgc: m.psgc_code, is_capital: bool(m.is_capital) })),
    schools: (await active('secondary_schools').orderBy('name')).map((s) => ({ id: s.id, name: s.name, municipality_id: s.municipality_id })),
    heis: (await active('heis').orderBy('name')).map((h) => ({ id: h.id, name: h.name })),
    semesters: Object.keys(D.SEMESTERS),
    year_levels: ['1st', '2nd', '3rd', '4th', '5th'].map((x, i) => ({ value: i + 1, label: `${x} Year` })),
    stipend_statuses: D.STIPEND_STATUSES,
    graduation_statuses: D.GRADUATION_STATUSES,
    termination_grounds: D.TERMINATION_GROUNDS,
    standing_rule: ruleSummary(),
    options: OPTIONS,   // every other dropdown list (sex, semesters, statuses, roles, settings ...)
  };
}));

const KINDS = {
  schools: ['secondary_schools', 'secondary_school_id', 'Secondary school'],
  heis: ['heis', 'hei_id', 'HEI'],
  programs: ['scholarship_programs', 'program_id', 'Scholarship program'],
  cycles: ['scholarship_cycles', 'cycle_id', 'Scholarship cycle'],
};
const NAME_RE = /^[^<>{}]{2,160}$/;
const reference = express.Router();

reference.get('/', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  await V.ensureCycles(trx);
  const munis = Object.fromEntries((await trx('municipalities')).map((m) => [m.id, m.name]));
  const out = { ok: true };
  for (const [kind, [table, column]] of Object.entries(KINDS)) {
    const usage = Object.fromEntries((await trx('scholars').select(column).count({ n: '*' }).groupBy(column)).map((r) => [r[column], Number(r.n)]));
    const rows = await trx(table).orderBy(kind === 'cycles' ? [{ column: 'start_year', order: 'desc' }] : ['name']);
    out[kind] = rows.map((i) => {
      const base = { id: i.id, is_active: bool(i.is_active), scholars: usage[i.id] || 0 };
      if (kind === 'cycles') return { ...base, name: i.label, start_year: i.start_year };
      if (kind === 'schools') return { ...base, name: i.name, municipality_id: i.municipality_id, municipality: munis[i.municipality_id] };
      return { ...base, name: i.name };
    });
  }
  out.municipalities = Object.entries(munis).map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.name.localeCompare(b.name));
  return out;
}));

function cleanName(kind, d, errors) {
  if (kind === 'cycles') {
    const start = Number(String(d.start_year ?? '').trim());
    if (!Number.isInteger(start) || start < 2000 || start > 2100 || String(d.start_year ?? '').trim() === '') {
      errors.start_year = 'Enter the starting year, e.g. 2027 for 2027-2028.'; return null;
    }
    return start;
  }
  const name = cleanText(d.name, 160);
  if (!NAME_RE.test(name || '')) { errors.name = 'Enter a name of 2 to 160 characters with no < > { } symbols.'; return null; }
  return name;
}
function duplicate(trx, kind, table, value, municipalityId = null, exclude = null) {
  let q = kind === 'cycles' ? trx(table).where({ start_year: value }) : trx(table).whereRaw('LOWER(name) = ?', [value.toLowerCase()]);
  if (kind === 'schools') q = q.where({ municipality_id: municipalityId });
  if (exclude) q = q.whereNot({ id: exclude });
  return q.first();
}

reference.post('/:kind', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const { kind } = req.params;
  if (!KINDS[kind]) throw new ApiError('Unknown list.', 404);
  const [table, , label] = KINDS[kind];
  const d = V.requireJson(req);
  const errors = {};
  const value = cleanName(kind, d, errors);
  let muniId = null;
  if (kind === 'schools') {
    muniId = d.municipality_id;
    if (!muniId || !(await trx('municipalities').where({ id: Number(muniId) }).first())) errors.municipality_id = "Select the school's municipality.";
    else muniId = Number(muniId);
  }
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  if (await duplicate(trx, kind, table, value, muniId)) {
    throw new ApiError(`This ${label.toLowerCase()} is already on the list.`, 409, { [kind !== 'cycles' ? 'name' : 'start_year']: 'Already on the list.' });
  }
  let row;
  if (kind === 'cycles') row = { label: `${value}-${value + 1}`, start_year: value, is_active: true };
  else if (kind === 'schools') row = { name: value, municipality_id: muniId, is_active: true };
  else row = { name: value, is_active: true };
  const [id] = await trx(table).insert(row);
  await audit.log(trx, req, 'edit', `${label} added`, { targetType: kind, targetId: id, targetLabel: row.label || row.name });
  return created({ ok: true, id });
}));

reference.patch('/:kind/:id', route(async (req, res, trx) => {
  S.requireRole(req, 'admin');
  const { kind } = req.params;
  if (!KINDS[kind]) throw new ApiError('Unknown list.', 404);
  const [table, column, label] = KINDS[kind];
  const item = await trx(table).where({ id: Number(req.params.id) }).first();
  if (!item) throw new ApiError(`${label} not found.`, 404);
  const d = V.requireJson(req);
  const errors = {}; const changes = {}; const upd = {};
  const inUse = Number((await trx('scholars').where({ [column]: item.id }).count({ n: '*' }).first()).n);
  if ('name' in d && kind !== 'cycles') {
    const name = cleanName(kind, d, errors);
    if (name && name !== item.name) {
      const muni = Number(d.municipality_id || item.municipality_id || 0) || null;
      if (await duplicate(trx, kind, table, name, muni, item.id)) errors.name = 'Another entry already has this name.';
      else { changes.name = [item.name, name]; upd.name = name; }
    }
  }
  if (kind === 'schools' && 'municipality_id' in d && Number(d.municipality_id || 0) !== item.municipality_id) {
    if (inUse) errors.municipality_id = `${inUse} scholar(s) use this school, so its municipality cannot be changed. Add a new school entry instead.`;
    else if (!(await trx('municipalities').where({ id: Number(d.municipality_id || 0) }).first())) errors.municipality_id = "Select the school's municipality.";
    else { changes.municipality_id = [item.municipality_id, Number(d.municipality_id)]; upd.municipality_id = Number(d.municipality_id); }
  }
  if ('is_active' in d && !!d.is_active !== bool(item.is_active)) { changes.is_active = [bool(item.is_active), !!d.is_active]; upd.is_active = !!d.is_active; }
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  if (Object.keys(changes).length) {
    await trx(table).where({ id: item.id }).update(upd);
    const ia = changes.is_active;
    const action = ia && ia[0] === true && ia[1] === false ? `${label} deactivated` : ia && ia[0] === false && ia[1] === true ? `${label} reactivated` : `${label} updated`;
    await audit.log(trx, req, 'edit', action, { targetType: kind, targetId: item.id, targetLabel: upd.name || item.label || item.name, details: changes });
  }
  return { ok: true, in_use: inUse };
}));

module.exports = { lookups, reference };
