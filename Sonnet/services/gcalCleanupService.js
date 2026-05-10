// services/gcalCleanupService.js
// Phase 75 / GCAL-01: dispatcher helpers for the gcal-sync BullMQ queue.
//
// Called from:
//   - DELETE /api/events/:id            (this plan, 75-03)
//   - RSVP yes->no / RSVP DELETE flow   (Plan 75-04)
//
// Best-effort + non-blocking:
//   - Never throws to the caller. The caller's primary action (event delete /
//     RSVP change) must never be blocked by a Redis outage or a cleanup-job
//     enqueue failure.
//   - Per-row errors are caught + counted; the function returns { enqueued,
//     skipped, errors } counters for ops visibility but does NOT propagate.
//
// Job granularity:
//   - One job per (event_id, event_participation_id) pair (CONTEXT D-JOB-GRANULARITY).
//   - Each job carries the googleCalendarEventId in the payload so the worker
//     does not need a second DB lookup.
//   - Deterministic jobId of `gcal-cleanup-${eventParticipationId}` enables
//     BullMQ's built-in jobId-dedupe so duplicate enqueue calls (e.g. retried
//     DELETE request, double-fired RSVP change) don't create duplicate jobs.

const { EventParticipation } = require('../models');
const { gcalSyncQueue } = require('../queues');

/**
 * Enqueue per-attendee GCal cleanup jobs for an event being cancelled or
 * hard-deleted. Skips EventParticipation rows with null
 * google_calendar_event_id silently (they never had a GCal entry to remove).
 *
 * MUST be called BEFORE EventParticipation.destroy / event.destroy so the
 * google_calendar_event_id values are still readable when we enqueue.
 *
 * @param {Object} params
 * @param {string} params.eventId - Event UUID
 * @returns {Promise<{ enqueued: number, skipped: number, errors: number }>}
 */
async function enqueueCleanupJobsForEvent({ eventId }) {
  const counters = { enqueued: 0, skipped: 0, errors: 0 };

  let participations;
  try {
    participations = await EventParticipation.findAll({
      where: { event_id: eventId },
      attributes: ['id', 'event_id', 'user_id', 'google_calendar_event_id'],
    });
  } catch (queryErr) {
    // DB unavailable — best-effort, return zeros instead of throwing.
    console.error(
      `[gcalCleanupService] Failed to query EventParticipations for event ${eventId} (non-fatal):`,
      queryErr.message
    );
    return counters;
  }

  for (const p of participations) {
    if (!p.google_calendar_event_id) {
      counters.skipped++;
      continue;
    }
    try {
      await gcalSyncQueue.add(
        'cleanup',
        {
          eventId: p.event_id,
          eventParticipationId: p.id,
          userId: p.user_id,
          googleCalendarEventId: p.google_calendar_event_id,
        },
        { jobId: `gcal-cleanup-${p.id}` } // dedupe-on-retry safety
      );
      counters.enqueued++;
    } catch (enqueueErr) {
      counters.errors++;
      console.error(
        `[gcalCleanupService] Failed to enqueue cleanup job for EP ${p.id} (non-fatal):`,
        enqueueErr.message
      );
    }
  }

  return counters;
}

/**
 * Enqueue a single cleanup job for one attendee. Used by the RSVP yes->no
 * and RSVP DELETE-of-yes paths in Plan 75-04.
 *
 * Also best-effort + non-blocking. Returns counters; never throws.
 *
 * @param {Object} params
 * @param {string} params.eventId
 * @param {string} params.eventParticipationId
 * @param {string} params.userId
 * @param {string|null} params.googleCalendarEventId
 * @returns {Promise<{ enqueued: number, skipped: number, errors?: number }>}
 */
async function enqueueCleanupJobForAttendee({
  eventId,
  eventParticipationId,
  userId,
  googleCalendarEventId,
}) {
  if (!googleCalendarEventId) {
    return { enqueued: 0, skipped: 1 };
  }
  try {
    await gcalSyncQueue.add(
      'cleanup',
      { eventId, eventParticipationId, userId, googleCalendarEventId },
      { jobId: `gcal-cleanup-${eventParticipationId}` }
    );
    return { enqueued: 1, skipped: 0 };
  } catch (err) {
    console.error(
      `[gcalCleanupService] Failed to enqueue per-attendee cleanup job for EP ${eventParticipationId} (non-fatal):`,
      err.message
    );
    return { enqueued: 0, skipped: 0, errors: 1 };
  }
}

module.exports = {
  enqueueCleanupJobsForEvent,
  enqueueCleanupJobForAttendee,
};
