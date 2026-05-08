// scripts/run-migration-prod.js
//
// Run a single Sequelize migration against Railway's Postgres using the
// PUBLIC proxy URL (works from a local laptop). Designed to be invoked via
// `railway run` with the Postgres service linked.
//
// Why this wrapper exists:
//   The Railway Postgres service exposes two URLs:
//     - DATABASE_URL          → internal hostname (postgres.railway.internal)
//                               only resolves from inside Railway's network
//     - DATABASE_PUBLIC_URL   → public TCP proxy (*.proxy.rlwy.net)
//                               works from anywhere with sslmode=require
//
//   `railway run` injects the service's env vars verbatim, with no flags
//   to swap them. Our config/database.js reads DATABASE_URL by priority
//   (POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL)
//   and would pick the internal one — which fails to resolve from a laptop.
//
//   This wrapper remaps DATABASE_PUBLIC_URL → DATABASE_URL and clears the
//   higher-priority URL vars BEFORE config/database.js loads. The migration
//   itself runs unchanged.
//
// Usage:
//   railway run -- node scripts/run-migration-prod.js <migration-filename>
//
// Examples:
//   railway run -- node scripts/run-migration-prod.js 20260501000001-create-scheduler-runs.js
//   railway run -- node scripts/run-migration-prod.js 20260507000002-add-availability-prompt-creator.js

const filename = process.argv[2];

if (!filename) {
  console.error('Usage: railway run -- node scripts/run-migration-prod.js <migration-filename>');
  console.error('Example: railway run -- node scripts/run-migration-prod.js 20260501000001-create-scheduler-runs.js');
  process.exit(1);
}

if (!process.env.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL is not set in the environment.');
  console.error('');
  console.error('Make sure you ran this via `railway run` with the Postgres service linked:');
  console.error('  railway link <project-id>     # (link to project + Postgres service if needed)');
  console.error('  railway run -- node scripts/run-migration-prod.js <filename>');
  console.error('');
  console.error('Or fall back to passing DATABASE_URL inline:');
  console.error("  DATABASE_URL='<public-url>' node scripts/run-migration-prod.js <filename>");
  process.exit(1);
}

// Remap so config/database.js's priority chain picks the public URL.
// MUST happen BEFORE require('../config/database').
process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
process.env.POSTGRES_URL = '';
process.env.POSTGRES_PRIVATE_URL = '';
process.env.PGDATABASE_URL = '';

const sequelize = require('../config/database');
const { Sequelize } = require('sequelize');

const migrationPath = '../migrations/' + filename;
let migration;
try {
  migration = require(migrationPath);
} catch (err) {
  console.error(`Could not load migration ${filename}:`, err.message);
  process.exit(1);
}

if (typeof migration.up !== 'function') {
  console.error(`Migration ${filename} does not export an up() function.`);
  process.exit(1);
}

(async () => {
  console.log(`▶ Running migration: ${filename}`);
  try {
    await migration.up(sequelize.getQueryInterface(), Sequelize);
    await sequelize.close();
    console.log(`✓ Migration complete: ${filename}`);
    process.exit(0);
  } catch (err) {
    console.error(`✗ Migration failed: ${filename}`);
    console.error(err);
    process.exit(1);
  }
})();
