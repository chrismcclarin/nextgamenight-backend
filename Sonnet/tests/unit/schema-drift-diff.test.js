// tests/unit/schema-drift-diff.test.js
// Phase 88.4 / Plan 04: DB-FREE unit coverage for the schema-drift DIFF half
// (scripts/ci/schema-drift-diff.js -> diffSchemas / subtractAllowlist / formatFindings /
// decideExitCode) plus the accepted-drift policy module it consumes
// (scripts/ci/schema-drift-allowlist.js). SPEC R3 / R4 / R6, decisions D-07 and D-08.
//
// Strategy: every function under test is PURE. The tests hand `canonicalize` hand-written
// pg_catalog row fixtures — so the REAL pipeline (rows -> identities -> diff -> subtract ->
// format) runs end to end — and assert the findings and the rendered text. They MUST stay
// DB-free: no model-layer import, no live connection. This file runs in the `npm run test:unit`
// lane (jest.unit.config.js), which loads no globalSetup and so never provisions Postgres.
//
// WHY THIS FILE MATTERS: every failure mode in the differ is SILENTLY GREEN. A diff that
// under-reports — pairing two objects that are actually different, collapsing a finding that
// should stand, or suppressing one the owner never signed off — looks EXACTLY like a healthy
// schema, and nothing downstream catches it. These assertions are the only control.
//
// FIXTURES: the builders and the shape values below are transcribed from
// tests/unit/schema-drift-canonicalize.test.js (Plan 02), which in turn transcribed them from
// real in-repo migration/model pairs. They are COPIED rather than `require`d because extracting
// a shared fixtures module would mean editing Plan 02's committed test file, which is outside
// this plan's declared file set. Keep the values in step with that file if either changes.
//
// Coverage (1:1 with the describe blocks below):
//   1. FK presence            — an FK on one side only yields ONE MIGRATION-ONLY finding
//   2. ON DELETE value        — c vs n yields ONE DIFFERS finding, rendered as CASCADE/SET NULL
//   3. Unique presence        — a unique identity on one side only yields one finding
//   4. Plain index            — presence, and a btree-vs-gin method flip, both yield findings
//   5. Missing table collapse — one TABLE-MISSING finding, zero per-object findings
//   6. Allowlist subtraction  — suppressed WITH the entry, reappears WITHOUT it (SPEC R6),
//                               `accepted` narrows suppression to the reviewed divergence, a
//                               PRESENCE entry pins the FULL identity rather than a subset of it
//                               (88.4-CODE-REVIEW.md #9), and PIN_FIELDS is asserted to cover
//                               IDENTITY_FIELDS kind-for-kind so a future promotion cannot
//                               silently reopen subset matching
//   7. Malformed allowlist    — validateAllowlist throws; ENTRIES is frozen
//   8. Report-only exit gating— 0 under SCHEMA_DRIFT_REPORT_ONLY=1, 1 armed, 1 on a throw in both
//   9. Deterministic output   — same findings, and a shuffled array, format byte-identically

const {
  canonicalize,
  diffSchemas,
  subtractAllowlist,
  formatFindings,
  formatSuppressionSummary,
  decideExitCode,
  IDENTITY_FIELDS,
  PREFIX_FIELDS,
} = require('../../scripts/ci/schema-drift-diff');

const { ENTRIES, validateAllowlist, PIN_FIELDS } = require('../../scripts/ci/schema-drift-allowlist');

// --- fixture builders (mirror the SELECT lists in Q_INDEXES / Q_CONSTRAINTS / Q_FOREIGN_KEYS)

const idxRow = (o) => ({
  table_name: '',
  index_name: '',
  indexrelid: 0,
  indisunique: false,
  indisprimary: false,
  indnkeyatts: 1,
  method: 'btree',
  full_def: '',
  predicate: null,
  expressions: null,
  key_attnums: [],
  key_columns: [],
  // Post-key-list clauses promoted into the identity by 88.4-CODE-REVIEW.md #1/#13; defaults
  // are the no-clause case. Pinned in detail in tests/unit/schema-drift-canonicalize.test.js.
  included_columns: [],
  nulls_not_distinct: false,
  ...o,
});

const conRow = (o) => ({
  table_name: '',
  kind: 'u',
  constraint_name: '',
  backing_index_oid: 0,
  columns: [],
  definition: '',
  ...o,
});

const fkRow = (o) => ({
  child_table: '',
  parent_table: '',
  constraint_name: '',
  on_delete: 'a',
  on_update: 'a',
  match_type: 's',
  condeferrable: false,
  condeferred: false,
  child_columns: [],
  parent_columns: [],
  definition: '',
  ...o,
});

const tableRows = (names) => names.map((table_name) => ({ table_name }));

