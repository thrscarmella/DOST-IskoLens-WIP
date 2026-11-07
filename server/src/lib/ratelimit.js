'use strict';
/* Limits per network address, on top of the per-account lockout (in memory). */
const config = require('../config');
const { ApiError } = require('./util');
const { clientIp } = require('./security');
const events = new Map();
const key = (bucket, req) => `${bucket}|${clientIp(req) || 'unknown'}`;

function check(req, bucket, limitConfig, windowSeconds, message) {
  const limit = config[limitConfig];
  const k = key(bucket, req);
  const cutoff = Date.now() - windowSeconds * 1000;
  const q = (events.get(k) || []).filter((t) => t >= cutoff);
  events.set(k, q);
  if (q.length >= limit) {
    const wait = Math.floor(windowSeconds - (Date.now() - q[0]) / 1000) + 1;
    const minutes = Math.max(1, Math.round(wait / 60));
    throw new ApiError(`${message} Try again in about ${minutes} minute${minutes !== 1 ? 's' : ''}.`, 429, null, 'rate_limited');
  }
}
function hit(req, bucket) {
  const k = key(bucket, req);
  events.set(k, [...(events.get(k) || []), Date.now()]);
}
function reset() { events.clear(); }
module.exports = { check, hit, reset };
