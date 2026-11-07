'use strict';
/* Outgoing email: SMTP when MAIL_SERVER is set, otherwise instance/outbox/*.eml */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const config = require('../config');

const mailConfigured = () => !!config.MAIL_SERVER;
let transport = null;

async function sendMail(to, subject, body) {
  if (!mailConfigured()) {
    const outbox = path.join(config.INSTANCE_DIR, 'outbox');
    fs.mkdirSync(outbox, { recursive: true });
    const d = new Date();
    const stamp = d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-') + String(process.hrtime.bigint() % 1000n).padStart(3, '0');
    const eml = `From: ${config.MAIL_FROM}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: 8bit\r\nMIME-Version: 1.0\r\n\r\n${body}\r\n`;
    fs.writeFileSync(path.join(outbox, `${stamp}.eml`), eml, 'utf8');
    console.info(`Email not sent (MAIL_SERVER not set); saved to outbox: ${subject}`);
    return false;
  }
  try {
    if (!transport) {
      transport = nodemailer.createTransport({
        host: config.MAIL_SERVER, port: config.MAIL_PORT, secure: config.MAIL_PORT === 465,
        requireTLS: config.MAIL_USE_TLS && config.MAIL_PORT !== 465,
        auth: config.MAIL_USERNAME ? { user: config.MAIL_USERNAME, pass: config.MAIL_PASSWORD } : undefined,
        connectionTimeout: 15000,
      });
    }
    await transport.sendMail({ from: config.MAIL_FROM, to, subject, text: body });
    return true;
  } catch (err) {
    console.error(`Failed to send email: ${subject}`, err.message);
    return false;
  }
}
module.exports = { sendMail, mailConfigured };