// Every side in this file declares the SAME table inventory unless a test is specifically
// exercising the TABLE-MISSING collapse — otherwise the collapse would swallow the very
// per-object findings under test, which is exactly the false-green shape being guarded against.
const ALL_TABLES = tableRows([
  'AvailabilityPrompts',
  'AvailabilitySuggestions',
  'Friendships',
  'UserGroups',
  'Users',
]);

const side = ({ fks = [], cons = [], idxs = [], tables = ALL_TABLES } = {}) =>
  canonicalize({ fks, cons, idxs, tables });

// --- FK fixtures -------------------------------------------------------------------------
// migrations/20260703000001-rekey-usergroup-user-uuid.js — UserGroups.user_uuid -> Users.id.
const ACTION_SQL = { c: 'CASCADE', n: 'SET NULL', r: 'RESTRICT', a: 'NO ACTION' };
const ugFk = (onDelete, name = 'UserGroups_user_uuid_fkey') =>
  fkRow({
    child_table: 'UserGroups',
    parent_table: 'Users',
    constraint_name: name,
    on_delete: onDelete,
    child_columns: ['user_uuid'],
    parent_columns: ['id'],
    definition: `FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE ${ACTION_SQL[onDelete]}`,
  });

// --- unique fixture (Plan 02 shape 3) ----------------------------------------------------
// migrations/20260703000002-rekey-friendship-uuid.js:137-140. Inexpressible in the ORM's v6
// `indexes:` DSL (models/Friendship.js:4,21-22 says so) — a genuine MIGRATION-ONLY object.
const FRIENDSHIPS_PAIR_UNIQUE = idxRow({
  table_name: 'Friendships',
  index_name: 'friendships_pair_unique_uuid',
  indexrelid: 1002,
  indisunique: true,
  indnkeyatts: 2,
  full_def:
    'CREATE UNIQUE INDEX friendships_pair_unique_uuid ON public."Friendships" ' +
    'USING btree (LEAST(requester_uuid, addressee_uuid), GREATEST(requester_uuid, addressee_uuid))',
  expressions: 'LEAST(requester_uuid, addressee_uuid), GREATEST(requester_uuid, addressee_uuid)',
  key_attnums: [0, 0],
  key_columns: [null, null],
});

const FRIENDSHIPS_PAIR_KEYSPEC =
  'LEAST(requester_uuid, addressee_uuid),GREATEST(requester_uuid, addressee_uuid)';

// --- plain-index fixtures (Plan 02 shapes 5 and 6) ---------------------------------------
const promptsIdx = (name, oid) =>
  idxRow({
    table_name: 'AvailabilityPrompts',
    index_name: name,
    indexrelid: oid,
    indnkeyatts: 1,
    full_def: `CREATE INDEX ${name} ON public."AvailabilityPrompts" USING btree (created_by_user_id)`,
    key_attnums: [7],
    key_columns: ['created_by_user_id'],
  });

const PROMPTS_MIGRATION = promptsIdx('availability_prompts_created_by_user_idx', 1003);

const SUGGESTION_GIN = idxRow({
  table_name: 'AvailabilitySuggestions',
  index_name: 'idx_suggestion_participant_ids_gin',
  indexrelid: 1004,
  method: 'gin',
  indnkeyatts: 1,
  full_def:
    'CREATE INDEX idx_suggestion_participant_ids_gin ON public."AvailabilitySuggestions" ' +
    'USING gin (participant_user_ids)',
  key_attnums: [9],
  key_columns: ['participant_user_ids'],
});

const SUGGESTION_BTREE = idxRow({
  ...SUGGESTION_GIN,
  index_name: 'idx_suggestion_participant_ids_btree',
  indexrelid: 2004,
  method: 'btree',
  full_def: SUGGESTION_GIN.full_def
    .replace('idx_suggestion_participant_ids_gin', 'idx_suggestion_participant_ids_btree')
    .replace('USING gin', 'USING btree'),
});

// A conforming allowlist entry, so every test's entry starts from a shape the validator accepts
// and each test varies exactly the one field it is about.
// Default values for the per-kind PIN fields an entry must carry (88.4-CODE-REVIEW.md #9), each
// written in the RENDERED form the differ prints — decoded English for the FK actions, '(none)'
// for an absent value. These match the `ugFk` / `FRIENDSHIPS_PAIR_UNIQUE` fixtures below, which is
// what makes the default ENTRY() a MATCHING entry.
const PIN_DEFAULT = {
  parentTable: 'Users',
  parentColumns: 'id',
  onDelete: 'CASCADE',
  onUpdate: 'NO ACTION', // fkRow's on_update: 'a'
  matchType: 'SIMPLE', // fkRow's match_type: 's'
  method: 'btree',
  includeSpec: '(none)',
  nullsNotDistinct: '(none)',
};

