// scripts/test-anomaly.js
// One-off local verification: forces a scheduler anomaly to fire by seeding
// fake SchedulerRun history, then calls checkAnomalies. Should emit:
//   - console.warn line about consecutive zero-output runs
//   - Sentry "warning" event tagged scheduler_anomaly=zero_output (if SENTRY_DSN set)
//
// Run: node scripts/test-anomaly.js
// Cleanup: the script deletes its own seeded rows at the end.

require('dotenv').config();
const { sequelize, SchedulerRun } = require('../models');
const { checkAnomalies } = require('../services/schedulerHealthService');

const TEST_JOB = 'reminder';

(async () => {
  try {
    await sequelize.authenticate();
    console.log('DB connected.');

    const now = Date.now();
    const min = (n) => new Date(now - n * 60 * 1000);
    const hr = (n) => new Date(now - n * 60 * 60 * 1000);

    // Seed: one historical non-zero run (3h ago) + three recent zero runs (15/30/45 min ago)
    const seeded = await SchedulerRun.bulkCreate([
      { job_name: TEST_JOB, sent_count: 5, skipped_count: 0, duration_ms: 100, ran_at: hr(3) },
      { job_name: TEST_JOB, sent_count: 0, skipped_count: 0, duration_ms: 100, ran_at: min(45) },
      { job_name: TEST_JOB, sent_count: 0, skipped_count: 0, duration_ms: 100, ran_at: min(30) },
      { job_name: TEST_JOB, sent_count: 0, skipped_count: 0, duration_ms: 100, ran_at: min(15) },
    ]);
    console.log(`Seeded ${seeded.length} SchedulerRun rows for job=${TEST_JOB}`);

    console.log('Calling checkAnomalies...');
    const result = await checkAnomalies({ jobName: TEST_JOB });
    console.log('Result:', result);

    if (result.anomaly) {
      console.log('✓ Anomaly fired. Watch your Sentry dashboard for the event.');
    } else {
      console.log('✗ No anomaly detected. Check seeded rows / thresholds.');
    }

    // Cleanup
    const ids = seeded.map((r) => r.id);
    await SchedulerRun.destroy({ where: { id: ids } });
    console.log(`Cleaned up ${ids.length} seeded rows.`);

    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
})();
