/* ==========================================================================
   DOST-IskoLens — Navigation Shell Renderer
   Builds sidebar + topbar dynamically so markup isn't duplicated per page.
   ========================================================================== */

function getNavConfig(role) {
  const analytics = [
    { id: 'descriptive', label: 'Descriptive', icon: 'fa-chart-line', href: 'descriptive.html',
      children: [
        { label: 'Demographics', href: 'descriptive.html#demographics' },
        { label: 'Acceptance Rates', href: 'descriptive.html#acceptance-rates' },
        { label: 'HEI Distribution', href: 'descriptive.html#hei-distribution' },
        { label: 'Stipend Disbursement', href: 'descriptive.html#stipend-disbursement' },
        { label: 'Graduation & Termination', href: 'descriptive.html#graduation-termination' },
        { label: 'School Performance Ranks', href: 'descriptive.html#school-rankings' }
      ] },
    { id: 'diagnostic', label: 'Diagnostic', icon: 'fa-magnifying-glass-chart', href: 'diagnostic.html',
      children: [
        { label: 'Root Cause Analysis', href: 'diagnostic.html#root-cause' },
        { label: 'Termination Breakdown', href: 'diagnostic.html#termination-breakdown' },
        { label: 'School & Municipal Rates', href: 'diagnostic.html#school-municipal-rates' },
        { label: 'School Performance Diagnostic', href: 'diagnostic.html#school-performance-diagnostic' }
      ] },
    { id: 'predictive', label: 'Predictive', icon: 'fa-wand-magic-sparkles', href: 'predictive.html',
      children: [
        { label: 'Termination Risk Levels', href: 'predictive.html#termination-risk-levels' },
        { label: 'Graduation Forecast', href: 'predictive.html#graduation-forecast' },
        { label: 'Applicant Volume Forecast', href: 'predictive.html#applicant-volume-forecast' },
        { label: 'School Performance Forecast', href: 'predictive.html#school-performance-forecast' }
      ] },
    { id: 'prescriptive', label: 'Prescriptive', icon: 'fa-clipboard-list', href: 'prescriptive.html',
      children: [
        { label: 'Intervention Recommendation', href: 'prescriptive.html#intervention-recommendation' },
        { label: 'School Caravan Planning', href: 'prescriptive.html#school-caravan-planning' },
        { label: 'Municipal Priority Map', href: 'prescriptive.html#municipal-priority-map' },
        { label: 'Intervention Status Overview', href: 'prescriptive.html#status-overview' }
      ] }
  ];

  // KPI Reports is Administrator-only: the Admin compiles and submits these
  // reports to higher management, so Officers don't need (or get) this page.
  const reports = [];
  if (role === 'admin') {
    reports.push({ id: 'kpi', label: 'KPI Reports', icon: 'fa-chart-column', href: 'kpi-reports.html',
      children: [{ label: 'Generate Reports', href: 'kpi-reports.html' }, { label: 'View Generated Reports', href: 'kpi-report-view.html' }] });
  }

  const overview = [
    { id: 'dashboard', label: 'Dashboard', icon: 'fa-gauge-high', href: 'dashboard.html' }
  ];

  const scholarRecords = { id: 'scholars', label: 'Scholar Records', icon: 'fa-user-graduate', href: 'scholar-records.html',
    children: [{ label: 'Encode Records', href: 'encode-scholar.html' }, { label: 'View All Scholars', href: 'scholar-records.html' }] };

  const management = [scholarRecords];
  if (role === 'admin') {
    management.push({ id: 'users', label: 'User Management', icon: 'fa-users-gear', href: 'user-management.html' });
    management.push({ id: 'reference', label: 'Reference Lists', icon: 'fa-list-check', href: 'reference-lists.html' });
  }
  management.push({ id: 'geomap', label: 'DOST GeoMap', icon: 'fa-map-location-dot', href: 'geomap.html' });

  const others = [];
  if (role === 'admin') {
    others.push({ id: 'sysmanagement', label: 'System Management', icon: 'fa-server', href: 'system-management.html' });
    others.push({ id: 'auditlogs', label: 'Audit Logs', icon: 'fa-clipboard-check', href: 'audit-logs.html' });
    others.push({ id: 'dataprotection', label: 'Data Protection', icon: 'fa-shield-halved', href: 'data-protection.html' });
  }
  others.push({ id: 'settings', label: 'Settings', icon: 'fa-gear', href: 'profile.html?tab=settings' });
  others.push({ id: 'profile', label: 'My Profile', icon: 'fa-circle-user', href: 'profile.html' });
  others.push({ id: 'privacy', label: 'Privacy Notice', icon: 'fa-user-shield', href: 'privacy-notice.html' });

  return { overview, management, reports, analytics, others };
}

