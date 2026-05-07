// schedulers/deadlineScheduler.js
// Phase 71.2 / D-ADAPT-04: deadline-close path is now unified with manual+
// consensus close paths. Auto-event-creation has been REMOVED — the recipient
// (creator for manual / settings.created_by_user_id || group owner for auto,
// per the LOCKED D-ADAPT-05 + D-SCHEMA-06 rule) gets the same email+CTA flow
// as every other close trigger via promptLifecycleService.handlePromptClosed.
//
// `eventCreationService.convertSuggestionToEvent` is no longer called from
// this scheduler. The function remains in services/eventCreationService.js
// for the manual "Schedule it?" CTA path on the front end.
//
// `auto_schedule_enabled` BOOLEAN column on AvailabilityPrompts is functionally
// dead after this migration but remains in the schema (no schema sprawl in
// this plan). Future cleanup candidate.
const cron = require('node-cron');
const { AvailabilityPrompt } = require('../models');
const { Op } = require('sequelize');
const lifecycleService = require('../services/promptLifecycleService');
const { recordRun } = require('../services/schedulerHealthService');

// Check interval - default every 5 minutes, configurable via env
const DEADLINE_CHECK_INTERVAL = process.env.DEADLINE_CHECK_INTERVAL || '*/5 * * * *';

/**
 * Process a single expired prompt — Phase 71.2 unified close path.
 *
 * Sets prompt.status='closed' and routes through promptLifecycleService.
 * handlePromptClosed for the close-notification email + Schedule it? CTA.
 *
 * @param {Object} prompt - AvailabilityPrompt instance
 * @returns {Promise<{ emailsSent: number, processed: boolean }>}
 *   emailsSent is best-effort 1-when-attempted, 0 otherwise — the lifecycle
 *   service is best-effort and may skip silently (zero responses, no top
 *   slot, no recipient). The exact count of actually-dispatched emails is
 *   not tracked here; this preserves the schedulerHealth recordRun shape.
 */
async function processExpiredPrompt(prompt) {
  console.log(`Processing expired prompt ${prompt.id} for group ${prompt.group_id}`);

  try {
    // Phase 71.2 D-ADAPT-04: deadline-close path is now unified. No more
    // eventCreationService.convertSuggestionToEvent. handlePromptClosed
    // resolves recipient per the LOCKED rule and dispatches the unified
    // close-notification email.
    await prompt.update({ status: 'closed' });
    await lifecycleService.handlePromptClosed(prompt);
    return { emailsSent: 1, processed: true };
  } catch (error) {
    console.error(`Error processing prompt ${prompt.id}:`, error.message);
    // Don't update status on error - will retry next interval
    return { emailsSent: 0, processed: false };
  }
}

/**
 * Main scheduler job - runs every 5 minutes by default.
 *
 * Phase 71.2: now finds ALL active expired prompts (manual + auto). The old
 * `auto_schedule_enabled: true` filter is gone — the new model does not
 * differentiate at the deadline path; both paths route through the unified
 * close handler.
 */
const deadlineJob = cron.schedule(DEADLINE_CHECK_INTERVAL, async () => {
  console.log(`[${new Date().toISOString()}] Running deadline check...`);

  try {
    await recordRun('deadline', async () => {
      const expiredPrompts = await AvailabilityPrompt.findAll({
        where: {
          deadline: { [Op.lt]: new Date() },
          status: 'active'
        }
      });

      console.log(`Found ${expiredPrompts.length} expired prompts past deadline`);

      let emailsSent = 0;
      let skippedCount = 0;
      for (const prompt of expiredPrompts) {
        const r = await processExpiredPrompt(prompt);
        emailsSent += r.emailsSent;
        if (r.processed && r.emailsSent === 0) skippedCount++;
      }
      return { sent: emailsSent, skipped: skippedCount };
    });
  } catch (error) {
    console.error('Deadline scheduler error:', error);
  }
}, {
  scheduled: false,  // Don't start automatically - server.js will start it
  timezone: 'UTC'
});

module.exports = {
  deadlineJob,
  processExpiredPrompt,  // Export for testing
};
