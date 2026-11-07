'use strict';
/*
 * Intervention case handling (prescriptive module).
 * A case is opened for every active scholar at High or Moderate risk (from the
 * model, or from academic standing until a model exists). Officers claim a
 * case, log the actions taken, and close it with an outcome. Every step is in
 * the case's monitoring log and the audit log.
 */
const express = require('express');
const audit = require('../lib/audit');
const risk = require('../lib/risk');
const { route } = require('../lib/http');
const { ApiError, now, cleanText, iso } = require('../lib/util');
const S = require('../lib/security');
const V = require('../lib/validators');
const D = require('../lib/data');
const { recommendations } = require('../lib/recommend');

const router = express.Router();
const OPEN = ['open', 'claimed'];
const ACTIONS = ['Counseling session', 'Meeting with scholar', 'Coordination with HEI', 'Written warning issued', 'Study plan agreed',
  'Tutoring referral', 'Stipend records verified', 'Home or phone follow-up', 'Other'];
const OUTCOMES = ['Improved', 'No change', 'Recommended for termination', 'Scholar withdrew', 'Not needed after review'];

/* Opens cases for at-risk active scholars that have none open. Idempotent. */
async function refreshCases(trx) {
  const active = await D.scholarQuery(trx).whereIn('s.is_deactivated', [0, false]).where('s.status', 'active');
  const withRisk = await risk.attach(trx, active);
  const openIds = new Set((await trx('intervention_cases').whereIn('status', OPEN).select('scholar_id')).map((r) => r.scholar_id));
  let opened = 0; const t = now();
  for (const s of withRisk) {
    if (!['High', 'Moderate'].includes(s.risk.level) || openIds.has(s.id)) continue;
    const inconsistent = Number((await trx('stipend_disbursements').where({ scholar_id: s.id, status: 'Inconsistent' }).count({ n: '*' }).first()).n);
    const reason = s.risk.source === 'model'
      ? `Model rates this scholar ${s.risk.level} risk${s.risk.top_factors.length ? ` (main factor: ${s.risk.top_factors[0].label})` : ''}`
      : `Latest academic standing: ${s.academic_standing}`;
    await trx('intervention_cases').insert({ scholar_id: s.id, risk_level: s.risk.level, risk_source: s.risk.source, reason,
      recommended_actions_json: JSON.stringify(recommendations({ standing: s.academic_standing, topFactors: s.risk.top_factors, inconsistentStipends: inconsistent })),
      status: 'open', created_at: t, updated_at: t });
    opened += 1;
  }
  return opened;
}

async function caseJson(k, c, withLogs = false) {
  const s = await D.loadScholar(k, { 's.id': c.scholar_id });
  const names = await D.userNames(k, [c.claimed_by_id, c.closed_by_id]);
  const out = {
    id: c.id, status: c.status, risk_level: c.risk_level, risk_source: c.risk_source, reason: c.reason,
    recommended_actions: JSON.parse(c.recommended_actions_json || '[]'), claimed_by: names[c.claimed_by_id] ?? null, claimed_by_id: c.claimed_by_id,
    claimed_at: iso(c.claimed_at), outcome: c.outcome, outcome_notes: c.outcome_notes, closed_at: iso(c.closed_at), closed_by: names[c.closed_by_id] ?? null,
    created_at: iso(c.created_at), updated_at: iso(c.updated_at),
    scholar: s ? { code: s.scholar_code, municipality: s.municipality_name, hei: s.hei_name, year_level: s.year_level,
      academic_standing: s.academic_standing, program: s.program_name } : null,
  };
  if (withLogs) {
    const logs = await k('intervention_logs').where({ case_id: c.id }).orderBy('id', 'desc');
    const ln = await D.userNames(k, logs.map((l) => l.user_id));
    out.logs = logs.map((l) => ({ id: l.id, action_type: l.action_type, notes: l.notes, by: ln[l.user_id] ?? 'system', created_at: iso(l.created_at) }));
  }
  return out;
}
async function getCase(trx, id) {
  const c = await trx('intervention_cases').where({ id: Number(id) }).first();
  if (!c) throw new ApiError('Case not found.', 404);
  return c;
}
async function logEntry(trx, req, c, actionType, notes) {
  await trx('intervention_logs').insert({ case_id: c.id, user_id: req.user ? req.user.id : null, action_type: actionType, notes: notes || null, created_at: now() });
  await trx('intervention_cases').where({ id: c.id }).update({ updated_at: now() });
}

