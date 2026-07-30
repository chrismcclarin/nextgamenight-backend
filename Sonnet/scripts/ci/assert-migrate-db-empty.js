#!/usr/bin/env node
'use strict';
//
// scripts/ci/assert-migrate-db-empty.js
//
// Phase 88.4 Plan 09 (88.4-CODE-REVIEW.md #11; SPEC R2 acceptance: "Job logs show the
// migration-side DB started empty and every migration filename ran"): assert that the
// MIGRATION-SIDE database contains ZERO user relations and ZERO user enums BEFORE
// `sequelize-cli db:migrate` replays the chain into it.
//
// WHY THIS EXISTS AT ALL. Before this script, "from empty" rested on nothing but the
// freshness of the `postgres` service container. The whole migrate-cli-replay job is built on
// the from-empty property -- it is what makes the guarded baseline's table-creation branch,
// and therefore every migration's create path, actually execute in CI instead of first on
// Railway. Yet the only downstream check, scripts/ci/verify-migration-chain.js, reconciles
// `SequelizeMeta` against `migrations/` and PASSES on a short replay: if some future
// re-wiring hands this job a pre-built `boardgame_db` with a pre-seeded `SequelizeMeta`, the
// baseline takes its no-op branch, every later migration is already booked, the chain
// verifies clean, and scripts/ci/schema-drift-diff.js then compares a
// NOT-actually-migration-built schema against the sync side -- and very plausibly finds no
// drift, because both sides would descend from sync(). That is a FALSE GREEN on the exact
// property this phase exists to establish, and it is the failure mode of the retired
// pre-migration-simulation design (see the DECISION Phase 88.4 D-05 marker in ci.yml).
// Note the asymmetry this closes: the SYNC side already had this discipline (the baseline
// no-op proof step greps for the baseline's no-op line); the migrate side had no mirror.
//
// ENV CONTRACT (D-06) -- exactly one variable:
//   MIGRATE_DB_URL   the database the chain is about to be replayed INTO.
//
// DECISION Phase 88.4 Plan 09: a ZERO-RELATION CATALOG ASSERT run BEFORE the replay, OVER
// 88.4-CODE-REVIEW.md #11's own suggested fix of tee-ing `db:migrate` output and grepping for
// the baseline's `[88.4-baseline] empty database -- building` line. The grep was the shape the
// review proposed and the disposition upgraded it, for three reasons: (1) it is strictly
// weaker evidence -- the baseline's branch turns on the presence of ONE table ("Users"), so a
// database carrying a pre-seeded `SequelizeMeta` and no `Users` would print the
// building line and sail through, which is precisely the pre-seeded-meta scenario the review
// was worried about; (2) it couples a gate to a log string in an unrelated file, so renaming
// a console.log silently disarms it; (3) it can only fire AFTER the replay has already
// written to the database, so a failure leaves nothing to diagnose from. A catalog assert
// beforehand is checked against the database itself, names every object it found, and fires
// before anything is mutated. Replacing this with the log grep is a decision, not a cleanup.
//
// DECISION Phase 88.4 Plan 09: this script reports the connection's OWN resolved identity
// (`current_database()`, plus the host/port `pg` actually parsed out of the URL) and does NOT
// carry a copy of the `mask()` helper that create-sync-db.js:88, verify-migration-chain.js:55
// and schema-drift-diff.js each duplicate from scripts/log-db-resolution.js:19-33 under a
// "change all four together" note. Deliberate divergence on both counts: a fifth copy would
// make that note wrong and grow a maintenance burden the file does not need, and
// `current_database()` is STRICTLY BETTER evidence for this assert than a masked echo of the
// input string -- it reports where the connection LANDED rather than where it was aimed, which
// is exactly the D-06 concern (a step silently pointed at the wrong database). Nothing logged
// here is a credential. Adding a mask copy to "restore consistency" is a decision, not a
// cleanup.
//
// DECISION Phase 88.4 Plan 09: NO production-host deny list, deliberately diverging from its
// sibling create-sync-db.js (whose own marker argues FOR one). That script's verb is
// `DROP DATABASE`; this script's only verb is `SELECT`. It cannot damage anything it is
// pointed at, and it already fails CLOSED against every populated database on earth --
// including production, which has 28 tables and would be reported object-by-object. A deny
// list would add a second failure mode with no additional protection.
//
// LOCAL PROOF:
//   MIGRATE_DB_URL=postgres://postgres:password@localhost:5432/schema_migrate \
//   node scripts/ci/assert-migrate-db-empty.js
//
// Exits 0 (with an explicit evidence line naming the resolved database) when empty;
// exits 1 naming every object found when not.

const { Client } = require('pg');

