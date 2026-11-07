'use strict';
/* Weekly summary email (the "Weekly summary digest" setting). */
const config = require('../config');
const { sendMail } = require('./mailer');
const { now } = require('./util');
const { NOT_GOOD } = require('./standing');

const n = async (q) => Number((await q.count({ n: '*' }).first()).n);
async function buildDigest(k, user, days = 7) {
  const since = now(-days * 86400000);
  const live = () => k('scholars').whereIn('is_deactivated', [0, false]);
  const lines = [
    `Active scholars: ${await n(live().where({ status: 'active' }))}`,
    `New scholar records this week: ${await n(live().where('created_at', '>=', since))}`,
    `GWA records encoded this week: ${await n(k('academic_records').where('created_at', '>=', since))}`,
    `Active scholars below the GWA requirement: ${await n(live().where({ status: 'active' }).whereIn('academic_standing', NOT_GOOD))}`,
    `Termination reviews pending: ${await n(k('termination_requests').where({ status: 'pending' }))}`,
    `Terminations approved this week: ${await n(k('termination_requests').where({ status: 'approved' }).where('reviewed_at', '>=', since))}`,
  ];
  if (user.role === 'admin') {
    lines.push(`Account requests waiting for approval: ${await n(k('users').where({ status: 'pending' }))}`);
    lines.push(`Locked accounts: ${await n(k('users').whereIn('is_locked', [1, true]))}`);
  } else {
    lines.push(`Scholar records you encoded this week: ${await n(k('scholars').where({ created_by_id: user.id }).where('created_at', '>=', since))}`);
  }
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const body = `Hi ${user.first_name},\n\nHere is your DOST-IskoLens summary for the past ${days} days:\n\n${lines.map((l) => `  - ${l}`).join('\n')}` +
    `\n\nOpen IskoLens: ${base}/pages/dashboard.html\n\nYou receive this because the weekly summary digest is on in your IskoLens Settings.\n\nDOST-IskoLens`;
  return ['DOST-IskoLens weekly summary', body];
}
async function sendDigest(k, user) { const [s, b] = await buildDigest(k, user); return sendMail(user.email, s, b); }
async function sendAll(k) {
  const users = await k('users').where({ status: 'active' }).whereIn('pref_weekly_digest', [1, true]);
  for (const u of users) await sendDigest(k, u);
  console.info(`Weekly digest sent to ${users.length} user(s)`);
  return users.length;
}
module.exports = { buildDigest, sendDigest, sendAll };
