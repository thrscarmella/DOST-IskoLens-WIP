/* ==========================================================================
   DOST-IskoLens — API client
   Every page talks to the Node.js backend through IskoAPI. It adds the CSRF
   token, turns server errors into readable messages, sends users back to
   sign-in when the session expires, and keeps the 30-minute idle timer.
   ========================================================================== */

/* Escape any text before putting it into innerHTML. Scholar names, notes and
   remarks are typed by users, so they must never be inserted raw. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const IskoFmt = {
  date(iso, opts) {
    if (!iso) return '—';
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso + (iso.endsWith('Z') || iso.length === 10 ? '' : 'Z'));
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-US', opts || { year: 'numeric', month: 'short', day: 'numeric' });
  },
  dateLong(iso) { return IskoFmt.date(iso, { year: 'numeric', month: 'long', day: 'numeric' }); },
  dateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');  // server times are UTC
    return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  },
  relative(iso) {
    if (!iso) return 'Never';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    const mins = Math.round((Date.now() - d) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
    const days = Math.round(hrs / 24);
    if (days < 8) return `${days} day${days > 1 ? 's' : ''} ago`;
    return IskoFmt.date(iso);
  },
  month(ym) {
    if (!ym) return '—';
    const [y, m] = ym.split('-');
    return new Date(+y, +m - 1, 1).toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  },
  peso(n) { return n === null || n === undefined ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); },
  yearLevel(n) { return n ? ['1st', '2nd', '3rd', '4th', '5th'][n - 1] + ' Year' : '—'; },
  gwa(v, scale) { return v === null || v === undefined ? '—' : (scale === 'percent' ? Number(v).toFixed(2) + '%' : Number(v).toFixed(2)); }
};

/* Risk level badge. source "model" = from the trained model; "standing" = from academic standing (no model yet). */
function riskBadge(risk) {
  if (!risk || !risk.level) return '<span class="badge badge-gray">—</span>';
  const cls = { High: 'badge-red', Moderate: 'badge-amber', Low: 'badge-green' }[risk.level] || 'badge-gray';
  const tip = risk.source === 'model' ? 'From the risk model' : 'Based on academic standing (no risk model yet)';
  return `<span class="badge ${cls}" title="${tip}">${esc(risk.level)}${risk.source === 'model' ? '' : '*'}</span>`;
}
function standingBadge(standing) {
  if (!standing) return '<span class="badge badge-gray">No record yet</span>';
  const cls = standing === 'Good Standing' ? 'badge-green' : standing === 'Probation' ? 'badge-amber' : 'badge-red';
  return `<span class="badge ${cls}">${esc(standing)}</span>`;
}
function scholarStatusBadge(status, label) {
  const cls = { active: 'badge-green', graduated: 'badge-blue', pending_termination: 'badge-amber', terminated: 'badge-red' }[status] || 'badge-gray';
  return `<span class="badge ${cls}">${esc(label || status)}</span>`;
}

