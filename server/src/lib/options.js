'use strict';
/*
 * Every dropdown option shown in the system comes from the server: lists the
 * office maintains are read from the database (programs, cycles,
 * municipalities, schools, HEIs); fixed system values are defined once here and
 * used both by the dropdowns (/api/lookups) and by the server's validation.
 */
const D = require('./data');

const opt = (value, label = value) => ({ value, label });
const OPTIONS = {
  sexes: [opt('Male'), opt('Female')],
  semesters: Object.keys(D.SEMESTERS).map((s) => opt(s)),
  stipend_statuses: D.STIPEND_STATUSES.map((s) => opt(s)),
  graduation_statuses: D.GRADUATION_STATUSES.map((s) => opt(s)),
  termination_grounds: D.TERMINATION_GROUNDS.map((s) => opt(s)),
  document_types: D.DOCUMENT_TYPES.map((s) => opt(s)),
  scholar_statuses: Object.entries(D.STATUS_LABELS).map(([v, l]) => opt(v, l)),
  standing_filters: [opt('Good Standing'), opt('Probation'), opt('Failed'), opt('below', 'Below requirement (any)'), opt('none', 'No academic record yet')],
  user_roles: [opt('admin', 'Administrator'), opt('officer', 'Scholarship Officer')],
  user_statuses: [opt('active', 'Active'), opt('inactive', 'Inactive'), opt('pending', 'Pending')],
  account_statuses: [opt('active', 'Active'), opt('inactive', 'Inactive')],
  font_sizes: [opt('small', 'Small'), opt('medium', 'Medium'), opt('large', 'Large')],
  themes: [opt('light', 'Light'), opt('dark', 'Dark'), opt('system', 'Match my device')],
  export_formats: [opt('pdf', 'PDF Document'), opt('csv', 'CSV Spreadsheet')],
  report_formats: [opt('pdf', 'PDF'), opt('csv', 'CSV (Excel)')],
  reference_status_filters: [opt('1', 'Active only'), opt('0', 'Inactive only')],
  geomap_metrics: [opt('total', 'Total scholars'), opt('active', 'Active scholars'), opt('graduated', 'Graduated'), opt('terminated', 'Terminated'),
    opt('below_requirement', 'Below GWA requirement'), opt('acceptance_rate', 'Acceptance rate'), opt('priority_score', 'Outreach priority')],
};
const values = (key) => OPTIONS[key].map((o) => o.value);
module.exports = { OPTIONS, values };
