'use strict';
/*
 * Suggested intervention actions. With a trained model they follow the
 * scholar's top risk factors; without one they follow academic standing and
 * stipend issues. They are suggestions for the officer, to be adjusted to
 * DOST Davao Oriental policy.
 */
const BY_FACTOR = {
  share_below_requirement: 'Academic counseling with the HEI guidance office about the GWA requirement',
  n_below_requirement: 'Agree on a written study plan with the scholar for the coming term',
  max_consecutive_below: 'Issue a written academic warning and set monthly GWA monitoring',
  n_failed: 'Refer the scholar to tutoring or a peer study group for the failed subjects',
  gwa_mean_grade: 'Check grades at mid-term with the HEI and follow up with the scholar',
  gwa_last_grade: 'Check grades at mid-term with the HEI and follow up with the scholar',
  failed_subjects_total: 'Refer the scholar to tutoring or a peer study group for the failed subjects',
  units_mean: 'Review the study load with the scholar and the HEI adviser',
  n_irregular_or_leave: 'Confirm enrollment status with the HEI registrar',
  n_inconsistent: 'Verify the stipend records with the accounting unit and inform the scholar',
  n_pending: 'Follow up the pending stipend release',
};
function recommendations({ standing = null, topFactors = [], inconsistentStipends = 0 }) {
  const out = [];
  const add = (a) => { if (a && !out.includes(a)) out.push(a); };
  topFactors.filter((f) => f.effect === 'raises').forEach((f) => add(BY_FACTOR[f.feature]));
  if (standing === 'Failed') {
    add('Academic counseling with the HEI guidance office about the GWA requirement');
    add('Issue a written academic warning and set monthly GWA monitoring');
    add('Refer the scholar to tutoring or a peer study group for the failed subjects');
  } else if (standing === 'Probation') {
    add('Agree on a written study plan with the scholar for the coming term');
    add('Check grades at mid-term with the HEI and follow up with the scholar');
  }
  if (inconsistentStipends) add('Verify the stipend records with the accounting unit and inform the scholar');
  if (!out.length) add('Schedule a check-in meeting with the scholar');
  return out.slice(0, 5);
}
module.exports = { recommendations };
