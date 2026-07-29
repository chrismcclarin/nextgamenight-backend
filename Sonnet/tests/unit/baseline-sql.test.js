// tests/unit/baseline-sql.test.js
// Phase 88.4 / Plan 01: DB-FREE unit coverage for the pre-chain baseline migration
// (migrations/00000000000000-baseline-pre-migration-schema.js), SPEC R1.
//
// Strategy: that migration exports its captured DDL as `BASELINE_SQL` (an extra key
// sequelize-cli ignores) precisely so it can be asserted on as a STRING. These tests
// require the module directly and touch nothing else. They MUST stay DB-free: no model
// import, no queryInterface, no destructive schema rebuild (the 83.1 shared-DB hazard —
// RESEARCH Pitfall 4). They live in tests/unit/ because jest.unit.config.js pins
// `testMatch: ['<rootDir>/tests/unit/**/*.test.js']`; a file under tests/ci/ would be
// invisible to the fast lane and would only run under jest.config.js, which force-syncs
// Postgres in globalSetup.
//
// The point of this suite is that the embedded SQL is a MECHANICAL pg_dump derivative. A
// re-capture (new pg_dump version, new source commit) can silently change its shape, and
// the failure mode is a red CI replay at best or a prod-hostile statement at worst. Each
// assertion below pins one property of the strip that a re-capture could break.
//
// Coverage:
//   1. Module contract: BASELINE_SQL is exported as a non-empty string; up/down are functions
//   2. Pitfall 4 / R-13: zero psql meta-command lines (`\restrict`, `\unrestrict`)
//   3. Strip completeness: no SET boilerplate, no search_path set_config, no CREATE SCHEMA,
//      no `--` comment lines
//   4. Table inventory: exactly the 8 pre-chain tables, by set equality (no BoardGames)
//   5. No CREATE EXTENSION (UUIDs come from DataTypes.UUIDV4 app-side, not uuid-ossp)
//   6. enum_UserGroups_role exists with exactly ('member','admin','owner') — 20260322000001
//      ALTERs this type and depends on that label set
//   7. FK prerequisites: a UNIQUE on Users.user_id (20260107 references it) and the counts
//      the migration header claims (2 enums / 8 tables / 28 constraints / 12 indexes)
//   8. Irreversibility (DECISION Phase 88.4 D-04): down() is a function and the migration
//      SOURCE contains no table-drop statement

const fs = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  '00000000000000-baseline-pre-migration-schema.js'
);

const migration = require('../../migrations/00000000000000-baseline-pre-migration-schema');
const { BASELINE_SQL } = migration;
const SOURCE = fs.readFileSync(MIGRATION_PATH, 'utf8');

// Comment-stripped view of the migration. Every source-level assertion below runs against
// CODE, not SOURCE, because these assertions are about what the migration EXECUTES — and its
// header deliberately NAMES the rejected alternatives (the house `.catch(() => null)` idiom,
// the 40 `DROP INDEX` statements elsewhere in migrations/, the table-drop that down() refuses
// to do). Grepping raw source for those tokens matches the documentation of the decision
// rather than a violation of it, which is a false failure. The migration's header is entirely
// `//` line comments, so dropping those lines leaves exactly the executable text plus the
// embedded SQL.
const CODE = SOURCE.split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .join('\n');

// The COMPLETE expected table set. `models/index.js` at a8570366^ requires exactly these 8
// (BoardGame.js is present in that tree but never required — orphaned then, orphaned now),
// so sync() built exactly these. Driving the assertion off this const plus a set-equality
// check means an ADDED or REMOVED table fails loudly rather than passing a subset match
// (the errors.test.js EXPECTED_STATUS shape).
const EXPECTED_TABLES = [
  'EventParticipations',
  'Events',
  'GameReviews',
  'Games',
  'Groups',
  'UserGames',
  'UserGroups',
  'Users',
];

// Session knobs pg_dump emits for a psql restore. All are meaningless-to-harmful inside the
// app's own pooled connection, so the strip removes them; pinned individually so a partial
// strip is visible.
const FORBIDDEN_SET_KEYS = [
  'statement_timeout',
  'lock_timeout',
  'idle_in_transaction_session_timeout',
  'client_encoding',
  'standard_conforming_strings',
  'check_function_bodies',
  'xmloption',
  'client_min_messages',
  'row_security',
  'default_tablespace',
  'default_table_access_method',
];

