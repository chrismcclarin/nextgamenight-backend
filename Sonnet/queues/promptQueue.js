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
      enableReadyCheck: false
    });
    // round-2 MEDIUM: no-op error listener so a dead-port construction does not
    // emit an unhandled 'error' event Node throws.
    _connection.on('error', () => {});
  }
  return _connection;
}

function getQueue() {
  if (!_queue) {
    _queue = new Queue('prompts', {
      connection: getConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 1000, // Keep last 1000 completed jobs
        removeOnFail: false      // Keep all failed jobs for debugging
      }
    });
  }
  return _queue;
}

module.exports = { getQueue, getConnection };