function renderShell(activePageId) {
  const role = ISKOLENS_DATA.currentUser.role;
  const user = ISKOLENS_DATA.currentUser;
  const nav = getNavConfig(role);

  function renderItem(item) {
    const isActive = item.id === activePageId;
    const hasChildren = !!item.children;
    const currentFile = window.location.pathname.split('/').pop();
    const currentHash = window.location.hash;

    return `
      <li class="nav-item ${isActive ? 'active' : ''}" data-active-item="${isActive ? 'true' : 'false'}">
        <a class="nav-link" href="${item.href}" ${hasChildren ? `onclick="return toggleSubmenu(event, this)"` : ''}>
          <i class="fa-solid ${item.icon} nav-icon"></i>
          <span>${item.label}</span>
          ${hasChildren ? '<i class="fa-solid fa-chevron-down nav-caret"></i>' : ''}
        </a>
        ${hasChildren ? `<ul class="nav-submenu">
          ${item.children.map(c => {
            const [file, hash] = c.href.split('#');
            const sameFile = file === currentFile;
            // Non-hash children (e.g. "View Generated Reports") are active purely by filename match.
            // Hash children start inactive; scrollspy assigns the active one once the page has rendered.
            const staticActive = sameFile && !hash && (!currentHash || c.href.includes(currentHash));
            return `<li><a class="nav-sublink ${staticActive ? 'active' : ''}" data-hash="${hash || ''}" data-samefile="${sameFile}" href="${c.href}">${c.label}</a></li>`;
          }).join('')}
        </ul>` : ''}
      </li>`;
  }

  const sidebarHtml = `
    <div class="sidebar-scrim" onclick="closeMobileSidebar()"></div>
    <aside class="sidebar">
      <div class="sidebar-brand">
        <img class="brand-logo" src="../assets/images/dost-logo.png" alt="DOST IskoLens logo">
        <div class="sidebar-brand-text">
          <span class="eyebrow">Science Education Institute</span>
          <span class="brand-name">DOST&nbsp;-&nbsp;IskoLens</span>
        </div>
      </div>
      <nav class="sidebar-scroll">
        <div class="nav-group-label">Overview</div>
        <ul>${nav.overview.map(renderItem).join('')}</ul>
        <div class="nav-group-label">Management</div>
        <ul>${nav.management.map(renderItem).join('')}</ul>
        ${nav.reports.length ? `<div class="nav-group-label">Reports</div><ul>${nav.reports.map(renderItem).join('')}</ul>` : ''}
        <div class="nav-group-label">Analytics</div>
        <ul>${nav.analytics.map(renderItem).join('')}</ul>
        <div class="nav-group-label">Others</div>
        <ul>${nav.others.map(renderItem).join('')}</ul>
      </nav>
      <div class="sidebar-footer">
        <button class="footer-trigger" id="footer-trigger" onclick="toggleProfileMenu(event)">
          <div class="avatar-circle">${user.initials}</div>
          <div class="sidebar-footer-text">
            <div class="footer-name">${user.name}</div>
            <div class="footer-email">${user.email}</div>
          </div>
          <i class="fa-solid fa-chevron-up footer-caret"></i>
        </button>
        <div class="profile-menu" id="profile-menu">
          <div class="profile-menu-header">
            <div class="pm-name">${user.name}</div>
            <div class="pm-email">${user.email}</div>
          </div>
          <a class="profile-menu-item" href="profile.html"><i class="fa-solid fa-circle-user"></i> My Profile</a>
          <a class="profile-menu-item" href="profile.html?tab=settings"><i class="fa-solid fa-gear"></i> Settings</a>
          <div class="profile-menu-divider"></div>
          <button class="profile-menu-item danger" onclick="logoutUser()"><i class="fa-solid fa-right-from-bracket"></i> Log Out</button>
        </div>
      </div>
    </aside>`;


  const topbarHtml = `
    <header class="topbar">
      <div class="topbar-left">
        <button class="sidebar-toggle-btn" onclick="toggleSidebar()" aria-label="Toggle sidebar">
          <i class="fa-solid fa-bars"></i>
        </button>
      </div>
      <div class="topbar-right">
        <div class="notif-wrap">
          <button class="notif-bell-btn" onclick="toggleNotifPanel(event)" aria-label="Notifications">
            <i class="fa-solid fa-bell"></i>
            <span class="notif-dot" id="notif-dot" style="display:none;"></span>
          </button>
          <div class="notif-panel" id="notif-panel">
            <div class="notif-panel-head">
              <span>Notifications</span>
              <span class="badge badge-blue" id="notif-count">0 new</span>
            </div>
            <div class="notif-panel-body" id="notif-body"><div class="notif-empty">Loading…</div></div>
            <a class="notif-panel-footer" href="#" onclick="markAllNotificationsRead(event)">Mark all as read</a>
          </div>
        </div>
        <div class="topbar-clock">
          <div class="clock-label">Philippine Standard Time</div>
          <div class="clock-value" id="live-clock">—</div>
        </div>
      </div>
    </header>`;

  const sidebarMount = document.getElementById('sidebar-mount');
  const topbarMount = document.getElementById('topbar-mount');
  if (sidebarMount) sidebarMount.innerHTML = sidebarHtml;
  if (topbarMount) topbarMount.innerHTML = topbarHtml;
  if (sidebarMount) renderFloatingWidgets();

  // The active section's submenu is shown immediately on page load (no
  // animation here, matching how a pre-opened menu behaves) — the smooth
  // slide animation is reserved for when a user actually clicks a category
  // to expand/collapse it in place, via toggleSubmenu()/slideToggle() below.
  const activeItem = document.querySelector('.nav-item[data-active-item="true"]');
  if (activeItem) {
    const activeSubmenu = activeItem.querySelector(':scope > .nav-submenu');
    if (activeSubmenu) {
      activeItem.classList.add('open');
      activeSubmenu.style.display = 'flex';
    }
  }

  showSampleDataBanner(activePageId);
  improveAccessibility();
  startClock();
  loadNotifications();
  setInterval(loadNotifications, 60000);
  restoreSidebarState();
  initScrollSpy(activePageId);
}

