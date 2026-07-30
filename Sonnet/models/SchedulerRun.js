// models/SchedulerRun.js
// Records one row per scheduler tick for health telemetry and silent-failure
// detection. Phase 61 / MAIL-01: each registered scheduler wraps its work in
// schedulerHealthService.recordRun() which inserts a row here on every tick
// (success or failure). The anomaly detector queries this table to alert when
// historically-non-zero jobs go silent.
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SchedulerRun = sequelize.define('SchedulerRun', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  job_name: {
    type: DataTypes.STRING,
    allowNull: false,
    // e.g. 'reminder', 'deadline', 'auto_promotion', 'backup', 'prompt_sync'
  },
  sent_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  skipped_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  error: {
    type: DataTypes.TEXT,
    allowNull: true,
    // Stores error.message when a scheduler tick throws
  },
  duration_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  ran_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: true,
  indexes: [
    {
      // Anomaly query: SELECT last N runs of job ordered by ran_at DESC
      //
      // DECISION Phase 88.4 F-26 / F-27 (D2a): `order: 'DESC'` on ran_at. Migration
      // 20260501000001:69 creates `(job_name, ran_at DESC)` and the model declared no `order`, so
      // sync() emitted ASC — two objects under the name-free identity, hence the MIGRATION-ONLY
      // (F-26) and SYNC-ONLY (F-27) pair. The comment directly above already said DESC; the
      // ordering was dropped, not chosen.
      //
      // WORTH READING TWICE: both sides ALREADY USE THE IDENTICAL INDEX NAME
      // (`scheduler_runs_job_name_ran_at`), so the two databases differed in BEHAVIOUR while
      // looking identical to any name-based check. A name-keyed differ would have called them
      // equal. This pair is the in-repo proof of why D-04 excludes names from the identity.
      fields: ['job_name', { name: 'ran_at', order: 'DESC' }],
      name: 'scheduler_runs_job_name_ran_at',
    },
  ],
});

module.exports = SchedulerRun;
