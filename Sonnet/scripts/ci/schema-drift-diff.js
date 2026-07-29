#!/usr/bin/env node
'use strict';
//
// scripts/ci/schema-drift-diff.js
//
// Phase 88.4 (SPEC R3 + R4; decisions D-03, D-04, D-06): the schema-drift differ for the
// migrate-cli-replay CI job. It introspects TWO Postgres databases via pg_catalog — one
// built by replaying the migration chain through sequelize-cli, one built by sync()ing the
// models — and compares them STRUCTURALLY (not as dump text).
//
// LINEAGE: the four queries below supersede the single hand-run foreign-key query recorded
// in `.planning/phases/88.2-group-soft-delete-recovery-window-inserted-2026-07-25/
// 88.2-CASCADE-AUDIT.md` § 1, which was run against prod during the 88.2 cascade audit and
// found the CASCADE->SET NULL flip. This version adds `unnest(...) WITH ORDINALITY` column
// ordering (a bare `array_agg` over a join has NO defined order, which is a classic source
// of nondeterministic diffs — SPEC R4), plus PK/UNIQUE constraints, the full index set, and
// a table inventory.
//
// ENV CONTRACT (D-06) — exactly two variables, and `DATABASE_URL` is deliberately NOT one:
//   MIGRATE_DB_URL   the migration-chain-built database
//   SYNC_DB_URL      the models/sync()-built database
//
// DECISION Phase 88.4 D-03: raw `pg` Client OVER the Sequelize instance exported by the
// models barrel (`../../models`) or the config module (`../config/database`). Both of those
// resolve the SHARED precedence chain
// `POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL`
// (`config/database.js:16-19`, `config/sequelize-cli.config.js:16-20`) and would silently
// connect to whichever database that chain happens to resolve — which is RESEARCH Pitfall 2,
// the differ comparing a database against ITSELF and passing. `config/database.js:22-37`
// additionally prints a connection banner that would pollute the diff output. `pg` is
// already a direct dependency (`package.json:50`); zero packages are added by this phase.
// Changing this to go through the models barrel is a decision, not a cleanup.
//
// DECISION Phase 88.4: a connection failure here exits NON-ZERO, deliberately deviating
// from the only other raw-`pg` script in the repo, `scripts/log-db-resolution.js:12-14`,
// which exits 0 on failure BECAUSE it is a pre-deploy diagnostic that must not block
// `migrate:apply`. This script is a GATE — swallowing a connection error would make an
// unreachable database indistinguishable from a clean schema. Do not inherit the swallow.
//
// SECURITY (T-88.4-06, ASVS V7): prints table / constraint / index / column NAMES only,
// never row data, and never a raw connection string — see `mask()` below, copied verbatim
// from `scripts/log-db-resolution.js:19-27`. Log lines prefer the side LABEL
// ("migration side" / "sync side") over any form of the URL.
//
// CATALOG LEGEND
//   confdeltype / confupdtype : a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT
//   confmatchtype             : f=FULL, p=PARTIAL, s=SIMPLE
//   contype                   : c=check, f=foreign key, p=primary key, u=unique
//   pg_index.indkey           : an int2vector; a 0 entry marks an EXPRESSION slot, whose
//                               decompiled text lives in indexprs / pg_get_indexdef
//
// LOCAL PROOF (two throwaway databases; never point this at prod):
//   MIGRATE_DB_URL=postgres://user:pw@localhost:5432/schema_migrate \
//   SYNC_DB_URL=postgres://user:pw@localhost:5432/schema_sync \
//   node scripts/ci/schema-drift-diff.js

const { Client } = require('pg');

