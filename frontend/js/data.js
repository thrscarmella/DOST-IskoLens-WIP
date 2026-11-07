/* ==========================================================================
   DOST-IskoLens — signed-in user
   Holds only the current user, taken from the server session. All other
   data on every page comes from the API; there are no sample records.
   ========================================================================== */

const ISKOLENS_DATA = {

  // The signed-in user comes from the server (/api/session.js), never from
  // localStorage, so the role cannot be changed from the browser.
  currentUser: (function () {
    const u = (window.ISKOLENS_SESSION && window.ISKOLENS_SESSION.user) || {};
    return {
      id: u.id, role: u.role || 'officer', name: u.name || '', email: u.email || '',
      initials: u.initials || '', roleLabel: u.role_label || ''
    };
  })(),
};