/* ==========================================================================
   Scrollspy — highlights the sub-nav item matching the section currently
   in view, so users always see exactly where they are on long analytics
   pages. Falls back gracefully if no anchor sections exist on the page.
   ========================================================================== */
function initScrollSpy(activePageId) {
  const spyPages = ['descriptive', 'diagnostic', 'predictive', 'prescriptive'];
  if (!spyPages.includes(activePageId)) return;

  const allSameFileLinks = Array.from(document.querySelectorAll('.nav-sublink[data-samefile="true"]'));
  const hashLinks = allSameFileLinks.filter(a => a.dataset.hash);
  if (!hashLinks.length) return;

  const sections = hashLinks
    .map(a => ({ link: a, el: document.getElementById(a.dataset.hash) }))
    .filter(s => s.el);
  if (!sections.length) return;

  // If a non-hash sibling pointing at this same file is already marked
  // active (e.g. "View Generated Reports" under KPI Reports), that item is
  // a distinct destination in its own right — don't let scrollspy hijack
  // the highlight to a section by default.
  const hasActiveNonHashSibling = allSameFileLinks.some(a => !a.dataset.hash && a.classList.contains('active'));

  function setActive(hash) {
    hashLinks.forEach(a => a.classList.toggle('active', a.dataset.hash === hash));
    if (hash) {
      allSameFileLinks.filter(a => !a.dataset.hash).forEach(a => a.classList.remove('active'));
    }
  }

  const initialHash = (window.location.hash || '').replace('#', '');
  if (initialHash) {
    setActive(initialHash);
  } else if (!hasActiveNonHashSibling) {
    setActive(sections[0].link.dataset.hash);
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const match = sections.find(s => s.el === entry.target);
        if (match) setActive(match.link.dataset.hash);
      }
    });
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });

  sections.forEach(s => observer.observe(s.el));
}

