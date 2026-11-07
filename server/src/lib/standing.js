'use strict';
/*
 * Academic standing rule (revised BPMN):
 *   1st and 2nd year: GWA of at least 85% (2.00) = Good Standing; passing but below = Probation
 *   3rd year and up:  passing grade (75% / 3.00) = Good Standing
 *   below passing = Failed. GWA 1.00-5.00 is a grade; 50-100 is a percentage.
 */
const config = require('../config');
const GOOD = 'Good Standing'; const PROBATION = 'Probation'; const FAILED = 'Failed';
const NOT_GOOD = [PROBATION, FAILED];

function detectScale(gwa) {
  if (gwa >= 1.0 && gwa <= 5.0) return 'grade';
  if (gwa >= 50.0 && gwa <= 100.0) return 'percent';
  return null;
}
function thresholds(scale, yearLevel) {
  const lower = config.GWA_LOWER_YEAR_LEVELS.includes(Number(yearLevel));
  if (scale === 'grade') return [lower ? config.GWA_REQUIRED_GRADE_LOWER_YEARS : config.GWA_PASSING_GRADE, config.GWA_PASSING_GRADE];
  return [lower ? config.GWA_REQUIRED_PERCENT_LOWER_YEARS : config.GWA_PASSING_PERCENT, config.GWA_PASSING_PERCENT];
}
function computeStanding(gwa, yearLevel, scale = null) {
  gwa = Number(gwa);
  scale = scale || detectScale(gwa);
  if (!scale) throw new Error('GWA must be between 1.00 and 5.00, or between 50 and 100 if encoded as a percentage.');
  const [required, passing] = thresholds(scale, yearLevel);
  if (scale === 'grade') {
    if (gwa <= required) return GOOD;
    return gwa <= passing ? PROBATION : FAILED;
  }
  if (gwa >= required) return GOOD;
  return gwa >= passing ? PROBATION : FAILED;
}
function ruleSummary() {
  return {
    lower_year_levels: [...config.GWA_LOWER_YEAR_LEVELS],
    grade: { required_lower_years: config.GWA_REQUIRED_GRADE_LOWER_YEARS, passing: config.GWA_PASSING_GRADE },
    percent: { required_lower_years: config.GWA_REQUIRED_PERCENT_LOWER_YEARS, passing: config.GWA_PASSING_PERCENT },
  };
}
/* records ordered oldest -> newest */
function consecutiveBelowRequirement(records) {
  if (records.length < 2) return false;
  return NOT_GOOD.includes(records[records.length - 1].standing) && NOT_GOOD.includes(records[records.length - 2].standing);
}
module.exports = { GOOD, PROBATION, FAILED, NOT_GOOD, detectScale, computeStanding, ruleSummary, consecutiveBelowRequirement };
