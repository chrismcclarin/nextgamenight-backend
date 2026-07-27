// tests/routes/groups.restore.test.js
//
// Phase 88.2 Plan 07 (SPEC-REQ-9, D-02, D-04) — the RESTORE half of the group
// recovery window, proven against the real database.
//
// RUN THIS SUITE ALONE. The backend's full Jest run has never been green (several
// files call sequelize.sync({ force: true }) against the SHARED test Postgres and
// yank tables out from under their neighbours), and this suite additionally holds a
// real row lock in its concurrency case:
//
//     npm test -- tests/routes/groups.restore.test.js
//
// WHAT THIS PROVES:
//   9a  a full restore is row-set-identical to the pre-delete world except the two
//       role changes, and the group is genuinely usable through the API again
//   9b  every refusal: non-member, pre-removed member, differently-stamped member,
//       past deadline, consumed token, garbage nonce, purged group
//   9b-bis / -bis-2 / -ter  the AF-3 duplicate-membership guard, including the case
//       where the ACCEPTER is the duplicate-row holder, and the full invite->restore
//       chain that proves plan 04's gate and this restore work together
//   9c  two concurrent acceptances yield exactly one owner and one whole group
//   AF-9  the already-restored path — the COMMON case, since one nonce is shared by
//       the whole roster — plus the anti-probing non-regression around it
//   MED-10  a superseded (re-delete) nonce is refused by the revocation, not by the
//       consume

