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
//   MODELS — which already declare the *_uuid columns + FKs. So a naive `up` would find
//   everything present and backfill nothing. To exercise a real migration, each scenario
//   first runs the migration's own `down(queryInterface)`, which DROPs the *_uuid column
//   (Postgres auto-drops the sync-built FK + uuid indexes that depend on it). That returns
//   the table to its TRUE pre-migration shape: old Auth0-string column(s) present, no
//   *_uuid column. Rows are then seeded via RAW INSERT on the old string columns (the
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
async function runCascadeScenario({ migration, table, uuidCol, matchedUser, seedMatched, seedOrphan }) {
  await migration.down(qi()); // establish pre-migration schema

  const matchedId = await seedMatched();
  const orphanId = await seedOrphan();

  const logs = await withLogCapture(() => migration.up(qi()));

  // (a) backfill
  const m = await selectOne(`SELECT "${uuidCol}" AS v FROM "${table}" WHERE id = :id`, { id: matchedId });
  expect(m.v).toBe(matchedUser.id);
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

      await migration.down(qi());

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

      await migration.down(qi());

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
