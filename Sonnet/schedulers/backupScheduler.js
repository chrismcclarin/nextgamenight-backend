// schedulers/backupScheduler.js
// Weekly database backup scheduler using node-cron
const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');
const { recordRun } = require('../services/schedulerHealthService');

// Optional Sentry integration (Phase 85 / BAPI-02). DSN-gated require mirrors
// workers/deadlineWorker.js so the swallowed backup failure escalates in
// production. Purely additive: the recordRun telemetry and the
// `return { sent: 0, skipped: 1 }` below are byte-for-byte unchanged.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[backupScheduler] Sentry not available:', err.message);
  }
}

// Weekly schedule: Sunday at 2am UTC
const BACKUP_SCHEDULE = '0 2 * * 0';

const backupScriptPath = path.join(__dirname, '..', 'scripts', 'backup-database.js');

/**
 * Promisified wrapper around execFile so recordRun can await the child process.
 * Resolves with { stdout, stderr } on exit code 0; rejects with the error
 * (which carries .stdout / .stderr) on non-zero exit.
 */
function runBackupChild() {
  return new Promise((resolve, reject) => {
    execFile('node', [backupScriptPath], {
      env: process.env,
      timeout: 600000 // 10 minute timeout
    }, (error, stdout, stderr) => {
      if (stdout) console.log('[backup]', stdout.trim());
      if (stderr) console.error('[backup]', stderr.trim());
      if (error) return reject(error);
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Weekly backup job - spawns backup-database.js as a child process
 * so it runs independently and won't crash the server on failure.
 */
const backupJob = cron.schedule(BACKUP_SCHEDULE, async () => {
  console.log(`[${new Date().toISOString()}] Starting scheduled database backup...`);

  try {
    await recordRun('backup', async () => {
      try {
        await runBackupChild();
        console.log(`[${new Date().toISOString()}] Scheduled backup completed successfully`);
        return { sent: 1, skipped: 0 };
      } catch (err) {
        // Backup child exited non-zero. Treat as a failure for telemetry but
        // do NOT throw -- the existing behavior was "log and continue", and
        // recordRun-on-throw would mark the run as errored when really we
        // just want a zero-output record so the anomaly detector can fire if
        // backups stay broken (note: backup is NOT in SWEEP_JOBS).
        console.error(`[${new Date().toISOString()}] Scheduled backup failed:`, err.message);
        if (Sentry) Sentry.captureException(err, { tags: { job: 'backup' } });
        return { sent: 0, skipped: 1 };
      }
    });
  } catch (error) {
    console.error('Backup scheduler error:', error.message);
  }
}, {
  scheduled: false,  // Don't start automatically - server.js will call .start()
  timezone: 'UTC'
});

module.exports = { backupJob };
