// migrations/20260902000005-add-target-to-single-use-tokens.js
//
// Phase 88.8 (SPEC R12 as amended by A12, CONTEXT D-35) — adds the nullable
// `target` column to single_use_tokens.
//
// `target` is the PENDING address an email-change token proves; null for every
// other purpose. Post-A12 this is the ONLY place a requested-but-unverified
// address is ever stored.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); its sync()-built counterpart is
// `models/SingleUseToken.js`, which declares `target` with byte-identical type,
// nullability and default. Change one, change the other — the Jest/CI database is
// built by `sequelize.sync({ force: true })` in tests/globalSetup.js and never by
// this file, so a divergence here is invisible until prod. This column is a
// production-only 500 on EVERY mint if this migration is skipped and only the
// model attribute lands.
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
// NO INDEX, deliberately. Plan 09 never looks a token up BY address: it resolves
// by `nonce` (unique index single_use_tokens_nonce_unique) or by
// `purpose + user_id` (the leading prefix of
// single_use_tokens_purpose_user_event_status). Adding one "for symmetry" would
// index a personal address for no reader.
const sequelize = require('../config/database');

async function up() {
  const queryInterface = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');

  // Idempotent: only add the column if it doesn't already exist. A throwing
  // migration blocks the Railway deploy at preDeployCommand, before /health is
  // ever reached (T-88.8-09).
  const tableDescription = await queryInterface.describeTable('single_use_tokens');
  if (tableDescription.target) {
    console.log('[88.8] Column target already exists on single_use_tokens. Skipping.');
    return;
  }

  await queryInterface.addColumn('single_use_tokens', 'target', {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  });
  console.log('[88.8] Added target column to single_use_tokens.');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.removeColumn('single_use_tokens', 'target');
  console.log('[88.8] Dropped target column from single_use_tokens.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
