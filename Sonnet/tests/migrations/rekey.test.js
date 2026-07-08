// tests/migrations/rekey.test.js
//
// Phase 87.1 (BINT-02, Part B) — MIGRATION VERIFICATION HARNESS (A4, net-new).
//
// Proves the 7 UUID re-key EXPAND migrations (20260703000001..07) on CI Postgres:
//   (a) backfill — matched rows get *_uuid = the correct Users.id
//   (b) orphan disposition — CASCADE tables DELETE unmatched rows (logged count);
//       GroupInvite (SET NULL) leaves the FK NULL and KEEPS the row; Friendship
//       deletes a row where EITHER endpoint is unmatched
//   (c) idempotency — a second `up` throws nothing and does not double-apply
//
// WHY THIS NEEDS A "PRE-MIGRATION" SCHEMA (legacy-provisioning spec):
//   The test DB is built ONCE by tests/globalSetup.js via sync({force:true}) from the
//   MODELS. Phase 87.1 Plan 09 REMOVED the old Auth0-string columns from those models, so
//   the sync-built schema now has ONLY the *_uuid columns + FKs (the POST-migration shape)
//   and NO old string columns at all. To exercise a real migration, each scenario must
//   provision TRUE pre-migration shape ITSELF — it may NOT rely on the model-derived
//   schema for any pre-migration column:
//     1. run the migration's own `down(queryInterface)`, which DROPs the *_uuid column
//        (Postgres auto-drops the sync-built FK + uuid indexes that depend on it);
//     2. provisionLegacyColumns() then ADDs the old Auth0-string column(s) back via raw
//        SQL — because Plan 09 deleted them from the model, sync() no longer builds them,
//        so WITHOUT this step the raw seed INSERT (and the migration's own backfill UPDATE
//        + DROP NOT NULL, which reference the old column) would throw "column does not
//        exist" and the authoritative backfill/orphan/idempotency proof would go red.
//   The two steps together yield TRUE pre-migration shape: old string column(s) present,
//   *_uuid column ABSENT. Because down() dropped *_uuid, the migration's guarded ADD COLUMN
//   + backfill path DEMONSTRABLY EXECUTES on `up` (it does not short-circuit on an
//   already-present *_uuid). Rows are seeded via RAW INSERT on the old string columns (the
//   Sequelize model can't be used — it would emit the now-absent *_uuid column). Parent
//   rows (Users/Groups/Events/Games/BallotOptions) are created via models since their
//   schema is untouched. Finally `up` runs and we assert against the real backfill/orphan
//   logic. Running `up` twice restores the baseline (uuid column present) for later files.
//
// AUTHORITY: CI Postgres is the authoritative gate. The local sandbox DB is unreachable
//   (route/DB suites time out in beforeAll on sequelize.authenticate()), so this file is
//   validated statically locally and RUN on CI. Run it ALONE (schema mutation is inherent):
//   npm test -- tests/migrations/rekey.test.js --forceExit --testTimeout=25000
//
// NOTE: tests/setup.js runs truncateAll in beforeEach, so every scenario is fully
//   self-contained within a single `it` (seed → up → assert, no beforeEach in between).

const crypto = require('crypto');
const { QueryTypes } = require('sequelize');
const {
  sequelize,
  User,
  Group,
  Game,
  Event,
  EventBallotOption,
  UserGroup,
  EventRsvp,
  EventBring,
  EventBallotVote,
  SentNotification,
  GroupInvite,
  Friendship,
} = require('../../models');

const migrations = {
  usergroup: require('../../migrations/20260703000001-rekey-usergroup-user-uuid.js'),
  friendship: require('../../migrations/20260703000002-rekey-friendship-uuid.js'),
  groupinvite: require('../../migrations/20260703000003-rekey-groupinvite-invited-by-uuid.js'),
  eventrsvp: require('../../migrations/20260703000004-rekey-eventrsvp-user-uuid.js'),
  eventbring: require('../../migrations/20260703000005-rekey-eventbring-user-uuid.js'),
  eventballotvote: require('../../migrations/20260703000006-rekey-eventballotvote-user-uuid.js'),
  sentnotification: require('../../migrations/20260703000007-rekey-sentnotification-user-uuid.js'),
};

