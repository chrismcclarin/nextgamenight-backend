// migrations/20260902000003-add-email-changed-at-to-users.js
//
// Phase 88.8 (SPEC R12 as amended by A12, CONTEXT D-36) — adds the nullable
// `email_changed_at` column to Users.
//
// NULL means the address in Users.email is Auth0-owned and plan 04's repair
// branch MAY overwrite it. A TIMESTAMP means the user set the address themselves
// and the repair branch MUST leave it alone. Same
// nullable-timestamp-as-state-marker idiom as `orphaned_at` one migration
// earlier, so the two read as a pair.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); its counterpart is `models/User.js`, which declares
// `email_changed_at` with byte-identical type, nullability and default AND adds
// it to the defaultScope exclude list. Change one, change the other — the
// Jest/CI database is built by `sequelize.sync({ force: true })` in
// tests/globalSetup.js and never by this file, so a divergence here is invisible
// until prod.
//
// Pitfall 2 — the drift gate does NOT cover this. `migrate-cli-replay` runs
// scripts/ci/schema-drift-diff.js, which diffs foreign keys, PK/UNIQUE
// constraints, indexes and a table inventory ONLY (IDENTITY_FIELDS at :313-316
// has no column kind; its own comment at :319-323 calls a column-level kind
// FUTURE work). A missing addColumn adds no table, no constraint and no index,
// so migrate-cli-replay stays green. The compensating control is
// tests/migrations/columnMirror.test.js, which asserts this file exists on disk
// and names its own column.
const sequelize = require('../config/database');

async function up() {
  const queryInterface = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');

  // Idempotent: only add the column if it doesn't already exist. A throwing
  // migration blocks the Railway deploy at preDeployCommand, before /health is
  // ever reached (T-88.8-09).
  const tableDescription = await queryInterface.describeTable('Users');
  if (tableDescription.email_changed_at) {
    console.log('[88.8] Column email_changed_at already exists on Users. Skipping.');
    return;
  }

  await queryInterface.addColumn('Users', 'email_changed_at', {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
  console.log('[88.8] Added email_changed_at column to Users.');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.removeColumn('Users', 'email_changed_at');
  console.log('[88.8] Dropped email_changed_at column from Users.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
