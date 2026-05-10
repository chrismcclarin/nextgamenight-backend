// workers/gcalSyncWorker.js
//
// SCAFFOLD ONLY — Plan 75-02 ships the queue/worker infra.
// Plan 75-03 fills in the GCal removal logic.
// Plan 75-04 wires the RSVP yes->no trigger.
//
// This handler intentionally does NO work — it logs the job data and
// returns a structured placeholder so end-to-end wiring tests can
// confirm the queue/worker/Bull Board path is hooked up correctly.
// Sentry require is wired now (matches reminderWorker pattern) so
// Plan 75-03 can lean on the same Sentry hook for permanent-failure
// alerts (per CONTEXT failure-handling decision).
const { Worker } = require('bullmq');
const Redis = require('ioredis');

// Optional Sentry integration -- mirror reminderWorker.js so Plan 75-03's
// permanent-failure alerts (after 3 retries) can use the same hook.
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
  enableReadyCheck: false
});

const gcalSyncWorker = new Worker('gcal-sync', async (job) => {
  const { eventId, eventParticipationId, userId } = job.data || {};
  console.log(
    `[GcalSyncWorker] (scaffold) Received job ${job.id} for event ${eventId} ` +
    `participation ${eventParticipationId} user ${userId}`
  );
  // SCAFFOLD ONLY -- Plan 75-03 implements the real handler.
  // Returning a structured placeholder so e2e checks can confirm wiring.
  return { scaffold: true, eventId, eventParticipationId, userId };
}, {
  connection,
  concurrency: 5  // GCal API rate-limit-friendly; per-attendee jobs are independent
});

gcalSyncWorker.on('failed', (job, err) => {
  console.error(`[GcalSyncWorker] Job ${job?.id} failed:`, err.message);
});

gcalSyncWorker.on('completed', (job, result) => {
  console.log(`[GcalSyncWorker] Job ${job.id} completed:`, result);
});

module.exports = gcalSyncWorker;
