// tests/unit/schema-drift-canonicalize.test.js
// Phase 88.4 / Plan 02: DB-FREE unit coverage for the schema-drift canonicalizer
// (scripts/ci/schema-drift-diff.js -> canonicalize), SPEC R4 / decision D-04.
//
// Strategy: `canonicalize` is a PURE function of catalog ROWS, so these tests hand it
// hand-written pg_catalog row fixtures and assert the derived identity strings. They MUST
// stay DB-free: no model-layer import, no ORM instance, no live connection — this file runs in
// the `npm run test:unit` lane (jest.unit.config.js), which loads no globalSetup and so
// never provisions Postgres. The plan's acceptance grep asserts the ORM's name appears
// NOWHERE in this file, which is why the prose below says "the ORM": it is a mechanical,
// greppable proof of DB-freeness rather than a promise.
//
// WHY THIS FILE IS THE HIGHEST-VALUE TEST IN THE PHASE: every hand-rolled shortcut in the
// differ fails SILENTLY GREEN. A canonicalizer that under-reports — folds two objects that
// are actually different, or renders a partial keySpec — looks EXACTLY like a healthy
// schema. Nothing downstream catches that. These fixtures are the only control against it,
// which is why each one is transcribed from a real in-repo migration/model pair rather than
// invented (RESEARCH § Normalization test shapes; all 7 verified in-repo).
//
// Coverage (1:1 with the describe blocks below):
//   1. UserGroups partial composite unique — migration side and sync side MATCH
//   2. The same index under two historical names — names are DISCARDED from the identity
//   3. Friendships LEAST/GREATEST functional pair-unique — renders, does NOT crash on the
//      NULL key_columns elements
//   4. Table-level UNIQUE folds onto its backing index — ONE identity, empty predicate, and
//      it shares shape 1's prefix so it reads as DIFFERS rather than as an unrelated object
//   5. Auto-name divergence with identical semantics — MATCH
//   6. GIN vs btree — pg_am.amname is part of a non-unique index identity
//   7. Partial unique with a function in the key — expression AND predicate together
//   8. PK-backing indexes are skipped (one `pk`, zero `unique`/`index`)
//   9. Deterministic ordering — shuffled input yields a byte-identical identities array
//
// Shapes 1-7 are ALSO driven from the single SHAPES table by a test.each, with a
// set-equality assertion on the shape names so adding or removing a shape fails loudly.

const { canonicalize } = require('../../scripts/ci/schema-drift-diff');

// --- fixture builders -------------------------------------------------------------------
// Field sets mirror the SELECT lists in Q_INDEXES / Q_CONSTRAINTS / Q_FOREIGN_KEYS so a
// reader can see the contract the canonicalizer is coded against.

const idxRow = (o) => ({
  table_name: '',
  index_name: '',
  indexrelid: 0,
  indisunique: false,
  indisprimary: false,
  indnkeyatts: 1,
  method: 'btree',
  full_def: '',
  predicate: null, // pg_get_expr(indpred, indrelid) — NULL when not partial
  expressions: null, // pg_get_expr(indexprs, indrelid) — NULL when all simple columns
  key_attnums: [],
  key_columns: [], // NULL element = expression slot (indkey entry 0)
  // The two post-key-list clauses pg_get_indexdef renders OUTSIDE the paren group keySpecOfIndex
  // parses, promoted into the identity by 88.4-CODE-REVIEW.md #1/#13. Defaults are the
  // no-clause case, which is what every real index in this repo is today.
  included_columns: [], // indkey slots past indnkeyatts — the INCLUDE payload
  nulls_not_distinct: false, // pg_index.indnullsnotdistinct (PG 15+)
  ...o,
});

