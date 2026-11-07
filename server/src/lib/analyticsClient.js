'use strict';
/* Calls to the Python analytics service (ANALYTICS_URL). */
const config = require('../config');

async function call(pathname, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.ANALYTICS_URL.replace(/\/$/, '')}${pathname}`, {
      method, signal: ctrl.signal, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json() };
  } finally { clearTimeout(timer); }
}
/* {available, model_trained, ...} - never throws */
async function status() {
  try { const r = await call('/health', { timeoutMs: 3000 }); return { available: true, ...r.data }; } catch { return { available: false, model_trained: false }; }
}
module.exports = { call, status };
