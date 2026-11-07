'use strict';
/*
 * Risk level for each scholar. When a model has been trained and the scholars
 * scored, the model's level is used (source "model"). Otherwise it falls back
 * to academic standing (source "standing"): Failed -> High, Probation ->
 * Moderate, Good Standing -> Low, no GWA yet -> none.
 */
const client = require('./analyticsClient');
const { buildTable } = require('./features');
const { now } = require('./util');

const FALLBACK = { Failed: 'High', Probation: 'Moderate', 'Good Standing': 'Low' };
const fallback = (standing) => (FALLBACK[standing] ? { level: FALLBACK[standing], source: 'standing', top_factors: [] } : { level: null, source: 'standing', top_factors: [] });

async function riskMap(k, ids) {
  if (!ids.length) return {};
  const rows = [];
  for (let i = 0; i < ids.length; i += 500) rows.push(...await k('scholar_risk').whereIn('scholar_id', ids.slice(i, i + 500)));
  return Object.fromEntries(rows.map((r) => [r.scholar_id, {
    level: r.level, source: 'model', model_version: r.model_version, scored_at: r.scored_at,
    probabilities: JSON.parse(r.probabilities_json || '{}'), top_factors: JSON.parse(r.top_factors_json || '[]'),
  }]));
}
/* Attaches .risk to scholar rows ({id, academic_standing, ...}) */
async function attach(k, rows) {
  const m = await riskMap(k, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, risk: m[r.id] || fallback(r.academic_standing) }));
}
async function forOne(k, scholar) { return (await riskMap(k, [scholar.id]))[scholar.id] || fallback(scholar.academic_standing); }

/* Scores all active scholars with the trained model. Returns {scored} or {skipped: reason}. */
async function scoreAll(k) {
  const st = await client.status();
  if (!st.available) return { skipped: 'The analytics service is not running.' };
  if (!st.model_trained) return { skipped: 'No model has been trained yet.' };
  const table = (await buildTable(k)).filter((r) => ['active', 'pending_termination'].includes(r.status));
  let scored = 0;
  for (let i = 0; i < table.length; i += 200) {
    const batch = table.slice(i, i + 200);
    const r = await client.call('/predict', { method: 'POST', body: { scholars: batch }, timeoutMs: 120000 });
    if (r.status !== 200) return { skipped: r.data.error || 'Scoring failed.' };
    const t = now();
    for (const p of r.data.predictions) {
      const row = batch.find((b) => b.scholar_ref === p.scholar_ref);
      if (!row) continue;
      await k('scholar_risk').where({ scholar_id: row.scholar_id }).delete();
      await k('scholar_risk').insert({ scholar_id: row.scholar_id, level: p.risk, probabilities_json: JSON.stringify(p.probabilities),
        top_factors_json: JSON.stringify(p.top_factors || []), model_version: r.data.model_version, scored_at: t });
      scored += 1;
    }
  }
  return { scored, model_version: st.model_version };
}
module.exports = { attach, forOne, riskMap, scoreAll, fallback };
