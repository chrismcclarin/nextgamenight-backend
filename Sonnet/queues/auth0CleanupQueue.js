// queues/auth0CleanupQueue.js
// Phase 87.2 (REQ-6, D-05/D-06): dedicated BullMQ queue for the durable Auth0
// login-identity deletion retry lane. Jobs are enqueued by the account-deletion
// flow (plan 87.2-04) after the Users row is hard-deleted; each job carries ONLY
// the Auth0 subject ({ sub }) — never any token/secret (D-02, T-87.2-07).
//
// SPEC Req 6 invariant: no working login may be left pointing at deleted data
// without a pending retry that will kill it. This queue is that retry lane; the
// worker (workers/auth0CleanupWorker.js) deletes the Auth0 identity and clears
// the PendingAuth0Deletion marker on success.
//
// Retry policy (D-06): 10 attempts with exponential 60s backoff (~17h coverage)
// — sized to survive an hours-scale Auth0 Management-API outage. removeOnFail is
// false so the dead-letter row persists indefinitely and stays visible in Bull
// Board for ops (T-87.2-08); on attempts-exhausted the worker pages via Sentry.
// The deterministic jobId (auth0-cleanup-<sub>) that dedupes duplicate enqueues
// (T-87.2-09) is set by the enqueuer in plan 87.2-04, NOT here.
//
// Lazy connection + queue construction (BTEST-04 / D-03 part 1, Pitfall 4). See
// gcalSyncQueue.js for the rationale. Connects on first use, not at require.
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
        // WR-01: exponential backoff capped at 20s — parity with the pre-refactor
        // shared connection. Keeps producers reconnecting through a Redis blip.
        return Math.min(times * 1000, 20000);
      }
    });
    // WR-02: surface connection errors instead of swallowing them. A listener is
    // still required so a dead-port construction does NOT emit an unhandled 'error'
    // event Node throws, but a real production outage MUST be logged.
    _connection.on('error', (err) => {
      console.error('[auth0CleanupQueue] Redis connection error:', err.message);
    });
  }
  return _connection;
}

function getQueue() {
  if (!_queue) {
    _queue = new Queue('auth0-cleanup', {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 10,                                    // D-06: 10 retries
        backoff: { type: 'exponential', delay: 60000 }, // D-06: exponential 60s base (~17h coverage)
        removeOnComplete: 1000,                          // matches existing queues
        removeOnFail: false                              // dead-letter lane persists indefinitely (T-87.2-08)
      }
    });
  }
  return _queue;
}

module.exports = { getQueue, getConnection };
