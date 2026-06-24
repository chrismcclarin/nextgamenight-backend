// schedulers/promptScheduler.js
// Syncs GroupPromptSettings nested schedules (template_config.schedules array)
// to BullMQ Job Schedulers.
//
// Storage shape (post-refactor): each row in GroupPromptSettings owns a JSONB
// array `template_config.schedules[]` with multiple per-group schedules. The
// legacy top-level columns (schedule_day_of_week, schedule_time) are unused
// and remain NULL on every row. This scheduler reads ONLY from the nested
// array and registers one BullMQ scheduler per active nested schedule.
// NOTE (BTEST-04 / round-3 MEDIUM): the `{ promptQueue }` destructure is
// intentionally NOT at module top. This module sits on the prod boot path
// (server.js -> routes/groupPromptSettings.js -> promptScheduler), so a
// module-top destructure would fire the queues/index.js getter and connect
// Redis at app import. Each function that touches promptQueue requires it
// lazily inside its own body.
const { GroupPromptSettings } = require('../models');
const { recordRun } = require('../services/schedulerHealthService');

/**
 * Convert day of week (0-6, 0=Sunday) and time (HH:MM or HH:MM:SS) to cron pattern.
 * @param {number} dayOfWeek - Day of week (0=Sunday, 1=Monday, etc.)
 * @param {string} time - Time in HH:MM or HH:MM:SS format
 * @returns {string|null} Cron pattern (e.g., "0 15 10 * * 1" for Monday 10:15)
 */
function buildCronPattern(dayOfWeek, time) {
  if (dayOfWeek === null || dayOfWeek === undefined || !time) {
    return null;
  }

  // Parse time string — accepts both 'HH:MM' (frontend) and 'HH:MM:SS' (legacy
  // top-level TIME column). Destructuring ignores trailing seconds segment.
  const parts = String(time).split(':').map(Number);
  const hours = parts[0];
  const minutes = parts[1];

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null;
  }
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  // BullMQ cron format: second minute hour dayOfMonth month dayOfWeek
  // Example: "0 15 10 * * 1" = every Monday at 10:15:00
  return `0 ${minutes} ${hours} * * ${dayOfWeek}`;
}

/**
 * Build the BullMQ scheduler ID for a (settings, nested-schedule) pair.
 * Composite ID is required because a single GroupPromptSettings row owns
 * many nested schedules (e.g., a "Tuesday Catan" + "Saturday Wingspan").
 */
function buildSchedulerId(settingsId, scheduleId) {
  return `prompt-schedule-${settingsId}-${scheduleId}`;
}

/**
 * Upsert a single nested schedule into BullMQ. Used by both the bulk sync and
 * the on-write route hooks so the same shape is registered everywhere.
 *
 * @param {GroupPromptSettings} settings - Sequelize instance (for group_id + tz fallback).
 * @param {Object} schedule - One element from settings.template_config.schedules[].
 * @returns {Promise<{ schedulerId: string, cronPattern: string }|null>}
 *          null when the schedule is not registerable (missing day/time, etc.)
 */
async function upsertSinglePromptScheduler(settings, schedule) {
  if (!settings || !schedule) return null;
  if (!schedule.id) return null;

  const cronPattern = buildCronPattern(
    schedule.schedule_day_of_week,
    schedule.schedule_time
  );
  if (!cronPattern) return null;

  const schedulerId = buildSchedulerId(settings.id, schedule.id);
  const tz = schedule.schedule_timezone || settings.schedule_timezone || 'UTC';

  // Lazy require (BTEST-04): resolve the queue at call time, not import time.
  const { promptQueue } = require('../queues');
  await promptQueue.upsertJobScheduler(schedulerId, {
    pattern: cronPattern,
    tz
  }, {
    name: 'send-availability-prompt',
    data: {
      groupId: settings.group_id,
      settingsId: settings.id,
      scheduleId: schedule.id,
      timezone: tz,
      gameId: schedule.game_id || null,
      defaultDeadlineHours: schedule.default_deadline_hours || settings.default_deadline_hours || 72,
      defaultTokenExpiryHours: schedule.default_token_expiry_hours || settings.default_token_expiry_hours || 168,
      minParticipants: schedule.min_participants ?? settings.min_participants ?? null,
      selectedMemberIds: Array.isArray(schedule.selected_member_ids) ? schedule.selected_member_ids : []
    },
    opts: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }
    }
  });

  return { schedulerId, cronPattern };
}

/**
 * Sync every active nested schedule across all GroupPromptSettings rows to
 * BullMQ Job Schedulers, then reconcile by removing any BullMQ schedulers
 * that no longer correspond to a live nested schedule.
 *
 * Reconcile is necessary because the on-write route hooks may have failed
 * (Redis blip, app restart mid-write) leaving orphan schedulers in BullMQ
 * after a schedule was DELETE'd or toggled off.
 */
