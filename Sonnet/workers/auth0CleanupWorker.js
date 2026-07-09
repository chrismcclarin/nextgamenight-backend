// workers/auth0CleanupWorker.js
// Phase 87.2 / REQ-6 (Plan 03, D-07): durable Auth0 login-identity deletion worker.
//
// Triggered by jobs enqueued from the account-deletion flow (plan 87.2-04) via the
// `auth0-cleanup` BullMQ queue (queues/auth0CleanupQueue.js). Each job carries ONLY
// the Auth0 subject ({ sub }) — never a token/secret (D-02, T-87.2-07). It upholds
// the SPEC Req 6 invariant: no working login left pointing at deleted data without
// a retry that will kill it.
//
// Flow:
//   1. Read job.data.sub.
//   2. auth0Service.deleteUser(sub) — 404-idempotent (plan 87.2-02); throws on
//      401/403/429/5xx so BullMQ retries per the D-06 profile (attempts:10,
//      exponential 60s ≈ 17h).
//   3. On success, mark the PendingAuth0Deletion row COMPLETED (completed_at set,
//      email nulled, row RETAINED — plan 87.2-05 Task 2). The row is the tombstone
//      that blocks orphaned-token re-provision for the ~24h token-TTL window; the
//      reconciliation sweep purges it after the retention window.
//   4. On failure, re-throw. On attempts-exhausted the failed-event hook pages via
//      Sentry (T-87.2-08) — removeOnFail:false keeps the dead-letter row visible.
//
// The handler is exported as `processAuth0CleanupJob` and the failed-event hook as
// `handleJobFailed` so tests can drive them directly without booting BullMQ + Redis.
//
// The worker runs in the same process as the server, so auth0Service's cached
// getManagementToken() works identically (RESEARCH Finding 4).

const { Worker } = require('bullmq');
const Redis = require('ioredis');

// Optional Sentry integration -- mirrors gcalSyncWorker.js. SENTRY_DSN is the
// gate; when absent, alerts are silently skipped.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[Auth0CleanupWorker] Sentry not available:', err.message);
  }
}

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/**
 * Pure handler — exported so tests can invoke it directly with mocked deps.
 *
 * @param {{ id: string, data: { sub: string } }} job
 * @returns {Promise<object>}
 */
async function processAuth0CleanupJob(job) {
  const { sub } = job.data || {};

  // Lazy-require so tests can mock these without import-time hoisting issues.
  const auth0Service = require('../services/auth0Service');
  const { PendingAuth0Deletion } = require('../models');

  // 1. Delete the Auth0 login identity. 404 is idempotent-success (plan 87.2-02);
  //    401/403/429/5xx throw and bubble to BullMQ's retry lane.
  await auth0Service.deleteUser(sub);

  // 2. Mark the durable marker COMPLETED on success (plan 87.2-05 Task 2 — this
  //    supersedes plan 87.2-03's destroy-on-success). The marker doubles as the
  //    tombstone the Users-create guards read (Req 6): Auth0 deletion does not
  //    revoke already-issued tokens (~24h TTL), so destroying the row here would
  //    reopen the JIT re-provision hole the moment this job succeeds. The email
  //    is nulled in the SAME update — the notice email was already sent
  //    in-request from the captured value (plan 87.2-04 Step 5); after completion
  //    the tombstone needs only the sub, and retaining a deleted user's email in
  //    a GDPR-deletion table past this point would invalidate T-87.2-03's
  //    short-lived-row acceptance. Purging the row is the sweep's job (server.js)
  //    once completed_at is older than the 24h retention window.
  await PendingAuth0Deletion.update(
    { completed_at: new Date(), email: null },
    { where: { auth0_sub: sub } }
  );

  console.log(`[Auth0CleanupWorker] Job ${job.id}: deleted Auth0 identity + marked tombstone completed for ${sub}`);
  return { ok: true, sub };
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
    console.error('[Auth0CleanupWorker] Job failed (no job context):', err && err.message);
    return;
  }
  const attempts = (job.opts && job.opts.attempts) || 10; // D-06: 10
  const exhausted = job.attemptsMade >= attempts;
  console.error(
    `[Auth0CleanupWorker] Job ${job.id} failed (attempt ${job.attemptsMade}/${attempts}):`,
    err && err.message
  );
  if (exhausted && Sentry) {
    // T-87.2-08: a working login on deleted data must page loudly.
    Sentry.captureException(err, {
      tags: { worker: 'auth0-cleanup', exhausted: 'true' },
      extra: {
        sub: job.data && job.data.sub,
        attemptsMade: job.attemptsMade,
      },
    });
  }
}

const auth0CleanupWorker = new Worker('auth0-cleanup', processAuth0CleanupJob, {
  connection,
  concurrency: 5, // per-subject jobs are independent
});

auth0CleanupWorker.on('failed', handleJobFailed);

auth0CleanupWorker.on('completed', (job, result) => {
  console.log(`[Auth0CleanupWorker] Job ${job.id} completed:`, result);
});

module.exports = auth0CleanupWorker;
module.exports.processAuth0CleanupJob = processAuth0CleanupJob;
module.exports.handleJobFailed = handleJobFailed;
