#!/usr/bin/env node
'use strict';
//
// scripts/ci/schema-drift-diff.js
//
// Phase 88.4 (SPEC R3 + R4 + R6; decisions D-03, D-04, D-06, D-07, D-08): the schema-drift
// differ for the migrate-cli-replay CI job. It introspects TWO Postgres databases via
// pg_catalog — one built by replaying the migration chain through sequelize-cli, one built by
// sync()ing the models — and compares them STRUCTURALLY (not as dump text).
//
// FOUR STAGES, in order: dump (`dumpSchema`) -> canonicalize to name-free identities
// (`canonicalize`) -> structural set diff (`diffSchemas`) -> subtract the owner-signed accepted
// -drift policy (`subtractAllowlist` over `scripts/ci/schema-drift-allowlist.js`). Then print,
// then gate the exit code. Stages 2-4 are PURE and DB-free, which is why
// `tests/unit/schema-drift-diff.test.js` can pin every mismatch class with no Postgres at all.
//
// LINEAGE: the four queries below supersede the single hand-run foreign-key query recorded
// in `.planning/phases/88.2-group-soft-delete-recovery-window-inserted-2026-07-25/
// 88.2-CASCADE-AUDIT.md` § 1, which was run against prod during the 88.2 cascade audit and
// found the CASCADE->SET NULL flip. This version adds `unnest(...) WITH ORDINALITY` column
// ordering (a bare `array_agg` over a join has NO defined order, which is a classic source
// of nondeterministic diffs — SPEC R4), plus PK/UNIQUE constraints, the full index set, and
// a table inventory.
//
// ENV CONTRACT (D-06) — exactly two connection variables, and `DATABASE_URL` is deliberately
// NOT one:
//   MIGRATE_DB_URL              the migration-chain-built database   (required)
//   SYNC_DB_URL                 the models/sync()-built database     (required)
//   SCHEMA_DRIFT_REPORT_ONLY    '1' = print findings but exit 0 (D-08). Optional; see the
//                               report-only DECISION marker near the bottom of this file.
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
// from `scripts/log-db-resolution.js:19-33`. Log lines prefer the side LABEL
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

// Load and validate the accepted-drift policy at STARTUP (T-88.4-13). This throw propagates
// out of `require()` itself, so it is structurally unreachable by the report-only suppression
// further down — which only ever gates `process.exitCode` on FINDINGS. A malformed policy file
// is a CRASH, not a finding: an entry the validator half-understood would suppress real drift
// that nobody signed off, which is the false-green this phase exists to prevent.
const {
  ENTRIES: ALLOWLIST_ENTRIES,
  validateAllowlist,
  // The per-kind identity attributes an entry must pin BEYOND (side, kind, table, keySpec,
  // predicate). Owned by the allowlist module because it is the ENTRY CONTRACT; consumed here so
  // `entryMatchesObject` and `validateAllowlist` can never disagree about what an entry pins.
  PIN_FIELDS,
} = require('./schema-drift-allowlist');
validateAllowlist(ALLOWLIST_ENTRIES);