const conRow = (o) => ({
  table_name: '',
  kind: 'u', // contype: 'p' | 'u'
  constraint_name: '',
  backing_index_oid: 0, // conindid
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

const identitiesOf = (raw) => canonicalize(raw).identities.map((r) => r.identity);

// --- shape 1: UserGroups partial composite unique ---------------------------------------
// migrations/20260725000001-group-usergroup-event-paranoid.js:113-116 (migration side)
// models/userGroup.js:76-80 (sync side — explicit `name` so both sides agree on the name too)
const UG_PARTIAL_UNIQUE_DEF =
  'CREATE UNIQUE INDEX usergroups_user_uuid_group_id_uq ON public."UserGroups" ' +
  'USING btree (user_uuid, group_id) WHERE ("deletedAt" IS NULL)';

const UG_PARTIAL_MIGRATION = idxRow({
  table_name: 'UserGroups',
  index_name: 'usergroups_user_uuid_group_id_uq',
  indexrelid: 1001,
  indisunique: true,
  indnkeyatts: 2,
  full_def: UG_PARTIAL_UNIQUE_DEF,
  predicate: '("deletedAt" IS NULL)',
  key_attnums: [3, 4],
  key_columns: ['user_uuid', 'group_id'],
});

// Same object in a separately-built database: only the catalog OID differs.
const UG_PARTIAL_SYNC = idxRow({ ...UG_PARTIAL_MIGRATION, indexrelid: 2001 });

const UG_PARTIAL_IDENTITY = 'unique|UserGroups|user_uuid,group_id|("deletedAt" IS NULL)||';

// --- shape 2: the same index under its two historical names ------------------------------
// 20260725000001:99-105 drops BOTH names; they were observed coexisting on one table
// (88.2-CASCADE-AUDIT.md § 3). `user_groups_user_uuid_group_id` is sync()'s auto-generated
// form of the same index.
const UG_PARTIAL_SYNC_AUTONAME = idxRow({
  ...UG_PARTIAL_MIGRATION,
  index_name: 'user_groups_user_uuid_group_id',
  indexrelid: 2002,
  full_def: UG_PARTIAL_UNIQUE_DEF.replace(
    'usergroups_user_uuid_group_id_uq',
    'user_groups_user_uuid_group_id'
  ),
});

// --- shape 3: Friendships functional pair-unique -----------------------------------------
// migrations/20260703000002-rekey-friendship-uuid.js:137-140. Inexpressible in the ORM's v6
// `indexes:` DSL (models/Friendship.js:4,21-22 says so), i.e. a genuine MIGRATION-ONLY object.
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
  key_columns: [null, null], // BOTH slots are expressions
});

const FRIENDSHIPS_PAIR_IDENTITY =
  'unique|Friendships|LEAST(requester_uuid, addressee_uuid),GREATEST(requester_uuid, addressee_uuid)|||';

// --- shape 4: table-level UNIQUE from belongsToMany.through.unique -----------------------
// What models/index.js:66,70 would produce if `unique: false` were lifted (DECISION Phase
// 88.2 D-01 at :45-46 pins it false). A FULL unique on the same columns as shape 1.
const UG_FULL_UNIQUE_CON = conRow({
  table_name: 'UserGroups',
  kind: 'u',
  constraint_name: 'UserGroups_user_uuid_group_id_key',
  backing_index_oid: 3001,
  columns: ['user_uuid', 'group_id'],
  definition: 'UNIQUE (user_uuid, group_id)',
});

const UG_FULL_UNIQUE_IDX = idxRow({
  table_name: 'UserGroups',
  index_name: 'UserGroups_user_uuid_group_id_key',
  indexrelid: 3001, // == conindid
  indisunique: true,
  indnkeyatts: 2,
  full_def:
    'CREATE UNIQUE INDEX "UserGroups_user_uuid_group_id_key" ON public."UserGroups" ' +
    'USING btree (user_uuid, group_id)',
  key_attnums: [3, 4],
  key_columns: ['user_uuid', 'group_id'],
});

const UG_FULL_UNIQUE_IDENTITY = 'unique|UserGroups|user_uuid,group_id|||';

