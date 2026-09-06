// migrations/20260902000006-add-send-failed-at-to-single-use-tokens.js
//
// Phase 88.8 (owner ruling 2026-09-04, review round 4 defect 2 — "keep the
// token") — adds the nullable `send_failed_at` column to single_use_tokens.
//
// A timestamp means THE MAIL CARRYING THIS TOKEN WAS REFUSED BY THE PROVIDER and
// no code was ever delivered. Null on every row whose mail was not refused, and
// null for every purpose that sends no mail. Plan 09's per-user hourly mail
// budget counts rows created in the last hour WHERE this column is null — which
// is how a refused send keeps its token (so Resend, Verify and reload-hydration
// all still work) without charging the user for a mail that never left.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); its sync()-built counterpart is
// `models/SingleUseToken.js`, which declares `send_failed_at` with
// byte-identical type, nullability and default AND carries the full DECISION
// marker. Change one, change the other — the Jest/CI database is built by
// `sequelize.sync({ force: true })` in tests/globalSetup.js and never by this
// file, so a divergence here is invisible until prod.
//
// Pitfall 2 — the drift gate does NOT cover this. `migrate-cli-replay` runs
// scripts/ci/schema-drift-diff.js, which diffs foreign keys, PK/UNIQUE
// constraints, indexes and a table inventory ONLY (IDENTITY_FIELDS at :313-316
// has no column kind; its own comment at :319-323 calls a column-level kind
// FUTURE work). A missing addColumn adds no table, no constraint and no index,
// so migrate-cli-replay stays green. The compensating control is
// tests/migrations/columnMirror.test.js, which asserts this file exists on disk
// and names its own column.
//
// NO INDEX, deliberately. The hourly count already rides the leading
// `purpose, user_id` prefix of single_use_tokens_purpose_user_event_status;
// `send_failed_at IS NULL` is a filter over rows that prefix has already narrowed
// to one user, so D-39's "NO new index is required" survives this column intact.
const sequelize = require('../config/database');

async function up() {
  const queryInterface = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');

  // Idempotent: only add the column if it doesn't already exist. A throwing
  // migration blocks the Railway deploy at preDeployCommand, before /health is
  // ever reached (T-88.8-09).
  const tableDescription = await queryInterface.describeTable('single_use_tokens');
  if (tableDescription.send_failed_at) {
    console.log('[88.8] Column send_failed_at already exists on single_use_tokens. Skipping.');
    return;
  }

  await queryInterface.addColumn('single_use_tokens', 'send_failed_at', {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
  console.log('[88.8] Added send_failed_at column to single_use_tokens.');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.removeColumn('single_use_tokens', 'send_failed_at');
  console.log('[88.8] Dropped send_failed_at column from single_use_tokens.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
