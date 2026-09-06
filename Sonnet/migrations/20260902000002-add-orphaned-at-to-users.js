// migrations/20260902000002-add-orphaned-at-to-users.js
//
// Phase 88.8 (SPEC R5, CONTEXT D-14) — adds the nullable `orphaned_at` column to
// Users. Set when a collision repair releases a dead identity's address: the row
// stays for its historical rows but is marked as no longer owning that address.
// Null on every row that can log in. Literal type-match for the sibling
// `sms_welcome_sent_at` (D-14) — the same nullable-timestamp-as-state-marker
// idiom, so the two read as a pair.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); its counterpart is `models/User.js`, which declares
// `orphaned_at` with byte-identical type, nullability and default. Change one,
// change the other — the Jest/CI database is built by
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
const sequelize = require('../config/database');

async function up() {
  const queryInterface = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');

  // Idempotent: only add the column if it doesn't already exist. A throwing
  // migration blocks the Railway deploy at preDeployCommand, before /health is
  // ever reached (T-88.8-09).
  const tableDescription = await queryInterface.describeTable('Users');
  if (tableDescription.orphaned_at) {
    console.log('[88.8] Column orphaned_at already exists on Users. Skipping.');
    return;
  }

  await queryInterface.addColumn('Users', 'orphaned_at', {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  });
  console.log('[88.8] Added orphaned_at column to Users.');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.removeColumn('Users', 'orphaned_at');
  console.log('[88.8] Dropped orphaned_at column from Users.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