// Kind-aware, because the field set an entry may carry IS kind-dependent: validateAllowlist
// rejects an `onDelete` on an index entry as an unknown field and a missing `method` on one as a
// partial pin. Overrides win, so a test can deliberately mis-pin one field.
const ENTRY = (o = {}) => {
  const kind = o.kind || 'unique';
  const base = {
    side: 'migration-only',
    kind,
    table: 'Friendships',
    keySpec: FRIENDSHIPS_PAIR_KEYSPEC,
    predicate: '',
    signedOffBy: 'test-owner',
    signedOffOn: '2026-07-29',
  };
  for (const f of PIN_FIELDS[kind] || []) base[f] = PIN_DEFAULT[f];
  return { ...base, ...o };
};

// =======================================================================================

describe('1 — FK presence (an FK on the migration side only)', () => {
  const findings = diffSchemas(side({ fks: [ugFk('c')] }), side({ fks: [] }));

  test('yields exactly ONE MIGRATION-ONLY finding', () => {
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('MIGRATION-ONLY');
    expect(findings[0].side).toBe('migration-only');
    expect(findings[0].kind).toBe('fk');
  });

  test('names the child table, the child columns, and the parent table', () => {
    const [f] = findings;
    expect(f.table).toBe('UserGroups');
    expect(f.keySpec).toBe('user_uuid');
    expect(f.migration.parentTable).toBe('Users');
    expect(f.migration.parentColumns).toBe('id');

    const out = formatFindings(findings);
    expect(out).toContain('UserGroups');
    expect(out).toContain('user_uuid');
    expect(out).toContain('parent=Users(id)');
    expect(out).toContain('present on the migration side ONLY');
  });

  test('the mirror case is a SYNC-ONLY finding', () => {
    const mirrored = diffSchemas(side({ fks: [] }), side({ fks: [ugFk('c')] }));
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0].type).toBe('SYNC-ONLY');
    expect(mirrored[0].side).toBe('sync-only');
  });
});

describe('2 — ON DELETE value (the 88.2 CASCADE -> SET NULL class)', () => {
  const findings = diffSchemas(side({ fks: [ugFk('c')] }), side({ fks: [ugFk('n')] }));

  test('yields exactly ONE DIFFERS finding, NOT a MIGRATION-ONLY + SYNC-ONLY pair', () => {
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('DIFFERS');
    expect(findings.filter((f) => f.type === 'MIGRATION-ONLY')).toHaveLength(0);
    expect(findings.filter((f) => f.type === 'SYNC-ONLY')).toHaveLength(0);
  });

  test('names onDelete as the diverging attribute and carries both sides', () => {
    const [f] = findings;
    expect(f.attribute).toBe('onDelete');
    expect(f.values).toEqual({ migration: 'CASCADE', sync: 'SET NULL' });
  });

  test('renders both values as English words, never as raw confdeltype letters', () => {
    const out = formatFindings(findings);
    expect(out).toContain('CASCADE');
    expect(out).toContain('SET NULL');
    expect(out).toContain('onDelete: CASCADE (migration) vs SET NULL (sync)');
    // The raw catalog letters must not be what a developer is asked to interpret.
    expect(out).not.toContain('onDelete: c (migration)');
    expect(out).not.toContain('vs n (sync)');
  });

  test('an FK identical on both sides yields no finding at all', () => {
    expect(diffSchemas(side({ fks: [ugFk('c')] }), side({ fks: [ugFk('c')] }))).toHaveLength(0);
  });

  test('a divergence on a SECOND attribute is its own separate finding', () => {
    // onDelete c-vs-n AND onUpdate a-vs-c: two independently reviewable, independently
    // allowlistable findings, not one lumped verdict.
    const m = ugFk('c');
    const s = { ...ugFk('n'), on_update: 'c' };
    const multi = diffSchemas(side({ fks: [m] }), side({ fks: [s] }));
    expect(multi).toHaveLength(2);
    expect(multi.map((f) => f.attribute).sort()).toEqual(['onDelete', 'onUpdate']);
  });
});

