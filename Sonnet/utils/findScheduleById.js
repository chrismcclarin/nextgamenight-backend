// utils/findScheduleById.js
//
// Finds the nested schedule a poll's schedule_id points at inside
// GroupPromptSettings.template_config.schedules[] (review 261025-rl3 R1 scoped check).
//
// DECISION quick-261025-rl3 R1: ONE matcher shared by the wire decoration
// (routes/availabilityPrompt.js decoratePromptForWire, schedule_name) and the
// close-email recipient resolver (services/promptLifecycleService.js
// handlePromptClosed), OVER two private copies, so a change to the id rule lands
// once and the poll's displayed schedule and its mailed creator can never come
// from different schedules. Inlining it again at either site is a decision, not
// a cleanup.
//
// Rule: ids compare case-insensitively (AvailabilityPrompt.schedule_id is a UUID
// column and Postgres returns it lowercase; a stored schedule id may carry any
// case). Tolerant by design: a non-array schedules, a non-string or empty
// scheduleId, and entries that are null or carry a non-string id all yield no
// match rather than a throw.

/**
 * @param {unknown} schedules  template_config.schedules (normally an array).
 * @param {unknown} scheduleId the poll's schedule_id.
 * @returns {object|null} the matching schedule object, or null.
 */
function findScheduleById(schedules, scheduleId) {
  if (!Array.isArray(schedules)) return null;
  if (typeof scheduleId !== 'string' || scheduleId === '') return null;
  const wanted = scheduleId.toLowerCase();
  const match = schedules.find(
    (s) => s && typeof s.id === 'string' && s.id.toLowerCase() === wanted
  );
  return match || null;
}

module.exports = { findScheduleById };
