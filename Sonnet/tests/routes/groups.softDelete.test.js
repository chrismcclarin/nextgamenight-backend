// tests/routes/groups.softDelete.test.js
//
// Phase 88.2 Plan 01 (SPEC-REQ-1 / SPEC-REQ-3, D-01) — prove that soft-delete is a
// CENTRAL filter, not a per-call-site one.
//
// SPEC-REQ-3 rejects any design where a missed call site can leak a deleted group.
// The mechanism is Sequelize `paranoid` on exactly three models (Group, UserGroup,
// Event). This suite pins the three things that could silently break it:
//
//   1) SCOPE COMPOSITION — `Group.scope('withInviteToken')` does NOT bypass the
//      paranoid clause. This is the whole reason `paranoid` was chosen over a
//      hand-written where-based default scope: a named scope REPLACES a where-based
//      default scope, but `_paranoidClause` is applied independently of scopes.
//   2) BSEC-01 / BE-043 NON-REGRESSION — the invite_token hide/opt-in pair still
//      behaves exactly as before for a LIVE group.
//   3) THE CARVE-OUT PRIMITIVE — `{ paranoid: false }` is what the restore preview,
//      the accept-ownership handler and the purge sweep will use to read a
//      soft-deleted row. If it stops working, those plans have no escape hatch.
//
// STAMPING DISCIPLINE — deliberate: this suite marks rows deleted with
// `Model.update({ deletedAt }, { silent: true })`, NOT `.destroy()`. `destroy()`
// calls `Utils.now()` once per call, so three destroys produce three DIFFERENT
// millisecond timestamps and a group + its memberships + its events could not be
// restored as one unit by a `deletedAt` match (88.2-RESEARCH.md F-05). Plan 06 owns
// the real single-timestamp stamping path; this suite must not encode a discipline
// that contradicts it. `silent: true` additionally suppresses the `updatedAt` bump.

const request = require('supertest');
const express = require('express');
const groupRoutes = require('../../routes/groups');
const { Group, User, UserGroup, Event } = require('../../models');
const { getUserRoleInGroup } = require('../../services/authorizationService');
const { makeUser, makeGroup, addToGroup } = require('../factories');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Harness mirrors tests/routes/groups.invite.test.js: inject req.user ahead of the
// router (the router is mounted with NO real Auth0 middleware, so without this every
// handler short-circuits at 401).
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/groups', groupRoutes);

/** Stamp a group soft-deleted. See STAMPING DISCIPLINE in the header. */
async function stampGroup(groupId, deletedAt = new Date(), purgeAfter = undefined) {
  const values = { deletedAt };
  if (purgeAfter !== undefined) values.purge_after = purgeAfter;
  await Group.update(values, { where: { id: groupId }, silent: true });
}

