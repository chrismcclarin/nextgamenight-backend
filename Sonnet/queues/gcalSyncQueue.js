// queues/gcalSyncQueue.js
// Phase 75 / GCAL-01: dedicated BullMQ queue for outbound Google Calendar
// removal jobs (event cancel, event hard-delete, RSVP yes->no per Plan 75-04).
//
// Plan 75-02 ships ONLY the queue infrastructure. The worker handler is a
// scaffold no-op (see workers/gcalSyncWorker.js); real removal logic ships
// in Plan 75-03. Decoupling the queue + worker scaffold from the business
// logic lets Plans 75-03 and 75-04 enqueue against a queue that already
// exists in production.
//
// Retry policy (per CONTEXT D-RETRY): 3 attempts with exponential backoff.
// 1s base delay -> ~1s, ~2s, ~4s waits. Quicker than reminderQueue's 10s
// base because GCal API calls resolve in well under a second on success
// and we don't want ghost entries lingering for the duration of three
// 10s+ backoffs. removeOnFail=false keeps failed jobs visible in Bull
// Board for ops debugging (matches existing queues).
//
// Lazy connection + queue construction (BTEST-04 / D-03 part 1). See
// reminderQueue.js for the rationale. Connects on first use, not at require.
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
      console.error('[gcalSyncQueue] Redis connection error:', err.message);
    });
  }
  return _connection;
}

function getQueue() {
  if (!_queue) {
    _queue = new Queue('gcal-sync', {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,                                    // CONTEXT D-RETRY: 3 retries
        backoff: { type: 'exponential', delay: 1000 }, // CONTEXT D-RETRY: 1s -> 2s -> 4s pattern
        removeOnComplete: 1000,                         // matches existing queues
        removeOnFail: false                             // Keep all failed jobs for debugging
      }
    });
  }
  return _queue;
}

module.exports = { getQueue, getConnection };
