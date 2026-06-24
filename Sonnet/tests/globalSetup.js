// tests/globalSetup.js
//
// Jest globalSetup: runs ONCE in the PARENT process before any worker spawns.
// Builds the test schema a single time via a force-sync and then closes its own
// connection. Workers get a separate module registry, so
// the per-test data wipe (TRUNCATE) lives in tests/setup.js, NOT here
// (Pitfall 1: a TRUNCATE issued here would run against this parent connection's
// registry, not the workers').
//
// LIFECYCLE NOTE (for plan 05's force-sync + close gates): this file is the
// canonical place that legitimately calls BOTH sync({force:true}) AND
// sequelize.close(). Plan 05's grep gates MUST EXCLUDE tests/globalSetup.js and
// tests/globalTeardown.js — these calls are the parent-process schema/connection
// lifecycle, not the per-suite destruction this phase removes.
const path = require('path');
const fs = require('fs');

/**
 * DESTRUCTIVE-OP GUARD — NON-PRODUCTION SEMANTICS (threat T-83.1-01, review HIGH-1).
 *
 * sync({force:true}) DROPs and recreates every table. We must never run it
 * against a production database. The guard aborts ONLY when the target is a
 * real production DB:
 *   - NODE_ENV === 'production', OR
 *   - the resolved DB host matches a production-host allowlist.
 *
 * The host allowlist MUST include the Railway INTERNAL/private host
 * (`railway.internal`) because prod connects primarily via POSTGRES_PRIVATE_URL
 * (config/database.js:14-19), plus the public Railway proxy hosts
 * (`rlwy.net`, `railway.app`). Omitting `railway.internal` would leave the host
 * arm silently missing the documented prod target.
 *
 * We deliberately DO NOT require the DB name to contain 'test'. CI uses
 * `boardgame_db` and `.env.test` is gitignored (Sonnet/.gitignore), so in CI
 * dotenv no-ops and the run falls back to DATABASE_URL=.../boardgame_db — which
 * has no "test" substring. A name-substring guard would throw against
 * `boardgame_db` and abort the suite before any test, making CI's `test` job
 * impossible to green (the single DoD-blocking issue from the review).
 *
 * Safety property preserved: "never force-sync/TRUNCATE a production DB".
 * Coupling removed: "the DB must be named *test*".
 *
 * (Alternative considered + rejected: rename CI's DB to `boardgame_test_db` and
 * align db:create / DATABASE_URL in ci.yml — rejected as more cross-file
 * coupling for no added safety.)
 */
const PROD_HOST_PATTERNS = ['railway.internal', 'rlwy.net', 'railway.app'];

function resolveDbHost(sequelize) {
  // Prefer the connection URL host (matches how prod actually connects), then
  // fall back to sequelize.config.host for the individual-var path.
  const url =
    process.env.POSTGRES_PRIVATE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.PGDATABASE_URL;
  if (url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      // fall through to config.host
    }
  }
  return (sequelize && sequelize.config && sequelize.config.host) || '';
}

function assertNotProduction(sequelize) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      "[globalSetup] Refusing to sync({force:true}): NODE_ENV==='production'. " +
        'This would DROP every table in a production database.'
    );
  }

  const host = (resolveDbHost(sequelize) || '').toLowerCase();
  const denyHost = (process.env.PROD_DB_HOST_DENY || '').toLowerCase();
  const matchedPattern = PROD_HOST_PATTERNS.find((p) => host.includes(p));
  const matchedDeny = denyHost && host.includes(denyHost);

  if (matchedPattern || matchedDeny) {
    throw new Error(
      `[globalSetup] Refusing to sync({force:true}): DB host "${host}" matches a ` +
        `production-host allowlist (${matchedPattern || denyHost}). ` +
        'This would DROP every table in a production database.'
    );
  }
  // localhost / 127.0.0.1 and any non-production NODE_ENV pass the guard.
}

module.exports = async function globalSetup() {
  // Load test env. In CI this is gitignored and absent (dotenv no-ops) — that is
  // expected; the non-production guard above protects the CI fallback DB.
  const envTestPath = path.join(__dirname, '..', '.env.test');
  if (fs.existsSync(envTestPath)) {
    require('dotenv').config({ path: envTestPath });
  }

  // Force test mode BEFORE requiring ../models so config/database.js resolves the
  // test connection.
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  if (process.env.NODE_ENV !== 'production') {
    process.env.NODE_ENV = 'test';
  }

  const { sequelize } = require('../models');

  assertNotProduction(sequelize);

  await sequelize.authenticate();
  // Build the schema exactly once for the whole run. No migrations: there is no
  // genesis migration in the repo (D-02), so sync is the only path that
  // provisions an empty DB.
  await sequelize.sync({ force: true });

  // Own our own connection lifecycle — close the parent connection so workers
  // open fresh pooled connections.
  await sequelize.close();
};
