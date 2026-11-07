'use strict';
/*
 * Two-step verification with authenticator apps (TOTP, RFC 6238): Google
 * Authenticator, Microsoft Authenticator and similar. The shared secret is
 * stored encrypted; recovery codes are stored only as hashes.
 */
const crypto = require('crypto');
const config = require('../config');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = ''; let out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function code(secretB32, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
/* Accepts the current 30-second code and one step either side (clock drift). */
function verify(secretB32, token, now = Date.now()) {
  const t = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const c = Math.floor(now / 30000);
  return [-1, 0, 1].some((d) => crypto.timingSafeEqual(Buffer.from(code(secretB32, c + d)), Buffer.from(t)));
}
const newSecret = () => base32(crypto.randomBytes(20));

const key = () => crypto.createHash('sha256').update(`totp:${config.SECRET_KEY}`).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
function decrypt(stored) {
  const [iv, tag, enc] = String(stored).split('.').map((x) => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');
function newRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
}
const otpauthUri = (secret, account) =>
  `otpauth://totp/${encodeURIComponent(`DOST-IskoLens:${account}`)}?secret=${secret}&issuer=${encodeURIComponent('DOST-IskoLens')}&algorithm=SHA1&digits=6&period=30`;

module.exports = { verify, newSecret, encrypt, decrypt, hashCode, newRecoveryCodes, otpauthUri, code };