// System schemas are excluded by NAME rather than by `pg_namespace.nspacl` or an oid range:
// the set is fixed and small, and an explicit list is auditable. `pg_toast*` / `pg_temp*` are
// pattern-matched because their names carry a backend id.
//
// relkind set is ('r','p','v','m','f','S') -- ordinary and partitioned tables, views,
// materialized views, foreign tables, and SEQUENCES. Indexes ('i') and the composite types
// Postgres auto-creates per table ('c') are DELIBERATELY excluded: both are dependent objects
// that cannot exist without a relation this query already reports, so including them would
// only produce duplicate noise on failure. Sequences ARE included even though the baseline
// creates none directly, because a leftover sequence is evidence of a dropped table and
// therefore of a database that is not fresh.
const Q_RELATIONS = `
  SELECT n.nspname AS schema,
         c.relname AS name,
         c.relkind AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg_toast%'
     AND n.nspname NOT LIKE 'pg_temp%'
   ORDER BY n.nspname, c.relname
`;

// Enums are checked as well as relations because the baseline creates TWO of them
// (`[88.4-baseline] pre-chain schema created (2 enums, 8 tables, ...)`) and `CREATE TYPE` has
// no IF NOT EXISTS in Postgres 16 -- a leftover enum from a previous run breaks the replay
// with a duplicate-object error rather than a useful message. Reporting it here names the real
// cause.
const Q_ENUMS = `
  SELECT n.nspname AS schema,
         t.typname AS name
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE t.typtype = 'e'
     AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg_toast%'
     AND n.nspname NOT LIKE 'pg_temp%'
   ORDER BY n.nspname, t.typname
`;

const KIND_LABEL = {
  r: 'table',
  p: 'partitioned table',
  v: 'view',
  m: 'materialized view',
  f: 'foreign table',
  S: 'sequence',
};

/**
 * The whole verdict as a pure function, so it is unit-testable with no database
 * (the same fast-lane discipline Plan 08 applied to the differ's SQL).
 *
 * @param {Array<{schema: string, name: string, kind: string}>} relations
 * @param {Array<{schema: string, name: string}>} enums
 * @returns {{ok: boolean, message: string}}
 */
function verdict(relations, enums) {
  if (!relations.length && !enums.length) {
    return {
      ok: true,
      message:
        '0 user relations, 0 user enums — the chain is about to replay from a genuinely ' +
        'EMPTY database, so the guarded baseline MUST take its table-creation branch and ' +
        'every migration MUST run its create path. The from-empty property now rests on this ' +
        'evidence rather than on service-container freshness (88.4-CODE-REVIEW.md #11).',
    };
  }

  const objects = [
    ...relations.map((r) => `  ${r.schema}.${r.name} (${KIND_LABEL[r.kind] || r.kind})`),
    ...enums.map((e) => `  ${e.schema}.${e.name} (enum type)`),
  ];

  // `SequelizeMeta` is called out by name because it is the specific object that turns a
  // non-empty database into a SILENT short replay rather than a loud collision.
  const meta = relations.some((r) => r.name === 'SequelizeMeta');
  const metaNote = meta
    ? '\n  !! `SequelizeMeta` IS PRESENT. This is the false-green shape, not merely a dirty ' +
      'database: every filename it already books will be SKIPPED by db:migrate, ' +
      'verify-migration-chain.js will still pass (all rows booked, no orphans), and the ' +
      'schema drift diff will then compare a schema the migration chain did not build.'
    : '';

  return {
    ok: false,
    message:
      `${relations.length} user relation(s) and ${enums.length} user enum(s) found — the ` +
      'migration-side database is NOT empty, so this job would not be testing the from-empty ' +
      `replay it exists to test:\n${objects.join('\n')}${metaNote}\n` +
      '  FIX: give this job a freshly-created database (the postgres service container\'s ' +
      "POSTGRES_DB, or an explicit CREATE DATABASE), and make sure no earlier step in the " +
      'job connects to it. Do NOT relax this assertion — a non-empty migration side makes ' +
      'the drift diff meaningless (88.4-CODE-REVIEW.md #11).',
  };
}

async function main() {
  const url = process.env.MIGRATE_DB_URL;
  if (!url) {
    console.error(
      '[88.4-fromempty] MIGRATE_DB_URL is not set. It must point at the database the ' +
        'migration chain is about to be replayed into. Purpose-named on purpose (D-06): this ' +
        'script must not be steerable by the shared ' +
        'POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL chain, ' +
        'because in a two-database job that chain is a false green waiting to happen.'
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();

    // Reported from the CONNECTION, not from the input string — see the DECISION marker above.
    const { rows: who } = await client.query('SELECT current_database() AS db');
    console.log(
      `[88.4-fromempty] migration side resolved to database "${who[0].db}" on ` +
        `${client.host}:${client.port}`
    );

    const { rows: relations } = await client.query(Q_RELATIONS);
    const { rows: enums } = await client.query(Q_ENUMS);

    const result = verdict(relations, enums);
    if (result.ok) {
      console.log(`[88.4-fromempty] PASS — ${result.message}`);
    } else {
      console.error(`::error::[88.4-fromempty] FAIL — ${result.message}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(
      `[88.4-fromempty] failed: ${err && err.message ? err.message : err}`
    );
    // process.exitCode (NOT process.exit) so the finally below can close the client.
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = { verdict, Q_RELATIONS, Q_ENUMS, KIND_LABEL };

if (require.main === module) {
  main();
}