describe('Phase 88.2 — paranoid soft-delete is the central hide filter', () => {
  let owner;
  let group;

  // Schema is built once by tests/globalSetup.js; the global beforeEach TRUNCATEs
  // every table, so all fixtures are seeded per-test.
  beforeEach(async () => {
    owner = await makeUser({ username: 'softdelete-owner' });
    group = await makeGroup({ name: 'Soft Delete Test Group' });
    await addToGroup(owner, group, 'owner');
    currentActor = owner.user_id;
  });

  describe('SPEC-REQ-3a — a soft-deleted group is absent from default reads', () => {
    it('Group.findByPk returns null for a stamped group, and { paranoid: false } returns it', async () => {
      const before = await Group.findByPk(group.id);
      expect(before).not.toBeNull();

      await stampGroup(group.id);

      expect(await Group.findByPk(group.id)).toBeNull();

      // THE CARVE-OUT PRIMITIVE. The restore preview, the accept-ownership handler
      // and the purge sweep all depend on this reading the row back.
      const carveOut = await Group.findByPk(group.id, { paranoid: false });
      expect(carveOut).not.toBeNull();
      expect(carveOut.deletedAt).toBeInstanceOf(Date);
    });

    it('Group.scope("withInviteToken") ALSO returns null — the scope does not bypass the paranoid filter', async () => {
      await stampGroup(group.id);

      // This is the assertion the whole D-01 decision rests on. A hand-written
      // `defaultScope: { where: { deletedAt: null } }` would be REPLACED by this
      // named scope and this would return the row — reopening the BE-043 leak on
      // every invite-token read path.
      expect(await Group.scope('withInviteToken').findByPk(group.id)).toBeNull();
    });

    it('Group.count() excludes a stamped group — the aggregate path is paranoid-filtered too', async () => {
      const before = await Group.count();
      expect(before).toBe(1);

      await stampGroup(group.id);

      expect(await Group.count()).toBe(0);
      expect(await Group.count({ paranoid: false })).toBe(1);
    });
  });

  describe('SPEC-REQ-3b — BSEC-01 / BE-043 non-regression on a LIVE group', () => {
    it('a default read hides invite_token and the scoped read returns the real token', async () => {
      // Generate a token through the real lazy-generate endpoint (same approach as
      // tests/routes/groups.invite.test.js).
      const res = await request(app)
        .get(`/api/groups/${group.id}/invite-token`)
        .expect(200);
      expect(res.body.invite_token).toBeTruthy();

      const plain = await Group.findByPk(group.id);
      expect(plain).not.toBeNull();
      expect(plain.invite_token).toBeUndefined();
      expect(plain.toJSON()).not.toHaveProperty('invite_token');

      const scoped = await Group.scope('withInviteToken').findByPk(group.id);
      expect(scoped).not.toBeNull();
      expect(typeof scoped.invite_token).toBe('string');
      expect(scoped.invite_token).toBe(res.body.invite_token);
    });
  });

  describe('SPEC-REQ-1 / SPEC-REQ-9 — Groups.purge_after schema pin', () => {
    it('purge_after exists as a model attribute', () => {
      expect(Group.rawAttributes.purge_after).toBeDefined();
      expect(Group.rawAttributes.purge_after.allowNull).toBe(true);
    });

    it('deletedAt and purge_after round-trip together, readable via { paranoid: false }', async () => {
      const deletedAt = new Date('2026-07-26T12:00:00.000Z');
      const purgeAfter = new Date(deletedAt.getTime() + THIRTY_DAYS_MS);

      await stampGroup(group.id, deletedAt, purgeAfter);

      const row = await Group.findByPk(group.id, { paranoid: false });
      expect(row).not.toBeNull();
      expect(row.deletedAt.toISOString()).toBe(deletedAt.toISOString());
      expect(row.purge_after.toISOString()).toBe(purgeAfter.toISOString());
      expect(row.purge_after.getTime() - row.deletedAt.getTime()).toBe(THIRTY_DAYS_MS);

      // A live group carries no purge_after.
      const live = await makeGroup();
      expect((await Group.findByPk(live.id)).purge_after).toBeNull();
    });
  });

  describe('D-01 choke point — a stamped UserGroup row revokes the role', () => {
    it('UserGroup.findOne returns null and getUserRoleInGroup consequently returns null', async () => {
      expect(await getUserRoleInGroup(owner.user_id, group.id)).toBe('owner');

      await UserGroup.update(
        { deletedAt: new Date() },
        { where: { user_uuid: owner.id, group_id: group.id }, silent: true }
      );

      expect(
        await UserGroup.findOne({ where: { user_uuid: owner.id, group_id: group.id } })
      ).toBeNull();

      // getUserRoleInGroup (services/authorizationService.js:35-46) funnels
      // isOwner / isActiveMember / isMemberOrHigher / isOwnerOrAdmin, so a stamped
      // membership row revokes all of them at once.
      expect(await getUserRoleInGroup(owner.user_id, group.id)).toBeNull();

      // ...and the row is still there for the restore path to bring back.
      const carveOut = await UserGroup.findOne({
        where: { user_uuid: owner.id, group_id: group.id },
        paranoid: false,
      });
      expect(carveOut).not.toBeNull();
      expect(carveOut.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('D-01 — a stamped Event disappears from group reads', () => {
    it('Event.findAll for the group returns zero rows once the events are stamped', async () => {
      await Event.create({
        group_id: group.id,
        start_date: new Date('2026-08-01T18:00:00.000Z'),
        status: 'scheduled',
      });
      await Event.create({
        group_id: group.id,
        start_date: new Date('2026-08-08T18:00:00.000Z'),
        status: 'scheduled',
      });

      expect(await Event.count({ where: { group_id: group.id } })).toBe(2);

      await Event.update(
        { deletedAt: new Date() },
        { where: { group_id: group.id }, silent: true }
      );

      expect(await Event.findAll({ where: { group_id: group.id } })).toHaveLength(0);
      expect(
        await Event.findAll({ where: { group_id: group.id }, paranoid: false })
      ).toHaveLength(2);
    });
  });

  describe('the carve-out is exactly three models — no more, no fewer', () => {
    it('Group, UserGroup and Event are paranoid', () => {
      expect(Group.options.paranoid).toBe(true);
      expect(UserGroup.options.paranoid).toBe(true);
      expect(Event.options.paranoid).toBe(true);
    });

    it('User is NOT paranoid (guards against paranoid creeping model-wide)', () => {
      expect(Boolean(User.options.paranoid)).toBe(false);
    });
  });
});
