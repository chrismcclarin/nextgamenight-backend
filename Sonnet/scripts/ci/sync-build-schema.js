#!/usr/bin/env node
'use strict';
//
// scripts/ci/sync-build-schema.js
//
// Phase 88.4 (SPEC R2; decision D-06): build the SYNC-SIDE schema of the migrate-cli-replay
// CI job from the CURRENT MODELS. `scripts/ci/create-sync-db.js` creates the database empty
// one step earlier; this script drives `sequelize.sync()` against it so
// `scripts/ci/schema-drift-diff.js` can compare a models-built schema against the
// migration-chain-built one from the same commit.
//
// ENV CONTRACT (D-06) -- exactly one variable:
//   DATABASE_URL   scoped BY THE WORKFLOW STEP to the sync database (schema_sync).
//
// This is the ONE script in the phase that correctly reaches the database through
// `require('../../models')`, because building the sync-side schema IS driving the models.
// That import resolves the shared precedence chain
// `POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL`
// (config/database.js:16-19), so DATABASE_URL is the variable the workflow sets and this
// script reads no other URL variable. Its siblings (create-sync-db.js, verify-migration-
// chain.js, schema-drift-diff.js) deliberately use purpose-named vars + raw `pg` instead,
// precisely to stay off that chain.
//
// DECISION Phase 88.4 D-06: plain `sequelize.sync()` OVER a force-sync. The database is
// created EMPTY one step earlier, so dropping-and-recreating every table buys nothing here,
// and the force variant is a destructive verb that must never appear in a script whose
// target is resolved from an env chain. Keeping it out also keeps this file clear of
// ci.yml's force-sync grep gate should that gate ever widen beyond its current `tests/`
// scope (it would not fire today -- do not invite it). Changing this to a force-sync is a
// decision, not a cleanup.
//
// DECISION Phase 88.4: NODE_ENV refusal only, WITHOUT the DB-host deny list. The stronger
// in-repo guard (tests/globalSetup.js:67-88) denies BOTH on NODE_ENV=production AND on the
// resolved DB host matching PROD_HOST_PATTERNS / PROD_DB_HOST_DENY. Chosen here: the
// NODE_ENV refusal plus the sync-target assert below. Rejected: replicating the host-deny
// list -- because the target-name assert is strictly stronger for THIS script's failure
// mode (it pins the exact database, not merely a set of known-bad hosts), and the database
// being synced was created empty by the previous step. Do not "restore consistency" by
// swapping the assert for the host list; add the host list alongside it if anything.
//
// LOCAL PROOF (point this at a throwaway local server, never at prod):
//   ADMIN_DB_URL=postgres://postgres:password@localhost:5432/postgres \
//     node scripts/ci/create-sync-db.js
//   DATABASE_URL=postgres://postgres:password@localhost:5432/schema_sync \
//     node scripts/ci/sync-build-schema.js

// Must match scripts/ci/create-sync-db.js's hardcoded SYNC_DB_NAME.
const EXPECTED_DB_NAME = 'schema_sync';

(async () => {
  // Non-production refusal, BEFORE any schema verb -- mirrors the retired provision script
  // (retired in Plan 88.4-05; see the DECISION Phase 88.4 D-05 marker in ci.yml's
  // migrate-cli-replay job) and tests/globalSetup.js:68-73. CI leaves NODE_ENV unset;
  // local proof may set test.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[88.4-sync] refusing to run: NODE_ENV=production ' +
        '(sequelize.sync() issues schema DDL and must never touch a production database)'
    );
    process.exitCode = 1;
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      `[88.4-sync] DATABASE_URL is not set. The workflow step must scope it to the ` +
        `"${EXPECTED_DB_NAME}" database created by scripts/ci/create-sync-db.js.`
    );
    process.exitCode = 1;
    return;
  }

  // Required AFTER the guards on purpose: models/index.js -> config/database.js constructs
  // the connection (and logs a banner) at require time, so requiring it above would run
  // before the production refusal.
  const { sequelize } = require('../../models');

  try {
    await sequelize.authenticate();

    // SYNC-TARGET ASSERT -- the T-88.4-17 backstop. If the per-step DATABASE_URL is
    // missing or mis-indented in the workflow YAML, config/database.js does NOT fail: it
    // silently falls back to the DB_* individual vars / hardcoded defaults
    // (config/database.js:87-121), which are the MIGRATE database's own coordinates. sync()
    // would then quietly overwrite the migration-built schema with the sync one, and the
    // differ would compare a database against itself and report a clean PASS. The same
    // hazard applies if POSTGRES_PRIVATE_URL / POSTGRES_URL are present in the environment,
    // since both outrank DATABASE_URL in the chain. This assert converts that silent
    // cross-contamination into a loud failure.
    if (sequelize.config.database !== EXPECTED_DB_NAME) {
      throw new Error(
        `refusing to sync: resolved database is "${sequelize.config.database}", ` +
          `expected "${EXPECTED_DB_NAME}". The connection did not resolve to the sync-side ` +
          'database -- syncing here would overwrite the migration-built schema and make the ' +
          'drift diff compare a database against itself.'
      );
    }

    await sequelize.sync();
    console.log('[88.4-sync] sync-side schema built from models.');
  } catch (err) {
    console.error(`[88.4-sync] failed: ${err && err.message ? err.message : err}`);
    // process.exitCode (NOT process.exit) so the finally below can close the connection.
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
})();
