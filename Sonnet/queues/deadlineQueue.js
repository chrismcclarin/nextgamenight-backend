const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Lazy connection + queue construction (BTEST-04 / D-03 part 1). See
// reminderQueue.js for the rationale. Connects on first use, not at require.
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
      console.error('[deadlineQueue] Redis connection error:', err.message);
    });
  }
  return _connection;
}

function getQueue() {
  if (!_queue) {
    _queue = new Queue('deadlines', {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 2,              // Fewer retries — deadline enforcement is time-sensitive
        backoff: { type: 'fixed', delay: 10000 },
        removeOnComplete: 500,
        removeOnFail: false       // Keep all failed jobs for debugging
      }
    });
  }
  return _queue;
}

module.exports = { getQueue, getConnection };
