// workers/emailNoticeWorker.js
// Phase 88.8 (SPEC A13 / DR-E, CONTEXT D-40): worker for the durable
// email-change SECURITY NOTICE lane (queues/emailNoticeQueue.js).
//
// Triggered by jobs enqueued from plan 09's verify and revert handlers after
// their transaction commits. Each job carries { to, sub, action, newAddress };
// `to` is the PRIOR address — the one the real account holder still controls
// once a redirect is in place — and the mail carries no code and no link.
//
// Flow:
//   1. Read job.data.
//   2. emailService.sendEmailChangeNotice(to, { action, newAddress }).
//   3. THROW on a refusal so BullMQ retries per the D-06 profile (attempts 10,
//      exponential 60s ~ 17h).
//   4. On attempts-exhausted the failed-event hook pages via Sentry (T-88.8-75)
//      — removeOnFail:false keeps the dead-letter row visible in Bull Board.
//
// The handler is exported as `processEmailNoticeJob` and the failed-event hook
// as `handleJobFailed` so tests can drive them directly without booting BullMQ
// + Redis — same shape as workers/auth0CleanupWorker.js:125-127.

const { Worker } = require('bullmq');
const Redis = require('ioredis');

// Optional Sentry integration -- mirrors auth0CleanupWorker.js. SENTRY_DSN is
// the gate; when absent, alerts are silently skipped.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[EmailNoticeWorker] Sentry not available:', err.message);
  }
}

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

/**
 * Domain of an email address, or a fixed placeholder. Telemetry-side scrubber.
 *
 * DECISION Phase 88.8 T-88.8-76: derived locally here rather than imported from
 * plan 04's `emailDomain` in `utils/provisioningReport.js`, so this file carries
 * no cross-wave dependency on a module written in a different plan. The two do
 * the same job on two different paths; consolidating them is a deliberate
 * NON-GOAL of this plan, not an oversight. It is also NOT
 * `emailService.maskEmail` — that is a DISPLAY mask for mail copy and keeps a
 * first initial, which telemetry to a third party does not get.
 *
 * @param {string} value
 * @returns {string} The domain, or 'unknown'.
 */
function emailDomainOf(value) {
  if (typeof value !== 'string') return 'unknown';
  const at = value.lastIndexOf('@');
  if (at < 0 || at === value.length - 1) return 'unknown';
  return value.slice(at + 1);
}

/**
 * Pure handler — exported so tests can invoke it directly with mocked deps.
 *
 * @param {{ id: string, data: { to: string, sub: string, action: string, newAddress: string } }} job
 * @returns {Promise<object>}
 */
async function processEmailNoticeJob(job) {
  const { to, sub, action, newAddress } = job.data || {};

  // Lazy-require so tests can mock the service without import-time hoisting issues.
  const emailService = require('../services/emailService');

  if (!to) {
    // No recipient means the enqueuer lost the prior address. Throwing puts the
    // job in the dead-letter lane where ops can see it, rather than "sending"
    // nowhere and reporting success.
    throw new Error(`[EmailNoticeWorker] Job ${job.id}: no recipient on job data`);
  }

  const result = await emailService.sendEmailChangeNotice(to, { action, newAddress });

  // THROW on a refusal. Returning cleanly here would mark the job complete and
  // silently discard the retry lane this whole plan exists to build — and the
  // A13 notice is the only warning the real account holder ever gets, so a
  // swallowed refusal destroys it permanently. The message deliberately names
  // no address: a job error string ends up in Redis, in Bull Board and in
  // Sentry breadcrumbs.
  if (!result || result.success !== true) {
    throw new Error(
      `[EmailNoticeWorker] Job ${job.id}: provider refused the security notice ` +
      `(domain ${emailDomainOf(to)}) — retrying per the D-06 profile`
    );
  }

  console.log(`[EmailNoticeWorker] Job ${job.id}: security notice delivered for ${sub}`);
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
    console.error('[EmailNoticeWorker] Job failed (no job context):', err && err.message);
    return;
  }
  const attempts = (job.opts && job.opts.attempts) || 10; // D-06: 10
  const exhausted = job.attemptsMade >= attempts;
  console.error(
    `[EmailNoticeWorker] Job ${job.id} failed (attempt ${job.attemptsMade}/${attempts}):`,
    err && err.message
  );
  if (exhausted && Sentry) {
    // T-88.8-75: a security notice that never landed must page loudly — the
    // account holder was never warned.
    //
    // T-88.8-76 PII rule: `extra` carries the sub and the recipient's DOMAIN and
    // NOTHING else. Not the recipient's local part, and not the new address in
    // ANY form — a masked address is still a domain plus a first initial, and
    // SPEC R4's domain-only rule governs telemetry, not mail copy. attemptsMade
    // is deliberately omitted too, to keep this payload literally minimal; the
    // attempt count is already visible on the dead-letter row in Bull Board.
    Sentry.captureException(err, {
      tags: { worker: 'email-notice', exhausted: 'true' },
      extra: {
        sub: job.data && job.data.sub,
        recipientDomain: emailDomainOf(job.data && job.data.to),
      },
    });
  }
}

const emailNoticeWorker = new Worker('email-notice', processEmailNoticeJob, {
  connection,
  concurrency: 5, // per-user notices are independent
});

emailNoticeWorker.on('failed', handleJobFailed);

emailNoticeWorker.on('completed', (job, result) => {
  console.log(`[EmailNoticeWorker] Job ${job.id} completed:`, result);
});

module.exports = emailNoticeWorker;
module.exports.processEmailNoticeJob = processEmailNoticeJob;
module.exports.handleJobFailed = handleJobFailed;
