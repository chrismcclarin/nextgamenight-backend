// tests/migrations/columnMirror.test.js
//
// Phase 88.8 plan 02 Task 3(d) — COLUMN + ENUM-LABEL MIRRORING, because the CI
// drift gate that looks like it covers this does not.
//
// WHY THIS FILE EXISTS (verified 2026-09-04, not inherited from a summary):
//   * `migrate-cli-replay` runs scripts/ci/schema-drift-diff.js, which diffs
//     foreign keys, PK/UNIQUE constraints, indexes and a table inventory — and
//     NOTHING ELSE. Its IDENTITY_FIELDS map (:313-316) has fk/pk/unique/index and
//     no column kind; its own comment at :319-323 calls a column-level kind
//     "a future column-level `kind`". There is no `information_schema.columns`
//     query and no `pg_enum` / `enumlabel` query anywhere in the file.
//   * The Jest schema is built by `sequelize.sync({ force: true })` in
//     tests/globalSetup.js and NEVER runs migrations.
//   So a MODEL-ONLY column passes all 95+ suites and then 500s in production on
//   its first write, and a MIGRATION-ONLY column is invisible to the ORM. Adding
//   a column creates no table, no constraint and no index, so the drift gate is
//   green either way.
//
// WHAT THIS FILE ACTUALLY PROVES — said plainly, because a gate that overclaims
// is how Phase 88 collected fourteen defective ones:
//   (1) MODEL SIDE: the columns and ENUM labels really exist on the sync-built
//       database. Because that database is built FROM THE MODELS, this proves the
//       model half and NOTHING about the migration half.
//   (2) MIGRATION SIDE (partial): each expected migration FILE exists on disk and
//       names its own column. That is a file-presence check, not a schema check —
//       it cannot prove the migration runs correctly, only that it was not
//       forgotten. It is the standing compensating control for T-88.8-08
//       (severity high, disposition PARTIAL), written as assertions rather than a
//       checklist tick precisely because a one-time tick evaporates when the phase
//       closes and the suite would stay green either way.
//   The remaining coverage is `db:migrate` failing on BROKEN DDL — which catches a
//   broken migration, never a missing one.
//
// DEFERRAL THIS LEAVES BEHIND: the class-closing fix is a real column-name set
// diff between the two databases the `migrate-cli-replay` job already builds side
// by side. scripts/ci/schema-drift-diff.js is explicitly designed for that
// promotion (one IDENTITY_FIELDS row plus one emitter, per its :319-323 comment),
// but it is Phase 91-shaped work, not 88.8 work. Plan 14 records it in
// `.planning/deferred/phase-91.md`.
//
// THIS TEST MUST NEVER REPLAY A MIGRATION. It only READS the catalog. The
// CLAUDE.md lesson from tests/migrations/rekey.test.js:35-44 is that a
// migration-replaying test which does not restore the CURRENT schema in afterAll
// poisons every suite that runs after it in the same `npm test` — that defect kept
// the backend suite red for months. There is deliberately no beforeAll/afterAll
// schema work here, no query-interface handle, and no migration call of any kind:
// this file mutates nothing, so it cannot leak anything.

const fs = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

// Sequelize DataTypes.DATE on Postgres lands as `timestamp with time zone`, and
// DataTypes.STRING as `character varying`. Read off the shipped
// `Users.sms_welcome_sent_at` column rather than guessed (verified 2026-09-04).
const TS = 'timestamp with time zone';
const VARCHAR = 'character varying';

// Each expected migration file, paired with the column (or ENUM value) it must
// name inside its own contents.
const EXPECTED_MIGRATIONS = [
  ['20260902000001-add-picture-url-to-users.js', 'picture_url'],
  ['20260902000002-add-orphaned-at-to-users.js', 'orphaned_at'],
  ['20260902000003-add-email-changed-at-to-users.js', 'email_changed_at'],
  ['20260902000004-single-use-tokens-email-change-verify.js', 'email_change_verify'],
  ['20260902000005-add-target-to-single-use-tokens.js', 'target'],
  ['20260902000006-add-send-failed-at-to-single-use-tokens.js', 'send_failed_at'],
  ['20260902000007-add-lower-email-unique-index-to-users.js', 'users_email_lower_unique'],
];