describe('3 — unique presence (Friendships functional pair-unique)', () => {
  const findings = diffSchemas(side({ idxs: [FRIENDSHIPS_PAIR_UNIQUE] }), side({ idxs: [] }));

  test('yields one finding of the correct side and kind', () => {
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('MIGRATION-ONLY');
    expect(findings[0].kind).toBe('unique');
    expect(findings[0].table).toBe('Friendships');
    expect(findings[0].keySpec).toBe(FRIENDSHIPS_PAIR_KEYSPEC);
  });

  test('a table-level UNIQUE vs a PARTIAL unique on the same columns is a DIFFERS on predicate', () => {
    // Plan 02 shape 1 vs shape 4 — the 88.2 D-01 class. Same prefix, predicate is the only
    // divergence, so it must read as ONE finding about the predicate.
    const PARTIAL = idxRow({
      table_name: 'UserGroups',
      index_name: 'usergroups_user_uuid_group_id_uq',
      indexrelid: 1001,
      indisunique: true,
      indnkeyatts: 2,
      full_def:
        'CREATE UNIQUE INDEX usergroups_user_uuid_group_id_uq ON public."UserGroups" ' +
        'USING btree (user_uuid, group_id) WHERE ("deletedAt" IS NULL)',
      predicate: '("deletedAt" IS NULL)',
      key_attnums: [3, 4],
      key_columns: ['user_uuid', 'group_id'],
    });
    const FULL_CON = conRow({
      table_name: 'UserGroups',
      kind: 'u',
      constraint_name: 'UserGroups_user_uuid_group_id_key',
      backing_index_oid: 3001,
      columns: ['user_uuid', 'group_id'],
      definition: 'UNIQUE (user_uuid, group_id)',
    });
    const FULL_IDX = idxRow({
      table_name: 'UserGroups',
      index_name: 'UserGroups_user_uuid_group_id_key',
      indexrelid: 3001,
      indisunique: true,
      indnkeyatts: 2,
      full_def:
        'CREATE UNIQUE INDEX "UserGroups_user_uuid_group_id_key" ON public."UserGroups" ' +
        'USING btree (user_uuid, group_id)',
      key_attnums: [3, 4],
      key_columns: ['user_uuid', 'group_id'],
    });

    const findings2 = diffSchemas(
      side({ idxs: [PARTIAL] }),
      side({ cons: [FULL_CON], idxs: [FULL_IDX] })
    );
    expect(findings2).toHaveLength(1);
    expect(findings2[0].type).toBe('DIFFERS');
    expect(findings2[0].attribute).toBe('predicate');
    expect(findings2[0].values).toEqual({ migration: '("deletedAt" IS NULL)', sync: '(none)' });
    // The finding's own allowlist key pins the MIGRATION side's predicate, always.
    expect(findings2[0].predicate).toBe('("deletedAt" IS NULL)');
  });
});

describe('4 — plain index (presence, and a method flip)', () => {
  test('an index on one side only yields exactly one finding', () => {
    const findings = diffSchemas(side({ idxs: [PROMPTS_MIGRATION] }), side({ idxs: [] }));
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('MIGRATION-ONLY');
    expect(findings[0].kind).toBe('index');
    expect(findings[0].table).toBe('AvailabilityPrompts');
    expect(findings[0].keySpec).toBe('created_by_user_id');
  });

  test('btree vs gin over the same column is a DIFFERS finding, NOT a match', () => {
    const findings = diffSchemas(side({ idxs: [SUGGESTION_GIN] }), side({ idxs: [SUGGESTION_BTREE] }));
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('DIFFERS');
    expect(findings[0].attribute).toBe('method');
    expect(findings[0].values).toEqual({ migration: 'gin', sync: 'btree' });
    expect(formatFindings(findings)).toContain('method: gin (migration) vs btree (sync)');
  });

  test('an auto-name divergence with identical semantics yields NO finding (SPEC R4)', () => {
    // The whole point of the name-free identity: sync() names the same index differently.
    const syncAutoName = promptsIdx('availability_prompts_created_by_user_id', 2003);
    expect(diffSchemas(side({ idxs: [PROMPTS_MIGRATION] }), side({ idxs: [syncAutoName] }))).toHaveLength(0);
  });
});

describe('5 — a missing table collapses into ONE finding', () => {
  // Five child objects on a table the sync side does not have at all: 1 pk (constraint + its
  // backing index), 1 fk, 1 unique index, 2 plain indexes.
  const GHOST_PK_CON = conRow({
    table_name: 'Ghosts',
    kind: 'p',
    constraint_name: 'Ghosts_pkey',
    backing_index_oid: 5001,
    columns: ['id'],
    definition: 'PRIMARY KEY (id)',
  });
  const GHOST_PK_IDX = idxRow({
    table_name: 'Ghosts',
    index_name: 'Ghosts_pkey',
    indexrelid: 5001,
    indisunique: true,
    indisprimary: true,
    full_def: 'CREATE UNIQUE INDEX "Ghosts_pkey" ON public."Ghosts" USING btree (id)',
    key_attnums: [1],
    key_columns: ['id'],
  });
  const GHOST_FK = fkRow({
    child_table: 'Ghosts',
    parent_table: 'Users',
    constraint_name: 'Ghosts_user_uuid_fkey',
    on_delete: 'c',
    child_columns: ['user_uuid'],
    parent_columns: ['id'],
    definition: 'FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE CASCADE',
  });
  const ghostIdx = (name, oid, col, unique) =>
    idxRow({
      table_name: 'Ghosts',
      index_name: name,
      indexrelid: oid,
      indisunique: Boolean(unique),
      full_def: `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${name} ON public."Ghosts" USING btree (${col})`,
      key_attnums: [2],
      key_columns: [col],
    });

  const GHOST_TABLES = tableRows(['Ghosts', 'Users']);
  const migrationSide = canonicalize({
    fks: [GHOST_FK],
    cons: [GHOST_PK_CON],
    idxs: [
      GHOST_PK_IDX,
      ghostIdx('ghosts_slug_uq', 5002, 'slug', true),
      ghostIdx('ghosts_a_idx', 5003, 'col_a', false),
      ghostIdx('ghosts_b_idx', 5004, 'col_b', false),
    ],
    tables: GHOST_TABLES,
  });
  const syncSide = canonicalize({ tables: tableRows(['Users']) });

  test('the migration side really does carry five canonical objects for that table', () => {
    expect(migrationSide.identities.filter((r) => r.table === 'Ghosts')).toHaveLength(5);
  });

  test('yields exactly one TABLE-MISSING finding and zero per-object findings', () => {
    const findings = diffSchemas(migrationSide, syncSide);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('TABLE-MISSING');
    expect(findings[0].kind).toBe('table');
    expect(findings[0].table).toBe('Ghosts');
    expect(findings[0].keySpec).toBe('');
    expect(findings.filter((f) => f.kind !== 'table' && f.table === 'Ghosts')).toHaveLength(0);
  });

  test('the collapsed count is reported rather than discarded silently', () => {
    const [f] = diffSchemas(migrationSide, syncSide);
    expect(f.collapsedObjectCount).toBe(5);
    expect(formatFindings([f])).toContain('5 per-object finding(s) for this table were collapsed');
  });

  test("a kind:'table' allowlist entry matches on (side, table) alone", () => {
    const findings = diffSchemas(migrationSide, syncSide);
    const entry = ENTRY({ kind: 'table', table: 'Ghosts', keySpec: '' });
    expect(() => validateAllowlist([entry])).not.toThrow();
    expect(subtractAllowlist(findings, [entry]).kept).toHaveLength(0);
  });
});