// The ownership-offer fanout is mocked file-wide so no test attempts a real send.
// Mocked as a PROMISE-RETURNING jest.fn because the DELETE handler attaches a
// trailing .catch to it (AF-11).
jest.mock('../../services/groupOwnershipOfferService', () => ({
  sendGroupOwnershipOffers: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const { Op } = require('sequelize');
const groupRoutes = require('../../routes/groups');
const eventRoutes = require('../../routes/events');
const inviteRoutes = require('../../routes/invites');
const {
  Group,
  UserGroup,
  Event,
  EventParticipation,
  GameReview,
  GroupInvite,
  Game,
  SingleUseToken,
  sequelize,
} = require('../../models');
const { sendGroupOwnershipOffers } = require('../../services/groupOwnershipOfferService');
const {
  makeUser,
  makeGroup,
  addToGroup,
  makeGameReview,
  makeGroupInvite,
} = require('../factories');

// Harness mirrors tests/routes/groups.softDelete.test.js: inject req.user ahead of
// the routers (they are mounted with NO real Auth0 middleware).
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor, email_verified: true };
  next();
});
app.use('/api/groups', groupRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/invites', inviteRoutes);

/** The one indistinguishable failure body the preview returns for every genuine failure. */
const PREVIEW_INVALID_BODY = { error: 'Invalid or expired restore link' };

/** Soft-delete a group through the real endpoint and hand back its restore nonce. */
async function deleteGroupAndGetNonce(group, ownerSub) {
  currentActor = ownerSub;
  const res = await request(app).delete(`/api/groups/${group.id}`);
  expect(res.status).toBe(200);
  const token = await SingleUseToken.findOne({
    where: { group_id: group.id, purpose: 'group_restore', status: 'active' },
  });
  expect(token).not.toBeNull();
  return token.nonce;
}

/**
 * Capture the full row-id set across all SIX tables SPEC-REQ-9 names, plus every
 * UserGroup role. Read with { paranoid: false } so the capture is directly
 * comparable across the delete.
 */
async function captureWorld(groupId) {
  const groups = await Group.findAll({ where: { id: groupId }, paranoid: false });
  const userGroups = await UserGroup.findAll({ where: { group_id: groupId }, paranoid: false });
  const events = await Event.findAll({ where: { group_id: groupId }, paranoid: false });
  const eventIds = events.map((e) => e.id).sort();
  const participations = eventIds.length
    ? await EventParticipation.findAll({ where: { event_id: { [Op.in]: eventIds } } })
    : [];
  const reviews = await GameReview.findAll({ where: { group_id: groupId } });
  const invites = await GroupInvite.findAll({ where: { group_id: groupId } });

  return {
    groupIds: groups.map((g) => g.id).sort(),
    userGroupIds: userGroups.map((ug) => ug.id).sort(),
    eventIds,
    participationIds: participations.map((p) => p.id).sort(),
    reviewIds: reviews.map((r) => r.id).sort(),
    inviteIds: invites.map((i) => i.id).sort(),
    // user_uuid -> role, so the two sanctioned role changes are checkable while every
    // other member's role is pinned unchanged.
    rolesByUuid: Object.fromEntries(userGroups.map((ug) => [ug.user_uuid, ug.role])),
    deletedAtByUserGroupId: Object.fromEntries(
      userGroups.map((ug) => [ug.id, ug.deletedAt ? ug.deletedAt.getTime() : null])
    ),
  };
}

describe('Phase 88.2 — SPEC-REQ-9: restoring a soft-deleted group', () => {
  let owner;
  let memberA;
  let memberB;
  let memberC;
  let group;

  beforeEach(async () => {
    sendGroupOwnershipOffers.mockReset();
    sendGroupOwnershipOffers.mockResolvedValue({ sent: 0, failed: 0, unreachable: 0 });

    owner = await makeUser({ username: 'restore-owner' });
    memberA = await makeUser({ username: 'restore-member-a' });
    memberB = await makeUser({ username: 'restore-member-b' });
    memberC = await makeUser({ username: 'restore-member-c' });
    group = await makeGroup({ name: 'Restore Test Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(memberA, group, 'member');
    await addToGroup(memberB, group, 'admin');
    await addToGroup(memberC, group, 'member');
    currentActor = owner.user_id;
  });

  // ==========================================================================
  // SPEC-REQ-9a — full restore with row-set equality
  // ==========================================================================
  describe('SPEC-REQ-9a — a full restore is row-set-identical except the two role changes', () => {
    let game;
    let eventOne;
    let eventTwo;

    beforeEach(async () => {
      game = await Game.create({ name: `Restore Game ${Date.now()}`, is_custom: true });
      eventOne = await Event.create({
        group_id: group.id,
        game_id: game.id,
        start_date: new Date('2026-09-01T18:00:00.000Z'),
        status: 'scheduled',
      });
      eventTwo = await Event.create({
        group_id: group.id,
        game_id: game.id,
        start_date: new Date('2026-09-08T18:00:00.000Z'),
        status: 'scheduled',
      });
      await EventParticipation.create({ event_id: eventOne.id, user_id: memberA.id });
      await EventParticipation.create({ event_id: eventOne.id, user_id: memberB.id });
      await EventParticipation.create({ event_id: eventTwo.id, user_id: owner.id });
      await makeGameReview(memberA, group, game);
      await makeGameReview(memberB, group, game);
      await makeGroupInvite(group, owner); // still pending across the whole flow
    });

    it('restores roster, events, participations, reviews and pending invites with identical id sets', async () => {
      const before = await captureWorld(group.id);
      expect(before.userGroupIds).toHaveLength(4);
      expect(before.eventIds).toHaveLength(2);
      expect(before.participationIds).toHaveLength(3);
      expect(before.reviewIds).toHaveLength(2);
      expect(before.inviteIds).toHaveLength(1);

      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = memberA.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });
      expect(res.status).toBe(200);

      const after = await captureWorld(group.id);

      // Row-set equality across all six tables.
      expect(after.groupIds).toEqual(before.groupIds);
      expect(after.userGroupIds).toEqual(before.userGroupIds);
      expect(after.eventIds).toEqual(before.eventIds);
      expect(after.participationIds).toEqual(before.participationIds);
      expect(after.reviewIds).toEqual(before.reviewIds);
      expect(after.inviteIds).toEqual(before.inviteIds);

      // Exactly two role changes, and nothing else moved.
      expect(before.rolesByUuid[memberA.id]).toBe('member');
      expect(before.rolesByUuid[owner.id]).toBe('owner');
      expect(after.rolesByUuid[memberA.id]).toBe('owner');
      expect(after.rolesByUuid[owner.id]).toBe('member');
      expect(after.rolesByUuid[memberB.id]).toBe(before.rolesByUuid[memberB.id]); // admin
      expect(after.rolesByUuid[memberC.id]).toBe(before.rolesByUuid[memberC.id]); // member

      // Every restored row is live again.
      expect(Object.values(after.deletedAtByUserGroupId).every((v) => v === null)).toBe(true);
      const liveGroup = await Group.findByPk(group.id);
      expect(liveGroup).not.toBeNull();
      expect(liveGroup.deletedAt).toBeNull();
      expect(liveGroup.purge_after).toBeNull();
      const liveEvents = await Event.findAll({ where: { group_id: group.id } });
      expect(liveEvents).toHaveLength(2);
      expect(liveEvents.every((e) => e.deletedAt === null)).toBe(true);
    });

    it('the group is genuinely usable through the API again, not merely un-stamped', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = memberA.user_id;
      // Before the restore the accepter cannot read it at all. 403, not 404: the
      // group-detail handler is authorization-first and isActiveMember resolves
      // through the paranoid UserGroup choke point, so the accepter's own stamped
      // membership row makes the authz check fail before any group lookup runs.
      await request(app).get(`/api/groups/${group.id}`).expect(403);

      await request(app).post('/api/groups/accept-ownership').send({ token: nonce }).expect(200);

      await request(app).get(`/api/groups/${group.id}`).expect(200);

      const events = await request(app).get(`/api/events/user/${memberA.user_id}`);
      expect(events.status).toBe(200);
      const returnedIds = events.body.map((e) => e.id).sort();
      expect(returnedIds).toEqual([eventOne.id, eventTwo.id].sort());
    });

    it('the 200 wire body is exactly { success, group_id, group_name } in snake_case (MED #14/#15)', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);
      currentActor = memberA.user_id;

      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['group_id', 'group_name', 'success']);
      expect(res.body.group_id).toBe(group.id);
      expect(res.body.group_name).toBe('Restore Test Group');
      // The camelCase service shape must never reach the wire — a `...result` spread
      // would emit these and every suite on both sides would still be green.
      expect(Object.keys(res.body)).not.toContain('groupId');
      expect(Object.keys(res.body)).not.toContain('groupName');
    });
  });

  // ==========================================================================
  // SPEC-REQ-9b — refusals
  // ==========================================================================
  describe('SPEC-REQ-9b — refusals', () => {
    it('a logged-in user with no membership row in that group → 403', async () => {
      const stranger = await makeUser({ username: 'restore-stranger' });
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = stranger.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      expect(res.status).toBe(403);
      expect(res.body.group_id).toBeUndefined();
      expect(await Group.findByPk(group.id)).toBeNull(); // still soft-deleted
    });

    it('a member removed BEFORE the delete (row hard-deleted) → 403', async () => {
      const removed = await makeUser({ username: 'restore-removed' });
      await addToGroup(removed, group, 'member');
      // Plan 03's sanctioned hard delete: no row survives at all.
      await UserGroup.destroy({ force: true, where: { user_uuid: removed.id, group_id: group.id } });

      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = removed.user_id;
      await request(app)
        .post('/api/groups/accept-ownership')
        .send({ token: nonce })
        .expect(403);
    });

    it('a member soft-deleted by an EARLIER, unrelated stamp → 403, and is NOT resurrected by someone else\'s restore (Pitfall 3)', async () => {
      const earlier = await makeUser({ username: 'restore-earlier-stamp' });
      const earlierRow = await addToGroup(earlier, group, 'member');
      const oldStamp = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await UserGroup.update(
        { deletedAt: oldStamp },
        { where: { id: earlierRow.id }, silent: true }
      );

      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = earlier.user_id;
      await request(app)
        .post('/api/groups/accept-ownership')
        .send({ token: nonce })
        .expect(403);

      // Someone legitimately entitled restores it...
      currentActor = memberA.user_id;
      await request(app).post('/api/groups/accept-ownership').send({ token: nonce }).expect(200);

      // ...and the differently-stamped row is STILL soft-deleted, carrying its own
      // original timestamp. This is the whole point of matching on deletedAt === stamp.
      const after = await UserGroup.findByPk(earlierRow.id, { paranoid: false });
      expect(after.deletedAt).not.toBeNull();
      expect(after.deletedAt.getTime()).toBe(oldStamp.getTime());
      expect(await UserGroup.findByPk(earlierRow.id)).toBeNull();
    });

    it('a link followed after purge_after has passed → 410 window_expired, group stays soft-deleted', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);
      await Group.update(
        { purge_after: new Date(Date.now() - 60 * 1000) },
        { where: { id: group.id }, paranoid: false, silent: true }
      );

      currentActor = memberA.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('window_expired');
      expect(await Group.findByPk(group.id)).toBeNull();
      // The token was NOT burned — the refusal happened before the consume.
      const token = await SingleUseToken.findOne({ where: { nonce } });
      expect(token.status).toBe('active');
    });

    it('a token already consumed → 410 already_used', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);
      // Consume it out from under the accepter WITHOUT restoring the group, so the
      // group is still soft-deleted when step 5 runs.
      expect(await SingleUseToken.consumeByNonce(nonce)).not.toBeNull();

      currentActor = memberA.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('already_used');
      expect(await Group.findByPk(group.id)).toBeNull();
    });

    it('a garbage nonce → 410 invalid_token from accept, 404 from the preview', async () => {
      await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = memberA.user_id;
      const accept = await request(app)
        .post('/api/groups/accept-ownership')
        .send({ token: 'not-a-real-nonce' });
      expect(accept.status).toBe(410);
      expect(accept.body.code).toBe('invalid_token');

      currentActor = null;
      const preview = await request(app).get('/api/groups/restore-preview/not-a-real-nonce');
      expect(preview.status).toBe(404);
      expect(preview.body).toEqual(PREVIEW_INVALID_BODY);
    });

    it('a FULLY PURGED group whose token row survives → 410 window_expired with no group_id, never 409 (MED #2/#35)', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      // Erase the group exactly as the purge sweep will, leaving the token row behind.
      await sequelize.query('DELETE FROM "UserGroups" WHERE group_id = :id', {
        replacements: { id: group.id },
      });
      await sequelize.query('DELETE FROM "Groups" WHERE id = :id', {
        replacements: { id: group.id },
      });

      currentActor = memberA.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      // window_expired ("the recovery window ended and its data was erased") is the
      // TRUE reason. already_restored/409 would tell the user their group is back and
      // hand the frontend a redirect into a group that no longer exists.
      expect(res.status).toBe(410);
      expect(res.body.code).toBe('window_expired');
      expect(res.body.group_id).toBeUndefined();
    });

    it('an empty body → 400, and no session → 401', async () => {
      currentActor = memberA.user_id;
      await request(app).post('/api/groups/accept-ownership').send({}).expect(400);

      currentActor = null;
      await request(app).post('/api/groups/accept-ownership').send({ token: 'x' }).expect(401);
    });
  });

  // ==========================================================================
  // SPEC-REQ-9b-bis / -bis-2 — the AF-3 duplicate-membership guard (step 6a)
  // ==========================================================================
  describe('SPEC-REQ-9b-bis — the AF-3 duplicate-membership guard', () => {
    /**
     * Construct the pathological state DIRECTLY rather than through the (now-closed)
     * invite path, so these cases pin the guard and not plan 04's gate: the target
     * holds BOTH a stamped row (from the group delete) and a live row (as a
     * post-delete join would have produced).
     */
    async function giveDuplicateLiveRow(user) {
      return UserGroup.create({
        user_uuid: user.id,
        group_id: group.id,
        role: 'member',
        status: 'active',
        joined_at: new Date(),
      });
    }

    it('BYSTANDER case: a duplicate pair on someone OTHER than the accepter — restore still succeeds, one live row survives', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);
      await giveDuplicateLiveRow(memberB); // memberB was 'admin' before the delete

      currentActor = memberA.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      // The restore SUCCEEDS rather than aborting on usergroups_user_uuid_group_id_uq.
      expect(res.status).toBe(200);

      const bystanderRows = await UserGroup.findAll({
        where: { user_uuid: memberB.id, group_id: group.id },
        paranoid: false,
      });
      expect(bystanderRows).toHaveLength(1);
      expect(bystanderRows[0].deletedAt).toBeNull();

      // The roster is NOT short: every other member is restored normally.
      const roster = await UserGroup.findAll({ where: { group_id: group.id } });
      expect(roster.map((r) => r.user_uuid).sort()).toEqual(
        [owner.id, memberA.id, memberB.id, memberC.id].sort()
      );
      expect(roster.filter((r) => r.role === 'owner')).toHaveLength(1);
    });

    it('ACCEPTER-IS-THE-HOLDER case: the accepter holds both rows — restore succeeds and the group has exactly one owner, them (SPEC-REQ-9b-bis-2)', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);
      await giveDuplicateLiveRow(memberA); // the accepter themself

      currentActor = memberA.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      // Not a silent no-op returning 200 over an ownerless group: a promote keyed on
      // the stamped membership.id would match ZERO rows here, because step 6a just
      // hard-deleted exactly that row.
      expect(res.status).toBe(200);

      const accepterRows = await UserGroup.findAll({
        where: { user_uuid: memberA.id, group_id: group.id },
        paranoid: false,
      });
      expect(accepterRows).toHaveLength(1);
      expect(accepterRows[0].deletedAt).toBeNull();

      const owners = await UserGroup.findAll({ where: { group_id: group.id, role: 'owner' } });
      expect(owners).toHaveLength(1);
      expect(owners[0].user_uuid).toBe(memberA.id);
      expect(await UserGroup.count({ where: { group_id: group.id, role: 'owner' } })).toBe(1);
    });

    it('SPEC-REQ-9b-ter — the full AF-3 chain: a pending invite is refused 410, then the restore still succeeds with one live row per pair', async () => {
      const invitee = await makeUser({ username: 'restore-invitee' });
      await addToGroup(invitee, group, 'member');
      const invite = await makeGroupInvite(group, owner, { invited_email: invitee.email });

      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      // Plan 04 Task 4's gate: a pending invite on a soft-deleted group is refused.
      currentActor = invitee.user_id;
      const accepted = await request(app)
        .post('/api/invites/accept-by-token')
        .send({ token: invite.token });
      expect(accepted.status).toBe(410);

      // ...and the restore is therefore not poisoned by a duplicate live row.
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });
      expect(res.status).toBe(200);

      const roster = await UserGroup.findAll({ where: { group_id: group.id }, paranoid: false });
      const perPair = roster
        .filter((r) => r.deletedAt === null)
        .reduce((acc, r) => {
          acc[r.user_uuid] = (acc[r.user_uuid] || 0) + 1;
          return acc;
        }, {});
      expect(Object.values(perPair).every((n) => n === 1)).toBe(true);
      // The roster is complete — the invited member is still on it.
      expect(Object.keys(perPair).sort()).toEqual(
        [owner.id, memberA.id, memberB.id, memberC.id, invitee.id].sort()
      );
    });
  });

  // ==========================================================================
  // SPEC-REQ-9c — concurrency (real row locking; must not be mocked)
  // ==========================================================================
  describe('SPEC-REQ-9c — two members accepting concurrently', () => {
    // Poll for handler transactions actually BLOCKING on our row lock — an
    // observable database condition, not a sleep. Same shape as the deterministic
    // race test plan 06 established in groups.softDelete.test.js.
    async function waitForLockWaiters(n, { timeoutMs = 10000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const [row] = await sequelize.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock'
               AND query ILIKE '%FOR UPDATE%'
               AND pid <> pg_backend_pid()`,
          { type: sequelize.QueryTypes.SELECT }
        );
        if (row && row.n >= n) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }

    it('exactly one 200, one 409-or-410, exactly one owner, and a WHOLE group', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      // Hold the same Groups row lock both handlers take, from a test-owned
      // transaction, so both requests are provably in flight and blocked before
      // either can commit. Promise.all alone would be non-deterministic about which
      // guard refused the loser.
      const t0 = await sequelize.transaction();
      await sequelize.query('SELECT id FROM "Groups" WHERE id = :id FOR UPDATE', {
        replacements: { id: group.id },
        type: sequelize.QueryTypes.SELECT,
        transaction: t0,
      });

      let released = false;
      let responses;
      try {
        // req.user is injected from a module-scoped variable, so both in-flight
        // requests must be dispatched under the SAME actor. Two different members
        // would race on `currentActor` itself, not on the group row. The identity
        // that matters here is the group row lock, which is per-group, not per-user.
        currentActor = memberA.user_id;
        // .then() is REQUIRED — a supertest Test is lazy and does not dispatch until
        // end()/then() is called.
        const pendingA = request(app)
          .post('/api/groups/accept-ownership')
          .send({ token: nonce })
          .then((r) => r, (e) => e);
        const pendingB = request(app)
          .post('/api/groups/accept-ownership')
          .send({ token: nonce })
          .then((r) => r, (e) => e);

        expect(await waitForLockWaiters(2)).toBe(true);

        await t0.commit();
        released = true;
        responses = await Promise.all([pendingA, pendingB]);
      } finally {
        if (!released) await t0.rollback();
      }

      const statuses = responses.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      const loser = responses.find((r) => r.status !== 200);
      expect([409, 410]).toContain(loser.status);

      // Exactly one owner...
      expect(await UserGroup.count({ where: { group_id: group.id, role: 'owner' } })).toBe(1);
      // ...and the group is FULLY restored, not half.
      const liveGroup = await Group.findByPk(group.id);
      expect(liveGroup).not.toBeNull();
      expect(liveGroup.purge_after).toBeNull();
      expect(await UserGroup.count({ where: { group_id: group.id } })).toBe(4);
    });
  });

  // ==========================================================================
  // Preview coverage + AF-9
  // ==========================================================================
  describe('GET /restore-preview/:token — D-02 disclosure surface', () => {
    it('returns 200 with EXACTLY { group_name, purge_after } and no counts, with no auth', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);
      const stamped = await Group.findByPk(group.id, { paranoid: false });

      currentActor = null; // no Authorization, no req.user
      const res = await request(app).get(`/api/groups/restore-preview/${nonce}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['group_name', 'purge_after']);
      expect(res.body.group_name).toBe('Restore Test Group');
      expect(new Date(res.body.purge_after).getTime()).toBe(stamped.purge_after.getTime());
      expect(res.body).not.toHaveProperty('member_count');
      expect(res.body).not.toHaveProperty('event_count');
      expect(res.body).not.toHaveProperty('group_id');
    });

    it('AF-9: after a restore the SAME preview URL returns 200 already_restored, not 404', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);
      currentActor = memberA.user_id;
      await request(app).post('/api/groups/accept-ownership').send({ token: nonce }).expect(200);

      currentActor = null;
      const res = await request(app).get(`/api/groups/restore-preview/${nonce}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['group_id', 'group_name', 'status']);
      expect(res.body.status).toBe('already_restored');
      expect(res.body.group_id).toBe(group.id);
      expect(res.body).not.toHaveProperty('member_count');
      expect(res.body).not.toHaveProperty('event_count');
    });

    it('AF-9: a SECOND member accepting the same nonce gets 409 carrying group_id, not 410', async () => {
      const nonce = await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = memberA.user_id;
      await request(app).post('/api/groups/accept-ownership').send({ token: nonce }).expect(200);

      // This is the assertion that fails if a `status: 'active'` predicate is ever
      // restored to either the preview lookup or restoreGroupByToken's step 1.
      currentActor = memberB.user_id;
      const res = await request(app).post('/api/groups/accept-ownership').send({ token: nonce });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('already_restored');
      expect(res.body.group_id).toBe(group.id);
      expect(Object.keys(res.body)).not.toContain('groupId');
      // memberA is still the only owner — the loser changed nothing.
      expect(await UserGroup.count({ where: { group_id: group.id, role: 'owner' } })).toBe(1);
    });

    it('anti-probing non-regression: four GENUINE failure modes all return a byte-identical 404', async () => {
      currentActor = null;

      // (1) garbage nonce
      const garbage = await request(app).get('/api/groups/restore-preview/deadbeef-not-a-nonce');

      // (2) revoked token
      const revokedGroup = await makeGroup({ name: 'Revoked Token Group' });
      await addToGroup(owner, revokedGroup, 'owner');
      const revokedNonce = await deleteGroupAndGetNonce(revokedGroup, owner.user_id);
      await SingleUseToken.update(
        { status: 'revoked' },
        { where: { nonce: revokedNonce }, silent: true }
      );
      currentActor = null;
      const revoked = await request(app).get(`/api/groups/restore-preview/${revokedNonce}`);

      // (3) token whose group was purged
      const purgedGroup = await makeGroup({ name: 'Purged Group' });
      await addToGroup(owner, purgedGroup, 'owner');
      const purgedNonce = await deleteGroupAndGetNonce(purgedGroup, owner.user_id);
      await sequelize.query('DELETE FROM "UserGroups" WHERE group_id = :id', {
        replacements: { id: purgedGroup.id },
      });
      await sequelize.query('DELETE FROM "Groups" WHERE id = :id', {
        replacements: { id: purgedGroup.id },
      });
      currentActor = null;
      const purged = await request(app).get(`/api/groups/restore-preview/${purgedNonce}`);

      // (4) token past purge_after
      const expiredNonce = await deleteGroupAndGetNonce(group, owner.user_id);
      await Group.update(
        { purge_after: new Date(Date.now() - 60 * 1000) },
        { where: { id: group.id }, paranoid: false, silent: true }
      );
      currentActor = null;
      const expired = await request(app).get(`/api/groups/restore-preview/${expiredNonce}`);

      for (const res of [garbage, revoked, purged, expired]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual(PREVIEW_INVALID_BODY);
      }
      // Byte-identical, not merely deep-equal-shaped.
      const bodies = [garbage, revoked, purged, expired].map((r) => JSON.stringify(r.body));
      expect(new Set(bodies).size).toBe(1);
    });
  });

  // ==========================================================================
  // MED #10 — the superseded (re-delete) token
  // ==========================================================================
  describe('MED #10 — a superseded nonce is refused by the REVOCATION, not by the consume', () => {
    it('delete → restore → delete again: the FIRST nonce previews 404 and accepts 410 invalid_token; the SECOND restores', async () => {
      const firstNonce = await deleteGroupAndGetNonce(group, owner.user_id);

      currentActor = memberA.user_id;
      await request(app)
        .post('/api/groups/accept-ownership')
        .send({ token: firstNonce })
        .expect(200);

      // memberA is the owner now, so memberA deletes it the second time.
      const secondNonce = await deleteGroupAndGetNonce(group, memberA.user_id);
      expect(secondNonce).not.toBe(firstNonce);

      // Without the revocation the preview would render a working-looking offer
      // naming the group and the NEW deadline, which the accept then refuses.
      currentActor = null;
      const preview = await request(app).get(`/api/groups/restore-preview/${firstNonce}`);
      expect(preview.status).toBe(404);
      expect(preview.body).toEqual(PREVIEW_INVALID_BODY);

      // invalid_token (step 1, revocation) — NOT already_used (step 5, consume). The
      // code is what proves which guard refused it.
      currentActor = memberB.user_id;
      const stale = await request(app)
        .post('/api/groups/accept-ownership')
        .send({ token: firstNonce });
      expect(stale.status).toBe(410);
      expect(stale.body.code).toBe('invalid_token');

      // The second nonce still works.
      const fresh = await request(app)
        .post('/api/groups/accept-ownership')
        .send({ token: secondNonce });
      expect(fresh.status).toBe(200);
      expect(fresh.body.group_id).toBe(group.id);
      expect(await UserGroup.count({ where: { group_id: group.id, role: 'owner' } })).toBe(1);
    });
  });
});
