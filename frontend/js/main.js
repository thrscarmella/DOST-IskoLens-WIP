/* ==========================================================================
   DOST-IskoLens — Shared UI Utilities
   Modals, toasts, confirm dialogs, form validation helpers.
   ========================================================================== */

const IskoUI = {
  chartColors: {
    blue: '#2f6fe6', navy: '#0d1526', green: '#22c55e', amber: '#f59e0b',
    red: '#ef4444', purple: '#8b5cf6', sky: '#38bdf8', gray: '#cbd3e1'
  }
};

/* ---------------- Modal ---------------- */
/* Modals and drawers are keyboard accessible: focus moves into the dialog,
   Tab and Shift+Tab stay inside it, Esc closes it, and focus returns to
   the control that opened it. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const dialogStack = [];

function visibleFocusables(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
}
function activateDialog(root, labelSource) {
  const box = root.classList.contains('modal-overlay') ? root.querySelector('.modal-box') || root : root;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  const title = labelSource || box.querySelector('.modal-header span, .side-drawer-header h3');
  if (title && !box.getAttribute('aria-labelledby')) {
    if (!title.id) title.id = 'dlg-title-' + Math.random().toString(36).slice(2, 8);
    box.setAttribute('aria-labelledby', title.id);
  }
  box.querySelectorAll('.modal-close').forEach(btn => { if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', 'Close'); });
  linkFormLabels(box);
  dialogStack.push({ root, returnTo: document.activeElement });
  setTimeout(() => {
    const preferred = box.querySelector('[autofocus]') || visibleFocusables(box).find(el => !el.classList.contains('modal-close')) || box;
    if (preferred === box) box.setAttribute('tabindex', '-1');
    preferred.focus();
  }, 30);
}
function deactivateDialog(root) {
  const i = dialogStack.findIndex(d => d.root === root);
  if (i === -1) return;
  const { returnTo } = dialogStack.splice(i, 1)[0];
  if (returnTo && document.contains(returnTo)) setTimeout(() => returnTo.focus(), 10);
}
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
  activateDialog(modal);
}
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('show');
  if (!document.querySelector('.modal-overlay.show, .side-drawer.show')) document.body.style.overflow = '';
  if (modal) deactivateDialog(modal);
}
document.addEventListener('click', function (e) {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
});

/* ---------------- Side Drawer ---------------- */
function openDrawer(drawerId) {
  const drawer = document.getElementById(drawerId);
  const overlay = document.getElementById(drawerId + '-overlay');
  if (drawer) drawer.classList.add('show');
  if (overlay) overlay.classList.add('show');
  document.body.style.overflow = 'hidden';
  if (drawer) activateDialog(drawer);
}
function closeDrawer(drawerId) {
  const drawer = document.getElementById(drawerId);
  const overlay = document.getElementById(drawerId + '-overlay');
  if (drawer) drawer.classList.remove('show');
  if (overlay) overlay.classList.remove('show');
  if (!document.querySelector('.modal-overlay.show, .side-drawer.show')) document.body.style.overflow = '';
  if (drawer) deactivateDialog(drawer);
}
document.addEventListener('click', function (e) {
  if (e.target.classList && e.target.classList.contains('side-drawer-overlay')) {
    closeDrawer(e.target.id.replace('-overlay', ''));
  }
});
document.addEventListener('keydown', function (e) {
  const top = dialogStack[dialogStack.length - 1];
  if (e.key === 'Escape') {
    if (top) {
      top.root.classList.contains('side-drawer') ? closeDrawer(top.root.id) : closeModal(top.root.id);
    } else {
      document.querySelectorAll('.dropdown-menu.show, .notif-panel.show, .profile-menu.show').forEach(m => m.classList.remove('show'));
    }
    return;
  }
  if (e.key === 'Tab' && top) {
    const items = visibleFocusables(top.root);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!top.root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }
});

/* Connects each form label to its field (for="..."), so screen readers
   announce the label and clicking the label focuses the field. */
function linkFormLabels(root) {
  (root || document).querySelectorAll('.form-group, .ev-field, .auth-field').forEach(group => {
    const label = group.querySelector('label');
    const field = group.querySelector('input:not([type="checkbox"]):not([type="radio"]), select, textarea');
    if (!label || !field || label.htmlFor || label.contains(field)) return;
    if (!field.id) field.id = 'fld-' + Math.random().toString(36).slice(2, 9);
    label.htmlFor = field.id;
  });
}

/* ---------------- Toast ----------------
   type: 'success' | 'error' | 'warning' | 'info'
   Optional 5th/6th args let a call include a "Learn more" link when useful;
   existing calls with just (title, message, type) are unaffected. */
function showToast(title, message, type, learnMoreText, learnMoreUrl) {
  type = type || 'success';
  let stack = document.querySelector('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
  }
  const icons = { success: 'fa-check', error: 'fa-exclamation', warning: 'fa-info', info: 'fa-info' };
  const colors = { success: '#16a34a', error: '#dc2626', warning: '#d97706', info: '#2f6fe6' };
  const icon = icons[type] || icons.success;
  const color = colors[type] || colors.success;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <div class="toast-icon" style="color:${color};"><i class="fa-solid ${icon}"></i></div>
    <div>
      <strong>${title}</strong>
      <p>${message || ''}</p>
      ${learnMoreText ? `<a class="toast-learn-more" href="${learnMoreUrl || '#'}">${learnMoreText}</a>` : ''}
    </div>`;
  stack.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .3s ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4200);
}

/* ---------------- Confirm dialog (uses the confirm-modal markup if present, else native) ---------------- */
function confirmAction(message, onConfirm) {
  const modal = document.getElementById('confirm-modal');
  if (!modal) {
    if (window.confirm(message)) onConfirm();
    return;
  }
  document.getElementById('confirm-modal-message').textContent = message;
  openModal('confirm-modal');
  const btn = document.getElementById('confirm-modal-btn');
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', function () {
    closeModal('confirm-modal');
    onConfirm();
  });
}

/* ---------------- Simple form validation ---------------- */
function validateForm(formEl) {
  let valid = true;
  formEl.querySelectorAll('[required]').forEach(field => {
    const value = (field.value || '').trim();
    field.classList.remove('field-error');
    if (!value) {
      valid = false;
      field.classList.add('field-error');
      field.style.borderColor = '#ef4444';
    } else {
      field.style.borderColor = '';
    }
  });
  return valid;
}

/* ---------------- Dropdown menus (generic) ---------------- */
function toggleDropdown(id) {
  document.querySelectorAll('.dropdown-menu').forEach(d => {
    if (d.id !== id) d.classList.remove('show');
  });
  const el = document.getElementById(id);
  if (el) el.classList.toggle('show');
}
document.addEventListener('click', function (e) {
  if (!e.target.closest('.dropdown-trigger') && !e.target.closest('.dropdown-menu')) {
    document.querySelectorAll('.dropdown-menu').forEach(d => d.classList.remove('show'));
  }
});

/* ---------------- Chip toggle (used in KPI generate modal) ---------------- */
function toggleChip(el) {
  el.classList.toggle('selected');
}

document.addEventListener('DOMContentLoaded', function () {
  linkFormLabels(document);
  document.querySelectorAll('i.fa-solid, i.fa-regular, i.fas, i.far').forEach(i => i.setAttribute('aria-hidden', 'true'));
});