async function syncPromptSchedulesToQueue() {
  try {
    // Load every settings row — the top-level is_active controls the entire
    // group's prompt feature. Nested-schedule active state is checked per-item.
    const allSettings = await GroupPromptSettings.findAll();

    let synced = 0;
    let skipped = 0;
    const liveSchedulerIds = new Set();

    for (const settings of allSettings) {
      // Top-level off => all this group's nested schedules are skipped.
      if (settings.is_active === false) {
        const nestedCount = (settings.template_config?.schedules || []).length;
        skipped += nestedCount;
        continue;
      }

      const schedules = settings.template_config?.schedules || [];
      for (const schedule of schedules) {
        // Per-schedule guards
        if (schedule.is_active === false) { skipped++; continue; }
        if (schedule.deleted_at) { skipped++; continue; }
        if (schedule.schedule_day_of_week === null || schedule.schedule_day_of_week === undefined) {
          skipped++;
          continue;
        }
        if (!schedule.schedule_time) { skipped++; continue; }

        try {
          const result = await upsertSinglePromptScheduler(settings, schedule);
          if (result) {
            liveSchedulerIds.add(result.schedulerId);
            synced++;
          } else {
            skipped++;
          }
        } catch (err) {
          console.error(`[PromptScheduler] Failed to upsert schedule ${schedule.id} for settings ${settings.id}:`, err.message);
          skipped++;
        }
      }
    }

    // Reconcile — sweep BullMQ for schedulers that no longer match any live
    // nested schedule. Only touches scheduler IDs in our prompt-schedule-*
    // namespace so we don't accidentally clobber other queues' schedulers.
    let reconciled = 0;
    try {
      // Lazy require (BTEST-04): resolve the queue at call time, not import time.
      const { promptQueue } = require('../queues');
      // Page through up to 1000 schedulers — should be more than enough; if a
      // single Redis ever holds more than that we can revisit pagination.
      const existing = await promptQueue.getJobSchedulers(0, 999, true);
      for (const s of existing) {
        const key = s?.key;
        if (!key || !key.startsWith('prompt-schedule-')) continue;
        if (liveSchedulerIds.has(key)) continue;
        try {
          await promptQueue.removeJobScheduler(key);
          console.log(`[PromptScheduler] Reconciled (removed orphan) ${key}`);
          reconciled++;
        } catch (err) {
          console.error(`[PromptScheduler] Failed to remove orphan scheduler ${key}:`, err.message);
        }
      }
    } catch (err) {
      // Reconcile is best-effort — a failure here must not break the sync.
      console.error('[PromptScheduler] Reconcile sweep failed:', err.message);
    }

    console.log(`[PromptScheduler] Synced ${synced} schedules from ${allSettings.length} settings rows, skipped ${skipped}, reconciled ${reconciled}`);
    return { synced, skipped, reconciled, total: allSettings.length };
  } catch (err) {
    console.error('[PromptScheduler] Failed to sync schedules:', err.message);
    throw err;
  }
}

/**
 * Remove a single nested schedule's BullMQ entry. Called by route hooks on
 * DELETE / toggle-off / deactivation.
 *
 * Signature change (2026-05): now requires both settingsId AND scheduleId so
 * we can target a specific nested schedule rather than blowing away a whole
 * group's worth.
 */
async function removePromptScheduler(settingsId, scheduleId) {
  if (!settingsId || !scheduleId) {
    console.warn('[PromptScheduler] removePromptScheduler called without both settingsId + scheduleId — no-op');
    return false;
  }
  const schedulerId = buildSchedulerId(settingsId, scheduleId);
  try {
    // Lazy require (BTEST-04): resolve the queue at call time, not import time.
    const { promptQueue } = require('../queues');
    await promptQueue.removeJobScheduler(schedulerId);
    console.log(`[PromptScheduler] Removed scheduler ${schedulerId}`);
    return true;
  } catch (err) {
    // Ignore "not found" errors — idempotent remove.
    if (err.message && err.message.includes('not found')) {
      return false;
    }
    console.error(`[PromptScheduler] Failed to remove scheduler ${schedulerId}:`, err.message);
    throw err;
  }
}

/**
 * Telemetry-wrapped variant used at server startup. Maps the underlying
 * { synced, skipped, ... } shape to the { sent, skipped } contract that
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
  upsertSinglePromptScheduler,
  removePromptScheduler,
  buildCronPattern,    // Exported for testing
  buildSchedulerId     // Exported for testing
};