describe('6 — allowlist subtraction (SPEC R6, both directions)', () => {
  const findings = diffSchemas(side({ idxs: [FRIENDSHIPS_PAIR_UNIQUE] }), side({ idxs: [] }));
  const entry = ENTRY();

  test('the entry is itself conforming', () => {
    expect(() => validateAllowlist([entry])).not.toThrow();
  });

  test('WITH the entry the finding is suppressed', () => {
    const { kept, suppressed } = subtractAllowlist(findings, [entry]);
    expect(kept).toHaveLength(0);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].entry).toBe(entry);
  });

  test('WITHOUT the entry the SAME finding reappears (this is SPEC R6)', () => {
    const { kept, suppressed } = subtractAllowlist(findings, []);
    expect(suppressed).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0].table).toBe('Friendships');
    expect(kept[0].type).toBe('MIGRATION-ONLY');
  });

  test('the suppression summary names the entry, so a suppressed instance stays visible', () => {
    const { suppressed } = subtractAllowlist(findings, [entry]);
    const summary = formatSuppressionSummary(findings.length, suppressed, [entry]);
    expect(summary).toContain('1 of 1 finding(s) suppressed');
    expect(summary).toContain('Friendships');
    expect(summary).toContain('test-owner');
    expect(summary).toContain('2026-07-29');
  });

  test('an entry pinned to the wrong keySpec suppresses nothing (never pin to names)', () => {
    const wrong = ENTRY({ keySpec: 'requester_uuid,addressee_uuid' });
    expect(subtractAllowlist(findings, [wrong]).kept).toHaveLength(1);
  });

  test('an UNUSED entry is called out in the summary rather than passing unnoticed', () => {
    const unused = ENTRY({ table: 'Users', keySpec: 'email' });
    const { suppressed } = subtractAllowlist(findings, [unused]);
    expect(formatSuppressionSummary(findings.length, suppressed, [unused])).toContain('UNUSED entry');
  });

  describe('`accepted` narrows a differs entry to the reviewed divergence', () => {
    const DIFFERS_ENTRY = ENTRY({
      side: 'differs',
      kind: 'fk',
      table: 'UserGroups',
      keySpec: 'user_uuid',
      accepted: { attribute: 'onDelete', migration: 'CASCADE', sync: 'SET NULL' },
    });

    const cascadeVsSetNull = diffSchemas(side({ fks: [ugFk('c')] }), side({ fks: [ugFk('n')] }));
    const cascadeVsRestrict = diffSchemas(side({ fks: [ugFk('c')] }), side({ fks: [ugFk('r')] }));

    test('the entry is conforming and pins the exact divergence', () => {
      expect(() => validateAllowlist([DIFFERS_ENTRY])).not.toThrow();
    });

    test('it SUPPRESSES the divergence it pins (CASCADE vs SET NULL)', () => {
      expect(subtractAllowlist(cascadeVsSetNull, [DIFFERS_ENTRY]).kept).toHaveLength(0);
    });

    test('it does NOT suppress a DIFFERENT divergence on the same object (CASCADE vs RESTRICT)', () => {
      const { kept, suppressed } = subtractAllowlist(cascadeVsRestrict, [DIFFERS_ENTRY]);
      expect(suppressed).toHaveLength(0);
      expect(kept).toHaveLength(1);
      expect(kept[0].values).toEqual({ migration: 'CASCADE', sync: 'RESTRICT' });
    });

    test('the surviving finding says explicitly that the allowlisted divergence is a different one', () => {
      const { kept } = subtractAllowlist(cascadeVsRestrict, [DIFFERS_ENTRY]);
      const out = formatFindings(kept);
      expect(out).toContain('allowlisted divergence is CASCADE vs SET NULL');
      expect(out).toContain('found CASCADE vs RESTRICT');
      expect(out).toContain('not covered');
    });

    test('it does NOT suppress a divergence on a different ATTRIBUTE carrying the same value pair', () => {
      // onUpdate CASCADE vs SET NULL is NOT what was signed off, even though the value pair is
      // identical to the accepted onDelete pin — which is why `accepted` carries `attribute`.
      const m = ugFk('c');
      const s = { ...ugFk('c'), on_update: 'n' };
      const onUpdateOnly = diffSchemas(
        side({ fks: [{ ...m, on_update: 'c' }] }),
        side({ fks: [s] })
      );
      expect(onUpdateOnly).toHaveLength(1);
      expect(onUpdateOnly[0].attribute).toBe('onUpdate');
      expect(subtractAllowlist(onUpdateOnly, [DIFFERS_ENTRY]).kept).toHaveLength(1);
    });
  });

  // ------------------------------------------------------------------------------------
  // 88.4-CODE-REVIEW.md #9: a PRESENCE entry pins the FULL normalized identity.
  //
  // The corridor these close: before this, `entryMatchesObject` compared only
  // (side, kind, table, keySpec, predicate). For an `fk` the identity ALSO carries
  // parentTable / parentColumns / onDelete / onUpdate / matchType, and for an `index` it carries
  // method (plus, since #1/#13, includeSpec / nullsNotDistinct). So one owner-signed entry
  // suppressed every object sharing the partial key — including objects nobody had reviewed.
  // Day-one impact was zero (the census concluded 0 allowlist entries), which is exactly why it
  // had to be closed BEFORE the first entry can exist rather than after.
  describe('a presence entry pins the FULL identity, not a subset of it', () => {
    const SYNC_ONLY_FK = (parentTable, parentColumns, onDelete) =>
      diffSchemas(
        side({ fks: [] }),
        side({
          fks: [
            fkRow({
              child_table: 'UserGroups',
              parent_table: parentTable,
              parent_columns: parentColumns,
              constraint_name: 'UserGroups_user_uuid_fkey',
              on_delete: onDelete,
              child_columns: ['user_uuid'],
              definition: `FOREIGN KEY (user_uuid) REFERENCES "${parentTable}"(${parentColumns[0]})`,
            }),
          ],
        })
      );

    const REVIEWED = ENTRY({
      side: 'sync-only',
      kind: 'fk',
      table: 'UserGroups',
      keySpec: 'user_uuid',
      parentTable: 'Users',
      parentColumns: 'id',
      onDelete: 'SET NULL',
    });

    test('the entry is conforming and DOES suppress the object it was signed off for', () => {
      expect(() => validateAllowlist([REVIEWED])).not.toThrow();
      const reviewed = SYNC_ONLY_FK('Users', ['id'], 'n');
      expect(reviewed).toHaveLength(1);
      expect(subtractAllowlist(reviewed, [REVIEWED]).suppressed).toHaveLength(1);
    });

    test('it does NOT suppress the same column pointing at a DIFFERENT PARENT TABLE', () => {
      const other = SYNC_ONLY_FK('Groups', ['id'], 'n');
      expect(other[0].keySpec).toBe(REVIEWED.keySpec); // same partial key — the old matcher's blind spot
      expect(subtractAllowlist(other, [REVIEWED]).kept).toHaveLength(1);
    });

    test('it does NOT suppress the same FK with a different PARENT COLUMN', () => {
      const other = SYNC_ONLY_FK('Users', ['user_id'], 'n');
      expect(subtractAllowlist(other, [REVIEWED]).kept).toHaveLength(1);
    });

    test('it does NOT suppress the same FK with a different ON DELETE action', () => {
      const other = SYNC_ONLY_FK('Users', ['id'], 'c');
      expect(subtractAllowlist(other, [REVIEWED]).kept).toHaveLength(1);
    });

    test('an index entry must pin `method` — a btree entry does not suppress a gin object', () => {
      const ginFinding = diffSchemas(side({ idxs: [SUGGESTION_GIN] }), side({ idxs: [] }));
      const btreeEntry = ENTRY({
        kind: 'index',
        table: 'AvailabilitySuggestions',
        keySpec: 'participant_user_ids',
        method: 'btree',
      });
      expect(() => validateAllowlist([btreeEntry])).not.toThrow();
      expect(subtractAllowlist(ginFinding, [btreeEntry]).kept).toHaveLength(1);
      expect(subtractAllowlist(ginFinding, [ENTRY({ ...btreeEntry, method: 'gin' })]).kept).toHaveLength(0);
    });

    test('the finding PRINTS its pins, so an entry can be written by copying rather than deriving', () => {
      const out = formatFindings(SYNC_ONLY_FK('Users', ['id'], 'n'));
      expect(out).toContain('identity pins :');
      expect(out).toContain("parentTable: 'Users'");
      expect(out).toContain("onDelete: 'SET NULL'"); // decoded, NOT the catalog letter 'n'
      expect(out).toContain("matchType: 'SIMPLE'");
      expect(out).not.toContain("onDelete: 'n'");
    });

    test('a pin field is REQUIRED — an entry omitting one is rejected, not treated as a wildcard', () => {
      const partial = { ...REVIEWED };
      delete partial.matchType;
      expect(() => validateAllowlist([partial])).toThrow(/matchType/);
    });

    test('a pin field written as a raw catalog letter is a MISS, not a silent match', () => {
      // The whole convention is "copy what the differ printed". An entry with 'n' instead of
      // 'SET NULL' validates (both are non-empty strings) and must then suppress NOTHING —
      // surfacing as an UNUSED entry rather than as accidentally-correct behaviour.
      const raw = ENTRY({ ...REVIEWED, onDelete: 'n' });
      expect(() => validateAllowlist([raw])).not.toThrow();
      expect(subtractAllowlist(SYNC_ONLY_FK('Users', ['id'], 'n'), [raw]).kept).toHaveLength(1);
    });
  });

  // The STRUCTURAL guard the PIN_FIELDS marker in schema-drift-allowlist.js promises. Two tables
  // in two modules have to agree; a comment saying so is not enforcement. A future phase promoting
  // an IDENTITY_FIELDS field (as 88.4 did with includeSpec / nullsNotDistinct) without adding it
  // here would silently reopen subset matching, and nothing else in CI would notice.
  describe('PIN_FIELDS covers exactly the non-prefix identity fields, for every kind', () => {
    test('the two modules agree kind-for-kind', () => {
      for (const kind of Object.keys(IDENTITY_FIELDS)) {
        const expected = IDENTITY_FIELDS[kind].filter(
          (f) => !PREFIX_FIELDS.includes(f) && f !== 'predicate'
        );
        expect(PIN_FIELDS[kind]).toEqual(expected);
      }
    });

    test("kind 'table' is pin-free, and every allowlist kind has an entry (no undefined lookups)", () => {
      expect(PIN_FIELDS.table).toEqual([]);
      for (const kind of ['fk', 'pk', 'unique', 'index', 'table']) {
        expect(Array.isArray(PIN_FIELDS[kind])).toBe(true);
      }
    });

    test('pk has nothing to pin because its identity IS the DIFFERS prefix', () => {
      expect(IDENTITY_FIELDS.pk).toEqual(PREFIX_FIELDS);
      expect(PIN_FIELDS.pk).toEqual([]);
    });
  });
});