/* ==========================================================================
   Notifications — role-scoped. Officers see items tied to their own
   caseload (tasks, risk follow-ups); Admins see system-wide items needing
   administrative attention.
   ========================================================================== */
/* Notifications come from /api/notifications. They are loaded after the
   shell renders, refreshed every minute, and marked read when opened. The
   poll is sent as a "passive" request so it never keeps an idle session
   alive. */
function renderNotifications(data) {
  const dot = document.getElementById('notif-dot');
  const count = document.getElementById('notif-count');
  const body = document.getElementById('notif-body');
  if (!body) return;
  const unread = data.unread || 0;
  if (dot) { dot.textContent = unread > 99 ? '99+' : unread; dot.style.display = unread ? '' : 'none'; }
  if (count) count.textContent = `${unread} new`;
  const items = data.notifications || [];
  body.innerHTML = items.length ? items.map(n => `
    <a class="notif-row${n.is_read ? ' is-read' : ''}" href="${esc(n.link || '#')}" data-id="${n.id}" onclick="return openNotification(event, this)">
      <div class="notif-flag ${esc(n.urgency)}"></div>
      <div class="notif-text"><div class="n-main">${esc(n.title)}</div><div class="n-sub">${esc(n.body || '')} · ${esc(IskoFmt.relative(n.created_at))}</div></div>
    </a>`).join('') : `<div class="notif-empty">No notifications yet</div>`;
}

function loadNotifications() {
  if (typeof IskoAPI === 'undefined') return;
  IskoAPI.get('/api/notifications', { passive: true }).then(renderNotifications).catch(() => {});
}

function openNotification(evt, el) {
  evt.preventDefault();
  const href = el.getAttribute('href');
  IskoAPI.post(`/api/notifications/${el.dataset.id}/read`).catch(() => {}).finally(() => {
    if (href && href !== '#') window.location.href = href; else loadNotifications();
  });
  return false;
}

function markAllNotificationsRead(evt) {
  evt.preventDefault();
  evt.stopPropagation();
  IskoAPI.post('/api/notifications/read-all').then(loadNotifications).catch(err => IskoAPI.fail(err));
}

function toggleNotifPanel(evt) {
  evt.stopPropagation();
  document.getElementById('notif-panel').classList.toggle('open');
}

document.addEventListener('click', (e) => {
  const panel = document.getElementById('notif-panel');
  if (panel && panel.classList.contains('open') && !e.target.closest('.notif-wrap')) {
    panel.classList.remove('open');
  }
});

/* ==========================================================================
   Smooth submenu slide — real measured-height animation (not a CSS
   max-height approximation), so the motion is genuinely smooth regardless
   of how tall a given submenu actually is. Adapted to our flex-column
   submenu layout: opens to display:flex rather than a generic block guess.
   ========================================================================== */
const SUBMENU_ANIMATION_MS = 300;

