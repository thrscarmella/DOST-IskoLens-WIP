'use strict';
/* Lookup lists created by init-db, and fictional demo scholars (seed-demo). */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { now, pad } = require('./util');
const { computeStanding } = require('./standing');

const MUNICIPALITIES = ['Baganga', 'Banaybanay', 'Boston', 'Caraga', 'Cateel', 'Governor Generoso', 'Lupon', 'Manay', 'Mati City', 'San Isidro', 'Tarragona'];
const GEO_NAME = { 'City of Mati': 'Mati City' };
const PLACEHOLDER_HEIS = ['Davao Oriental State University (DOrSU) — Main Campus', 'DOrSU — Cateel Campus', 'DOrSU — Gov. Generoso Campus',
  'DOrSU — Lupon Campus', 'DOrSU — San Isidro Campus', 'DOSCST — Main Campus', 'DOSCST — Caraga Campus'];
const PROGRAMS = ['Merit', 'RA 7687', 'JLSS'];

async function seedLookups(k) {
  const psgc = {};
  const geo = path.join(config.FRONTEND_DIR, 'assets', 'geo', 'davao-oriental-municipalities.geojson');
  if (fs.existsSync(geo)) {
    for (const f of JSON.parse(fs.readFileSync(geo, 'utf8')).features) {
      const name = GEO_NAME[f.properties.name] || f.properties.name;
      psgc[name] = f.properties.psgc;
    }
  }
  let added = 0;
  for (const name of MUNICIPALITIES) {
    let m = await k('municipalities').where({ name }).first();
    if (!m) {
      const [id] = await k('municipalities').insert({ name, psgc_code: psgc[name] || null, is_capital: name === 'Mati City' });
      m = { id }; added += 1;
    }
    const school = `${name.replace(' City', '').replace('Governor', 'Gov.')} National High School`;
    if (!(await k('secondary_schools').where({ name: school, municipality_id: m.id }).first())) {
      await k('secondary_schools').insert({ name: school, municipality_id: m.id, is_active: true });
    }
  }
  for (const name of PLACEHOLDER_HEIS) if (!(await k('heis').where({ name }).first())) await k('heis').insert({ name, is_active: true });
  for (const name of PROGRAMS) if (!(await k('scholarship_programs').where({ name }).first())) await k('scholarship_programs').insert({ name, is_active: true });
  for (let start = 2016; start <= new Date().getFullYear(); start++) {
    const label = `${start}-${start + 1}`;
    if (!(await k('scholarship_cycles').where({ label }).first())) await k('scholarship_cycles').insert({ label, start_year: start, is_active: true });
  }
  return added;
}

/* Small deterministic random generator, so demo data is the same every run */
function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { random: next, int: (a, b) => a + Math.floor(next() * (b - a + 1)), choice: (arr) => arr[Math.floor(next() * arr.length)], uniform: (a, b) => a + next() * (b - a) };
}

async function seedDemo(k, count, createScholar, actor) {
  const r = rng(42);
  const degrees = ['BS Information Technology', 'BS Civil Engineering', 'BS Biology', 'BS Mathematics', 'BS Computer Science', 'BS Agriculture', 'BS Environmental Science'];
  const munis = await k('municipalities'); const heis = await k('heis'); const programs = await k('scholarship_programs');
  const cycles = Object.fromEntries((await k('scholarship_cycles')).map((c) => [c.start_year, c]));
  const year = new Date().getFullYear();
  const starts = Object.keys(cycles).map(Number).filter((y) => y >= year - 4 && y <= year - 1);
  let made = 0;
  for (let i = 0; i < count; i++) {
    const m = r.choice(munis);
    const school = await k('secondary_schools').where({ municipality_id: m.id }).first();
    const start = r.choice(starts);
    const yearLevel = Math.min(year - start, 4) || 1;
    const values = {
      gender: r.choice(['Male', 'Female']),
      birth_date: `${start - 18}-${pad(r.int(1, 12))}-${pad(r.int(1, 28))}`, mobile_number: `09${r.int(10, 99)} ${r.int(100, 999)} ${r.int(1000, 9999)}`,
      email: null, program_id: r.choice(programs).id, cycle_id: cycles[start].id, municipality_id: m.id, secondary_school_id: school.id,
      enrollment_date: `${start}-08-${pad(r.int(1, 28))}`, hei_id: r.choice(heis).id, degree_program: r.choice(degrees), year_level: yearLevel,
    };
    const s = await createScholar(k, values, actor);
    const base = r.uniform(1.4, 2.4);
    let lastStanding = null;
    const t = now();
    for (let j = 0; j < Math.min(yearLevel * 2 - 1, 6); j++) {
      const ay = `${start + Math.floor(j / 2)}-${start + Math.floor(j / 2) + 1}`;
      const sem = j % 2 === 0 ? '1st Semester' : '2nd Semester';
      const gwa = Math.round(Math.min(Math.max(base + r.uniform(-0.3, 0.45) * (j / 3), 1.0), 4.0) * 100) / 100;
      const lvl = Math.floor(j / 2) + 1;
      lastStanding = computeStanding(gwa, lvl, 'grade');
      await k('academic_records').insert({ scholar_id: s.id, academic_year: ay, semester: sem, semester_order: j % 2 + 1, gwa, gwa_scale: 'grade',
        year_level_at_record: lvl, standing: lastStanding, date_recorded: `${start + Math.floor(j / 2) + (j % 2)}-${j % 2 === 0 ? '01' : '06'}-15`, encoded_by_id: actor.id, created_at: t });
      const rel = new Date(Date.UTC(start + Math.floor(j / 2), 8, 10) + 150 * (j % 2) * 86400000).toISOString().slice(0, 10);
      await k('stipend_disbursements').insert({ scholar_id: s.id, period: `${sem} ${ay}`, amount: 20000, status: 'Released', date_released: rel, encoded_by_id: actor.id, created_at: t, updated_at: t });
    }
    await k('scholars').where({ id: s.id }).update({ academic_standing: lastStanding });
    made += 1;
  }
  return made;
}
module.exports = { seedLookups, seedDemo, MUNICIPALITIES };