describe('7 — a malformed allowlist THROWS rather than widening accepted drift', () => {
  test('ENTRIES is frozen and ships EMPTY (D-08: entries land after owner sign-off)', () => {
    expect(Object.isFrozen(ENTRIES)).toBe(true);
    expect(ENTRIES).toHaveLength(0);
  });

  test('an empty allowlist is valid — it is the correct day-one state, not an oversight', () => {
    expect(() => validateAllowlist(ENTRIES)).not.toThrow();
    expect(() => validateAllowlist([])).not.toThrow();
  });

  // Deliberately the OPPOSITE of utils/errors.js:71's fallback-on-unknown: a typo'd field there
  // degrades gracefully, here it would silently widen accepted drift.
  const MALFORMED = [
    ['an unknown field', ENTRY({ typo: 1 })],
    ['a missing required field', (() => { const e = ENTRY(); delete e.predicate; return e; })()],
    ['a non-string field value', ENTRY({ table: 42 })],
    // 88.4-CODE-REVIEW.md #9 — the full-identity pin is validated, not merely documented.
    [
      'a missing PIN field (a partial pin is not a wildcard)',
      (() => { const e = ENTRY({ kind: 'index', method: 'btree' }); delete e.method; return e; })(),
    ],
    [
      'an empty-string PIN field (the differ prints \'(none)\', never \'\')',
      ENTRY({ includeSpec: '' }),
    ],
    [
      'a PIN field belonging to a DIFFERENT kind (onDelete on a unique entry)',
      ENTRY({ onDelete: 'CASCADE' }),
    ],
    [
      'a differs entry whose pin contradicts accepted.migration',
      ENTRY({
        side: 'differs',
        kind: 'fk',
        table: 'UserGroups',
        keySpec: 'user_uuid',
        onDelete: 'SET NULL',
        accepted: { attribute: 'onDelete', migration: 'CASCADE', sync: 'SET NULL' },
      }),
    ],
    ['a side outside its enum', ENTRY({ side: 'bogus' })],
    ['a kind outside its enum', ENTRY({ kind: 'trigger' })],
    ['a differs entry with no accepted', ENTRY({ side: 'differs' })],
    [
      'a presence entry that carries accepted',
      ENTRY({ accepted: { attribute: 'onDelete', migration: 'CASCADE', sync: 'SET NULL' } }),
    ],
    ["a kind:'table' entry with a non-empty keySpec", ENTRY({ kind: 'table' })],
    ['a placeholder sign-off date', ENTRY({ signedOffOn: '2026-__-__' })],
    ['an empty signer', ENTRY({ signedOffBy: '' })],
    [
      'an accepted object missing `attribute`',
      ENTRY({ side: 'differs', accepted: { migration: 'CASCADE', sync: 'SET NULL' } }),
    ],
    [
      'an accepted object whose two values are equal',
      ENTRY({ side: 'differs', accepted: { attribute: 'onDelete', migration: 'A', sync: 'A' } }),
    ],
    [
      'an accepted object with an unknown sub-field',
      ENTRY({
        side: 'differs',
        accepted: { attribute: 'onDelete', migration: 'A', sync: 'B', why: 'x' },
      }),
    ],
    ['a non-array argument', 'not-an-array'],
  ];

  test.each(MALFORMED)('throws on %s', (_label, entry) => {
    const arg = Array.isArray(entry) || typeof entry !== 'object' ? entry : [entry];
    expect(() => validateAllowlist(arg)).toThrow(/schema-drift-allowlist/);
  });
});

