#!/usr/bin/env node
'use strict';
//
// scripts/ci/verify-migration-chain.js
//
// Phase 88.4 (SPEC R2): assert that the migrate-cli-replay job's migration replay booked
// COMPLETELY -- that every file in `migrations/` has a matching row in `SequelizeMeta`, and
// that `SequelizeMeta` carries no row without a file. A replay that silently skipped a
// migration would leave the migrate-side database structurally short, and the drift diff
// would then report that shortfall as model/migration drift instead of as the replay bug it
// actually is. This script names the real cause first.
//
// REPLACES `scripts/ci/provision-premigration-schema.js verify` (:149-168), which Plan 05
// deletes. Two deliberate deviations from that analog:
//
// DECISION Phase 88.4: raw `pg` on MIGRATE_DB_URL OVER the analog's models-barrel import
// (provision-premigration-schema.js:46). That barrel resolves the shared precedence
// chain `POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL`
// (config/database.js:16-19), so it would verify whichever database that chain happens to
// resolve -- in a two-database job that is a false green waiting to happen. A purpose-named
// var read through raw `pg` is immune to the chain entirely, and matches
// scripts/ci/schema-drift-diff.js. Reverting this to the models import is a decision, not a
// cleanup.
//
// DECISION Phase 88.4: FULL-DIRECTORY comparison OVER the analog's pinned filename set
// (its CLI_APPLIED_FILES, :98). That pinned set existed because the provision script
// simulated a pre-migration shape and hand-seeded SequelizeMeta with everything EXCEPT the
// re-key/data migrations it wanted the CLI to run -- so only those could be asserted. The
// from-empty design replays the WHOLE chain, so the assertion widens to the whole directory
// and needs no edit when migrations are added. Narrowing it back to a pinned list is a
// decision, not a cleanup.
//
// Retained from the analog: the `missing` ARRAY and a failure message that NAMES files
// rather than counting them (:156-162). A count is not actionable; a filename is.
//
// ENV CONTRACT (D-06) -- exactly one variable:
//   MIGRATE_DB_URL   the migration-chain-built database whose SequelizeMeta is checked.
//
// LOCAL PROOF (against a throwaway database that has been migrated):
//   MIGRATE_DB_URL=postgres://user:pw@localhost:5432/schema_migrate \
//   node scripts/ci/verify-migration-chain.js

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

// Verbatim from scripts/log-db-resolution.js:19-27. Never log an unmasked connection string.
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
  const migrateUrl = process.env.MIGRATE_DB_URL;
  if (!migrateUrl) {
    console.error(
      '[88.4-verify] MIGRATE_DB_URL is not set. It must point at the migration-chain-built ' +
        'database (the one sequelize-cli just migrated).'
    );
    process.exitCode = 1;
    return;
  }

  // Same shape as provision-premigration-schema.js:131-134.
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  if (files.length === 0) {
    console.error(`[88.4-verify] no .js migrations found in ${MIGRATIONS_DIR} -- refusing to pass vacuously.`);
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: migrateUrl, connectionTimeoutMillis: 10000 });

  try {
    console.log(`[88.4-verify] migrate side: ${mask(migrateUrl)}`);
    await client.connect();

    let rows;
    try {
      const res = await client.query('SELECT name FROM "SequelizeMeta"');
      rows = res.rows;
    } catch (err) {
      if (err && err.code === '42P01') {
        // undefined_table: sequelize-cli creates SequelizeMeta on its first successful
        // migration, so its absence means the replay never applied anything at all.
        console.error(
          '::error::[88.4-verify] SequelizeMeta does not exist on the migrate side -- ' +
            'the migration replay applied nothing. Check the sequelize-cli db:migrate step.'
        );
        process.exitCode = 1;
        return;
      }
      throw err;
    }

    const booked = new Set(rows.map((r) => r.name));
    const onDisk = new Set(files);

    const missing = files.filter((f) => !booked.has(f));
    const extra = [...booked].filter((n) => !onDisk.has(n)).sort();

    if (missing.length || extra.length) {
      console.error(
        `[88.4-verify] FAIL -- ${missing.length} migration(s) on disk not recorded in ` +
          `SequelizeMeta, ${extra.length} SequelizeMeta row(s) with no migration file ` +
          `(${files.length} file(s) on disk, ${booked.size} row(s) booked).`
      );
      // One annotation per offending filename: each name lands on its own line and gets its
      // own entry in the GitHub checks UI. Naming them is the whole point -- a count leaves
      // the reader to diff two lists by hand.
      for (const name of missing) {
        console.error(`::error::[88.4-verify] migration NOT recorded in SequelizeMeta: ${name}`);
      }
      for (const name of extra) {
        console.error(`::error::[88.4-verify] SequelizeMeta row has no migration file: ${name}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(
      `[88.4-verify] OK — all ${files.length} migration(s) recorded in SequelizeMeta.`
    );
  } catch (err) {
    console.error(`[88.4-verify] failed: ${err && err.message ? err.message : err}`);
    // process.exitCode (NOT process.exit) so the finally below can close the client.
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
