const Redis = require('ioredis');

// Shared Redis connection — reused across all queues for monitoring/admin
// REDIS_URL format: redis://username:password@host:port
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // REQUIRED for BullMQ blocking commands
  enableReadyCheck: false,    // Faster startup
  retryStrategy(times) {
    const delay = Math.min(times * 1000, 20000); // Exponential backoff, max 20s
    return delay;
  }
});

connection.on('connect', () => console.log('Redis connected for BullMQ'));
connection.on('error', (err) => console.error('Redis connection error:', err.message));

// Import queue definitions (each queue manages its own connection internally)
const promptQueue = require('./promptQueue');
const deadlineQueue = require('./deadlineQueue');
const reminderQueue = require('./reminderQueue');
const gcalSyncQueue = require('./gcalSyncQueue');

module.exports = {
  connection,
  promptQueue,
  deadlineQueue,
  reminderQueue,
  gcalSyncQueue
};