// Verbatim from scripts/log-db-resolution.js:19-27. Credential masking is a security
// control (T-88.4-06), not cosmetics — never log an unmasked connection string.
const mask = (url) => {
  if (!url) return 'unset';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`;
  } catch {
    return '<unparseable>';
  }
};

// ---------------------------------------------------------------------------------------
// The four pg_catalog queries (D-03).
//
// All four restrict to `n.nspname = 'public'` and exclude `SequelizeMeta`, which exists
// only on the migration side (sequelize-cli creates it; sync() does not) and would
// otherwise be reported as drift on every single run.
//
// DECISION Phase 88.4 D-03: table names come from `pg_class.relname` OVER
// `conrelid::regclass::text` (which is what the 88.2 cascade-audit query used).
// `regclass::text` QUOTES mixed-case identifiers — it renders `"UserGroups"`, while
// `relname` renders `UserGroups`. Mixing the two would make an FK finding's table name
// unequal to the same table's name from the index/table queries, silently defeating the
// table-level matching the diff layer does (allowlist entries keyed by table, and the
// TABLE-MISSING suppression that collapses a missing table into ONE finding instead of
// fifteen). Both sides of the diff would be consistently wrong, so it fails as a missed
// suppression, not as a phantom finding — i.e. silently.
// ---------------------------------------------------------------------------------------

// A — Foreign keys, with ON DELETE / ON UPDATE / MATCH disposition.
const Q_FOREIGN_KEYS = `
SELECT
  t.relname                    AS child_table,
  pt.relname                   AS parent_table,
  c.conname                    AS constraint_name,
  c.confdeltype                AS on_delete,
  c.confupdtype                AS on_update,
  c.confmatchtype              AS match_type,
  c.condeferrable,
  c.condeferred,
  (SELECT array_agg(att.attname ORDER BY k.ord)
     FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute att
       ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS child_columns,
  (SELECT array_agg(att.attname ORDER BY k.ord)
     FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute att
       ON att.attrelid = c.confrelid AND att.attnum = k.attnum) AS parent_columns,
  pg_get_constraintdef(c.oid)  AS definition
FROM pg_constraint c
JOIN pg_class     t  ON t.oid  = c.conrelid
JOIN pg_class     pt ON pt.oid = c.confrelid
JOIN pg_namespace n  ON n.oid  = t.relnamespace
WHERE c.contype = 'f'
  AND n.nspname = 'public'
  AND t.relname <> 'SequelizeMeta'
ORDER BY t.relname, c.conname
`;

// B — Primary keys and table-level UNIQUE constraints. `conindid` is the OID of the index
// that BACKS the constraint; the canonicalizer uses it to fold a UNIQUE constraint and its
// equivalent unique index into one identity (normalization rule 1).
const Q_CONSTRAINTS = `
SELECT
  t.relname                    AS table_name,
  c.contype                    AS kind,
  c.conname                    AS constraint_name,
  c.conindid                   AS backing_index_oid,
  (SELECT array_agg(att.attname ORDER BY k.ord)
     FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute att
       ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS columns,
  pg_get_constraintdef(c.oid)  AS definition
FROM pg_constraint c
JOIN pg_class     t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE c.contype IN ('p','u')
  AND n.nspname = 'public'
  AND t.relname <> 'SequelizeMeta'
ORDER BY t.relname, c.conname
`;

// C — The full index set, including expression and partial indexes.
// `pg_get_indexdef` / `pg_get_expr` are used instead of a hand-built DDL renderer: they
// handle opclasses, collations, NULLS NOT DISTINCT, INCLUDE columns, expressions and
// predicates correctly. A hand-rolled renderer is a false-green factory (RESEARCH
// "Don't Hand-Roll").
const Q_INDEXES = `
SELECT
  t.relname                                  AS table_name,
  i.relname                                  AS index_name,
  ix.indexrelid                              AS indexrelid,
  ix.indisunique                             AS indisunique,
  ix.indisprimary                            AS indisprimary,
  ix.indnkeyatts                             AS indnkeyatts,
  am.amname                                  AS method,
  pg_get_indexdef(ix.indexrelid)             AS full_def,
  pg_get_expr(ix.indpred,  ix.indrelid)      AS predicate,
  pg_get_expr(ix.indexprs, ix.indrelid)      AS expressions,
  ix.indkey::int2[]                          AS key_attnums,
  (SELECT array_agg(a.attname ORDER BY k.ord)
     FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
     LEFT JOIN pg_attribute a
       ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
    WHERE k.ord <= ix.indnkeyatts)           AS key_columns
FROM pg_index ix
JOIN pg_class     i  ON i.oid  = ix.indexrelid
JOIN pg_class     t  ON t.oid  = ix.indrelid
JOIN pg_namespace n  ON n.oid  = t.relnamespace
JOIN pg_am        am ON am.oid = i.relam
WHERE n.nspname = 'public'
  AND ix.indislive
  AND t.relname <> 'SequelizeMeta'
ORDER BY t.relname, i.relname
`;

// D — Table inventory, so a missing TABLE is reported as one finding, not fifteen.
const Q_TABLES = `
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = 'public'
  AND c.relname <> 'SequelizeMeta'
ORDER BY 1
`;

/**
 * Open a raw `pg` connection, run the four catalog queries, and return the RAW rows.
 * Normalization is a separate, DB-free step (`canonicalize`) so it can be unit-tested
 * against hand-written catalog-row fixtures with no database at all.
 *
 * @param {string} url   connection string (never logged unmasked)
 * @param {string} label human-readable side label, e.g. 'migration side'
 * @returns {Promise<{fks: object[], cons: object[], idxs: object[], tables: object[]}>}
 */
async function dumpSchema(url, label) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const [fks, cons, idxs, tables] = await Promise.all([
      client.query(Q_FOREIGN_KEYS),
      client.query(Q_CONSTRAINTS),
      client.query(Q_INDEXES),
      client.query(Q_TABLES),
    ]);
    return { fks: fks.rows, cons: cons.rows, idxs: idxs.rows, tables: tables.rows };
  } catch (err) {
    // Side LABEL + masked target only. Rethrow: a GATE must not swallow this.
    throw new Error(
      `[88.4] ${label} introspection failed (${mask(url)}): ${err && err.message ? err.message : err}`
    );
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  dumpSchema,
  Q_FOREIGN_KEYS,
  Q_CONSTRAINTS,
  Q_INDEXES,
  Q_TABLES,
};

// ---------------------------------------------------------------------------------------
// Script entry point. Guarded by `require.main === module` so that `require()`ing this file
// from a unit test opens NO connection and prints NOTHING.
// ---------------------------------------------------------------------------------------
async function main() {
  const migrateUrl = process.env.MIGRATE_DB_URL;
  const syncUrl = process.env.SYNC_DB_URL;

  const missing = [];
  if (!migrateUrl) missing.push('MIGRATE_DB_URL');
  if (!syncUrl) missing.push('SYNC_DB_URL');
  if (missing.length) {
    console.error(
      `[88.4] refusing to run: ${missing.join(' and ')} unset.\n` +
        '       This differ reads ONLY MIGRATE_DB_URL and SYNC_DB_URL (D-06). It deliberately\n' +
        '       does NOT fall back to DATABASE_URL / POSTGRES_URL: a job-level DATABASE_URL is\n' +
        '       exactly how both sides end up pointing at the same database and the gate passes\n' +
        '       on a schema compared against itself. Set the two variables per-step in ci.yml.'
    );
    process.exitCode = 1;
    return;
  }

  // T-88.4-08: the same URL on both sides compares a schema against itself and is
  // guaranteed green — the single most dangerous false-green in this design.
  if (migrateUrl === syncUrl) {
    console.error(
      '[88.4] refusing to run: MIGRATE_DB_URL and SYNC_DB_URL are identical.\n' +
        '       A schema compared against itself always passes. Point them at two databases.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[88.4] migration side: ${mask(migrateUrl)}`);
  console.log(`[88.4] sync side:      ${mask(syncUrl)}`);

  const [migrationSide, syncSide] = await Promise.all([
    dumpSchema(migrateUrl, 'migration side'),
    dumpSchema(syncUrl, 'sync side'),
  ]);

  for (const [label, side] of [['migration side', migrationSide], ['sync side', syncSide]]) {
    console.log(
      `[88.4] ${label}: ${side.tables.length} table(s), ${side.fks.length} FK(s), ` +
        `${side.cons.length} PK/UNIQUE constraint(s), ${side.idxs.length} index(es)`
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[88.4] differ failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
