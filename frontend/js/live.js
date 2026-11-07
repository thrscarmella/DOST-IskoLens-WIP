/* Shared helpers for the live analytics, interventions, KPI and system pages. */
const Live = (function () {
  const charts = {};
  function empty(title, text, icon = 'fa-hourglass-half') {
    return `<div class="empty-state no-data-yet"><div class="empty-icon"><i class="fa-solid ${icon}" aria-hidden="true"></i></div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`;
  }
  const noData = (what) => empty('No data yet', `${what} will appear here once the DOST Davao Oriental dataset is loaded.`);
  const serviceOff = () => empty('Analytics service not running', 'Start the Python analytics service (see README), then refresh this page.', 'fa-plug-circle-xmark');
  function table(columns, rows, caption = '') {
    if (!rows.length) return '<p class="text-sm text-muted">No records yet.</p>';
    return `<div class="table-wrap"><table class="data-table">${caption ? `<caption class="visually-hidden">${esc(caption)}</caption>` : ''}
      <thead><tr>${columns.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${v === null || v === undefined ? '—' : (typeof v === 'string' && v.startsWith('<') ? v : esc(String(v)))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }
  function chart(id, type, labels, datasets, opts = {}) {
    const el = document.getElementById(id);
    if (!el || typeof Chart === 'undefined') return;
    if (charts[id]) charts[id].destroy();
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const tick = dark ? '#b4bed4' : '#4c576e';
    const palette = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#475569', '#0d9488'];
    charts[id] = new Chart(el, {
      type, data: { labels, datasets: datasets.map((d, i) => ({ backgroundColor: type === 'doughnut' ? palette : (d.color || palette[i]), borderColor: d.color || palette[i], borderWidth: type === 'line' ? 2 : 0, ...d })) },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: type === 'doughnut' || datasets.length > 1, labels: { color: tick } } },
        scales: type === 'doughnut' ? {} : { x: { ticks: { color: tick } }, y: { beginAtZero: true, ticks: { color: tick } } }, ...opts },
    });
  }
  const box = (id, h = 260) => `<div style="position:relative; height:${h}px;"><canvas id="${id}" role="img" aria-label="Chart"></canvas></div>`;
  const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
  return { empty, noData, serviceOff, table, chart, box, pct };
}());