function slideUp(target, duration = SUBMENU_ANIMATION_MS) {
  target.style.transitionProperty = 'height, margin, padding';
  target.style.transitionDuration = `${duration}ms`;
  target.style.transitionTimingFunction = 'cubic-bezier(0.4, 0, 0.2, 1)';
  target.style.boxSizing = 'border-box';
  target.style.height = `${target.offsetHeight}px`;
  target.offsetHeight; // force reflow so the height above is committed before animating to 0
  target.style.overflow = 'hidden';
  target.style.height = '0';
  target.style.paddingTop = '0';
  target.style.paddingBottom = '0';
  target.style.marginTop = '0';
  target.style.marginBottom = '0';
  window.setTimeout(() => {
    target.style.display = 'none';
    target.style.removeProperty('height');
    target.style.removeProperty('padding-top');
    target.style.removeProperty('padding-bottom');
    target.style.removeProperty('margin-top');
    target.style.removeProperty('margin-bottom');
    target.style.removeProperty('overflow');
    target.style.removeProperty('transition-duration');
    target.style.removeProperty('transition-property');
    target.style.removeProperty('transition-timing-function');
  }, duration);
}

function slideDown(target, duration = SUBMENU_ANIMATION_MS) {
  target.style.removeProperty('display');
  let display = window.getComputedStyle(target).display;
  if (display === 'none') display = 'flex';
  target.style.display = display;
  const height = target.offsetHeight;
  target.style.overflow = 'hidden';
  target.style.height = '0';
  target.style.paddingTop = '0';
  target.style.paddingBottom = '0';
  target.style.marginTop = '0';
  target.style.marginBottom = '0';
  target.offsetHeight; // force reflow before animating to the measured height
  target.style.boxSizing = 'border-box';
  target.style.transitionProperty = 'height, margin, padding';
  target.style.transitionDuration = `${duration}ms`;
  target.style.transitionTimingFunction = 'cubic-bezier(0.4, 0, 0.2, 1)';
  target.style.height = `${height}px`;
  target.style.removeProperty('padding-top');
  target.style.removeProperty('padding-bottom');
  target.style.removeProperty('margin-top');
  target.style.removeProperty('margin-bottom');
  window.setTimeout(() => {
    target.style.removeProperty('height');
    target.style.removeProperty('overflow');
    target.style.removeProperty('transition-duration');
    target.style.removeProperty('transition-property');
    target.style.removeProperty('transition-timing-function');
  }, duration);
}

function slideToggle(target, duration = SUBMENU_ANIMATION_MS) {
  if (window.getComputedStyle(target).display === 'none') return slideDown(target, duration);
  return slideUp(target, duration);
}

function toggleSubmenu(evt, el) {
  evt.preventDefault();
  const item = el.closest('.nav-item');
  const submenu = item.querySelector(':scope > .nav-submenu');
  if (!submenu) return false;
  item.classList.toggle('open');
  slideToggle(submenu);
  return false;
}

function toggleSidebar() {
  const shell = document.querySelector('.app-shell');
  if (window.innerWidth <= 900) {
    shell.classList.toggle('sidebar-mobile-open');
  } else {
    shell.classList.toggle('sidebar-collapsed');
    localStorage.setItem('iskolens_sidebar_collapsed', shell.classList.contains('sidebar-collapsed'));
  }
}

/* ==========================================================================
   Profile menu — click the avatar/name in the sidebar footer to reveal
   My Profile, Settings, and Log Out. Mirrors the notification bell pattern
   so the interaction feels consistent across the app.
   ========================================================================== */
function toggleProfileMenu(evt) {
  evt.stopPropagation();
  document.getElementById('profile-menu').classList.toggle('open');
  document.getElementById('footer-trigger').classList.toggle('menu-open');
}

function closeProfileMenu() {
  const menu = document.getElementById('profile-menu');
  const trigger = document.getElementById('footer-trigger');
  if (menu) menu.classList.remove('open');
  if (trigger) trigger.classList.remove('menu-open');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.sidebar-footer')) closeProfileMenu();
});

/* ==========================================================================
   Logout — a dedicated, custom-styled confirmation modal (built once and
   injected into the page) rather than the browser's native confirm(),
   so the moment feels considered rather than abrupt.
   ========================================================================== */
