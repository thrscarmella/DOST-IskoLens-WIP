'use strict';
/* In-app notifications (the bell) and academic alert emails. */
const config = require('../config');
const { now } = require('./util');
const { sendMail } = require('./mailer');

async function notify(trx, userIds, kind, title, body = null, link = null, urgency = 'gray') {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  const t = now();
  await trx('notifications').insert(ids.map((uid) => ({
    user_id: uid, kind, title: String(title).slice(0, 200), body: body ? String(body).slice(0, 300) : null,
    link, urgency, is_read: false, created_at: t,
  })));
}
async function activeUserIds(trx, role = null, exclude = null) {
  let q = trx('users').where({ status: 'active' });
  if (role) q = q.where({ role });
  return (await q.select('id')).map((r) => r.id).filter((id) => id !== exclude);
}
const notifyAdmins = async (trx, kind, title, body = null, link = null, urgency = 'amber', exclude = null) =>
  notify(trx, await activeUserIds(trx, 'admin', exclude), kind, title, body, link, urgency);
const notifyOfficers = async (trx, kind, title, body = null, link = null, urgency = 'amber', exclude = null) =>
  notify(trx, await activeUserIds(trx, 'officer', exclude), kind, title, body, link, urgency);

async function emailAcademicAlert(trx, title, body, link) {
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const users = await trx('users').where({ status: 'active' }).whereIn('pref_email_high_risk', [1, true]);
  for (const u of users) {
    await sendMail(u.email, `[IskoLens] ${title}`,
      `Hi ${u.first_name},\n\n${title}.\n${body}\n\nOpen the record: ${base}/pages/${link}\n\n` +
      'You receive this because academic alerts are on in your IskoLens Settings.\n\nDOST-IskoLens');
  }
}
module.exports = { notify, notifyAdmins, notifyOfficers, activeUserIds, emailAcademicAlert };