// Verbatim from scripts/log-db-resolution.js:19-33 (all four copies changed together — see the
// note in create-sync-db.js). Credential masking is a security control (T-88.4-06), not
// cosmetics — never log an unmasked connection string.
const mask = (url) => {
  if (!url) return 'unset';
  try {
    const u = new URL(url);
    // DECISION Phase 88.4 (88.4-CODE-REVIEW.md #6): the USERNAME is redacted too, over the
    // long-standing `${u.username}:***@` form. The username is not a credential, but these
    // scripts document a LOCAL PROOF mode in which a developer's own connection string is
    // logged, and a real username is identifying (and often environment-revealing) in a public
    // repo's CI log. Nothing needs it: every log line here already prefers the side LABEL
    // ("migration side" / "sync side") and the host+database are what a reader diagnoses from.
    return `${u.protocol}//***:***@${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`;
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
  (SELECT array_agg(att.attname::text ORDER BY k.ord)
     FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
     JOIN pg_attribute att
       ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS child_columns,
  (SELECT array_agg(att.attname::text ORDER BY k.ord)
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
  (SELECT array_agg(att.attname::text ORDER BY k.ord)
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
// handle opclasses, collations, expressions and predicates correctly. A hand-rolled
// renderer is a false-green factory (RESEARCH "Don't Hand-Roll").
//
// `pg_get_indexdef` RENDERS the post-key-list clauses correctly, but the identity derived
// from it does NOT read them: `keySpecOfIndex` deliberately parses ONLY the `USING <method>
// (...)` paren group, and both `INCLUDE (...)` and `NULLS NOT DISTINCT` are rendered AFTER
// that group. So the two columns below carry them explicitly — see the D-04 promotion marker
// on IDENTITY_FIELDS. Reading them off the catalog rather than re-parsing the rendered tail
// is deliberate: a boolean column and an attname array cannot be mis-parsed, whereas a tail
// parser has to distinguish the real clauses from the same text appearing inside a predicate
// literal. (Historical note, so the fixed comment is not mistaken for the original: this
// comment used to claim `pg_get_indexdef` "handles NULLS NOT DISTINCT and INCLUDE columns
// correctly" as though that settled the identity question. It does not — the rendering was
// always right and the IDENTITY silently dropped both, folding two genuinely different
// indexes onto one identity. 88.4-CODE-REVIEW.md #1/#13.)
const Q_INDEXES = `
SELECT
  t.relname                                  AS table_name,
  i.relname                                  AS index_name,
  ix.indexrelid                              AS indexrelid,
  ix.indisunique                             AS indisunique,
  ix.indisprimary                            AS indisprimary,
  ix.indnkeyatts                             AS indnkeyatts,
  ix.indnullsnotdistinct                     AS nulls_not_distinct,
  am.amname                                  AS method,
  pg_get_indexdef(ix.indexrelid)             AS full_def,
  pg_get_expr(ix.indpred,  ix.indrelid)      AS predicate,
  pg_get_expr(ix.indexprs, ix.indrelid)      AS expressions,
  ix.indkey::int2[]                          AS key_attnums,
  (SELECT array_agg(a.attname::text ORDER BY k.ord)
     FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
     LEFT JOIN pg_attribute a
       ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
    WHERE k.ord <= ix.indnkeyatts)           AS key_columns,
  -- INCLUDE columns: the indkey slots PAST the key attributes. Postgres requires INCLUDE
  -- payloads to be plain columns (no expressions), so no NULL slot can appear here.
  (SELECT array_agg(a.attname::text ORDER BY k.ord)
     FROM unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
     LEFT JOIN pg_attribute a
       ON a.attrelid = ix.indrelid AND a.attnum = k.attnum
    WHERE k.ord > ix.indnkeyatts)            AS included_columns
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

// ---------------------------------------------------------------------------------------
// Canonicalization (D-04).
//
// Turns raw catalog rows into flat, name-free identity records. This half is deliberately
// PURE and DB-free so `tests/unit/schema-drift-canonicalize.test.js` can drive it with
// hand-written catalog-row fixtures in the fast (no-Postgres) Jest lane. Every hand-rolled
// shortcut in this phase fails SILENTLY GREEN — a differ that under-reports looks exactly
// like a healthy schema — so those unit tests are the only control against that, and this
// code is written to be testable without a database on purpose.
// ---------------------------------------------------------------------------------------

// Which named fields participate in each kind's IDENTITY, and in what order.
//
// DECISION Phase 88.4 D-04: object NAMES are excluded from every identity, over the obvious
// name-keyed diff. A name-keyed differ reports 20-40 phantom findings of the form "migration
// has x_idx, sync has x" (RESEARCH Pitfall 3) — the same index created by a migration with
// an explicit `name` and by sync()'s auto-generated name is ONE object, not two.
// The exclusion is STRUCTURAL rather than a convention: `identityOf` reads this table
// instead of building a string by hand, so `displayName` / `definition` cannot leak into an
// identity even by accident. Re-adding a name to any row here is a decision, not a cleanup.
//
// DECISION Phase 88.4 D-04: FK deferrability (`condeferrable` / `condeferred`) is
// deliberately NOT part of the FK identity, even though the query selects it. D-04 fixes the
// FK tuple at (table, childCols, parentTable, parentCols, onDelete, onUpdate, matchType);
// nothing in this codebase declares a deferrable constraint, and a `differs`-class finding on
// deferrability would be pure noise on day one. The fields are CARRIED on the record so a
// later phase can promote them by adding one entry to this row — not by re-plumbing. Same
// reasoning for `method` on `unique`: a UNIQUE enforced by a btree is the same CONSTRAINT
// whatever index method backs it, so `method` is identity-bearing for `index` only.
//
// DECISION Phase 88.4 D-04 (PROMOTED 2026-07-30, 88.4-CODE-REVIEW.md #1/#13): `includeSpec`
// and `nullsNotDistinct` ARE identity-bearing on `unique` and `index`, over leaving them off
// the identity with a comment saying so. Both are rendered by `pg_get_indexdef` AFTER the
// `USING <method> (...)` paren group that `keySpecOfIndex` parses, so before this promotion two
// indexes differing ONLY in nulls-distinctness or in their INCLUDE payload canonicalized to the
// SAME identity and the divergence was never reported — a silent under-report, which is the one
// failure class this whole file is built to prevent (a differ that under-reports is
// indistinguishable from a healthy schema). Latent when promoted (nothing under `migrations/`
// emits either clause, and Sequelize 6 cannot express either), which is why this is the D-04
// promotion path working as designed — one row edit plus an emitter — rather than a rewrite.
// `nullsNotDistinct` is carried on `index` as well as `unique` even though only a UNIQUE index
// can be NULLS NOT DISTINCT: the field is always '' for a non-unique index, and a kind-specific
// omission would be one more asymmetry for a future reader to re-derive. Demoting either field
// is a decision, not a cleanup.
const IDENTITY_FIELDS = {
  fk: ['kind', 'table', 'keySpec', 'parentTable', 'parentColumns', 'onDelete', 'onUpdate', 'matchType'],
  pk: ['kind', 'table', 'keySpec'],
  unique: ['kind', 'table', 'keySpec', 'predicate', 'includeSpec', 'nullsNotDistinct'],
  index: ['kind', 'table', 'keySpec', 'predicate', 'method', 'includeSpec', 'nullsNotDistinct'],
};

/**
 * Derive the canonical identity string for a record. Adding a future column-level `kind`
 * is a new row in IDENTITY_FIELDS plus a new emitter — not a rewrite (SPEC boundary:
 * the format must not structurally preclude a later column diff).
 */
function identityOf(record) {
  const fields = IDENTITY_FIELDS[record && record.kind];
  if (!fields) {
    throw new Error(`[88.4] cannot derive an identity for unknown kind "${record && record.kind}"`);
  }
  return fields
    .map((f) => {
      const v = record[f];
      return v === null || v === undefined ? '' : String(v);
    })
    .join('|');
}

// A uniform record shape for every kind. Fields that do not apply to a kind stay at their
// empty default rather than being absent, so the diff layer can read any field off any
// record without existence checks.
function makeRecord(fields) {
  return {
    kind: '',
    table: '',
    keySpec: '',
    predicate: '',
    parentTable: '',
    parentColumns: '',
    onDelete: '',
    onUpdate: '',
    matchType: '',
    method: '',
    includeSpec: '',
    nullsNotDistinct: '',
    // Human-output only — never identity-bearing (see IDENTITY_FIELDS).
    deferrable: false,
    deferred: false,
    displayName: '',
    definition: '',
    ...fields,
  };
}

// `oid` has no pg-types parser, so node-postgres hands it back as a string while a
// hand-written fixture is likely to use a number. Normalize both before comparing, or the
// unique-fold silently never fires and every UNIQUE constraint shows up twice.
const oidKey = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * Join a catalog column array into a keySpec fragment.
 *
 * REFUSES a non-array rather than degrading to '' (Plan 08, and this is not a hypothetical
 * hardening — it is a regression guard for a bug that shipped):
 *
 * `array_agg(att.attname)` aggregates a column of type `name`, so the result type is `name[]`
 * (OID 1003). node-postgres has NO type parser for `name[]` and hands the value back as the RAW
 * POSTGRES ARRAY LITERAL STRING — `'{game_id}'` — not a JS array. The previous
 * `Array.isArray(arr) ? ... : ''` ternary turned that into an EMPTY STRING, so EVERY foreign key's
 * `keySpec` and `parentColumns` were blank and the FK identity silently dropped both column lists.
 * Measured consequence against the real 77-migration replay: three identity groups each collapsed
 * TWO genuinely different foreign keys into one identity —
 *   fk|Events||Users||n|a|s   <= events_picked_by_id_fkey  + events_winner_id_fkey
 *   fk|Events||Users||n|c|s   <= Events_picked_by_id_fkey  + Events_winner_id_fkey
 *   fk|Friendships||Users||c|a|s <= friendships_addressee_uuid_fkey + friendships_requester_uuid_fkey
 * so a migration-side FK on `winner_id` and a sync-side FK on `picked_by_id` would have CANCELLED
 * OUT and the gate would have reported nothing. `Users(user_id)` versus `Users(id)` — the very
 * distinction F-20 and F-41 of the census turn on — was likewise invisible.
 *
 * FIXED AT BOTH LAYERS, deliberately: the four queries now cast `attname::text` so the driver
 * parses a real array, AND this function throws if it ever receives a non-array again. The cast
 * alone would have been enough today; the throw is what makes the NEXT such regression loud
 * instead of silent. Unit fixtures pass JS arrays and so could never have caught the driver-level
 * shape — which is exactly why the throw belongs here rather than in a test.
 */
const joinCols = (arr) => {
  if (arr === null || arr === undefined) return '';
  if (!Array.isArray(arr)) {
    throw new Error(
      `[88.4] expected a column ARRAY from pg_catalog, got ${typeof arr} ${JSON.stringify(arr)}. ` +
        `This is the name[]-not-parsed bug: node-postgres has no parser for name[], so an ` +
        `uncast array_agg(attname) arrives as a raw '{a,b}' STRING. Refusing to degrade to an ` +
        `empty keySpec — that silently drops the column list out of the identity and folds ` +
        `different objects together. Cast the aggregate to ::text[] in the query.`
    );
  }
  return arr.map((c) => (c === null || c === undefined ? '' : String(c))).join(',');
};

// Normalization rule 3: the predicate is `pg_get_expr(indpred, indrelid)` VERBATIM. Both
// `WHERE "deletedAt" IS NULL` written in a migration (20260725000001:113-116) and
// Sequelize's `where: { deletedAt: null }` (models/userGroup.js:76-80) go through the SAME
// Postgres deparser and therefore render identically by construction. Hand-normalizing
// whitespace or parens here could only introduce FALSE equivalences.
const predicateOf = (idx) => (idx.predicate === null || idx.predicate === undefined ? '' : String(idx.predicate));

// Normalization rule 6 (88.4-CODE-REVIEW.md #1/#13): the two post-key-list clauses
// `pg_get_indexdef` renders OUTSIDE the paren group `keySpecOfIndex` parses. Both come from the
// CATALOG (Q_INDEXES `included_columns` / `nulls_not_distinct`), never from re-parsing the
// rendered tail — a boolean column and an attname array cannot be mis-parsed.
const includeSpecOf = (idx) => joinCols(idx.included_columns);

// DECISION Phase 88.4: `nullsNotDistinct` renders as the literal SQL phrase when set and '' when
// not, OVER a boolean or the string 'true'. The phrase is what `pg_get_indexdef` prints and what a
// human writes in an allowlist pin, so log output and entry text stay the same string (the same
// rule `renderAttrValue` follows for onDelete/onUpdate). Only an explicit `true` counts: `false`,
// NULL and a fixture that omits the field all yield ''. That is NOT a silent default for a real
// run — `ix.indnullsnotdistinct` is a PG 15+ column, so a server without it fails the QUERY
// loudly (CI is postgres:16, prod is 17); the tolerant read exists only so a hand-written unit
// fixture degrades instead of crashing, matching the `columns` fallback in the unique-fold below.
const nullsNotDistinctOf = (idx) => (idx.nulls_not_distinct === true ? 'NULLS NOT DISTINCT' : '');

/**
 * Pull the top-level key-list terms out of a `pg_get_indexdef` string.
 *
 * pg_get_indexdef renders:
 *   CREATE [UNIQUE] INDEX name ON [ONLY] schema.table USING method (keys...) [INCLUDE (...)] [WHERE pred]
 *
 * Anchoring on `USING <method> (` rather than "the first open paren" means a '(' inside a
 * quoted table name cannot be mistaken for the start of the key list. INCLUDE columns sit
 * OUTSIDE this paren group, which is why the term count agrees with `indnkeyatts`.
 *
 * @returns {string[]|null} the terms, or null when the shape is unrecognizable
 */
function parseKeyTerms(fullDef) {
  if (typeof fullDef !== 'string' || fullDef.length === 0) return null;

  const anchor = /\sUSING\s+(?:"(?:[^"]|"")+"|[A-Za-z0-9_]+)\s*\(/i.exec(fullDef);
  if (!anchor) return null;
  const open = anchor.index + anchor[0].length - 1;

  // Balanced, quote-aware scan for the matching close paren.
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let close = -1;
  for (let i = open; i < fullDef.length; i++) {
    const ch = fullDef[i];
    if (inSingle) {
      if (ch === "'") {
        if (fullDef[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (fullDef[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) return null;

  // Split the inner list on TOP-LEVEL commas only: the comma inside
  // `LEAST(requester_uuid, addressee_uuid)` is at depth 1 and must not split a term.
  const inner = fullDef.slice(open + 1, close);
  const terms = [];
  let buf = '';
  depth = 0;
  inSingle = false;
  inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") buf += inner[++i];
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      buf += ch;
      if (ch === '"') {
        if (inner[i + 1] === '"') buf += inner[++i];
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") { inSingle = true; buf += ch; continue; }
    if (ch === '"') { inDouble = true; buf += ch; continue; }
    if (ch === '(') { depth++; buf += ch; continue; }
    if (ch === ')') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) {
      terms.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) terms.push(buf.trim());
  return terms;
}

// Strip ONE wrapping pair of double quotes from a bare quoted identifier, so a camelCase
// column reads `deletedAt` (matching `pg_attribute.attname`, and matching what a human
// writes in an allowlist entry) rather than `"deletedAt"`. Expression terms and terms
// carrying modifiers (`col DESC`, `col varchar_pattern_ops`) are left untouched.
function unquoteIdent(term) {
  const m = /^"((?:[^"]|"")*)"$/.exec(term);
  return m ? m[1].replace(/""/g, '"') : term;
}

/**
 * Normalization rule 4: derive `keySpec` from the `pg_get_indexdef` key list.
 *
 * DECISION Phase 88.4 D-04: keySpec comes from the `pg_get_indexdef` key list, OVER
 * `pg_get_expr(indexprs)` and OVER the `key_columns` attname array alone.
 *   - `indexprs` gives only the expression LIST with no positional context relative to the
 *     plain columns in a mixed index, so `(group_id, LOWER(invited_email))` would lose the
 *     ordering that makes the key meaningful.
 *   - `key_columns` has a NULL element wherever `indkey` carries a 0 (an expression slot),
 *     so it cannot render a functional index at all — and the Friendships LEAST/GREATEST
 *     pair-unique (20260703000002:137-140) is exactly that shape.
 *   - Using the rendered key list ALSO keeps per-column modifiers (DESC, opclass,
 *     collation) inside the identity, so changing one is reported instead of swallowed.
 * `pg_get_indexdef` is Postgres's own renderer; a hand-built DDL reconstructor would
 * mishandle opclasses, collations, NULLS NOT DISTINCT and INCLUDE columns — a false-green
 * factory (RESEARCH "Don't Hand-Roll").
 *
 * Refuses to guess: an unparseable definition THROWS rather than falling back to a
 * partial keySpec, because a wrong keySpec under-reports drift silently, whereas a throw
 * fails the CI step loudly.
 */
function keySpecOfIndex(idx) {
  const terms = parseKeyTerms(idx.full_def);
  if (!terms) {
    throw new Error(
      `[88.4] could not locate the key list in pg_get_indexdef for index "${idx.index_name}" ` +
        `on table "${idx.table_name}". Refusing to guess a keySpec — a wrong one under-reports ` +
        `drift silently. Definition was: ${idx.full_def}`
    );
  }
  const nKeys = Number.isInteger(idx.indnkeyatts) ? idx.indnkeyatts : terms.length;
  if (terms.length !== nKeys) {
    throw new Error(
      `[88.4] index "${idx.index_name}" on "${idx.table_name}" reports indnkeyatts=${nKeys} but ` +
        `${terms.length} key term(s) parsed out of pg_get_indexdef. Refusing to guess. ` +
        `Definition was: ${idx.full_def}`
    );
  }
  return terms.map(unquoteIdent).join(',');
}

/**
 * Canonicalize one side's raw catalog rows into name-free identity records.
 *
 * @param {{fks?: object[], cons?: object[], idxs?: object[], tables?: object[]}} raw
 * @returns {{identities: object[], tables: string[]}}
 */
function canonicalize({ fks = [], cons = [], idxs = [], tables = [] } = {}) {
  const records = [];

  const idxByOid = new Map();
  for (const idx of idxs) idxByOid.set(oidKey(idx.indexrelid), idx);
  // Rule 1's bookkeeping: indexes already spoken for by a constraint.
  const consumedIndexOids = new Set();

  for (const fk of fks) {
    records.push(
      makeRecord({
        kind: 'fk',
        table: fk.child_table,
        keySpec: joinCols(fk.child_columns),
        parentTable: fk.parent_table,
        parentColumns: joinCols(fk.parent_columns),
        onDelete: fk.on_delete || '',
        onUpdate: fk.on_update || '',
        matchType: fk.match_type || '',
        deferrable: Boolean(fk.condeferrable),
        deferred: Boolean(fk.condeferred),
        displayName: fk.constraint_name || '',
        definition: fk.definition || '',
      })
    );
  }

  // Normalization rule 1: FOLD a table-level UNIQUE constraint into its backing unique
  // index. `conindid` names the index Postgres built to enforce the constraint, so the two
  // are one object; emitting both would make the 88.2 D-01 class (a table-level composite
  // UNIQUE on one side vs a PARTIAL unique index on the other) read as two unrelated
  // objects instead of one DIFFERS finding on the predicate.
  for (const con of cons) {
    const backing = idxByOid.get(oidKey(con.backing_index_oid));
    if (backing) consumedIndexOids.add(oidKey(backing.indexrelid));

    if (con.kind === 'p') {
      records.push(
        makeRecord({
          kind: 'pk',
          table: con.table_name,
          keySpec: joinCols(con.columns),
          displayName: con.constraint_name || '',
          definition: con.definition || '',
        })
      );
      continue;
    }
    if (con.kind === 'u') {
      records.push(
        makeRecord({
          kind: 'unique',
          table: con.table_name,
          // Prefer the backing index's rendered key list so a UNIQUE CONSTRAINT and an
          // equivalent unique INDEX produce byte-identical keySpecs and fold to one
          // identity. The `columns` fallback only fires if the catalog handed us a
          // constraint with no resolvable backing index, which Postgres does not do for
          // 'p'/'u' — it is there so a malformed fixture degrades rather than crashes.
          keySpec: backing ? keySpecOfIndex(backing) : joinCols(con.columns),
          predicate: backing ? predicateOf(backing) : '',
          method: backing ? backing.method || '' : '',
          // A table-level UNIQUE can carry both clauses too (`UNIQUE NULLS NOT DISTINCT (...)`
          // and `UNIQUE (...) INCLUDE (...)`), and Postgres records them on the BACKING index —
          // so they are read from `backing`, exactly like keySpec/predicate/method above.
          includeSpec: backing ? includeSpecOf(backing) : '',
          nullsNotDistinct: backing ? nullsNotDistinctOf(backing) : '',
          displayName: con.constraint_name || '',
          definition: con.definition || (backing && backing.full_def) || '',
        })
      );
      continue;
    }
    throw new Error(
      `[88.4] Q_CONSTRAINTS returned contype "${con.kind}" for "${con.table_name}"; ` +
        `only 'p' and 'u' are expected. Refusing to drop it silently.`
    );
  }

  for (const idx of idxs) {
    // Normalization rule 2: a PK-backing index is already emitted as `pk` from
    // Q_CONSTRAINTS. Checked independently of the consumed set so the skip still holds if
    // the constraint rows are absent (e.g. a fixture that supplies only the index).
    if (idx.indisprimary === true) continue;
    if (consumedIndexOids.has(oidKey(idx.indexrelid))) continue;

    const isUnique = idx.indisunique === true;
    records.push(
      makeRecord({
        kind: isUnique ? 'unique' : 'index',
        table: idx.table_name,
        keySpec: keySpecOfIndex(idx),
        predicate: predicateOf(idx),
        method: idx.method || '',
        includeSpec: includeSpecOf(idx),
        nullsNotDistinct: nullsNotDistinctOf(idx),
        displayName: idx.index_name || '',
        definition: idx.full_def || '',
      })
    );
  }

  // Normalization rule 5: sort by identity so output ordering is stable run-to-run
  // (SPEC R4). Plain byte comparison, NOT localeCompare — a locale-dependent collation
  // would make "deterministic" mean "deterministic on this runner". `displayName` is the
  // tie-break only, so the ORDER is total even when two objects share an identity; it is
  // still not part of the identity itself.
  const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const identities = records
    .map((r) => ({ ...r, identity: identityOf(r) }))
    .sort((a, b) => byString(a.identity, b.identity) || byString(a.displayName, b.displayName));

  const tableNames = [
    ...new Set(
      tables
        .map((t) => (t && (t.table_name !== undefined ? t.table_name : t.relname)) || '')
        .filter((n) => n.length > 0)
    ),
  ].sort(byString);

  return { identities, tables: tableNames };
}

// ---------------------------------------------------------------------------------------
// The structural set diff (SPEC R3 + R4).
//
// `diffSchemas` is a PURE function of two canonicalized results, exported so
// `tests/unit/schema-drift-diff.test.js` can drive every mismatch class with no database.
//
// Four finding types:
//   MIGRATION-ONLY  identity present only in the migration-chain-built schema
//   SYNC-ONLY       identity present only in the sync()-built schema
//   DIFFERS         same identity PREFIX (kind + table + keySpec) on both sides, but one
//                   identity-bearing ATTRIBUTE differs. This is the class that catches the
//                   88.2 CASCADE->SET NULL flip: an FK whose onDelete is 'c' on one side and
//                   'n' on the other is ONE finding naming both values, NOT a MIGRATION-ONLY
//                   plus a SYNC-ONLY pair (which is what a naive identity-set diff produces,
//                   and which reads as "two unrelated objects" instead of "this FK is wrong").
//   TABLE-MISSING   a table from Q_TABLES is absent on one side; its per-object findings are
//                   SUPPRESSED into this one finding, so a missing table reads as one line
//                   rather than fifteen.
// ---------------------------------------------------------------------------------------

// The DIFFERS grouping prefix. Everything in IDENTITY_FIELDS that is NOT in the prefix is a
// candidate DIFFERS attribute — derived, not listed, so promoting a field in IDENTITY_FIELDS
// (e.g. FK deferrability, per the D-04 marker above) automatically makes it diffable here with
// no second edit. `pk`'s identity IS its prefix, so a pk can never produce a DIFFERS finding.
const PREFIX_FIELDS = ['kind', 'table', 'keySpec'];

const str = (v) => (v === null || v === undefined ? '' : String(v));
const prefixOf = (rec) => PREFIX_FIELDS.map((f) => str(rec[f])).join('|');
const diffAttributesOf = (kind) => (IDENTITY_FIELDS[kind] || []).filter((f) => !PREFIX_FIELDS.includes(f));

// Catalog letter -> the word a human signed off on. Printing a raw `confdeltype` of 'n' at a
// developer who has never read this phase is a finding they cannot act on (SPEC R3: "naming
// the offender" means naming it in terms they recognize from the migration they wrote).
const ACTION_WORDS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const MATCH_WORDS = { f: 'FULL', p: 'PARTIAL', s: 'SIMPLE' };
const DECODED_ATTRS = { onDelete: ACTION_WORDS, onUpdate: ACTION_WORDS, matchType: MATCH_WORDS };

/**
 * Render one attribute value for human output AND for allowlist comparison — the two are the
 * SAME string on purpose, so an owner reading a CI log line can copy the value straight into
 * an allowlist `accepted` pin without re-deriving it.
 */
function renderAttrValue(attribute, raw) {
  const v = str(raw);
  const table = DECODED_ATTRS[attribute];
  if (table) {
    if (v === '') return '(none)';
    return table[v] || `(unrecognized catalog code "${v}")`;
  }
  return v === '' ? '(none)' : v;
}

function presenceFinding(side, rec) {
  return {
    type: side === 'migration-only' ? 'MIGRATION-ONLY' : 'SYNC-ONLY',
    side,
    kind: rec.kind,
    table: rec.table,
    keySpec: rec.keySpec,
    predicate: rec.predicate,
    attribute: '',
    values: null,
    migration: side === 'migration-only' ? rec : null,
    sync: side === 'sync-only' ? rec : null,
    collapsedObjectCount: 0,
    notCovered: [],
  };
}

function differsFinding(mRec, sRec, attribute) {
  return {
    type: 'DIFFERS',
    side: 'differs',
    kind: mRec.kind,
    table: mRec.table,
    keySpec: mRec.keySpec,
    // The allowlist-matching `predicate` of a DIFFERS finding is the MIGRATION side's value,
    // ALWAYS — including when `predicate` is itself the diverging attribute (the 88.2 D-01
    // class: a full UNIQUE on one side vs a partial unique index on the other). A finding with
    // two predicates cannot have a single key, and picking a side arbitrarily per-finding would
    // make an allowlist entry unwritable. Both values are still pinned, in `accepted`.
    predicate: mRec.predicate,
    attribute,
    values: {
      migration: renderAttrValue(attribute, mRec[attribute]),
      sync: renderAttrValue(attribute, sRec[attribute]),
    },
    migration: mRec,
    sync: sRec,
    collapsedObjectCount: 0,
    notCovered: [],
  };
}

function tableFinding(side, table) {
  return {
    type: 'TABLE-MISSING',
    side,
    kind: 'table',
    table,
    keySpec: '',
    predicate: '',
    attribute: '',
    values: null,
    migration: null,
    sync: null,
    collapsedObjectCount: 0,
    notCovered: [],
  };
}

// TABLE-MISSING sorts FIRST inside its table group (rank 0) — a reader needs to see "this whole
// table is absent" before anything else about that table. Plain byte comparison throughout, NOT
// localeCompare: a locale-dependent collation would make "deterministic" mean "deterministic on
// this runner" (SPEC R4).
const NUL = '\u0000';
const sortKeyOf = (f) =>
  [
    f.table,
    f.kind === 'table' ? '0' : '1',
    f.kind,
    f.keySpec,
    f.predicate,
    f.type,
    f.attribute,
    f.values ? f.values.migration : '',
    f.values ? f.values.sync : '',
  ].join(NUL);

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortFindings = (findings) => [...findings].sort((a, b) => byString(sortKeyOf(a), sortKeyOf(b)));

function bucketByPrefix(records) {
  const buckets = new Map();
  for (const rec of records) {
    const key = prefixOf(rec);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(rec);
  }
  return buckets;
}

const countByIdentity = (records) => {
  const counts = new Map();
  for (const rec of records) counts.set(rec.identity, (counts.get(rec.identity) || 0) + 1);
  return counts;
};

/**
 * Diff two canonicalized sides.
 *
 * @param {{identities: object[], tables: string[]}} migrationSide
 * @param {{identities: object[], tables: string[]}} syncSide
 * @returns {object[]} findings, deterministically sorted
 */
function diffSchemas(migrationSide, syncSide) {
  const mIds = (migrationSide && migrationSide.identities) || [];
  const sIds = (syncSide && syncSide.identities) || [];
  const mTables = (migrationSide && migrationSide.tables) || [];
  const sTables = (syncSide && syncSide.tables) || [];

  const findings = [];

  // (1) Table inventory first, so the per-object collapse below knows which tables are gone.
  const mTableSet = new Set(mTables);
  const sTableSet = new Set(sTables);
  const missingTables = new Map(); // table -> its TABLE-MISSING finding
  for (const t of mTables) {
    if (!sTableSet.has(t)) {
      const f = tableFinding('migration-only', t);
      missingTables.set(t, f);
      findings.push(f);
    }
  }
  for (const t of sTables) {
    if (!mTableSet.has(t)) {
      const f = tableFinding('sync-only', t);
      missingTables.set(t, f);
      findings.push(f);
    }
  }

  // (2) Per-object set diff, bucketed by DIFFERS prefix.
  const mBuckets = bucketByPrefix(mIds);
  const sBuckets = bucketByPrefix(sIds);
  const prefixes = [...new Set([...mBuckets.keys(), ...sBuckets.keys()])].sort(byString);

  for (const prefix of prefixes) {
    const mList = mBuckets.get(prefix) || [];
    const sList = sBuckets.get(prefix) || [];

    // Cancel out exact identity matches, MULTISET-wise: two records on one side can share a
    // prefix (a partial unique and a full unique on the same columns), and one of them matching
    // must not silently absorb the other.
    const sRemaining = countByIdentity(sList);
    const mLeft = [];
    for (const rec of mList) {
      const n = sRemaining.get(rec.identity) || 0;
      if (n > 0) {
        sRemaining.set(rec.identity, n - 1);
        continue;
      }
      mLeft.push(rec);
    }
    const mRemaining = countByIdentity(mList);
    const sLeft = [];
    for (const rec of sList) {
      const n = mRemaining.get(rec.identity) || 0;
      if (n > 0) {
        mRemaining.set(rec.identity, n - 1);
        continue;
      }
      sLeft.push(rec);
    }

    // Leftovers on BOTH sides of one prefix = the same object with a differing attribute.
    // Pair positionally: both lists arrive identity-sorted from `canonicalize`, so the pairing
    // is deterministic. Pairing never DROPS anything — an unpaired leftover still yields a
    // presence finding below, so the worst case of a mis-pairing is a differently-worded
    // finding, never a missing one.
    const pairs = Math.min(mLeft.length, sLeft.length);
    for (let i = 0; i < pairs; i++) {
      const mRec = mLeft[i];
      const sRec = sLeft[i];
      const attrs = diffAttributesOf(mRec.kind).filter((a) => str(mRec[a]) !== str(sRec[a]));
      if (attrs.length === 0) {
        // Unreachable by construction (identity = prefix + diff attributes, and these two
        // identities differ). Kept as a never-drop fallback rather than a throw: if a future
        // IDENTITY_FIELDS edit ever put a field in neither set, under-reporting would be
        // silent, whereas two presence findings are merely noisier than one DIFFERS.
        findings.push(presenceFinding('migration-only', mRec));
        findings.push(presenceFinding('sync-only', sRec));
        continue;
      }
      // One finding per diverging attribute, so each is separately reviewable and separately
      // allowlistable — a single lumped finding could only be signed off wholesale.
      for (const attribute of attrs) findings.push(differsFinding(mRec, sRec, attribute));
    }
    for (let i = pairs; i < mLeft.length; i++) findings.push(presenceFinding('migration-only', mLeft[i]));
    for (let i = pairs; i < sLeft.length; i++) findings.push(presenceFinding('sync-only', sLeft[i]));
  }

  // (3) Collapse: a table that exists on one side only has already been reported once, so its
  // per-object findings are noise. Count them onto the TABLE-MISSING finding instead of
  // discarding them silently.
  const kept = [];
  for (const f of findings) {
    if (f.kind !== 'table' && missingTables.has(f.table)) {
      missingTables.get(f.table).collapsedObjectCount += 1;
      continue;
    }
    kept.push(f);
  }

  return sortFindings(kept);
}

// ---------------------------------------------------------------------------------------
// Allowlist subtraction (SPEC R6, D-07).
// ---------------------------------------------------------------------------------------

/**
 * The record whose identity an entry pins. The MIGRATION-side object whenever one exists —
 * including for a DIFFERS finding, which is the same choice `differsFinding` already makes for
 * `predicate` and for the same reason: a finding with two records cannot have two keys, and
 * picking a side per-finding would make an allowlist entry unwritable. `kind: 'table'` findings
 * carry neither record and return before this is called.
 */
const pinRefOf = (finding) => finding.migration || finding.sync;

/**
 * Compute the pin values a would-be allowlist entry for this finding must carry, rendered exactly
 * as the human output prints them. Exported and reused by `formatFinding` so the log line and the
 * matcher read from ONE source — the "copy it off the CI log" instruction in the allowlist header
 * is only true if these cannot drift apart.
 *
 * @returns {Array<[string, string]>} [field, rendered value] pairs, in identity order
 */
function pinsOf(finding) {
  if (!finding || finding.kind === 'table') return [];
  const ref = pinRefOf(finding);
  return (PIN_FIELDS[finding.kind] || []).map((f) => [f, renderAttrValue(f, ref ? ref[f] : '')]);
}

// The object-level key: the FULL normalized identity, not a subset of it (88.4-CODE-REVIEW.md #9).
// A `kind: 'table'` entry matches on (side, table) alone — there is no per-object key for a
// whole-table difference.
//
// DECISION Phase 88.4: the pin fields are compared against `renderAttrValue`'s output, OVER the
// raw record values. `onDelete` lives in the record as the catalog letter 'c'; the differ PRINTS
// 'CASCADE' and the allowlist header instructs the owner to copy what was printed. Comparing raw
// values would silently reject every correctly-written entry (and, worse, an entry written with
// the raw letter would validate and match while contradicting the documented convention).
function entryMatchesObject(entry, finding) {
  if (entry.side !== finding.side) return false;
  if (entry.kind !== finding.kind) return false;
  if (entry.table !== finding.table) return false;
  if (entry.kind === 'table') return true;
  if (entry.keySpec !== finding.keySpec) return false;
  if (entry.predicate !== finding.predicate) return false;
  for (const [field, value] of pinsOf(finding)) {
    if (entry[field] !== value) return false;
  }
  return true;
}

// A `differs` entry additionally has to pin THE divergence that was found. Anything else on the
// same object is un-reviewed drift and must still fail the gate (T-88.4-13).
function entryMatchesFinding(entry, finding) {
  if (!entryMatchesObject(entry, finding)) return false;
  if (finding.side !== 'differs') return true;
  const acc = entry.accepted;
  return Boolean(
    acc &&
      acc.attribute === finding.attribute &&
      acc.migration === finding.values.migration &&
      acc.sync === finding.values.sync
  );
}

/**
 * Subtract the allowlist from a finding set.
 *
 * @returns {{kept: object[], suppressed: Array<{finding: object, entry: object}>}}
 */
function subtractAllowlist(findings, entries = ALLOWLIST_ENTRIES) {
  const list = Array.isArray(entries) ? entries : [];
  const kept = [];
  const suppressed = [];

  for (const finding of findings) {
    const match = list.find((e) => entryMatchesFinding(e, finding));
    if (match) {
      suppressed.push({ finding, entry: match });
      continue;
    }
    // Near miss: an allowlisted OBJECT whose divergence is not the accepted one. Say so out
    // loud on the finding's own line — otherwise the author of the entry reads "Friendships
    // again?" and assumes the allowlist is broken, rather than "this is a DIFFERENT drift".
    const notCovered = list
      .filter((e) => e.side === 'differs' && entryMatchesObject(e, finding) && e.accepted)
      .map(
        (e) =>
          `allowlisted divergence is ${e.accepted.migration} vs ${e.accepted.sync} (${e.accepted.attribute}); ` +
          `found ${finding.values ? finding.values.migration : '(n/a)'} vs ` +
          `${finding.values ? finding.values.sync : '(n/a)'} (${finding.attribute || 'n/a'}) — not covered`
      );
    kept.push(notCovered.length ? { ...finding, notCovered } : finding);
  }

  return { kept, suppressed };
}

// ---------------------------------------------------------------------------------------
// Human output (SPEC R3 + R4). Deterministic: every list is sorted before rendering, so two
// runs on the same commit — and a shuffled input array — produce byte-identical text.
//
// SECURITY (T-88.4-16, ASVS V7): table / constraint / index / column NAMES and catalog-rendered
// DEFINITIONS only. No row data reaches this output, because no query in this file selects any.
// ---------------------------------------------------------------------------------------

const show = (v) => (str(v) === '' ? '(none)' : str(v));

function formatFinding(finding) {
  const lines = [];
  const head = [`  [${finding.type}]`, finding.kind];
  if (finding.kind !== 'table') {
    head.push(`key=${show(finding.keySpec)}`);
    head.push(`predicate=${show(finding.predicate)}`);
  }
  if (finding.kind === 'fk') {
    const ref = finding.migration || finding.sync;
    head.push(`parent=${show(ref && ref.parentTable)}(${show(ref && ref.parentColumns)})`);
  }
  lines.push(head.join('  '));

  if (finding.type === 'TABLE-MISSING') {
    const has = finding.side === 'migration-only' ? 'migration side' : 'sync side';
    const lacks = finding.side === 'migration-only' ? 'sync side' : 'migration side';
    lines.push(`      table exists on the ${has} ONLY — absent from the ${lacks}`);
    lines.push(
      `      ${finding.collapsedObjectCount} per-object finding(s) for this table were collapsed ` +
        `into this one finding`
    );
  } else if (finding.type === 'DIFFERS') {
    lines.push(
      `      ${finding.attribute}: ${finding.values.migration} (migration) vs ${finding.values.sync} (sync)`
    );
  } else {
    const has = finding.side === 'migration-only' ? 'migration side' : 'sync side';
    const lacks = finding.side === 'migration-only' ? 'sync side' : 'migration side';
    lines.push(`      present on the ${has} ONLY — absent from the ${lacks}`);
  }

  // Labels padded to a fixed width so the migration and sync lines align in the log — a
  // side-by-side comparison is the whole point of a DIFFERS finding and ragged colons make
  // the two definitions much harder to scan for the one differing clause.
  const label = (s) => s.padEnd(14);
  for (const [side, rec] of [['migration', finding.migration], ['sync', finding.sync]]) {
    if (!rec) continue;
    lines.push(`      ${label(`${side} name`)}: ${show(rec.displayName)}`);
    lines.push(`      ${label(`${side} def`)}: ${show(rec.definition)}`);
  }

  // The remaining identity attributes, printed so an allowlist entry for this finding can be
  // written by COPYING rather than by re-deriving anything from `pg_catalog`. An entry must pin
  // the FULL normalized identity (88.4-CODE-REVIEW.md #9), and (side, kind, table, keySpec,
  // predicate) are already on the head line above — these are the rest. Suppressed for
  // `kind: 'table'`, which has no per-object key, and for `pk`, whose identity IS its prefix.
  const pins = pinsOf(finding);
  if (pins.length) {
    lines.push(`      identity pins : ${pins.map(([f, v]) => `${f}: '${v}'`).join(', ')}`);
  }

  for (const note of finding.notCovered || []) lines.push(`      NOTE: ${note}`);
  return lines;
}

/**
 * Render a finding set, grouped by table and deterministically ordered.
 * @returns {string}
 */
function formatFindings(findings) {
  const sorted = sortFindings(findings);
  const tables = [...new Set(sorted.map((f) => f.table))].sort(byString);
  const out = [
    `=== SCHEMA DRIFT: ${sorted.length} finding(s) across ${tables.length} table(s) ===`,
    '    migration side = the sequelize-cli migration chain replayed from an empty database',
    '    sync side      = sequelize.sync() from THIS commit\'s models',
    '',
  ];
  for (const table of tables) {
    out.push(table);
    for (const f of sorted.filter((x) => x.table === table)) out.push(...formatFinding(f));
    out.push('');
  }
  return out.join('\n');
}

/**
 * Render the allowlist accounting. An allowlisted instance must be VISIBLE in the log rather
 * than invisible — suppression with no trace is indistinguishable from a differ that never
 * looked. An entry that matched NOTHING is also called out: that is either drift someone
 * reconciled (remove the entry) or a mistyped pin that is silently protecting nothing.
 * @returns {string}
 */
function formatSuppressionSummary(total, suppressed, entries = ALLOWLIST_ENTRIES) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) {
    return (
      // D-88.4-06: this line used to end "...is the correct state UNTIL the day-one census is
      // signed off", which prints on every CI run and told its reader the census was still
      // pending — the opposite of the state that authorized arming the gate. The census was
      // signed off on 2026-07-30 with all 43 findings dispositioned `reconcile` and none
      // accepted, so empty is correct BECAUSE of the sign-off, not while awaiting it.
      `[88.4] allowlist: EMPTY (0 entries) — nothing suppressed of ${total} finding(s). Empty is ` +
      `the correct state: the day-one census was signed off 2026-07-30 with all 43 findings ` +
      `reconciled and none accepted (D-08). A new entry needs an owner-signed DECISION marker.`
    );
  }

  const out = [
    `[88.4] allowlist: ${suppressed.length} of ${total} finding(s) suppressed by ` +
      `${list.length} entr${list.length === 1 ? 'y' : 'ies'} in scripts/ci/schema-drift-allowlist.js`,
  ];
  for (const { finding, entry } of sortFindings(suppressed.map((s) => s.finding)).map((f) => ({
    finding: f,
    entry: suppressed.find((s) => s.finding === f).entry,
  }))) {
    const pin = entry.kind === 'table' ? `${entry.side}/${entry.kind}/${entry.table}` : `${entry.side}/${entry.kind}/${entry.table}/${show(entry.keySpec)}`;
    const acc = entry.accepted
      ? ` accepted ${entry.accepted.migration} vs ${entry.accepted.sync} (${entry.accepted.attribute})`
      : '';
    out.push(
      `         - ${finding.type} ${finding.kind} ${finding.table} key=${show(finding.keySpec)} ` +
        `<- entry ${pin}${acc} [signed off by ${entry.signedOffBy} on ${entry.signedOffOn}]`
    );
  }

  const unused = list.filter((e) => !suppressed.some((s) => s.entry === e));
  for (const e of unused) {
    out.push(
      `         - UNUSED entry ${e.side}/${e.kind}/${e.table}/${show(e.keySpec)} matched no finding. ` +
        `Either the drift was reconciled (delete this entry) or the pin is stale/mistyped and is ` +
        `protecting nothing.`
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------
// Report-only gating (D-08).
//
// DECISION Phase 88.4 D-08: report-only is an ENV VAR THIS CODE READS
// (`SCHEMA_DRIFT_REPORT_ONLY=1`), chosen OVER GitHub Actions' step-level failure-tolerance key
// — the workflow option that renders a failed step as a warning and lets the job pass anyway.
// (That option's name is deliberately not spelled anywhere in this file: the phase's
// verification greps for it and treats a hit as "the differ delegated its gating to the
// workflow".) Three reasons, the third decisive:
//   1. The workflow option makes the JOB green but still renders the step with a warning, so
//      the signal is muddy — "did it find drift, or did it break?"
//   2. The env var is read by code we control, so the differ can print an unmissable banner
//      naming the exact arming step.
//   3. It SWALLOWS CRASHES. A differ that throws on a bad connection string would look
//      identical to a differ that found drift, and a gate whose crash is indistinguishable from
//      its pass is not a gate (T-88.4-15). Here, report-only gates ONLY the findings branch;
//      an uncaught exception sets a failing exit code in BOTH modes.
// Arming is then a reviewable one-line diff in ci.yml. Swapping this for the workflow option is
// a decision, not a cleanup.
//
// Strictly the string '1'. Anything else (including 'true' or '0') means ARMED — the ambiguous
// direction must fail closed, and a surprising red is a loud, fixable mistake whereas a
// surprising green is the failure mode this file exists to prevent.
// ---------------------------------------------------------------------------------------
const isReportOnly = () => process.env.SCHEMA_DRIFT_REPORT_ONLY === '1';

/**
 * The whole gate verdict, as a pure function so it can be unit-tested without spawning a
 * process. A throw outranks report-only, always.
 * @returns {number} 0 or 1
 */
function decideExitCode({ findingCount = 0, reportOnly = false, threw = false } = {}) {
  if (threw) return 1;
  if (findingCount > 0) return reportOnly ? 0 : 1;
  return 0;
}

const ARMED_ERROR = (n) =>
  `::error::[88.4] SCHEMA DRIFT — ${n} finding(s): the schema built by replaying the migration ` +
  `chain and the schema built by sequelize.sync() from this commit's models are NOT structurally ` +
  `equivalent (see the grouped findings printed above this line). REMEDY, per finding: reconcile ` +
  `the two sides — add/adjust the model definition, or write a prod-safe migration — OR, if the ` +
  `divergence is correct and permanent, add an owner-signed entry to ` +
  `scripts/ci/schema-drift-allowlist.js pinned to the NORMALIZED identity (never to a constraint ` +
  `or index name) with a full 'DECISION Phase 88.4 <accepted> OVER <rejected> — <why>' comment ` +
  `block; a bare allowlist addition WITHOUT that marker fails the quality job's marker gate. WHY ` +
  `THIS GATE EXISTS: this repo's CI test database is built by sync() while production is built by ` +
  `the migration chain, so any divergence means the whole suite is validating a schema that does ` +
  `not exist in prod — that is exactly how 88.2's ON DELETE CASCADE -> SET NULL flip reached ` +
  `production unnoticed. If you are deliberately accepting one of these, allowlist it with a ` +
  `signed-off marker in the same commit — do not weaken the differ.`;

// UNREACHABLE FROM CI as of Plan 88.4-09, and deliberately kept (D-88.4-06). The gate is ARMED:
// `SCHEMA_DRIFT_REPORT_ONLY` is set nowhere in .github/workflows/ci.yml, and the `quality` job's
// scripts/ci/verify-gate-armed.js now FAILS the build if it reappears as an env key at any scope.
// This message therefore only ever prints for a LOCAL run that opts in explicitly — which is a
// legitimate use (reading a full finding list without a non-zero exit while iterating on the
// differ), so the branch stays. Its D-08 framing was rewritten because it described the day-one
// census as still ahead: it is not, it was signed off 2026-07-30 with all 43 findings reconciled.
const REPORT_ONLY_WARNING = (n) =>
  `::warning::[88.4] REPORT-ONLY MODE — ${n} schema-drift finding(s) found; this run is PASSING ` +
  `anyway because SCHEMA_DRIFT_REPORT_ONLY=1 is set in THIS environment. Backend CI does NOT ` +
  `set it: the gate was armed in Plan 88.4-09 once the day-one census had been signed off ` +
  `(2026-07-30, all 43 findings reconciled, none accepted) and CI measured zero drift, and the ` +
  `quality job's scripts/ci/verify-gate-armed.js fails the build if the flag is re-added at any ` +
  `scope. So if you are seeing this in CI, something has disarmed the gate — investigate that ` +
  `before the findings. Locally, this mode is a convenience for reading a full finding list; ` +
  `unset the variable to get the real exit code. A CRASH in this differ fails in both modes — ` +
  `only findings are suppressed.`;

module.exports = {
  dumpSchema,
  canonicalize,
  identityOf,
  diffSchemas,
  subtractAllowlist,
  formatFindings,
  formatFinding,
  formatSuppressionSummary,
  renderAttrValue,
  pinsOf,
  decideExitCode,
  isReportOnly,
  // Exported so tests/unit/schema-drift-diff.test.js can assert the allowlist module's
  // PIN_FIELDS covers exactly the non-prefix identity fields — the structural guard against a
  // future IDENTITY_FIELDS promotion silently reopening subset matching (88.4-CODE-REVIEW.md #9).
  IDENTITY_FIELDS,
  PREFIX_FIELDS,
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

  const [migrationRaw, syncRaw] = await Promise.all([
    dumpSchema(migrateUrl, 'migration side'),
    dumpSchema(syncUrl, 'sync side'),
  ]);

  const canon = {};
  for (const [key, label, raw] of [
    ['migration', 'migration side', migrationRaw],
    ['sync', 'sync side', syncRaw],
  ]) {
    canon[key] = canonicalize(raw);
    console.log(
      `[88.4] ${label}: ${raw.tables.length} table(s), ${raw.fks.length} FK(s), ` +
        `${raw.cons.length} PK/UNIQUE constraint(s), ${raw.idxs.length} index(es) ` +
        `-> ${canon[key].identities.length} canonical identit(ies) across ${canon[key].tables.length} table(s)`
    );
  }

  // T-88.4-08, second false-green: two EMPTY databases are structurally equivalent, so a build
  // step that silently failed to create anything produces a clean, confident, meaningless pass.
  // The identical-URL guard above does not catch this — the URLs differ, both databases just
  // have nothing in them. Refuse rather than report equivalence.
  for (const [key, label] of [['migration', 'migration side'], ['sync', 'sync side']]) {
    if (canon[key].tables.length === 0) {
      console.error(
        `[88.4] refusing to run: the ${label} database has ZERO tables in schema "public".\n` +
          '       Two empty schemas are trivially equivalent, so continuing would report a clean\n' +
          '       pass for a build step that produced nothing. Check the preceding step (the\n' +
          '       migration replay, or the sync build) — that is what actually failed.'
      );
      process.exitCode = 1;
      return;
    }
  }

  const findings = diffSchemas(canon.migration, canon.sync);
  const { kept, suppressed } = subtractAllowlist(findings, ALLOWLIST_ENTRIES);
  console.log(formatSuppressionSummary(findings.length, suppressed, ALLOWLIST_ENTRIES));

  if (kept.length === 0) {
    console.log(
      '[88.4] NO SCHEMA DRIFT — the migration-chain-built and sync()-built schemas are\n' +
        '       structurally equivalent across foreign keys (incl. ON DELETE / ON UPDATE / MATCH),\n' +
        '       primary keys, unique constraints/indexes, and the index set.'
    );
    return;
  }

  console.log(formatFindings(kept));

  const reportOnly = isReportOnly();
  console.log(reportOnly ? REPORT_ONLY_WARNING(kept.length) : ARMED_ERROR(kept.length));
  process.exitCode = decideExitCode({ findingCount: kept.length, reportOnly });
}

if (require.main === module) {
  // An uncaught throw fails the step in BOTH modes (T-88.4-15) — `decideExitCode` puts `threw`
  // ahead of `reportOnly` precisely so a crash can never be mistaken for a suppressed finding.
  main().catch((err) => {
    console.error(`[88.4] differ failed: ${err && err.message ? err.message : err}`);
    process.exitCode = decideExitCode({ threw: true, reportOnly: isReportOnly() });
  });
}
