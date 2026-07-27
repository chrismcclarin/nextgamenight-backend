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
const { Group, User, UserGroup, Event, SingleUseToken } = require('../../models');
const { getUserRoleInGroup } = require('../../services/authorizationService');
const {
  softDeleteGroup,
  RECOVERY_WINDOW_DAYS,
  TOKEN_EXPIRY_MARGIN_MS,
  GroupAlreadyDeletedError,
} = require('../../services/groupRecoveryService');
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

  // ---------------------------------------------------------------------------
  // Plan 88.2-06 Task 1 — services/groupRecoveryService.softDeleteGroup
  //
  // Service-level contract. The endpoint-level assertions (six-table counts, the
  // stamp equality across three models, the dispatch wiring) live in the plan-06
  // Task 2 block below.
  // ---------------------------------------------------------------------------
  describe('softDeleteGroup — the service contract', () => {
    /**
     * Undo a soft delete by clearing the stamps directly. `restoreGroupByToken` is
     * plan 07 (wave 4) and does not exist yet, so a re-delete scenario in wave 3
     * has to reset the rows by hand.
     */
    async function clearStamps(groupId) {
      await Group.update(
        { deletedAt: null, purge_after: null },
        { where: { id: groupId }, paranoid: false, silent: true }
      );
      await UserGroup.update(
        { deletedAt: null },
        { where: { group_id: groupId }, paranoid: false, silent: true }
      );
      await Event.update(
        { deletedAt: null },
        { where: { group_id: groupId }, paranoid: false, silent: true }
      );
    }

    it('every recipient carries the Auth0 sub in user_id ALONGSIDE the Users.id UUID', async () => {
      const memberA = await makeUser({ username: 'roster-member-a' });
      const memberB = await makeUser({ username: 'roster-member-b' });
      await addToGroup(memberA, group, 'member');
      await addToGroup(memberB, group, 'admin');

      const { recipients } = await softDeleteGroup(group.id, { excludeUserUuid: owner.id });

      // Asserted on the RETURNED array, not on the mapping source — checking the
      // source is exactly what would pass with the field missing.
      expect(recipients).toHaveLength(2);
      const byUuid = new Map(recipients.map((r) => [r.user_uuid, r]));
      for (const seeded of [memberA, memberB]) {
        const r = byUuid.get(seeded.id);
        expect(r).toBeDefined();
        // The dispatcher's Auth0 Management API backfill keys on the SUB, not the
        // UUID. Omitting it fails silently: getUserById(undefined) rejects, the
        // backfill catch degrades as designed, and every synthetic-address member
        // is counted unreachable with plausible-looking counters and no error.
        expect(typeof r.user_id).toBe('string');
        expect(r.user_id).not.toBe(r.user_uuid);
        expect(r.user_id).toBe(seeded.user_id);
        // The include uses the contact-info scope; the default scope strips email.
        expect(r.email).toBe(seeded.email);
        expect(r.username).toBe(seeded.username);
      }

      // SPEC-REQ-8: the deleting owner is never offered their own group back.
      expect(recipients.some((r) => r.user_uuid === owner.id)).toBe(false);
    });

    it('the roster survives the stamping — it is read BEFORE the transaction', async () => {
      const member = await makeUser({ username: 'roster-survivor' });
      await addToGroup(member, group, 'member');

      const { recipients } = await softDeleteGroup(group.id, { excludeUserUuid: owner.id });
      expect(recipients).toHaveLength(1);

      // The same query run AFTER the transaction is paranoid-filtered to zero rows —
      // this is the positive control proving the ordering is load-bearing, not
      // stylistic (88.2-RESEARCH.md Pitfall 5).
      const after = await UserGroup.findAll({ where: { group_id: group.id, status: 'active' } });
      expect(after).toHaveLength(0);
    });

    it('a re-delete REVOKES the prior restore token instead of leaving two usable links', async () => {
      const first = await softDeleteGroup(group.id, { excludeUserUuid: owner.id });
      await clearStamps(group.id);
      const second = await softDeleteGroup(group.id, { excludeUserUuid: owner.id });

      expect(second.nonce).not.toBe(first.nonce);

      const firstRow = await SingleUseToken.findOne({ where: { nonce: first.nonce } });
      const secondRow = await SingleUseToken.findOne({ where: { nonce: second.nonce } });
      expect(firstRow.status).toBe('revoked');
      expect(secondRow.status).toBe('active');

      // Asserting only that a second token exists would pass with the bug fully
      // intact — the point is that exactly ONE link is live for the group.
      const active = await SingleUseToken.count({
        where: { group_id: group.id, purpose: 'group_restore', status: 'active' },
      });
      expect(active).toBe(1);
    });

    it('the revocation reaches an ALREADY-CONSUMED token — targeting only active rows would miss the whole case', async () => {
      const first = await softDeleteGroup(group.id, { excludeUserUuid: owner.id });

      // The member who already accepted the FIRST offer: consumeByNonce leaves the
      // row at 'used' with its expiry still in the future, and plan 07's preview
      // deliberately reads a consumed token (AF-9). Left un-revoked it renders a
      // working recovery offer that then refuses the accept with 410.
      const usedAt = new Date();
      await SingleUseToken.update(
        { status: 'used', used_at: usedAt },
        { where: { nonce: first.nonce } }
      );

      await clearStamps(group.id);
      await softDeleteGroup(group.id, { excludeUserUuid: owner.id });

      const firstRow = await SingleUseToken.findOne({ where: { nonce: first.nonce } });
      expect(firstRow.status).toBe('revoked');
      // used_at is preserved, so the audit trail survives the revocation.
      expect(firstRow.used_at).not.toBeNull();
    });

    it('a second softDeleteGroup on a stamped group throws the typed sentinel and changes nothing', async () => {
      const first = await softDeleteGroup(group.id, { excludeUserUuid: owner.id });

      await expect(
        softDeleteGroup(group.id, { excludeUserUuid: owner.id })
      ).rejects.toThrow(GroupAlreadyDeletedError);

      const row = await Group.findByPk(group.id, { paranoid: false });
      expect(row.deletedAt.getTime()).toBe(first.deletedAt.getTime());
      expect(row.purge_after.getTime()).toBe(first.purgeAfter.getTime());

      // What the sentinel actually prevents: the SECOND token mint (the paranoid
      // clause on the updates already prevents the double-stamp on its own).
      expect(
        await SingleUseToken.count({ where: { group_id: group.id, purpose: 'group_restore' } })
      ).toBe(1);
    });

    it('mints an active group_restore token with a null user_id and an expiry past purge_after', async () => {
      const { nonce, purgeAfter, deletedAt } = await softDeleteGroup(group.id, {
        excludeUserUuid: owner.id,
      });

      expect(purgeAfter.getTime() - deletedAt.getTime()).toBe(RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);

      const token = await SingleUseToken.findOne({ where: { nonce } });
      expect(token).not.toBeNull();
      expect(token.purpose).toBe('group_restore');
      expect(token.group_id).toBe(group.id);
      expect(token.user_id).toBeNull();
      expect(token.status).toBe('active');
      // MED #23: strictly greater, by exactly the margin — so purge_after is
      // provably the binding deadline and a late accept is refused for the true
      // reason rather than as an expired link.
      expect(token.expires_at.getTime()).toBeGreaterThan(purgeAfter.getTime());
      expect(token.expires_at.getTime() - purgeAfter.getTime()).toBe(TOKEN_EXPIRY_MARGIN_MS);
    });
  });
});