// Counts the migration header states explicitly. They are part of the contract: Plans 04/05
// diff this chain's end state against sync(), so a silently shrunk baseline reads as drift.
const EXPECTED_COUNTS = {
  'CREATE TYPE': 2,
  'CREATE TABLE': 8,
  'ADD CONSTRAINT': 28,
  'CREATE INDEX or CREATE UNIQUE INDEX': 12,
};

describe('baseline migration — module contract', () => {
  test('exports BASELINE_SQL as a non-empty string', () => {
    expect(typeof BASELINE_SQL).toBe('string');
    expect(BASELINE_SQL.length).toBeGreaterThan(1000);
  });

  test('exports up() and down()', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });

  test('sorts lexicographically first in migrations/ (it must run before 20260107-*)', () => {
    const files = fs
      .readdirSync(path.join(__dirname, '..', '..', 'migrations'))
      .filter((f) => f.endsWith('.js'))
      .sort();
    expect(files[0]).toBe('00000000000000-baseline-pre-migration-schema.js');
  });

  test('does not require ../config/database (Style A, CLI-native — D-06 env-chain hazard)', () => {
    expect(CODE).not.toContain("require('../config/database')");
  });
});

describe('baseline SQL — psql meta-commands stripped (R-13 / RESEARCH Pitfall 4)', () => {
  // pg_dump >= 16.10 emits `\restrict <token>` / `\unrestrict <token>` under the
  // CVE-2025-8714 hardening. sequelize.query() has no meta-command interpreter, so one
  // surviving line throws `syntax error at or near "\"` on the FIRST statement of the chain.
  test('contains no line beginning with a backslash', () => {
    const offenders = BASELINE_SQL.split('\n').filter((l) => /^\s*\\/.test(l));
    expect(offenders).toEqual([]);
  });

  test('contains neither the \\restrict nor the \\unrestrict token anywhere', () => {
    expect(BASELINE_SQL).not.toMatch(/\\restrict/);
    expect(BASELINE_SQL).not.toMatch(/\\unrestrict/);
  });
});

describe('baseline SQL — restore boilerplate stripped', () => {
  test.each(FORBIDDEN_SET_KEYS)('no SET %s', (key) => {
    expect(BASELINE_SQL).not.toMatch(new RegExp(`SET\\s+${key}\\b`, 'i'));
  });

  test("no set_config('search_path', ...) — it would leak onto a pooled connection", () => {
    expect(BASELINE_SQL).not.toMatch(/set_config\('search_path'/);
  });

  test('no CREATE SCHEMA / COMMENT ON SCHEMA', () => {
    expect(BASELINE_SQL).not.toMatch(/CREATE\s+SCHEMA/i);
    expect(BASELINE_SQL).not.toMatch(/COMMENT\s+ON\s+SCHEMA/i);
  });

  test('no `--` comment lines survive (the dump banners are stripped)', () => {
    const offenders = BASELINE_SQL.split('\n').filter((l) => /^\s*--/.test(l));
    expect(offenders).toEqual([]);
  });
});

describe('baseline SQL — table inventory is exactly the 8 pre-chain tables', () => {
  const found = [...BASELINE_SQL.matchAll(/CREATE TABLE\s+(?:"public"\.)?"([^"]+)"/g)].map(
    (m) => m[1]
  );

  test('the CREATE TABLE set equals the expected set exactly (added/removed table fails)', () => {
    expect(found.slice().sort()).toEqual(EXPECTED_TABLES.slice().sort());
  });

  test.each(EXPECTED_TABLES)('creates "%s"', (table) => {
    expect(found).toContain(table);
  });

  test('does NOT create BoardGames (BoardGame.js was orphaned at a8570366^ and still is)', () => {
    expect(found).not.toContain('BoardGames');
    expect(BASELINE_SQL).not.toMatch(/"BoardGames"/);
  });
});

describe('baseline SQL — no extension dependency', () => {
  // RESEARCH R-8: zero CREATE EXTENSION hits repo-wide. UUIDs are generated app-side by
  // DataTypes.UUIDV4, never by uuid-ossp/pgcrypto, so the baseline must not introduce a
  // superuser-requiring extension into the prod pre-deploy path.
  test('contains no CREATE EXTENSION', () => {
    expect(BASELINE_SQL).not.toMatch(/CREATE\s+EXTENSION/i);
  });
});