const uuid = () => crypto.randomUUID();
const qi = () => sequelize.getQueryInterface();

// --- low-level helpers -------------------------------------------------------

/**
 * Provision the pre-migration legacy Auth0-string column(s) that Plan 09 removed from the
 * models. The sync()-built schema no longer has them, so after the migration's down() drops
 * the *_uuid column (+FK+indexes) we ADD the old string column(s) back here to reach TRUE
 * pre-migration shape. Nullable VARCHAR is sufficient — the harness raw-seeds the Auth0
 * strings and the migration's backfill/DROP-NOT-NULL steps only need the column to EXIST.
 */
async function provisionLegacyColumns(table, columns) {
  for (const col of columns) {
    await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" VARCHAR`);
  }
}

/** Raw INSERT (bypasses the model so we can seed pre-migration string-only rows). */
async function insertRow(table, cols) {
  const keys = Object.keys(cols);
  const colList = keys.map((k) => `"${k}"`).join(', ');
  const valList = keys.map((k) => `:${k}`).join(', ');
  const rows = await sequelize.query(
    `INSERT INTO "${table}" (${colList}) VALUES (${valList}) RETURNING id`,
    { replacements: cols, type: QueryTypes.SELECT }
  );
  return rows[0].id;
}

async function selectOne(sql, replacements) {
  const rows = await sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
  return rows[0];
}

async function rowCount(table, id) {
  const r = await selectOne(`SELECT COUNT(*)::int AS n FROM "${table}" WHERE id = :id`, { id });
  return r.n;
}

/**
 * Read a column's nullability from information_schema. Used to PROVE the expand
 * migrations leave the new *_uuid columns NULLABLE post-up() — the DB-level
 * SET NOT NULL is deliberately deferred to the D-08 follow-up migration (F1).
 */
