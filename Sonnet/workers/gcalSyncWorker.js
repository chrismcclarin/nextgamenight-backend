// workers/gcalSyncWorker.js
// Phase 75 / GCAL-01 (Plan 75-03): outbound Google Calendar removal worker.
//
// Triggered by jobs enqueued from services/gcalCleanupService.js via the
// `gcal-sync` BullMQ queue (Plan 75-02). Each job is one (event,
// event_participation, user) triple and corresponds to a single attendee's
// ghost GCal entry that needs to be removed.
//
// Flow:
//   1. Load user. If missing -> skipped:user_not_found (no throw, no alert).
//   2. If user has no google_calendar_token -> skipped_due_to_disconnect
//      (Sentry breadcrumb, NOT alert; user disconnected GCal mid-flight).
//   3. Call googleCalendarService.deleteCalendarEventForUser, which
//      classifies Google API errors via err.code:
//        - GCAL_DISCONNECTED  -> skip + breadcrumb (no retry)
//        - GCAL_RATE_LIMITED  -> re-throw (BullMQ retries with backoff)
//        - GCAL_PERMANENT     -> re-throw; on attempts-exhausted, Sentry alert
//        - 5xx (no code)      -> re-throw (transient; BullMQ retries)
//   4. If the helper auto-refreshed the access token, persist it back to User.
//
// The handler function is exported as `processGcalSyncJob` so tests can drive
// it directly without booting BullMQ + Redis. The failed-event hook is
// exported as `handleJobFailed` so tests can assert the attempts-exhausted
// Sentry alert path without invoking the real BullMQ Worker lifecycle.

const { Worker } = require('bullmq');
const Redis = require('ioredis');

// Optional Sentry integration -- mirrors reminderWorker.js. SENTRY_DSN is the
// gate; when absent, breadcrumbs/alerts are silently skipped.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[GcalSyncWorker] Sentry not available:', err.message);
  }
}

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/**
 * Pure handler — exported so tests can invoke it directly with mocked deps.
 *
 * @param {{ id: string, data: object }} job
 * @returns {Promise<object>}
 */
async function processGcalSyncJob(job) {
  const { eventId, eventParticipationId, userId, googleCalendarEventId } = job.data || {};

  // Lazy-require so tests can mock these without import-time hoisting issues.
  const { User } = require('../models');
  const googleCalendarService = require('../services/googleCalendarService');

  // 1. Load user. If gone (deleted between event-add and cleanup), silently skip.
  const user = await User.findByPk(userId);
  if (!user) {
    console.log(
      `[GcalSyncWorker] Job ${job.id}: user ${userId} not found, skipping (user_not_found)`
    );
    return { skipped: true, reason: 'user_not_found', eventParticipationId };
  }

  // 2. Token presence check -> user disconnected GCal between event-add and cleanup.
  if (!user.google_calendar_token) {
    console.log(
      `[GcalSyncWorker] Job ${job.id}: user ${userId} has no GCal token, skipped_due_to_disconnect`
    );
    if (Sentry) {
      Sentry.addBreadcrumb({
        category: 'gcal-sync',
        message: 'skipped_due_to_disconnect',
        level: 'info',
        data: { eventId, eventParticipationId, userId, reason: 'no_token' },
      });
    }
    return { skipped: true, reason: 'skipped_due_to_disconnect', eventParticipationId };
  }

  // 3. Call Google.
  try {
    const result = await googleCalendarService.deleteCalendarEventForUser(
      googleCalendarEventId,
      user.google_calendar_token,
      user.google_calendar_refresh_token
    );

    // Persist refreshed access token, if the helper rotated it mid-call.
    if (result && result._new_access_token) {
      await user.update({ google_calendar_token: result._new_access_token });
    }

    console.log(
      `[GcalSyncWorker] Job ${job.id}: deleted gcal event for user ${userId} (alreadyGone=${!!(result && result.alreadyGone)})`
    );
    return {
      ok: true,
      eventParticipationId,
      alreadyGone: !!(result && result.alreadyGone),
    };
  } catch (err) {
    // GCAL_DISCONNECTED is the ONLY error code we swallow -- it means the user
    // revoked GCal access between event-add and cleanup. Breadcrumb + return
    // skip; do NOT throw, do NOT retry, do NOT alert.
    if (err && err.code === 'GCAL_DISCONNECTED') {
      console.log(
        `[GcalSyncWorker] Job ${job.id}: GCal disconnected for user ${userId} (${err.message}); skipping (no retry)`
      );
      if (Sentry) {
        Sentry.addBreadcrumb({
          category: 'gcal-sync',
          message: 'skipped_due_to_disconnect',
          level: 'info',
          data: { eventId, eventParticipationId, userId, reason: err.message },
        });
      }
      return { skipped: true, reason: 'skipped_due_to_disconnect', eventParticipationId };
    }

    // Everything else (GCAL_RATE_LIMITED, GCAL_PERMANENT, raw 5xx, unknown):
    // re-throw. BullMQ will retry per the queue's exponential-backoff config.
    // Permanent errors will burn through the 3 attempts; the failed-event
    // hook below catches the final failure and escalates to Sentry.
    throw err;
  }
}

/**
 * BullMQ `failed` event hook — also exported so tests can assert the
 * attempts-exhausted Sentry alert path without invoking the real Worker.
 *
 * @param {object} job - BullMQ job (may be undefined in some failure modes)
 * @param {Error} err
 */
function handleJobFailed(job, err) {
  if (!job) {
    console.error('[GcalSyncWorker] Job failed (no job context):', err && err.message);
    return;
  }
  const attempts = (job.opts && job.opts.attempts) || 3;
  const exhausted = job.attemptsMade >= attempts;
  console.error(
    `[GcalSyncWorker] Job ${job.id} failed (attempt ${job.attemptsMade}/${attempts}):`,
    err && err.message
  );
  if (exhausted && Sentry) {
    Sentry.captureException(err, {
      tags: { worker: 'gcal-sync', exhausted: 'true' },
      extra: {
        eventId: job.data && job.data.eventId,
        eventParticipationId: job.data && job.data.eventParticipationId,
        userId: job.data && job.data.userId,
        errorCode: err && err.code,
        attemptsMade: job.attemptsMade,
      },
    });
  }
}

const gcalSyncWorker = new Worker('gcal-sync', processGcalSyncJob, {
  connection,
  concurrency: 5, // GCal API rate-limit-friendly; per-attendee jobs are independent
});

gcalSyncWorker.on('failed', handleJobFailed);

gcalSyncWorker.on('completed', (job, result) => {
  console.log(`[GcalSyncWorker] Job ${job.id} completed:`, result);
});

module.exports = gcalSyncWorker;
module.exports.processGcalSyncJob = processGcalSyncJob;
module.exports.handleJobFailed = handleJobFailed;
