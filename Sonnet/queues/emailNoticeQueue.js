// queues/emailNoticeQueue.js
// Phase 88.8 (SPEC A13 / DR-E, CONTEXT D-40): dedicated BullMQ queue for the
// durable email-change SECURITY NOTICE lane. Jobs are enqueued by plan 09's
// verify and revert handlers AFTER their transaction commits; each job carries
// { to, sub, action, newAddress } and never a code, a token or a secret.
//
// Why this lane exists at all — it is not general-purpose mail plumbing. This
// phase creates the first mechanism that can redirect a user's mail off the
// Auth0-controlled address, and that redirect carries RSVP magic links,
// availability tokens and the ownership-offer restore link — all consumable with
// no session and all surviving a password reset. The A13 notice to the PRIOR
// address is therefore the ONLY out-of-band signal the real account holder ever
// gets that their address was taken over.
//
// DECISION Phase 88.8 D-40: queued WITH RETRIES, over fire-and-forget and over
// blocking the operation on the notice.
//   - Fire-and-forget was rejected because a single provider hiccup would
//     permanently destroy that one warning, with nothing left to retry from.
//   - Blocking the change on notice delivery was rejected because a user whose
//     PRIOR address is synthetic (google-oauth2-<id>@auth0.local) has nobody to
//     notify, so a hard dependency would lock out exactly the users this phase
//     exists to repair.
//   - Nothing about this notice appears in any response body or UI state:
//     telling the actor that the notice failed confuses a legitimate user about
//     a mail they never knew existed, and tells an attacker their tracks are
//     covered. Sentry fires only on genuine undeliverability, so it stays signal.
// Making this a direct send is a decision, not a simplification.
//
// Retry policy: the SHIPPED D-06 profile, deliberately identical to
// queues/auth0CleanupQueue.js:52-57 rather than a second tuning — 10 attempts
// with exponential 60s backoff (~17h coverage), sized to survive an hours-scale
// provider outage. removeOnFail is false so the dead-letter row persists
// indefinitely and stays visible in Bull Board for ops (T-88.8-75); on
// attempts-exhausted the worker pages via Sentry.
//
// Lazy connection + queue construction (BTEST-04 / D-03 part 1, T-88.8-77). See
// gcalSyncQueue.js for the rationale. Connects on first use, not at require, so
// a Redis-less test environment can require this module safely.
const { Queue } = require('bullmq');
const Redis = require('ioredis');

let _connection;
let _queue;

function getConnection() {
  if (!_connection) {
    _connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null, // REQUIRED for BullMQ blocking commands
      enableReadyCheck: false,
      retryStrategy(times) {
        // WR-01: exponential backoff capped at 20s — parity with every sibling
        // queue. Keeps producers reconnecting through a Redis blip.
        return Math.min(times * 1000, 20000);
      }
    });
    // WR-02: surface connection errors instead of swallowing them. A listener is
    // still required so a dead-port construction does NOT emit an unhandled 'error'
    // event Node throws, but a real production outage MUST be logged.
    _connection.on('error', (err) => {
      console.error('[emailNoticeQueue] Redis connection error:', err.message);
    });
  }
  return _connection;
}

function getQueue() {
  if (!_queue) {
    _queue = new Queue('email-notice', {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 10,                                    // D-06 profile: 10 retries
        backoff: { type: 'exponential', delay: 60000 }, // D-06: exponential 60s base (~17h coverage)
        removeOnComplete: 1000,                          // matches existing queues
        removeOnFail: false                              // dead-letter lane persists indefinitely (T-88.8-75)
      }
    });
  }
  return _queue;
}

module.exports = { getQueue, getConnection };
