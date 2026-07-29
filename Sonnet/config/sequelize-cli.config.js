// config/sequelize-cli.config.js
// Sequelize-CLI environment config.
// Mirrors the URL precedence chain from config/database.js so CLI commands
// (db:migrate, db:migrate:status, etc.) hit the same DB the runtime does.
//
// Used by:
//   - Local dev: `npx sequelize-cli db:migrate:status`
//   - CI: the `migrate-cli-replay` job in .github/workflows/ci.yml
//     (corrected in Phase 88.4 Plan 05 — the standalone migrations-check workflow this
//     line previously cited no longer exists)
//   - Railway pre-deploy step: `npm run migrate:apply`
//
// CI CONSUMER OF THE URL CHAIN BELOW (Phase 88.4, D-06): `migrate-cli-replay` builds TWO
// databases in one job and replays the whole migration chain from empty into one of them,
// so it sets DATABASE_URL PER STEP rather than job-wide, and never sets POSTGRES_URL /
// POSTGRES_PRIVATE_URL / PGDATABASE_URL at all. Any future change to the precedence chain
// below therefore has a named CI consumer: re-read that job's env comments first, because
// a change here can silently point the CLI and the 32 self-connecting migrations at
// different databases and turn the drift diff into a false green.
//
// Do NOT export a `sequelize` instance here — sequelize-cli expects a config object,
// not a live connection. Runtime DB connection lives in config/database.js.

require('dotenv').config();

const databaseUrl =
  process.env.POSTGRES_PRIVATE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.PGDATABASE_URL;

const isProduction = process.env.NODE_ENV === 'production';
const isRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME);
const isPrivateUrl = databaseUrl && databaseUrl === process.env.POSTGRES_PRIVATE_URL;
const requiresSSL = databaseUrl && (databaseUrl.includes('sslmode=require') || databaseUrl.includes('ssl=true'));

const sslConfig = isPrivateUrl
  ? false
  : (requiresSSL || (isProduction && !isRailway))
    ? { require: true, rejectUnauthorized: false }
    : false;

const baseConfig = {
  url: databaseUrl,
  dialect: 'postgres',
  dialectOptions: {
    ssl: sslConfig,
  },
};

module.exports = {
  development: baseConfig,
  test: baseConfig,
  production: baseConfig,
};
