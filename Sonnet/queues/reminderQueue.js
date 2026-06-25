const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Lazy connection + queue construction (BTEST-04 / D-03 part 1).
// The eager `new Redis()` + `new Queue()` at import threw ECONNREFUSED 6379 in a
// Redis-less environment (CI test job) before any test ran. Defer both behind
// getters so Redis connects on FIRST USE, not at require/destructure time.
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
    // event Node throws (ioredis lazyConnect:false begins connecting immediately).
    // But a real production outage (ECONNREFUSED/auth/reset) MUST be logged —
    // otherwise it stays invisible until a downstream enqueue fails generically.
    _connection.on('error', (err) => {
      console.error('[reminderQueue] Redis connection error:', err.message);
    });
  }
  return _connection;
}

function getQueue() {
  if (!_queue) {
    _queue = new Queue('reminders', {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: 1000,
        removeOnFail: false       // Keep all failed jobs for debugging
      }
    });
  }
  return _queue;
}

module.exports = { getQueue, getConnection };