function ensureLogoutModal() {
  if (document.getElementById('logout-confirm-modal')) return;
  const modal = document.createElement('div');
  modal.id = 'logout-confirm-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box logout-modal-box">
      <div class="logout-modal-icon"><i class="fa-solid fa-right-from-bracket"></i></div>
      <h3 class="logout-modal-title">Log out of DOST-IskoLens?</h3>
      <p class="logout-modal-copy">You'll need to sign back in to access your dashboard, scholar records, and reports.</p>
      <div class="logout-modal-actions">
        <button class="btn btn-outline" onclick="closeModal('logout-confirm-modal')">Cancel</button>
        <button class="btn btn-danger" onclick="doLogout()"><i class="fa-solid fa-right-from-bracket"></i> Log Out</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

function logoutUser() {
  closeProfileMenu();
  ensureLogoutModal();
  openModal('logout-confirm-modal');
}

function doLogout() {
  IskoAPI.post('/api/auth/logout').catch(() => {}).finally(() => {
    window.location.href = 'login.html';
  });
}

function closeMobileSidebar() {
  document.querySelector('.app-shell').classList.remove('sidebar-mobile-open');
}

function restoreSidebarState() {
  const collapsed = localStorage.getItem('iskolens_sidebar_collapsed') === 'true';
  if (collapsed && window.innerWidth > 900) {
    document.querySelector('.app-shell').classList.add('sidebar-collapsed');
  }
}

function startClock() {
  const el = document.getElementById('live-clock');
  if (!el) return;
  function tick() {
    const now = new Date();
    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const dateStr = now.toLocaleDateString('en-US', opts);
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = `${dateStr} at ${timeStr}`;
  }
  tick();
  setInterval(tick, 1000);
}

// Fill the role pill + breadcrumb home link consistently
function paintRoleBadges() {
  // A welcome line, not a button: "Welcome, Administrator" / "Welcome, Scholarship Officer"
  document.querySelectorAll('.js-role-pill').forEach(el => {
    el.textContent = ISKOLENS_DATA.currentUser.roleLabel ? `Welcome, ${ISKOLENS_DATA.currentUser.roleLabel}` : '';
    el.setAttribute('role', 'note');
  });
  document.querySelectorAll('.js-user-name').forEach(el => { el.textContent = ISKOLENS_DATA.currentUser.name; });
  document.querySelectorAll('.js-user-email').forEach(el => { el.textContent = ISKOLENS_DATA.currentUser.email; });
}

document.addEventListener('DOMContentLoaded', paintRoleBadges);


/* --------------------------------------------------------------------------
   Floating widgets — right-edge shortcuts shown on every signed-in page:
   Guides (opens the Guides tab of My Profile) and Disclaimer (modal).
   -------------------------------------------------------------------------- */
function renderFloatingWidgets() {
  if (document.getElementById('floating-widgets')) return;
  document.body.classList.add('has-fab-rail');

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="floating-widgets" id="floating-widgets">
      <a class="fw-btn fw-guides" href="profile.html?tab=guides" title="How-to guides for IskoLens">
        <i class="fa-solid fa-book-open"></i><span>Guides</span>
      </a>
      <button class="fw-btn fw-disclaimer" type="button" onclick="openModal('disclaimer-modal')" title="About this system">
        <i class="fa-solid fa-circle-info"></i><span>Disclaimer</span>
      </button>
    </div>

    <div class="modal-overlay" id="disclaimer-modal">
      <div class="modal-box disclaimer-box">
        <div class="modal-header"><span><i class="fa-solid fa-circle-info"></i>&nbsp; System Disclaimer</span><button class="modal-close" onclick="closeModal('disclaimer-modal')">&times;</button></div>
        <div class="modal-body">
          <div class="disclaimer-section">
            <h4><i class="fa-solid fa-bullseye"></i> Purpose</h4>
            <p>DOST-IskoLens is a decision-support system for DOST Davao Oriental. It helps scholarship staff monitor scholars, understand trends, identify scholars who may need support, and plan interventions and outreach. It supports the office's work; it does not replace it.</p>
          </div>
          <div class="disclaimer-section">
            <h4><i class="fa-solid fa-triangle-exclamation"></i> Limitations</h4>
            <ul>
              <li>Risk levels (Low, Moderate, High) and forecasts are estimates produced by machine-learning models trained on past records. They show likelihood, not certainty, and can be wrong.</li>
              <li>Results are only as accurate and complete as the data encoded or imported into the system. Missing, late, or incorrect records will affect every dashboard, prediction, and recommendation.</li>
              <li>Recommended interventions and caravan priorities are rule-based suggestions. They may not account for a scholar's personal circumstances or information not recorded in the system.</li>
              <li>Analytics show patterns and associations, which do not by themselves prove the cause of a scholar's performance.</li>
            </ul>
          </div>
          <div class="disclaimer-section">
            <h4><i class="fa-solid fa-user-shield"></i> Responsibility</h4>
            <ul>
              <li>All decisions about a scholar — including interventions and termination — remain with authorized DOST personnel, following DOST-SEI policies and guidelines. A risk level alone is never grounds for termination.</li>
              <li>Users are responsible for verifying information before acting on it and for keeping the records they encode accurate and up to date.</li>
              <li>Scholar information is personal data protected under the Data Privacy Act of 2012 (RA 10173). Access, use, and share it only for official purposes and within your assigned role.</li>
            </ul>
          </div>
        </div>
        <div class="modal-footer"><button class="btn btn-primary" onclick="closeModal('disclaimer-modal')">I Understand</button></div>
      </div>
    </div>`;
  while (wrap.firstElementChild) document.body.appendChild(wrap.firstElementChild);
}


/* Pages that still run on the original sample data until the DOST Davao Oriental
   dataset arrives. A banner makes that obvious, so nobody reads the numbers
   on these pages as real results. */
// Every page now shows live data; no page uses sample figures.
const SAMPLE_DATA_PAGES = [];
function showSampleDataBanner(activePageId) {
  if (!SAMPLE_DATA_PAGES.includes(activePageId) || location.pathname.endsWith('/interventions.html')) return;
  const body = document.querySelector('.page-body');
  if (!body || document.getElementById('sample-data-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'sample-data-banner';
  banner.className = 'sample-data-banner';
  banner.setAttribute('role', 'note');
  banner.innerHTML = '<i class="fa-solid fa-flask"></i><div><strong>Sample data, pending DOST dataset.</strong> ' +
    'The figures on this page are placeholders that show how the module will look. They are not real scholar results and ' +
    'will be replaced once DOST Davao Oriental provides the dataset.</div>';
  body.prepend(banner);
}


/* Page-wide accessibility fixes applied after the shell renders:
   a "Skip to content" link, a main landmark, labels on icon-only buttons,
   and label/field connections for forms. */
function improveAccessibility() {
  const body = document.querySelector('.page-body');
  if (body) {
    if (!body.id) body.id = 'main';
    if (body.tagName !== 'MAIN' && !body.getAttribute('role')) body.setAttribute('role', 'main');
    body.setAttribute('tabindex', '-1');
    if (!document.querySelector('.skip-link')) {
      const skip = document.createElement('a');
      skip.className = 'skip-link';
      skip.href = '#' + body.id;
      skip.textContent = 'Skip to main content';
      document.body.prepend(skip);
    }
  }
  const sidebar = document.getElementById('sidebar-mount');
  if (sidebar) { const nav = sidebar.querySelector('aside, nav, .sidebar'); if (nav && !nav.getAttribute('aria-label')) nav.setAttribute('aria-label', 'Main menu'); }
  const labels = {
    'notif-bell-btn': 'Notifications', 'sidebar-toggle': 'Collapse or expand the menu', 'menu-toggle': 'Open the menu',
    'modal-close': 'Close', 'fw-guides': 'Guides', 'fw-disclaimer': 'Disclaimer'
  };
  document.querySelectorAll('button, a').forEach(el => {
    if (el.getAttribute('aria-label') || el.textContent.trim()) return;
    const cls = Array.from(el.classList).find(c => labels[c]);
    const label = cls ? labels[cls] : el.getAttribute('title');
    if (label) el.setAttribute('aria-label', label);
  });
  document.querySelectorAll('i.fa-solid, i.fa-regular, i.fas, i.far').forEach(i => i.setAttribute('aria-hidden', 'true'));
  linkFormLabels(document);
}
