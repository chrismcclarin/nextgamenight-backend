// schedulers/promptScheduler.js
// Syncs GroupPromptSettings schedules to BullMQ Job Schedulers
const { promptQueue } = require('../queues');
const { GroupPromptSettings } = require('../models');
const { Op } = require('sequelize');
const { recordRun } = require('../services/schedulerHealthService');

/**
 * Convert day of week (0-6, 0=Sunday) and time (HH:MM:SS) to cron pattern
 * @param {number} dayOfWeek - Day of week (0=Sunday, 1=Monday, etc.)
 * @param {string} time - Time in HH:MM:SS format
 * @returns {string} Cron pattern (e.g., "0 15 10 * * 1" for Monday 10:15)
 */
function buildCronPattern(dayOfWeek, time) {
  if (dayOfWeek === null || dayOfWeek === undefined || !time) {
    return null;
  }

  // Parse time string (e.g., "10:15:00" -> hours=10, minutes=15)
  const [hours, minutes] = time.split(':').map(Number);

  // BullMQ cron format: second minute hour dayOfMonth month dayOfWeek
  // Example: "0 15 10 * * 1" = every Monday at 10:15:00
  return `0 ${minutes} ${hours} * * ${dayOfWeek}`;
}

/**
 * Sync all active GroupPromptSettings schedules to BullMQ Job Schedulers
 * Uses upsertJobScheduler to prevent duplicates on restart
 */
async function syncPromptSchedulesToQueue() {
  try {
    // Find all active schedules with day/time configured
    const activeSchedules = await GroupPromptSettings.findAll({
      where: {
        is_active: { [Op.eq]: true },
        schedule_day_of_week: { [Op.ne]: null },
        schedule_time: { [Op.ne]: null }
      }
    });

    console.log(`[PromptScheduler] Found ${activeSchedules.length} active schedules to sync`);

    let synced = 0;
    let skipped = 0;

    for (const schedule of activeSchedules) {
      const cronPattern = buildCronPattern(
        schedule.schedule_day_of_week,
        schedule.schedule_time
      );

      if (!cronPattern) {
        console.log(`[PromptScheduler] Skipping schedule ${schedule.id} - invalid cron pattern`);
        skipped++;
        continue;
      }

      // Use consistent scheduler ID based on settings ID
      const schedulerId = `prompt-schedule-${schedule.id}`;

      try {
        // Upsert job scheduler (creates or updates)
        await promptQueue.upsertJobScheduler(schedulerId, {
          pattern: cronPattern,
          tz: schedule.schedule_timezone || 'UTC'
        }, {
          name: 'send-availability-prompt',
          data: {
            groupId: schedule.group_id,
            settingsId: schedule.id,
            timezone: schedule.schedule_timezone || 'UTC'
          },
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 }
          }
        });

        synced++;
      } catch (err) {
        console.error(`[PromptScheduler] Failed to upsert scheduler ${schedulerId}:`, err.message);
        skipped++;
      }
    }

    console.log(`[PromptScheduler] Synced ${synced} schedules, skipped ${skipped}`);
    return { synced, skipped, total: activeSchedules.length };
  } catch (err) {
    console.error('[PromptScheduler] Failed to sync schedules:', err.message);
    throw err;
  }
}

/**
 * Remove a job scheduler when a schedule is deleted or deactivated
 * @param {string} settingsId - GroupPromptSettings ID
 */
async function removePromptScheduler(settingsId) {
  const schedulerId = `prompt-schedule-${settingsId}`;
  try {
    await promptQueue.removeJobScheduler(schedulerId);
    console.log(`[PromptScheduler] Removed scheduler ${schedulerId}`);
    return true;
  } catch (err) {
    // Ignore "not found" errors
    if (err.message && err.message.includes('not found')) {
      return false;
    }
    console.error(`[PromptScheduler] Failed to remove scheduler ${schedulerId}:`, err.message);
    throw err;
  }
}

/**
 * Telemetry-wrapped variant used at server startup. Maps the underlying
 * { synced, skipped, total } shape to the { sent, skipped } contract that
 * schedulerHealthService.recordRun expects, so prompt_sync runs land in the
 * same SchedulerRun feed as the cron-based jobs and can be swept for anomalies.
 */
async function syncPromptSchedulesWithTelemetry() {
  return recordRun('prompt_sync', async () => {
    const { synced, skipped } = await syncPromptSchedulesToQueue();
    return { sent: synced, skipped };
  });
}

module.exports = {
  syncPromptSchedulesToQueue,
  syncPromptSchedulesWithTelemetry,
  removePromptScheduler,
  buildCronPattern // Export for testing
};