router.get('/interventions', route(async (req, res, trx) => {
  S.requireLogin(req);
  const opened = await refreshCases(trx);
  const tab = req.query.tab || 'open';
  const q = trx('intervention_cases');
  if (tab === 'open') q.where({ status: 'open' });
  else if (tab === 'mine') q.where({ status: 'claimed', claimed_by_id: req.user.id });
  else if (tab === 'claimed') q.where({ status: 'claimed' });
  else if (tab === 'closed') q.where({ status: 'closed' });
  const rows = await q.orderByRaw("CASE risk_level WHEN 'High' THEN 0 WHEN 'Moderate' THEN 1 ELSE 2 END").orderBy('updated_at', 'desc').limit(300);
  const counts = Object.fromEntries((await trx('intervention_cases').select('status').count({ n: '*' }).groupBy('status')).map((r) => [r.status, Number(r.n)]));
  const mine = Number((await trx('intervention_cases').where({ status: 'claimed', claimed_by_id: req.user.id }).count({ n: '*' }).first()).n);
  const outcomes = Object.fromEntries((await trx('intervention_cases').where({ status: 'closed' }).select('outcome').count({ n: '*' }).groupBy('outcome')).map((r) => [r.outcome, Number(r.n)]));
  const st = await require('../lib/analyticsClient').status();
  return { ok: true, cases: await Promise.all(rows.map((c) => caseJson(trx, c))), newly_opened: opened,
    counts: { open: counts.open || 0, claimed: counts.claimed || 0, closed: counts.closed || 0, mine }, outcomes,
    risk_source: st.model_trained ? 'model' : 'standing', actions: ACTIONS, outcome_options: OUTCOMES };
}));
router.get('/interventions/:id', route(async (req, res, trx) => {
  S.requireLogin(req);
  return { ok: true, case: await caseJson(trx, await getCase(trx, req.params.id), true), actions: ACTIONS, outcome_options: OUTCOMES };
}, { tx: false }));
router.post('/interventions/:id/claim', route(async (req, res, trx) => {
  S.requireLogin(req);
  const c = await getCase(trx, req.params.id);
  if (c.status !== 'open') throw new ApiError(c.status === 'claimed' ? 'Someone has already claimed this case.' : 'This case is closed.', 409);
  await trx('intervention_cases').where({ id: c.id }).update({ status: 'claimed', claimed_by_id: req.user.id, claimed_at: now(), updated_at: now() });
  await logEntry(trx, req, c, 'Claimed', null);
  await audit.log(trx, req, 'edit', 'Intervention case claimed', { targetType: 'intervention', targetId: c.id });
  return { ok: true, case: await caseJson(trx, await getCase(trx, c.id), true) };
}));
router.post('/interventions/:id/release', route(async (req, res, trx) => {
  S.requireLogin(req);
  const c = await getCase(trx, req.params.id);
  if (c.status !== 'claimed') throw new ApiError('Only a claimed case can be released.', 409);
  if (c.claimed_by_id !== req.user.id && req.user.role !== 'admin') throw new ApiError('Only the officer handling this case or an Administrator can release it.', 403);
  const reason = cleanText((req.body || {}).reason, 500);
  if (reason.length < 5) throw new ApiError('Say briefly why the case is being released.', 422, { reason: 'Say briefly why (e.g. reassigned to another officer).' });
  await trx('intervention_cases').where({ id: c.id }).update({ status: 'open', claimed_by_id: null, claimed_at: null, updated_at: now() });
  await logEntry(trx, req, c, 'Released', reason);
  await audit.log(trx, req, 'edit', 'Intervention case released', { targetType: 'intervention', targetId: c.id, details: { reason } });
  return { ok: true, case: await caseJson(trx, await getCase(trx, c.id), true) };
}));
router.post('/interventions/:id/log', route(async (req, res, trx) => {
  S.requireLogin(req);
  const c = await getCase(trx, req.params.id);
  if (c.status !== 'claimed') throw new ApiError('Claim the case before logging actions.', 409);
  if (c.claimed_by_id !== req.user.id && req.user.role !== 'admin') throw new ApiError('Only the officer handling this case can log actions.', 403);
  const d = V.requireJson(req);
  const errors = {};
  if (!ACTIONS.includes(d.action_type)) errors.action_type = 'Select the action taken.';
  const notes = cleanText(d.notes, 2000);
  if (notes.length < 10) errors.notes = 'Describe what was done and agreed (at least 10 characters).';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  await logEntry(trx, req, c, d.action_type, notes);
  await audit.log(trx, req, 'edit', 'Intervention action logged', { targetType: 'intervention', targetId: c.id, details: { action: d.action_type } });
  return { ok: true, case: await caseJson(trx, await getCase(trx, c.id), true) };
}));
router.post('/interventions/:id/close', route(async (req, res, trx) => {
  S.requireLogin(req);
  const c = await getCase(trx, req.params.id);
  if (c.status !== 'claimed') throw new ApiError('Only a claimed case can be closed.', 409);
  if (c.claimed_by_id !== req.user.id && req.user.role !== 'admin') throw new ApiError('Only the officer handling this case can close it.', 403);
  const d = V.requireJson(req);
  const errors = {};
  if (!OUTCOMES.includes(d.outcome)) errors.outcome = 'Select the outcome.';
  const notes = cleanText(d.notes, 2000);
  if (notes.length < 10) errors.notes = 'Summarize the result (at least 10 characters).';
  if (Object.keys(errors).length) throw new ApiError('Check the highlighted fields.', 422, errors);
  await trx('intervention_cases').where({ id: c.id }).update({ status: 'closed', outcome: d.outcome, outcome_notes: notes, closed_at: now(), closed_by_id: req.user.id, updated_at: now() });
  await logEntry(trx, req, c, 'Closed', `${d.outcome}: ${notes}`);
  await audit.log(trx, req, 'edit', 'Intervention case closed', { targetType: 'intervention', targetId: c.id, details: { outcome: d.outcome } });
  return { ok: true, case: await caseJson(trx, await getCase(trx, c.id), true) };
}));

module.exports = { router, refreshCases };
