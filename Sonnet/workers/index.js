// workers/index.js
// Worker registry with graceful shutdown handling
const promptWorker = require('./promptWorker');
const deadlineWorker = require('./deadlineWorker');
const reminderWorker = require('./reminderWorker');
const gcalSyncWorker = require('./gcalSyncWorker');

async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, closing BullMQ workers gracefully...`);

  const timeout = setTimeout(() => {
    console.error('Graceful shutdown timeout (30s), forcing exit');
    process.exit(1);
  }, 30000); // 30-second timeout

  try {
    await Promise.all([
      promptWorker.close(),
      deadlineWorker.close(),
      reminderWorker.close(),
      gcalSyncWorker.close()
    ]);

    clearTimeout(timeout);
    console.log('All BullMQ workers closed gracefully');
    process.exit(0);
  } catch (err) {
    console.error('Error during worker shutdown:', err);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

console.log('BullMQ workers started (prompts, deadlines, reminders, gcal-sync)');

module.exports = { promptWorker, deadlineWorker, reminderWorker, gcalSyncWorker };
