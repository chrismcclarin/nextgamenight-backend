// workers/index.js
// Worker registry with graceful shutdown handling
const promptWorker = require('./promptWorker');
const deadlineWorker = require('./deadlineWorker');
const reminderWorker = require('./reminderWorker');
const gcalSyncWorker = require('./gcalSyncWorker');
const auth0CleanupWorker = require('./auth0CleanupWorker');
// Phase 88.8 / D-40: requiring this module is what CONSTRUCTS the Worker (each
// worker file does `new Worker(...)` at load), and server.js:522's destructure
// names only three workers but is not a start list — `require('./workers')`
// itself starts all of them. This require line is therefore what puts the
// email-notice lane into production.
const emailNoticeWorker = require('./emailNoticeWorker');

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
      gcalSyncWorker.close(),
      auth0CleanupWorker.close(),
      emailNoticeWorker.close()
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

console.log('BullMQ workers started (prompts, deadlines, reminders, gcal-sync, auth0-cleanup, email-notice)');

module.exports = { promptWorker, deadlineWorker, reminderWorker, gcalSyncWorker, auth0CleanupWorker, emailNoticeWorker };