// --- shape 5: auto-name divergence, identical semantics ----------------------------------
// 20260507000002 creates `availability_prompts_created_by_user_idx`; models/AvailabilityPrompt.js
// declares fields:['created_by_user_id'] with no `name`, so sync() generates
// `availability_prompts_created_by_user_id`.
const prompsIdx = (name, oid) =>
  idxRow({
    table_name: 'AvailabilityPrompts',
    index_name: name,
    indexrelid: oid,
    indnkeyatts: 1,
    full_def: `CREATE INDEX ${name} ON public."AvailabilityPrompts" USING btree (created_by_user_id)`,
    key_attnums: [7],
    key_columns: ['created_by_user_id'],
  });

const PROMPTS_MIGRATION = prompsIdx('availability_prompts_created_by_user_idx', 1003);
const PROMPTS_SYNC = prompsIdx('availability_prompts_created_by_user_id', 2003);
const PROMPTS_IDENTITY = 'index|AvailabilityPrompts|created_by_user_id||btree||';

// --- shape 6: GIN vs btree ---------------------------------------------------------------
// 20260208000001-add-suggestion-gin-index.js; absent from models/AvailabilitySuggestion.js
// (no `using:` anywhere in that file), i.e. MIGRATION-ONLY.
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

// Same table, same column, btree instead of gin — must NOT collapse into the GIN identity.
const SUGGESTION_BTREE = idxRow({
  ...SUGGESTION_GIN,
  index_name: 'idx_suggestion_participant_ids_btree',
  indexrelid: 2004,
  method: 'btree',
  full_def: SUGGESTION_GIN.full_def
    .replace('idx_suggestion_participant_ids_gin', 'idx_suggestion_participant_ids_btree')
    .replace('USING gin', 'USING btree'),
});

const SUGGESTION_GIN_IDENTITY = 'index|AvailabilitySuggestions|participant_user_ids||gin||';
const SUGGESTION_BTREE_IDENTITY = 'index|AvailabilitySuggestions|participant_user_ids||btree||';

// --- shape 7: partial unique with a function in the key ----------------------------------
// 20260228000001-create-group-invites-table.js:84-87. `LOWER()` in the key is genuinely
// inexpressible in the ORM's v6 DSL (unlike the partial predicate — models/GroupInvite.js:77-78
// claims otherwise and models/userGroup.js:63-70 disproves it for the predicate half).
const GROUP_INVITES_PENDING_UNIQUE = idxRow({
  table_name: 'GroupInvites',
  index_name: 'group_invites_pending_unique',
  indexrelid: 1005,
  indisunique: true,
  indnkeyatts: 2,
  full_def:
    'CREATE UNIQUE INDEX group_invites_pending_unique ON public."GroupInvites" ' +
    "USING btree (group_id, lower((invited_email)::text)) WHERE ((status)::text = 'pending'::text)",
  predicate: "((status)::text = 'pending'::text)",
  expressions: 'lower((invited_email)::text)',
  key_attnums: [2, 0],
  key_columns: ['group_id', null], // mixed: one plain column, one expression slot
});

const GROUP_INVITES_IDENTITY =
  "unique|GroupInvites|group_id,lower((invited_email)::text)|((status)::text = 'pending'::text)||";

// --- shape 8 fixtures: PK + its backing index -------------------------------------------
const USERS_PK_CON = conRow({
  table_name: 'Users',
  kind: 'p',
  constraint_name: 'Users_pkey',
  backing_index_oid: 4001,
  columns: ['id'],
  definition: 'PRIMARY KEY (id)',
});

const USERS_PK_IDX = idxRow({
  table_name: 'Users',
  index_name: 'Users_pkey',
  indexrelid: 4001,
  indisunique: true,
  indisprimary: true,
  indnkeyatts: 1,
  full_def: 'CREATE UNIQUE INDEX "Users_pkey" ON public."Users" USING btree (id)',
  key_attnums: [1],
  key_columns: ['id'],
});

// --- the shape table --------------------------------------------------------------------
// One row per RESEARCH normalization shape. `input` is a single side's catalog rows;
// `expectedIdentities` is the COMPLETE expected identity list for that input, so an extra
// or missing emitted object fails the assertion (not just a wrong one).

