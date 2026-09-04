// migrations/20260902000001-add-picture-url-to-users.js
//
// Phase 88.8 (SPEC R11) — adds the nullable `picture_url` column to Users.
// Holds the Google avatar URL lifted from the Auth0 `picture` claim at
// provisioning time. Deliberately NOT excluded by the User defaultScope: an
// avatar is a cross-boundary field (R11) — other members are meant to see it.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); its counterpart is `models/User.js`, which declares
// `picture_url` with byte-identical type, nullability and default. Change one,
// change the other — the Jest/CI database is built by
// `sequelize.sync({ force: true })` in tests/globalSetup.js and never by this
// file, so a divergence here is invisible until prod.
//
// Pitfall 2 — the drift gate does NOT cover this. `migrate-cli-replay` runs
// scripts/ci/schema-drift-diff.js, which diffs foreign keys, PK/UNIQUE
// constraints, indexes and a table inventory ONLY (its IDENTITY_FIELDS map at
// :313-316 has no column kind, and its own comment at :319-323 calls a
// column-level kind FUTURE work). A missing addColumn adds no table, no
// constraint and no index, so migrate-cli-replay stays green. The compensating
// control is tests/migrations/columnMirror.test.js, which asserts this file
// exists on disk and names its own column.
const sequelize = require('../config/database');

async function up() {
  const queryInterface = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');

  // Idempotent: only add the column if it doesn't already exist. A throwing
  // migration blocks the Railway deploy at preDeployCommand, before /health is
  // ever reached (T-88.8-09).
  const tableDescription = await queryInterface.describeTable('Users');
  if (tableDescription.picture_url) {
    console.log('[88.8] Column picture_url already exists on Users. Skipping.');
    return;
  }

  await queryInterface.addColumn('Users', 'picture_url', {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
  });
  console.log('[88.8] Added picture_url column to Users.');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.removeColumn('Users', 'picture_url');
  console.log('[88.8] Dropped picture_url column from Users.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