async function columnIsNullable(table, col) {
  const r = await selectOne(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name = :table AND column_name = :col`,
    { table, col }
  );
  return r ? r.is_nullable === 'YES' : null;
}

/** Capture console.log emitted while `fn` runs so we can assert on the migration's counts. */
async function withLogCapture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

const deletedCount = (lines) => {
  const line = lines.find((l) => /orphaned rows deleted:/.test(l));
  if (!line) return null;
  return Number((line.match(/orphaned rows deleted:\s*(\d+)/) || [])[1]);
};

// --- parent fixtures (schema untouched by the child migration's down) --------

const aUser = () => {
  const s = uuid();
  return User.create({ user_id: `auth0|${s}`, username: `u-${s}`, email: `u-${s}@example.com` });
};
const aGroup = () => {
  const s = uuid();
  return Group.create({ group_id: `g-${s}`, name: `G ${s}` });
};
const aGame = () => Game.create({ name: `Game ${uuid()}` });
const anEvent = (group) => Event.create({ group_id: group.id, start_date: new Date() });
const aBallotOption = (event) => EventBallotOption.create({ event_id: event.id, game_name: `opt-${uuid()}` });

const now = () => new Date();
const orphanKey = () => `auth0|orphan-${uuid()}`; // no matching Users row

// -----------------------------------------------------------------------------
// Shared CASCADE scenario: one matched row backfills, one orphan row is DELETEd,
// second `up` is a no-op. Used by the 5 single-user CASCADE tables.
// -----------------------------------------------------------------------------
async function runCascadeScenario({ migration, table, uuidCol, matchedUser, seedMatched, seedOrphan, legacyCols = ['user_id'] }) {
  await migration.down(qi()); // drop the *_uuid column + its FK + uuid indexes
  await provisionLegacyColumns(table, legacyCols); // re-add the Plan-09-removed old string col(s)

  const matchedId = await seedMatched();
  const orphanId = await seedOrphan();

  const logs = await withLogCapture(() => migration.up(qi()));

  // (a) backfill
  const m = await selectOne(`SELECT "${uuidCol}" AS v FROM "${table}" WHERE id = :id`, { id: matchedId });
  expect(m.v).toBe(matchedUser.id);
  // (a2) *_uuid stays NULLABLE post-up() — DB-level SET NOT NULL ships in D-08 (F1).
  expect(await columnIsNullable(table, uuidCol)).toBe(true);
  // (b) orphan DELETEd + logged count matches
  expect(await rowCount(table, orphanId)).toBe(0);
  expect(deletedCount(logs)).toBe(1);

  // (c) idempotent second up — no throw, matched row unchanged, nothing new deleted
  const logs2 = await withLogCapture(() => migration.up(qi()));
  const m2 = await selectOne(`SELECT "${uuidCol}" AS v FROM "${table}" WHERE id = :id`, { id: matchedId });
  expect(m2.v).toBe(matchedUser.id);
  expect(deletedCount(logs2)).toBe(0);
}

// =============================================================================

describe('Phase 87.1 UUID re-key migrations — backfill / orphan / idempotency', () => {
  describe('UserGroups (D-01, CASCADE)', () => {
    it('backfills user_uuid, deletes orphan membership, idempotent', async () => {
      const user = await aUser();
      const group = await aGroup();
      const orphanGroup = await aGroup();
      await runCascadeScenario({
        migration: migrations.usergroup,
        table: 'UserGroups',
        uuidCol: 'user_uuid',
        matchedUser: user,
        seedMatched: () => insertRow('UserGroups', {
          id: uuid(), user_id: user.user_id, group_id: group.id,
          role: 'member', status: 'active', joined_at: now(), createdAt: now(), updatedAt: now(),
        }),
        seedOrphan: () => insertRow('UserGroups', {
          id: uuid(), user_id: orphanKey(), group_id: orphanGroup.id,
          role: 'member', status: 'active', joined_at: now(), createdAt: now(), updatedAt: now(),
        }),
      });
    });
  });

  describe('EventRsvps (D-02, CASCADE)', () => {
    it('backfills user_uuid, deletes orphan RSVP, idempotent', async () => {
      const user = await aUser();
      const group = await aGroup();
      const event = await anEvent(group);
      await runCascadeScenario({
        migration: migrations.eventrsvp,
        table: 'EventRsvps',
        uuidCol: 'user_uuid',
        matchedUser: user,
        seedMatched: () => insertRow('EventRsvps', {
          id: uuid(), event_id: event.id, user_id: user.user_id, status: 'yes',
          createdAt: now(), updatedAt: now(),
        }),
        seedOrphan: () => insertRow('EventRsvps', {
          id: uuid(), event_id: event.id, user_id: orphanKey(), status: 'no',
          createdAt: now(), updatedAt: now(),
        }),
      });
    });
  });

  describe('EventBrings (D-02, CASCADE)', () => {
    it('backfills user_uuid, deletes orphan bring, idempotent', async () => {
      const user = await aUser();
      const group = await aGroup();
      const event = await anEvent(group);
      const game = await aGame();
      await runCascadeScenario({
        migration: migrations.eventbring,
        table: 'EventBrings',
        uuidCol: 'user_uuid',
        matchedUser: user,
        seedMatched: () => insertRow('EventBrings', {
          id: uuid(), event_id: event.id, user_id: user.user_id, game_id: game.id,
          createdAt: now(), updatedAt: now(),
        }),
        seedOrphan: () => insertRow('EventBrings', {
          id: uuid(), event_id: event.id, user_id: orphanKey(), game_id: game.id,
          createdAt: now(), updatedAt: now(),
        }),
      });
    });
  });

  describe('EventBallotVotes (D-02, CASCADE)', () => {
    it('backfills user_uuid, deletes orphan vote, idempotent', async () => {
      const user = await aUser();
      const group = await aGroup();
      const event = await anEvent(group);
      const option = await aBallotOption(event);
      await runCascadeScenario({
        migration: migrations.eventballotvote,
        table: 'EventBallotVotes',
        uuidCol: 'user_uuid',
        matchedUser: user,
        seedMatched: () => insertRow('EventBallotVotes', {
          id: uuid(), option_id: option.id, user_id: user.user_id,
          createdAt: now(), updatedAt: now(),
        }),
        seedOrphan: () => insertRow('EventBallotVotes', {
          id: uuid(), option_id: option.id, user_id: orphanKey(),
          createdAt: now(), updatedAt: now(),
        }),
      });
    });
  });

  describe('SentNotifications (D-03, CASCADE)', () => {
    it('backfills user_uuid, deletes orphan notification, idempotent', async () => {
      const user = await aUser();
      const group = await aGroup();
      const event = await anEvent(group);
      await runCascadeScenario({
        migration: migrations.sentnotification,
        table: 'SentNotifications',
        uuidCol: 'user_uuid',
        matchedUser: user,
        // SentNotification has timestamps:false — no createdAt/updatedAt columns.
        seedMatched: () => insertRow('SentNotifications', {
          id: uuid(), user_id: user.user_id, event_id: event.id,
          phone: '+15555550101', channel: 'sms', notification_type: 'event_created', sent_at: now(),
        }),
        seedOrphan: () => insertRow('SentNotifications', {
          id: uuid(), user_id: orphanKey(), event_id: event.id,
          phone: '+15555550102', channel: 'sms', notification_type: 'event_created', sent_at: now(),
        }),
      });
    });
  });

  describe('GroupInvites (D-04, SET NULL)', () => {
    it('backfills invited_by_uuid, leaves orphan NULL (NOT deleted), idempotent', async () => {
      const migration = migrations.groupinvite;
      const inviter = await aUser();
      const group = await aGroup();

      await migration.down(qi()); // drop invited_by_uuid + its FK
      await provisionLegacyColumns('GroupInvites', ['invited_by']); // re-add Plan-09-removed old col

      const matchedId = await insertRow('GroupInvites', {
        id: uuid(), group_id: group.id, invited_email: `m-${uuid()}@example.com`,
        invited_by: inviter.user_id, token: `tok-${uuid()}`, status: 'pending',
        createdAt: now(), updatedAt: now(),
      });
      const orphanId = await insertRow('GroupInvites', {
        id: uuid(), group_id: group.id, invited_email: `o-${uuid()}@example.com`,
        invited_by: orphanKey(), token: `tok-${uuid()}`, status: 'pending',
        createdAt: now(), updatedAt: now(),
      });

      await migration.up(qi());

      // matched backfilled
      const m = await selectOne('SELECT invited_by_uuid AS v FROM "GroupInvites" WHERE id = :id', { id: matchedId });
      expect(m.v).toBe(inviter.id);
      // orphan: NULL FK, row PRESERVED (SET NULL disposition — no delete)
      const o = await selectOne('SELECT invited_by_uuid AS v FROM "GroupInvites" WHERE id = :id', { id: orphanId });
      expect(o.v).toBeNull();
      expect(await rowCount('GroupInvites', orphanId)).toBe(1);

      // idempotent: second up throws nothing, matched unchanged, orphan still NULL + present
      await expect(migration.up(qi())).resolves.not.toThrow();
      const m2 = await selectOne('SELECT invited_by_uuid AS v FROM "GroupInvites" WHERE id = :id', { id: matchedId });
      expect(m2.v).toBe(inviter.id);
      expect(await rowCount('GroupInvites', orphanId)).toBe(1);
    });
  });

  describe('Friendships (D-05, CASCADE on BOTH endpoints)', () => {
    it('backfills both uuids, deletes either-endpoint-orphan pair, idempotent', async () => {
      const migration = migrations.friendship;
      const requester = await aUser();
      const addressee = await aUser();
      const realThird = await aUser();

      await migration.down(qi()); // drop requester_uuid/addressee_uuid + FKs + functional index
      await provisionLegacyColumns('Friendships', ['requester_id', 'addressee_id']); // re-add old cols

      // matched pair — both endpoints resolve
      const matchedId = await insertRow('Friendships', {
        id: uuid(), requester_id: requester.user_id, addressee_id: addressee.user_id,
        status: 'pending', createdAt: now(), updatedAt: now(),
      });
      // orphan-either — requester real, addressee unmatched → whole row must be deleted
      const orphanId = await insertRow('Friendships', {
        id: uuid(), requester_id: realThird.user_id, addressee_id: orphanKey(),
        status: 'pending', createdAt: now(), updatedAt: now(),
      });

      const logs = await withLogCapture(() => migration.up(qi()));

      // matched: both uuids backfilled
      const m = await selectOne(
        'SELECT requester_uuid AS req, addressee_uuid AS addr FROM "Friendships" WHERE id = :id',
        { id: matchedId }
      );
      expect(m.req).toBe(requester.id);
      expect(m.addr).toBe(addressee.id);
      // both *_uuid columns stay NULLABLE post-up() — DB-level SET NOT NULL ships in D-08 (F1).
      expect(await columnIsNullable('Friendships', 'requester_uuid')).toBe(true);
      expect(await columnIsNullable('Friendships', 'addressee_uuid')).toBe(true);
      // orphan-either: deleted, logged count matches
      expect(await rowCount('Friendships', orphanId)).toBe(0);
      expect(deletedCount(logs)).toBe(1);

      // idempotent second up
      const logs2 = await withLogCapture(() => migration.up(qi()));
      const m2 = await selectOne(
        'SELECT requester_uuid AS req, addressee_uuid AS addr FROM "Friendships" WHERE id = :id',
        { id: matchedId }
      );
      expect(m2.req).toBe(requester.id);
      expect(m2.addr).toBe(addressee.id);
      expect(deletedCount(logs2)).toBe(0);
    });
  });
});

// =============================================================================
// Cross-cutting integrity: UUID unique-index enforcement + CASCADE backstop (D-06).
//
// These run AFTER the migration-replay describe above, which is LOAD-BEARING for the
// Friendship functional-pair assertion: the LEAST/GREATEST unique index
// (`friendships_pair_unique_uuid`) is created ONLY by the friendship migration's up()
// (it is NOT a model/sync index), and the Friendship scenario above runs that up().
// The 4 composite unique indexes ARE model/sync-built. tests/setup.js truncates ROWS
// (not schema) per-test, so every constraint/index persists across these tests; each
// test seeds fresh via the models (writing *_uuid only — the Plan 09 shape).
// =============================================================================
describe('Phase 87.1 UUID integrity — unique-index enforcement + CASCADE backstop', () => {
  describe('duplicate-insert rejected per UUID unique index (T-87.1-12)', () => {
    it('UserGroup (user_uuid, group_id) rejects a duplicate membership', async () => {
      const user = await aUser();
      const group = await aGroup();
      await UserGroup.create({ user_uuid: user.id, group_id: group.id, role: 'member', status: 'active' });
      await expect(
        UserGroup.create({ user_uuid: user.id, group_id: group.id, role: 'member', status: 'active' })
      ).rejects.toThrow();
    });

    it('EventRsvp (event_id, user_uuid) rejects a duplicate RSVP', async () => {
      const user = await aUser();
      const event = await anEvent(await aGroup());
      await EventRsvp.create({ event_id: event.id, user_uuid: user.id, status: 'yes' });
      await expect(
        EventRsvp.create({ event_id: event.id, user_uuid: user.id, status: 'no' })
      ).rejects.toThrow();
    });

    it('EventBallotVote (option_id, user_uuid) rejects a duplicate vote', async () => {
      const user = await aUser();
      const event = await anEvent(await aGroup());
      const option = await aBallotOption(event);
      await EventBallotVote.create({ option_id: option.id, user_uuid: user.id });
      await expect(
        EventBallotVote.create({ option_id: option.id, user_uuid: user.id })
      ).rejects.toThrow();
    });

    it('EventBring (event_id, user_uuid, game_id) rejects a duplicate bring', async () => {
      const user = await aUser();
      const event = await anEvent(await aGroup());
      const game = await aGame();
      await EventBring.create({ event_id: event.id, user_uuid: user.id, game_id: game.id });
      await expect(
        EventBring.create({ event_id: event.id, user_uuid: user.id, game_id: game.id })
      ).rejects.toThrow();
    });

    it('Friendship LEAST/GREATEST functional pair rejects a REVERSED-endpoint duplicate', async () => {
      // The pair (A,B) and (B,A) collapse to the same LEAST/GREATEST canonical key,
      // so the reversed insert must violate friendships_pair_unique_uuid.
      const a = await aUser();
      const b = await aUser();
      await Friendship.create({ requester_uuid: a.id, addressee_uuid: b.id, status: 'pending' });
      await expect(
        Friendship.create({ requester_uuid: b.id, addressee_uuid: a.id, status: 'pending' })
      ).rejects.toThrow();
    });
  });

  describe('CASCADE integrity on a Users-row delete (D-06 backstop)', () => {
    it('deletes the 6 CASCADE tables\' child rows and NULLs GroupInvite.invited_by_uuid', async () => {
      const user = await aUser();
      const group = await aGroup();
      const event = await anEvent(group);
      const game = await aGame();
      const option = await aBallotOption(event);
      const friend = await aUser();

      // Seed one child row in each of the 6 CASCADE tables tied to `user`.
      await UserGroup.create({ user_uuid: user.id, group_id: group.id, role: 'member', status: 'active' });
      await EventRsvp.create({ event_id: event.id, user_uuid: user.id, status: 'yes' });
      await EventBring.create({ event_id: event.id, user_uuid: user.id, game_id: game.id });
      await EventBallotVote.create({ option_id: option.id, user_uuid: user.id });
      await SentNotification.create({
        user_uuid: user.id, event_id: event.id, phone: '+15555559001',
        channel: 'sms', notification_type: 'event_created', sent_at: now(),
      });
      await Friendship.create({ requester_uuid: user.id, addressee_uuid: friend.id, status: 'accepted' });

      // GroupInvite references `user` via the NULLABLE invited_by_uuid (D-04, SET NULL).
      const invite = await GroupInvite.create({
        group_id: group.id, invited_email: `cascade-${uuid()}@example.com`,
        invited_by_uuid: user.id, token: `tok-${uuid()}`, status: 'pending',
      });

      // Delete the parent Users row — Postgres FKs fire ON DELETE CASCADE / SET NULL.
      await user.destroy();

      // The 6 CASCADE tables' rows are gone.
      expect(await UserGroup.count({ where: { user_uuid: user.id } })).toBe(0);
      expect(await EventRsvp.count({ where: { user_uuid: user.id } })).toBe(0);
      expect(await EventBring.count({ where: { user_uuid: user.id } })).toBe(0);
      expect(await EventBallotVote.count({ where: { user_uuid: user.id } })).toBe(0);
      expect(await SentNotification.count({ where: { user_uuid: user.id } })).toBe(0);
      expect(await Friendship.count({ where: { requester_uuid: user.id } })).toBe(0);

      // GroupInvite row is PRESERVED with invited_by_uuid SET NULL (a pending invite
      // outlives its inviter's account).
      const inviteAfter = await GroupInvite.findByPk(invite.id);
      expect(inviteAfter).not.toBeNull();
      expect(inviteAfter.invited_by_uuid).toBeNull();
    });
  });
});
