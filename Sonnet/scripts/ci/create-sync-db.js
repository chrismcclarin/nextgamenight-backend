#!/usr/bin/env node
'use strict';
//
// scripts/ci/create-sync-db.js
//
// Phase 88.4 (SPEC R2; decision D-06): create the SYNC-SIDE database for the
// migrate-cli-replay CI job. The job needs two databases built from the same commit:
// one by replaying the migration chain through sequelize-cli, one by sync()ing the
// models. This script provisions the second one, empty, so
// `scripts/ci/sync-build-schema.js` can build its schema and
// `scripts/ci/schema-drift-diff.js` can compare the two.
//
// ENV CONTRACT (D-06) -- exactly one variable:
//   ADMIN_DB_URL   an admin connection (the `postgres` maintenance database), NOT the
//                  database being created. Purpose-named on purpose: it is deliberately
//                  absent from the shared runtime precedence chain
//                  `POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL`
//                  (config/database.js:16-19, config/sequelize-cli.config.js:16-20), so a
//                  stray DATABASE_URL in the environment can never steer this DROP.
//
// DROP TARGET IS HARDCODED AND IS NEVER TAKEN FROM ENV (threat T-88.4-10). The database
// dropped and recreated is the module-level const SYNC_DB_NAME below. There is no
// process.env.SYNC_DB_NAME, and the name is NOT derived from ADMIN_DB_URL's path
// component. A mis-set environment variable can change WHICH SERVER this connects to
// (which is why the NODE_ENV refusal below exists), but it cannot redirect the DROP onto a
// different database name.
//
// DECISION Phase 88.4 D-06: raw `pg` Client OVER Sequelize. `scripts/create-database.js`
// does the same job through a Sequelize admin connection; this script does not, because
// (a) `pg` avoids pulling in the runtime config module and its connection banner, and
// (b) Postgres refuses CREATE DATABASE inside an explicit multi-statement block, so a bare
// single-connection `Client` -- no wrapper, no pool -- is the correct shape. Also NOT
// carried over from that script: its emoji log prefixes (the house convention is a
// bracketed `[88.4...]` tag) and its string-interpolated identifier in the pg_database
// existence probe (parameterized here). Changing any of these is a decision, not a cleanup.
//
// LOCAL PROOF (point this at a throwaway local server, never at prod):
//   ADMIN_DB_URL=postgres://postgres:password@localhost:5432/postgres \
//   node scripts/ci/create-sync-db.js

const { Client } = require('pg');

// The one and only database this script is allowed to DROP. Hardcoded by design
// (T-88.4-10) -- see the header. Never read from env.
const SYNC_DB_NAME = 'schema_sync';

// Verbatim from scripts/log-db-resolution.js:19-27. Credential masking is a security
// control (T-88.4-11), not cosmetics -- never log an unmasked connection string.
const mask = (url) => {
  if (!url) return 'unset';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`;
  } catch {
    return '<unparseable>';
  }
};

(async () => {
  // Non-production refusal, BEFORE the client is opened. This script runs the most
  // destructive verb in the phase (DROP DATABASE), so it carries the refusal at least as
  // firmly as its sync-side sibling -- wording mirrors the retired provision script
  // (retired in Plan 88.4-05; see the DECISION Phase 88.4 D-05 marker in ci.yml's
  // migrate-cli-replay job) and the first guard in tests/globalSetup.js:68-73.
  // CI leaves NODE_ENV unset; local proof may set test.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      `[88.4-createdb] refusing to run: NODE_ENV=production ` +
        `(DROP DATABASE "${SYNC_DB_NAME}" would destroy a database on a production server)`
    );
    process.exitCode = 1;
    return;
  }

  const adminUrl = process.env.ADMIN_DB_URL;
  if (!adminUrl) {
    console.error(
      '[88.4-createdb] ADMIN_DB_URL is not set. It must point at an admin/maintenance ' +
        'database (e.g. postgres://user:pw@host:5432/postgres) on the throwaway CI server.'
    );
    process.exitCode = 1;
    return;
  }

  // Defense in depth against a future edit that wires SYNC_DB_NAME to env or to a URL
  // path component: identifiers cannot be parameterized in SQL, so the const is
  // interpolated below. Assert it is a plain lowercase identifier first, so such an edit
  // fails loudly here rather than becoming an injection point in the DROP.
  if (!/^[a-z][a-z0-9_]*$/.test(SYNC_DB_NAME)) {
    console.error(
      `[88.4-createdb] SYNC_DB_NAME "${SYNC_DB_NAME}" is not a plain lowercase identifier. ` +
        'It must be a hardcoded literal, never env-derived.'
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10000 });

  try {
    console.log(`[88.4-createdb] admin connection: ${mask(adminUrl)}`);
    await client.connect();

    // Existence probe kept from scripts/create-database.js:29-40, but parameterized.
    // Informational only -- the DROP below is unconditional (IF EXISTS) so a leftover
    // database from a previous run cannot leak schema into this one.
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      SYNC_DB_NAME,
    ]);
    console.log(
      existing.rows.length
        ? `[88.4-createdb] "${SYNC_DB_NAME}" already exists -- dropping it for a clean build.`
        : `[88.4-createdb] "${SYNC_DB_NAME}" does not exist yet.`
    );

    await client.query(`DROP DATABASE IF EXISTS "${SYNC_DB_NAME}"`);
    await client.query(`CREATE DATABASE "${SYNC_DB_NAME}"`);
    console.log(`[88.4-createdb] created empty database "${SYNC_DB_NAME}".`);
  } catch (err) {
    console.error(
      `[88.4-createdb] failed: ${err && err.message ? err.message : err}`
    );
    // process.exitCode (NOT process.exit) so the finally below can close the client.
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
