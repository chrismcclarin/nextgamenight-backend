// tests/unit/assert-migrate-db-empty.test.js
// Phase 88.4 / Plan 09 (88.4-CODE-REVIEW.md #11): unit coverage for the migration-side
// FROM-EMPTY assertion (scripts/ci/assert-migrate-db-empty.js), SPEC R2.
//
// WHY THIS FILE EXISTS AT ALL. The script it covers is the only thing standing between the
// migrate-cli-replay job and a FALSE GREEN: if the migration side is not actually empty, the
// baseline no-ops, the chain short-replays, verify-migration-chain.js still passes (every row
// booked, no orphans), and the drift diff then compares a schema the migration chain did not
// build. A gate whose whole job is catching that must not itself be unverifiable — the same
// argument Plan 08 made for the allowlist marker gate.
//
// `verdict` is a PURE function of two catalog result sets, so every interesting case is a
// fixture here. The queries themselves get text assertions: they cannot be executed in this
// lane, but the schema-exclusion clauses are exactly where a silent widening would hide, and
// Plan 08 established that a text assertion on the SQL is the right fast-lane cover (it is
// what would have caught the `array_agg(attname)` cast bug in the differ).
//
// DB-free: no model import, no connection. Runs in the `npm run test:unit` lane.

const {
  verdict,
  Q_RELATIONS,
  Q_ENUMS,
  KIND_LABEL,
} = require('../../scripts/ci/assert-migrate-db-empty');

const rel = (name, kind = 'r', schema = 'public') => ({ schema, name, kind });
const enm = (name, schema = 'public') => ({ schema, name });

describe('verdict — the empty case', () => {
  test('zero relations and zero enums PASSES', () => {
    const v = verdict([], []);
    expect(v.ok).toBe(true);
    // The pass must state the EVIDENCE, not merely "ok" — a green line nobody can interpret is
    // how the from-empty property became unverified in the first place.
    expect(v.message).toMatch(/0 user relations, 0 user enums/);
    expect(v.message).toMatch(/EMPTY database/);
  });
});

describe('verdict — the false-green shape', () => {
  test('a pre-seeded SequelizeMeta FAILS and is called out BY NAME', () => {
    const v = verdict([rel('SequelizeMeta')], []);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/`SequelizeMeta` IS PRESENT/);
    // The message must explain WHY this specific object is worse than a merely dirty database:
    // it produces a silent skip, not a loud collision.
    expect(v.message).toMatch(/SKIPPED by db:migrate/);
    expect(v.message).toMatch(/verify-migration-chain\.js will still pass/);
  });

  test('a populated database FAILS and names every object found', () => {
    const v = verdict([rel('Users'), rel('Groups'), rel('SequelizeMeta')], [enm('enum_Users_role')]);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/3 user relation\(s\) and 1 user enum\(s\)/);
    for (const name of ['Users', 'Groups', 'SequelizeMeta', 'enum_Users_role']) {
      expect(v.message).toContain(name);
    }
    // Naming objects rather than counting them is the retained lesson from
    // verify-migration-chain.js: a count is not actionable, an object name is.
    expect(v.message).toContain('public.Users (table)');
    expect(v.message).toContain('public.enum_Users_role (enum type)');
  });

  test('a leftover ENUM alone FAILS — CREATE TYPE has no IF NOT EXISTS', () => {
    // This is the case a relations-only check would miss entirely: zero tables, but the
    // baseline's CREATE TYPE collides on replay.
    const v = verdict([], [enm('enum_GroupInvites_status')]);
    expect(v.ok).toBe(false);
    expect(v.message).toMatch(/0 user relation\(s\) and 1 user enum\(s\)/);
    expect(v.message).toContain('enum_GroupInvites_status');
    // No SequelizeMeta here, so the false-green note must NOT be emitted — the note is a
    // specific diagnosis, and firing it indiscriminately would devalue it.
    expect(v.message).not.toMatch(/SequelizeMeta` IS PRESENT/);
  });

  test('a leftover SEQUENCE alone FAILS — evidence of a dropped table', () => {
    const v = verdict([rel('Users_id_seq', 'S')], []);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('public.Users_id_seq (sequence)');
  });

  test('a non-public schema is not exempt', () => {
    const v = verdict([rel('leftover', 'r', 'staging')], []);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('staging.leftover (table)');
  });

  test('every reported relkind renders a human label, never a bare letter', () => {
    const kinds = ['r', 'p', 'v', 'm', 'f', 'S'];
    const v = verdict(
      kinds.map((k) => rel(`obj_${k}`, k)),
      []
    );
    expect(v.ok).toBe(false);
    for (const k of kinds) {
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(v.message).toContain(`public.obj_${k} (${KIND_LABEL[k]})`);
    }
    // Guard against a relkind being added to the query without a label: the SQL's IN-list and
    // KIND_LABEL's keys must stay in lockstep, or a real finding prints as `(x)`.
    const inList = /relkind IN \(([^)]*)\)/.exec(Q_RELATIONS)[1];
    const queried = inList.match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    expect(queried.sort()).toEqual(kinds.sort());
    expect(Object.keys(KIND_LABEL).sort()).toEqual(kinds.sort());
  });

  test('the failure message forbids relaxing the assertion rather than leaving it open', () => {
    const v = verdict([rel('Users')], []);
    expect(v.message).toMatch(/Do NOT relax this assertion/);
  });
});

describe('the catalog queries exclude system objects and nothing else', () => {
  // These are text assertions on purpose: this lane has no database, and the exclusion clauses
  // are precisely where an accidental widening (e.g. narrowing to `nspname = 'public'`, which
  // would exempt every other schema) would pass unnoticed.
  for (const [label, sql] of [
    ['Q_RELATIONS', Q_RELATIONS],
    ['Q_ENUMS', Q_ENUMS],
  ]) {
    describe(label, () => {
      test("excludes pg_catalog and information_schema", () => {
        expect(sql).toMatch(/nspname NOT IN \('pg_catalog', 'information_schema'\)/);
      });

      test('excludes toast and temp schemas by pattern', () => {
        expect(sql).toMatch(/nspname NOT LIKE 'pg_toast%'/);
        expect(sql).toMatch(/nspname NOT LIKE 'pg_temp%'/);
      });

      test('is NOT scoped to the public schema — a leftover in any schema must be reported', () => {
        expect(sql).not.toMatch(/nspname\s*=\s*'public'/);
      });

      test('is a bare SELECT — this script must never mutate the database it inspects', () => {
        expect(sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
        expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i);
      });
    });
  }

  test('Q_ENUMS filters on typtype = e', () => {
    expect(Q_ENUMS).toMatch(/typtype\s*=\s*'e'/);
  });

  test('Q_RELATIONS excludes indexes and per-table composite types', () => {
    // Dependent objects would only produce duplicate noise on failure — see the query comment.
    const inList = /relkind IN \(([^)]*)\)/.exec(Q_RELATIONS)[1];
    expect(inList).not.toContain("'i'");
    expect(inList).not.toContain("'c'");
  });
});