const SHAPES = [
  {
    n: 1,
    name: 'UserGroups partial composite unique',
    input: { idxs: [UG_PARTIAL_MIGRATION] },
    expectedIdentities: [UG_PARTIAL_IDENTITY],
  },
  {
    n: 2,
    name: 'same index, two historical names',
    input: { idxs: [UG_PARTIAL_MIGRATION, UG_PARTIAL_SYNC_AUTONAME] },
    expectedIdentities: [UG_PARTIAL_IDENTITY, UG_PARTIAL_IDENTITY],
  },
  {
    n: 3,
    name: 'Friendships LEAST/GREATEST functional pair-unique',
    input: { idxs: [FRIENDSHIPS_PAIR_UNIQUE] },
    expectedIdentities: [FRIENDSHIPS_PAIR_IDENTITY],
  },
  {
    n: 4,
    name: 'table-level UNIQUE folds onto its backing index',
    input: { cons: [UG_FULL_UNIQUE_CON], idxs: [UG_FULL_UNIQUE_IDX] },
    expectedIdentities: [UG_FULL_UNIQUE_IDENTITY],
  },
  {
    n: 5,
    name: 'auto-name divergence, same semantics',
    input: { idxs: [PROMPTS_MIGRATION] },
    expectedIdentities: [PROMPTS_IDENTITY],
  },
  {
    n: 6,
    name: 'GIN index carries its access method',
    input: { idxs: [SUGGESTION_GIN] },
    expectedIdentities: [SUGGESTION_GIN_IDENTITY],
  },
  {
    n: 7,
    name: 'partial unique with a function in the key',
    input: { idxs: [GROUP_INVITES_PENDING_UNIQUE] },
    expectedIdentities: [GROUP_INVITES_IDENTITY],
  },
];

// Independent literal list — NOT derived from SHAPES. Adding or removing a normalization
// shape must fail here loudly rather than silently shrink the phase's false-green guard.
const EXPECTED_SHAPE_NAMES = [
  'UserGroups partial composite unique',
  'same index, two historical names',
  'Friendships LEAST/GREATEST functional pair-unique',
  'table-level UNIQUE folds onto its backing index',
  'auto-name divergence, same semantics',
  'GIN index carries its access method',
  'partial unique with a function in the key',
];