describe('baseline SQL — enum_UserGroups_role (20260322000001 depends on its label set)', () => {
  // migrations/20260322000001-add-pending-role-to-usergroups.js runs
  // `ALTER TYPE "enum_UserGroups_role" ADD VALUE IF NOT EXISTS 'pending'`, so the type must
  // exist here and must NOT already carry 'pending'.
  const enumMatch = BASELINE_SQL.match(
    /CREATE TYPE\s+(?:"public"\.)?"enum_UserGroups_role"\s+AS ENUM\s*\(([^)]*)\)/
  );

  test('creates the type', () => {
    expect(enumMatch).not.toBeNull();
  });

  test("labels are exactly 'member', 'admin', 'owner' (no 'pending' — that arrives in 20260322000001)", () => {
    const labels = enumMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(labels).toEqual(['member', 'admin', 'owner']);
  });

  test('creates enum_Events_status too', () => {
    expect(BASELINE_SQL).toMatch(/CREATE TYPE\s+(?:"public"\.)?"enum_Events_status"/);
  });
});

describe('baseline SQL — FK prerequisites and statement counts', () => {
  // migrations/20260107-create-user-availability.js:12-18 declares
  // `references: { model: 'Users', key: 'user_id' }`. An FK target needs a UNIQUE on that
  // column, so if this is ever dropped from the baseline the very first migration in the
  // chain fails on a from-empty replay.
  test('Users.user_id carries a UNIQUE constraint (20260107 references it)', () => {
    expect(BASELINE_SQL).toMatch(
      /ADD CONSTRAINT\s+"Users_user_id_key"\s+UNIQUE\s*\(\s*"user_id"\s*\)/
    );
  });

  test('Users.user_id also has its lookup index', () => {
    expect(BASELINE_SQL).toMatch(/CREATE INDEX\s+"users_user_id"/);
  });

  test.each(Object.entries(EXPECTED_COUNTS))('%s appears %i time(s)', (label, expected) => {
    const re =
      label === 'CREATE INDEX or CREATE UNIQUE INDEX'
        ? /CREATE (?:UNIQUE )?INDEX /g
        : new RegExp(label + ' ', 'g');
    expect((BASELINE_SQL.match(re) || []).length).toBe(expected);
  });
});

describe('baseline migration — irreversible by design (DECISION Phase 88.4 D-04)', () => {
  test('down() is a function', () => {
    expect(typeof migration.down).toBe('function');
  });

  test('the migration code contains no table-drop statement', () => {
    expect(CODE).not.toMatch(/DROP\s+TABLE/i);
  });

  test('the migration code contains no DROP TYPE / DROP INDEX either', () => {
    expect(CODE).not.toMatch(/DROP\s+TYPE/i);
    expect(CODE).not.toMatch(/DROP\s+INDEX/i);
  });

  test('down() resolves without touching a database', async () => {
    const logged = [];
    const originalLog = console.log;
    console.log = (...args) => logged.push(args.join(' '));
    try {
      await migration.down();
    } finally {
      console.log = originalLog;
    }
    expect(logged.join('\n')).toMatch(/no-op/);
  });
});

describe('baseline migration — existence guard shape (T-88.4-01)', () => {
  // The guard is the only thing between this DDL and prod (Railway runs migrate:apply on
  // EVERY deploy). These are source-level assertions: the runtime path is exercised by the
  // CI replay and by Plan 05's provisioned-path step, but the two-pronged signal check is
  // easy to "simplify" into the bare `.catch(() => null)` house idiom, which would fall
  // through to CREATE TABLE "Users" on a permissions failure. Pin it here.
  test("probes describeTable('Users')", () => {
    expect(CODE).toContain("describeTable('Users')");
  });

  test('detects the Sequelize-6 missing-table signal by message AND by 42P01', () => {
    expect(CODE).toContain("startsWith('No description found for')");
    expect(CODE).toContain("'42P01'");
  });

  test('rethrows anything that is not the missing-relation signal', () => {
    expect(CODE).toMatch(/if\s*\(!missingRelation\)\s*throw err;/);
  });

  test('does NOT use the bare swallow-everything catch idiom', () => {
    expect(CODE).not.toMatch(/\.catch\(\(\)\s*=>\s*null\)/);
  });
});