async function columnsOf(tableName) {
  return sequelize.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = :tableName`,
    { type: QueryTypes.SELECT, replacements: { tableName } }
  );
}

describe('Phase 88.8 plan 02 — column and ENUM-label mirroring', () => {
  describe('Users columns', () => {
    let cols;
    let byName;

    beforeAll(async () => {
      cols = await columnsOf('Users');
      byName = new Map(cols.map((c) => [c.column_name, c]));
    });

    it('ANTI-VACUITY: the Users catalog query returns a real column set', () => {
      // A query that silently returns zero rows would make every assertion below
      // vacuous — the exact defect class the frontend `drift-gate-registry` job
      // exists to prevent. Users has well over ten columns.
      expect(cols.length).toBeGreaterThan(10);
    });

    it.each([
      ['picture_url', VARCHAR],
      ['orphaned_at', TS],
      ['email_changed_at', TS],
    ])('%s exists, is nullable, and has the type its model attribute implies', (name, dataType) => {
      const col = byName.get(name);
      expect(col).toBeDefined();
      expect(col.is_nullable).toBe('YES');
      expect(col.data_type).toBe(dataType);
    });

    it('NEGATIVE SPACE: the withdrawn A12 columns really are absent', () => {
      // Not a mirroring check. SPEC amendment A12 withdrew the
      // notification-address pair while the phase was fully planned but
      // unexecuted; this asserts the withdrawal actually landed in the model
      // rather than trusting that every one of the fourteen plans was edited.
      // <!-- planner-discipline-allow: notification_email -->
      const offenders = cols
        .map((c) => c.column_name)
        .filter((n) => n.includes('notification_email'));
      expect(offenders).toEqual([]);
    });
  });

  describe('single_use_tokens columns', () => {
    let cols;
    let byName;

    beforeAll(async () => {
      cols = await columnsOf('single_use_tokens');
      byName = new Map(cols.map((c) => [c.column_name, c]));
    });

    it('ANTI-VACUITY: the single_use_tokens catalog query returns a real column set', () => {
      expect(cols.length).toBeGreaterThan(10);
    });

    it('target exists as a nullable string — the ONLY home of a pending address (D-35)', () => {
      const col = byName.get('target');
      expect(col).toBeDefined();
      expect(col.is_nullable).toBe('YES');
      expect(col.data_type).toBe(VARCHAR);
    });

    it('send_failed_at exists as a nullable timestamp — the provider-refusal marker', () => {
      const col = byName.get('send_failed_at');
      expect(col).toBeDefined();
      expect(col.is_nullable).toBe('YES');
      expect(col.data_type).toBe(TS);
    });
  });

  describe('enum_single_use_tokens_purpose labels', () => {
    let labels;

    beforeAll(async () => {
      const rows = await sequelize.query(
        `SELECT e.enumlabel AS label
           FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'enum_single_use_tokens_purpose'
          ORDER BY e.enumsortorder`,
        { type: QueryTypes.SELECT }
      );
      labels = rows.map((r) => r.label);
    });

    it('ANTI-VACUITY: the pg_enum query returns a real label set', () => {
      expect(labels.length).toBeGreaterThanOrEqual(4);
    });

    it('carries all four purposes including email_change_verify (D-07)', () => {
      expect(labels).toEqual(
        expect.arrayContaining(['oauth_state', 'rsvp', 'group_restore', 'email_change_verify'])
      );
    });
  });

  describe('Users case-insensitive unique index (owner ruling 2026-09-04)', () => {
    it('users_email_lower_unique exists on the sync-built schema and is UNIQUE', async () => {
      // Indexes ARE covered by migrate-cli-replay, unlike the columns above — so
      // this assertion guards the MODEL half specifically: a migration-only index
      // would turn the drift gate red, but a model declaration that silently
      // fails to render would not be caught here without this check.
      const rows = await sequelize.query(
        `SELECT i.relname AS name, ix.indisunique AS is_unique,
                pg_get_indexdef(ix.indexrelid) AS def
           FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_class t ON t.oid = ix.indrelid
          WHERE t.relname = 'Users' AND i.relname = 'users_email_lower_unique'`,
        { type: QueryTypes.SELECT }
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].is_unique).toBe(true);
      expect(rows[0].def).toContain('lower');
    });
  });

  describe('migration files exist on disk and name their own change (T-88.8-08)', () => {
    // The compensating control described in this file's header. The sync-built
    // database above cannot see a missing migration AT ALL, and neither can
    // migrate-cli-replay, so without these assertions a forgotten addColumn ships
    // green and 500s in production on first write.
    it.each(EXPECTED_MIGRATIONS)('%s exists and names %s', (filename, token) => {
      const full = path.join(MIGRATIONS_DIR, filename);
      expect(fs.existsSync(full)).toBe(true);
      expect(fs.readFileSync(full, 'utf8')).toContain(token);
    });
  });
});