test('the shape table covers exactly the 7 verified in-repo normalization shapes', () => {
  expect(SHAPES.map((s) => s.name).sort()).toEqual([...EXPECTED_SHAPE_NAMES].sort());
  expect(SHAPES.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test.each(SHAPES.map((s) => [s.n, s.name, s.input, s.expectedIdentities]))(
  'shape %i (%s) canonicalizes to exactly its expected identities',
  (_n, _name, input, expected) => {
    expect(identitiesOf(input)).toEqual(expected);
  }
);

// =======================================================================================

describe('shape 1 — UserGroups partial composite unique (migration side vs sync side MATCH)', () => {
  test('both sides produce the identity RESEARCH predicts', () => {
    expect(identitiesOf({ idxs: [UG_PARTIAL_MIGRATION] })).toEqual([UG_PARTIAL_IDENTITY]);
    expect(identitiesOf({ idxs: [UG_PARTIAL_SYNC] })).toEqual([UG_PARTIAL_IDENTITY]);
  });

  test('the predicate is carried through VERBATIM from pg_get_expr, parens and all', () => {
    const [rec] = canonicalize({ idxs: [UG_PARTIAL_MIGRATION] }).identities;
    expect(rec.predicate).toBe('("deletedAt" IS NULL)');
    expect(rec.kind).toBe('unique');
    expect(rec.keySpec).toBe('user_uuid,group_id');
  });

  test('the catalog OID is not identity-bearing (separately-built databases differ)', () => {
    expect(UG_PARTIAL_MIGRATION.indexrelid).not.toBe(UG_PARTIAL_SYNC.indexrelid);
    expect(canonicalize({ idxs: [UG_PARTIAL_MIGRATION] }).identities[0].identity).toBe(
      canonicalize({ idxs: [UG_PARTIAL_SYNC] }).identities[0].identity
    );
  });
});

describe('shape 2 — the same index under two historical names (names DISCARDED)', () => {
  test('two differently-named fixtures of one index share one identity', () => {
    const a = canonicalize({ idxs: [UG_PARTIAL_MIGRATION] }).identities[0];
    const b = canonicalize({ idxs: [UG_PARTIAL_SYNC_AUTONAME] }).identities[0];
    expect(a.displayName).not.toBe(b.displayName);
    expect(a.identity).toBe(b.identity);
  });

  test('no index name appears anywhere in the identity string (RESEARCH Pitfall 3)', () => {
    const { identities } = canonicalize({ idxs: [UG_PARTIAL_MIGRATION, UG_PARTIAL_SYNC_AUTONAME] });
    for (const rec of identities) {
      expect(rec.identity).not.toContain('usergroups_user_uuid_group_id_uq');
      expect(rec.identity).not.toContain('user_groups_user_uuid_group_id');
      expect(rec.identity).not.toContain(rec.displayName);
    }
  });
});

describe('shape 3 — Friendships LEAST/GREATEST functional pair-unique (MIGRATION-ONLY)', () => {
  test('does not throw on the NULL key_columns elements', () => {
    expect(() => canonicalize({ idxs: [FRIENDSHIPS_PAIR_UNIQUE] })).not.toThrow();
  });

  test('renders both expression terms into keySpec, in key order', () => {
    const [rec] = canonicalize({ idxs: [FRIENDSHIPS_PAIR_UNIQUE] }).identities;
    expect(rec.keySpec).toBe(
      'LEAST(requester_uuid, addressee_uuid),GREATEST(requester_uuid, addressee_uuid)'
    );
    expect(rec.identity).toBe(FRIENDSHIPS_PAIR_IDENTITY);
  });

  test('the comma INSIDE LEAST(...) does not split a key term', () => {
    const [rec] = canonicalize({ idxs: [FRIENDSHIPS_PAIR_UNIQUE] }).identities;
    expect(rec.keySpec.split('),').length).toBe(2);
  });
});

describe('shape 4 — table-level UNIQUE folds onto its backing index', () => {
  test('emits exactly ONE unique identity, not a constraint plus an index', () => {
    const { identities } = canonicalize({ cons: [UG_FULL_UNIQUE_CON], idxs: [UG_FULL_UNIQUE_IDX] });
    expect(identities).toHaveLength(1);
    expect(identities[0].kind).toBe('unique');
    expect(identities[0].identity).toBe(UG_FULL_UNIQUE_IDENTITY);
  });

  test('the folded identity has an EMPTY predicate', () => {
    const [rec] = canonicalize({ cons: [UG_FULL_UNIQUE_CON], idxs: [UG_FULL_UNIQUE_IDX] }).identities;
    expect(rec.predicate).toBe('');
  });

  test('it shares shape 1 prefix, so it reads as DIFFERS rather than an unrelated object', () => {
    const [full] = canonicalize({ cons: [UG_FULL_UNIQUE_CON], idxs: [UG_FULL_UNIQUE_IDX] }).identities;
    const [partial] = canonicalize({ idxs: [UG_PARTIAL_MIGRATION] }).identities;
    expect(full.identity).not.toBe(partial.identity);
    // Same kind + table + keySpec; the predicate is the ONLY divergence — the 88.2 D-01 class.
    expect([full.kind, full.table, full.keySpec]).toEqual([partial.kind, partial.table, partial.keySpec]);
    expect(full.predicate).not.toBe(partial.predicate);
  });
});

describe('shape 5 — auto-name divergence with identical semantics (MATCH)', () => {
  test('the migration name and the sync auto-generated name canonicalize identically', () => {
    const a = canonicalize({ idxs: [PROMPTS_MIGRATION] }).identities[0];
    const b = canonicalize({ idxs: [PROMPTS_SYNC] }).identities[0];
    expect(a.displayName).toBe('availability_prompts_created_by_user_idx');
    expect(b.displayName).toBe('availability_prompts_created_by_user_id');
    expect(a.identity).toBe(b.identity);
    expect(a.identity).toBe(PROMPTS_IDENTITY);
  });
});

describe('shape 6 — GIN index (pg_am.amname is part of a non-unique index identity)', () => {
  test('gin and btree over the same column are DIFFERENT identities', () => {
    const gin = canonicalize({ idxs: [SUGGESTION_GIN] }).identities[0];
    const btree = canonicalize({ idxs: [SUGGESTION_BTREE] }).identities[0];
    expect(gin.identity).toBe(SUGGESTION_GIN_IDENTITY);
    expect(btree.identity).toBe(SUGGESTION_BTREE_IDENTITY);
    expect(gin.identity).not.toBe(btree.identity);
  });

  test('the access method is carried on the record and lands in the identity', () => {
    const gin = canonicalize({ idxs: [SUGGESTION_GIN] }).identities[0];
    expect(gin.method).toBe('gin');
    expect(gin.identity).toContain('|gin|');
  });
});

describe('shape 7 — partial unique with a function in the key (expression AND predicate)', () => {
  test('both the expression term and the predicate appear in the identity', () => {
    const [rec] = canonicalize({ idxs: [GROUP_INVITES_PENDING_UNIQUE] }).identities;
    expect(rec.keySpec).toBe('group_id,lower((invited_email)::text)');
    expect(rec.predicate).toBe("((status)::text = 'pending'::text)");
    expect(rec.identity).toContain('lower((invited_email)::text)');
    expect(rec.identity).toContain("'pending'");
    expect(rec.identity).toBe(GROUP_INVITES_IDENTITY);
  });

  test('the plain column keeps its position ahead of the expression slot', () => {
    const [rec] = canonicalize({ idxs: [GROUP_INVITES_PENDING_UNIQUE] }).identities;
    expect(rec.keySpec.startsWith('group_id,')).toBe(true);
  });
});

// =======================================================================================
// The post-key-list clauses: INCLUDE (...) and NULLS NOT DISTINCT.
//
// DELIBERATELY OUTSIDE the SHAPES table above, whose documented contract is that every shape is
// transcribed from a real in-repo migration/model pair. These two are NOT in-repo — nothing under
// `migrations/` emits either clause and Sequelize 6 cannot express either, which is exactly why
// the gap was latent and survived to a code review (88.4-CODE-REVIEW.md #1/#13).
//
// Provenance, so these fixtures are evidence rather than invention: the `full_def` strings and the
// catalog values below are TRANSCRIBED from a live probe run against a throwaway local database
// (PostgreSQL 18.3) during 88.4-08. The rendering was verified for all four combinations —
// INCLUDE alone, NULLS NOT DISTINCT alone, both together, and both together WITH a WHERE
// predicate — confirming that the tail order is `INCLUDE (...)` then `NULLS NOT DISTINCT` then
// `WHERE (...)`, i.e. entirely outside the `USING btree (...)` group parseKeyTerms scans.
//
// WHY THIS IS THE HIGH-VALUE PART: before the promotion, EVERY assertion in this block passed
// while returning the WRONG answer — the two indexes folded onto one identity and the differ
// reported nothing. A silent fold is indistinguishable from a matching schema, so a regression
// here would be invisible in CI output.
describe('post-key-list clauses are identity-bearing (NULLS NOT DISTINCT, INCLUDE)', () => {
  const TAIL_BASE = {
    table_name: 'Tails',
    indisunique: true,
    indnkeyatts: 2,
    key_attnums: [1, 2],
    key_columns: ['a', 'b'],
  };

  const PLAIN = idxRow({
    ...TAIL_BASE,
    index_name: 'i_plain',
    indexrelid: 6001,
    full_def: 'CREATE UNIQUE INDEX i_plain ON public."Tails" USING btree (a, b)',
  });

  const NULLS_NOT_DISTINCT = idxRow({
    ...TAIL_BASE,
    index_name: 'i_nnd',
    indexrelid: 6002,
    nulls_not_distinct: true,
    full_def: 'CREATE UNIQUE INDEX i_nnd ON public."Tails" USING btree (a, b) NULLS NOT DISTINCT',
  });

  const WITH_INCLUDE = idxRow({
    ...TAIL_BASE,
    index_name: 'i_incl',
    indexrelid: 6003,
    included_columns: ['c', 'd'],
    full_def: 'CREATE UNIQUE INDEX i_incl ON public."Tails" USING btree (a, b) INCLUDE (c, d)',
  });

  const OTHER_INCLUDE = idxRow({
    ...WITH_INCLUDE,
    index_name: 'i_incl_c',
    indexrelid: 6004,
    included_columns: ['c'],
    full_def: 'CREATE UNIQUE INDEX i_incl_c ON public."Tails" USING btree (a, b) INCLUDE (c)',
  });

  const one = (idx) => canonicalize({ idxs: [idx] }).identities[0];

  test('all four share the SAME keySpec and predicate — the fold hazard is real, not contrived', () => {
    for (const idx of [PLAIN, NULLS_NOT_DISTINCT, WITH_INCLUDE, OTHER_INCLUDE]) {
      expect(one(idx).keySpec).toBe('a,b');
      expect(one(idx).predicate).toBe('');
    }
  });

  test('a NULLS NOT DISTINCT flip yields a DIFFERENT identity', () => {
    expect(one(NULLS_NOT_DISTINCT).nullsNotDistinct).toBe('NULLS NOT DISTINCT');
    expect(one(PLAIN).nullsNotDistinct).toBe('');
    expect(one(NULLS_NOT_DISTINCT).identity).not.toBe(one(PLAIN).identity);
  });

  test('an INCLUDE payload yields a DIFFERENT identity', () => {
    expect(one(WITH_INCLUDE).includeSpec).toBe('c,d');
    expect(one(PLAIN).includeSpec).toBe('');
    expect(one(WITH_INCLUDE).identity).not.toBe(one(PLAIN).identity);
  });

  test('two DIFFERENT INCLUDE payloads are two identities, not one', () => {
    expect(one(WITH_INCLUDE).identity).not.toBe(one(OTHER_INCLUDE).identity);
  });

  test('the INCLUDE payload does NOT leak into keySpec (indnkeyatts still governs the key list)', () => {
    // If included columns were counted as key terms, keySpecOfIndex's indnkeyatts cross-check
    // would throw instead — so this also pins that the two mechanisms agree.
    expect(() => canonicalize({ idxs: [WITH_INCLUDE] })).not.toThrow();
    expect(one(WITH_INCLUDE).keySpec).not.toContain('c');
  });

  test('a NULLS NOT DISTINCT flip on a table-level UNIQUE also differs (the fold reads the backing index)', () => {
    const con = (oid) =>
      conRow({
        table_name: 'Tails',
        kind: 'u',
        constraint_name: 'Tails_a_b_key',
        backing_index_oid: oid,
        columns: ['a', 'b'],
        definition: 'UNIQUE NULLS NOT DISTINCT (a, b)',
      });
    const distinct = canonicalize({ cons: [con(6001)], idxs: [PLAIN] }).identities[0];
    const notDistinct = canonicalize({ cons: [con(6002)], idxs: [NULLS_NOT_DISTINCT] }).identities[0];
    expect(distinct.kind).toBe('unique');
    expect(notDistinct.nullsNotDistinct).toBe('NULLS NOT DISTINCT');
    expect(distinct.identity).not.toBe(notDistinct.identity);
  });

  test('a non-unique index carries includeSpec too (INCLUDE is not unique-only)', () => {
    const nonUnique = idxRow({
      table_name: 'Tails',
      index_name: 'i_nonu_incl',
      indexrelid: 6005,
      indnkeyatts: 1,
      key_attnums: [1],
      key_columns: ['a'],
      included_columns: ['b'],
      full_def: 'CREATE INDEX i_nonu_incl ON public."Tails" USING btree (a) INCLUDE (b)',
    });
    expect(one(nonUnique).kind).toBe('index');
    expect(one(nonUnique).includeSpec).toBe('b');
  });
});

describe('PK-backing indexes are skipped', () => {
  test('a PK constraint plus its backing index yields exactly one `pk` identity', () => {
    const { identities } = canonicalize({ cons: [USERS_PK_CON], idxs: [USERS_PK_IDX] });
    expect(identities).toHaveLength(1);
    expect(identities[0].kind).toBe('pk');
    expect(identities[0].identity).toBe('pk|Users|id');
    expect(identities.filter((r) => r.kind === 'unique' || r.kind === 'index')).toHaveLength(0);
  });

  test('the skip holds even with no constraint row present (indisprimary alone)', () => {
    const { identities } = canonicalize({ idxs: [USERS_PK_IDX] });
    expect(identities).toHaveLength(0);
  });
});

describe('deterministic ordering (SPEC R4)', () => {
  // Every fixture in the file at once, including a foreign key so the `fk` branch is
  // exercised for ordering too. Distinct OIDs throughout so the unique-fold bookkeeping
  // cannot collide.
  const FK = fkRow({
    child_table: 'UserGroups',
    parent_table: 'Users',
    constraint_name: 'UserGroups_user_uuid_fkey',
    on_delete: 'c',
    child_columns: ['user_uuid'],
    parent_columns: ['id'],
    definition: 'FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE CASCADE',
  });

  const ALL = {
    fks: [FK],
    cons: [UG_FULL_UNIQUE_CON, USERS_PK_CON],
    idxs: [
      UG_PARTIAL_MIGRATION,
      UG_PARTIAL_SYNC_AUTONAME,
      FRIENDSHIPS_PAIR_UNIQUE,
      UG_FULL_UNIQUE_IDX,
      PROMPTS_MIGRATION,
      SUGGESTION_GIN,
      GROUP_INVITES_PENDING_UNIQUE,
      USERS_PK_IDX,
    ],
    tables: [
      { table_name: 'UserGroups' },
      { table_name: 'Users' },
      { table_name: 'Friendships' },
      { table_name: 'AvailabilityPrompts' },
      { table_name: 'AvailabilitySuggestions' },
      { table_name: 'GroupInvites' },
    ],
  };

  // Seeded Fisher-Yates: a real permutation, but a FIXED one, so a failure here is
  // reproducible rather than a flake. (A closed-form `j = (i*7+3) % n` swap loop is not
  // usable — for n=8 it is an involution and returns the array unchanged.) The Lehmer
  // multiplier keeps every intermediate under 2^53, so the sequence is exact integer
  // arithmetic on any platform.
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

  const SHUFFLED = {
    fks: shuffle(ALL.fks),
    cons: shuffle(ALL.cons),
    idxs: shuffle(ALL.idxs),
    tables: shuffle(ALL.tables),
  };

  test('shuffled input yields a deeply-identical identities array', () => {
    expect(SHUFFLED.idxs.map((i) => i.index_name)).not.toEqual(ALL.idxs.map((i) => i.index_name));
    expect(canonicalize(SHUFFLED).identities).toEqual(canonicalize(ALL).identities);
  });

  test('identities are sorted ascending by identity string', () => {
    const strings = canonicalize(ALL).identities.map((r) => r.identity);
    expect(strings).toEqual([...strings].sort());
  });

  test('the table inventory is sorted, de-duplicated, and shuffle-independent', () => {
    const { tables } = canonicalize(ALL);
    expect(tables).toEqual([...tables].sort());
    expect(canonicalize(SHUFFLED).tables).toEqual(tables);
  });
});