const IskoAPI = (function () {
  let csrf = (window.ISKOLENS_SESSION && window.ISKOLENS_SESSION.csrf) || null;

  class ApiError extends Error {
    constructor(message, status, body) {
      super(message);
      this.status = status;
      this.fieldErrors = (body && body.field_errors) || {};
      this.code = body && body.code;
    }
  }

  async function ensureCsrf() {
    if (csrf) return csrf;
    const r = await fetch('/api/auth/csrf', { credentials: 'same-origin' });
    csrf = (await r.json()).csrf;
    return csrf;
  }

  async function request(method, url, body, opts = {}) {
    const headers = { 'Accept': 'application/json' };
    if (method !== 'GET') headers['X-CSRF-Token'] = await ensureCsrf();
    if (opts.passive) headers['X-Passive-Request'] = '1';
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

    let res;
    try {
      res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
    } catch (e) {
      throw new ApiError('Cannot reach the IskoLens server. Check your network connection and try again.', 0, null);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (data && data.csrf) csrf = data.csrf;

    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status}).`;
      if (res.status === 401 && !opts.allow401) {
        const reason = data && data.code === 'session_expired' ? '&reason=timeout' : '';
        window.location.href = '/pages/login.html?next=' + encodeURIComponent(location.pathname + location.search) + reason;
      }
      if (res.status === 403 && data && data.code === 'csrf') csrf = null;
      if (res.status === 403 && data && data.code === 'two_factor_setup_required' && !location.pathname.endsWith('/profile.html')) {
        window.location.href = '/pages/profile.html?tab=security&setup2fa=1';
      }
      throw new ApiError(message, res.status, data);
    }
    if (!opts.passive) IskoIdle.touch(true);
    return data;
  }

  /* Shows field errors next to inputs. `map` is { apiField: inputElementId }. */
  function showFieldErrors(err, map) {
    clearFieldErrors(map);
    Object.entries(err.fieldErrors || {}).forEach(([field, msg]) => {
      const id = map && map[field];
      const el = id && document.getElementById(id);
      if (!el) return;
      el.classList.add('field-error');
      el.style.borderColor = '#ef4444';
      const note = document.createElement('div');
      note.className = 'api-field-error';
      note.textContent = msg;
      el.insertAdjacentElement('afterend', note);
    });
  }
  function clearFieldErrors(map) {
    Object.values(map || {}).forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.remove('field-error');
      el.style.borderColor = '';
      if (el.nextElementSibling && el.nextElementSibling.classList.contains('api-field-error')) el.nextElementSibling.remove();
    });
  }

  /* Report an error as a toast; returns the error for chaining. */
  function fail(err, title) {
    showToast(title || 'Could not complete the action', err.message, 'error');
    return err;
  }

  let lookupsPromise = null;
  function lookups() {
    if (!lookupsPromise) lookupsPromise = request('GET', '/api/lookups');
    return lookupsPromise;
  }

  /* Fills a <select> with options. items: [{id, name}] or strings. */
  function fillSelect(select, items, placeholder, selected, textKey = 'name', valueKey = 'id') {
    if (typeof select === 'string') select = document.getElementById(select);
    if (!select) return;
    const opts = (placeholder !== null ? [`<option value="">${esc(placeholder || 'Select')}</option>`] : [])
      .concat(items.map(it => {
        const value = typeof it === 'object' ? it[valueKey] : it;
        const text = typeof it === 'object' ? it[textKey] : it;
        return `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(text)}</option>`;
      }));
    select.innerHTML = opts.join('');
  }

  function download(url) {
    // A plain navigation keeps the session cookie and lets the browser save the file.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return {
    ApiError, request, lookups, fillSelect, showFieldErrors, clearFieldErrors, fail, download, ensureCsrf,
    get: (u, o) => request('GET', u, undefined, o),
    post: (u, b, o) => request('POST', u, b === undefined ? {} : b, o),
    patch: (u, b, o) => request('PATCH', u, b, o),
    put: (u, b, o) => request('PUT', u, b, o),
  };
})();

/* --------------------------------------------------------------------------
   Idle timer — mirrors the server's 30-minute rule. Real user activity
   (mouse, keys, touch, scroll) pings the server at most every 4 minutes so a
   user who is reading a long page is not signed out. After 30 idle minutes
   the page signs out by itself.
   -------------------------------------------------------------------------- */
const IskoIdle = (function () {
  const session = window.ISKOLENS_SESSION;
  const limitMs = ((session && session.idle_timeout_minutes) || 30) * 60000;
  let lastActivity = Date.now();
  let lastPing = Date.now();
  let warned = false;

  function touch(fromRequest) {
    lastActivity = Date.now();
    warned = false;
    if (fromRequest) lastPing = Date.now();
  }
  function onActivity() {
    touch(false);
    if (session && Date.now() - lastPing > 4 * 60000) {
      lastPing = Date.now();
      IskoAPI.post('/api/auth/ping').catch(() => {});
    }
  }
  if (session) {
    ['mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(evt =>
      window.addEventListener(evt, onActivity, { passive: true }));
    setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle >= limitMs) {
        window.location.href = '/pages/login.html?reason=timeout&next=' + encodeURIComponent(location.pathname + location.search);
      } else if (!warned && idle >= limitMs - 2 * 60000) {
        warned = true;
        if (typeof showToast === 'function') showToast('Still there?', 'You will be signed out in 2 minutes because of inactivity. Move the mouse or press a key to stay signed in.', 'warning');
      }
    }, 15000);
  }
  return { touch };
})();

(function syncAppearance() {
  const prefs = window.ISKOLENS_SESSION && window.ISKOLENS_SESSION.preferences;
  if (!prefs) return;
  try {
    const changed = localStorage.getItem('iskolens_theme') !== prefs.theme || localStorage.getItem('iskolens_font_size') !== prefs.font_size;
    localStorage.setItem('iskolens_theme', prefs.theme || 'light');
    localStorage.setItem('iskolens_font_size', prefs.font_size || 'medium');
    if (changed) {
      let t = prefs.theme || 'light';
      if (t === 'system') t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) { /* storage blocked: the theme still applies on this page */ }
})();