describe('8 — report-only exit gating (D-08)', () => {
  test('findings + report-only => 0 (the job passes on drift, by design)', () => {
    expect(decideExitCode({ findingCount: 7, reportOnly: true })).toBe(0);
  });

  test('findings + armed => 1', () => {
    expect(decideExitCode({ findingCount: 7, reportOnly: false })).toBe(1);
  });

  test('no findings => 0 in both modes', () => {
    expect(decideExitCode({ findingCount: 0, reportOnly: true })).toBe(0);
    expect(decideExitCode({ findingCount: 0, reportOnly: false })).toBe(0);
  });

  // T-88.4-15: a differ that crashes must never be indistinguishable from a differ that passed.
  test('a throw => 1 in BOTH modes, even with zero findings', () => {
    expect(decideExitCode({ findingCount: 0, reportOnly: true, threw: true })).toBe(1);
    expect(decideExitCode({ findingCount: 0, reportOnly: false, threw: true })).toBe(1);
    expect(decideExitCode({ findingCount: 9, reportOnly: true, threw: true })).toBe(1);
  });

  test('called with no arguments it is a clean pass (no findings, not report-only, no throw)', () => {
    expect(decideExitCode()).toBe(0);
  });
});

describe('9 — deterministic output (SPEC R4)', () => {
  const migrationSide = side({
    fks: [ugFk('c')],
    idxs: [FRIENDSHIPS_PAIR_UNIQUE, SUGGESTION_GIN, PROMPTS_MIGRATION],
  });
  const syncSide = side({ fks: [ugFk('n')], idxs: [SUGGESTION_BTREE] });
  const findings = diffSchemas(migrationSide, syncSide);

  // Seeded Fisher-Yates: a real permutation, but a FIXED one, so a failure is reproducible
  // rather than a flake. The Lehmer multiplier keeps every intermediate under 2^53.
  const shuffle = (arr) => {
    const out = [...arr];
    let seed = 884;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    for (let i = out.length - 1; i > 0; i--) {
      const j = next() % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  test('the fixture set is big enough for ordering to be a real question', () => {
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });

  test('formatting the same finding set twice is byte-identical', () => {
    expect(formatFindings(findings)).toBe(formatFindings(findings));
  });

  test('formatting a SHUFFLED finding array is byte-identical', () => {
    const shuffled = shuffle(findings);
    expect(shuffled.map((f) => f.table)).not.toEqual(findings.map((f) => f.table));
    expect(formatFindings(shuffled)).toBe(formatFindings(findings));
  });

  test('diffSchemas itself returns findings in a stable, sorted order', () => {
    const again = diffSchemas(migrationSide, syncSide);
    expect(again).toEqual(findings);
    const tables = findings.map((f) => f.table);
    expect(tables).toEqual([...tables].sort());
  });

  test('shuffling the CATALOG ROWS of both sides changes nothing either', () => {
    const shuffledMigration = side({
      fks: [ugFk('c')],
      idxs: shuffle([FRIENDSHIPS_PAIR_UNIQUE, SUGGESTION_GIN, PROMPTS_MIGRATION]),
    });
    expect(formatFindings(diffSchemas(shuffledMigration, syncSide))).toBe(formatFindings(findings));
  });
});
