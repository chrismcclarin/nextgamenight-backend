// tests/routes/groups.test.js
const request = require('supertest');
const express = require('express');
const groupRoutes = require('../../routes/groups');
const { Group, User, UserGroup, Event, Game } = require('../../models');
const { makeUser, addToGroup } = require('../factories');

// D-05 include-pin shapes (Phase 87.3 Task 1): the nested member id the FE
// cutover (PR-B) compares against is a UUID; the Auth0 sub is provider-prefixed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_RE = /^(auth0|google-oauth2|apple)\|/;

// The group routes derive the actor from req.user (BE-044 / BSEC-01 default-deny
// authz, Phase 83). Build a per-test app that injects req.user ahead of the
// router (mirrors tests/helpers/authStub.js + the leave-cascade suites). The
// router is mounted with NO real Auth0 middleware, so without this stub every
// handler short-circuits at `if (!userId) return 401`.
function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor ? { user_id: actor.user_id, email: actor.email } : undefined;
    next();
  });
  app.use('/api/groups', groupRoutes);
  return app;
}

describe('Group Routes', () => {
  let testUser1, testUser2, testGame;

  // Seed in beforeEach so fixtures survive the global per-test TRUNCATE
  // (plan-01 isolation harness). Connection lifecycle is owned by
  // tests/globalTeardown.js — this suite never calls sequelize.close().
  beforeEach(async () => {
    testUser1 = await makeUser({ user_id: 'test-user-groups-1', username: 'testuser1' });
    testUser2 = await makeUser({ user_id: 'test-user-groups-2', username: 'testuser2' });

    testGame = await Game.create({
      name: 'Test Game',
      is_custom: true
    });
  });

  describe('GET /api/groups/user/:user_id', () => {
    it('should get all groups for a user', async () => {
      const testGroup = await Group.create({
        group_id: 'test-group-1',
        name: 'Test Group 1'
      });

      await addToGroup(testUser1, testGroup);

      const response = await request(makeApp(testUser1))
        .get(`/api/groups/user/${testUser1.user_id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);

      // D-05 INCLUDE-PIN (Phase 87.3 Task 1): the nested roster member id the FE
      // cutover (PR-B) will compare against MUST be a UUID, never the Auth0 sub.
      // This is the second roster endpoint (the GET /:group_id/users roster is
      // pinned separately below) — together they form the PR-C regression net.
      const seededGroup = response.body.find((g) => g.id === testGroup.id);
      expect(seededGroup).toBeDefined();
      expect(Array.isArray(seededGroup.Users)).toBe(true);
      const me = seededGroup.Users.find((u) => u.username === 'testuser1');
      expect(me).toBeDefined();
      expect(me.id).toMatch(UUID_RE);
      expect(me.id).not.toMatch(SUB_RE);
      expect(me.id).toBe(testUser1.id);
      // Phase 87.3 PR-C ROSTER ALIAS: user_id NAME retained, VALUE = the UUID.
      expect(me.user_id).toBe(testUser1.id);
      expect(me.user_id).not.toMatch(SUB_RE);
    });

    it('should auto-create the user row when it does not exist yet', async () => {
      // The route auto-creates the authenticated user on first access
      // (Auth0-token-driven onboarding). A non-existent acting user therefore
      // yields 200 with an empty group list, not 404.
      const ghost = { user_id: 'auth0|ghost-user', email: 'ghost@example.com' };
      const response = await request(makeApp(ghost))
        .get(`/api/groups/user/${ghost.user_id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(0);
    });

    it('should return 403 when requesting another user\'s groups', async () => {
      const response = await request(makeApp(testUser1))
        .get(`/api/groups/user/${testUser2.user_id}`)
        .expect(403);

      expect(response.body.error).toContain('Cannot access other users');
    });

    it('should include recent events in groups', async () => {
      const testGroup = await Group.create({
        group_id: 'test-group-2',
        name: 'Test Group 2'
      });

      await addToGroup(testUser1, testGroup);

      await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      const response = await request(makeApp(testUser1))
        .get(`/api/groups/user/${testUser1.user_id}`)
        .expect(200);

      expect(response.body.length).toBeGreaterThan(0);
      // Check if group has events
      const group = response.body.find(g => g.id === testGroup.id);
      if (group && group.Events) {
        expect(Array.isArray(group.Events)).toBe(true);
      }
    });
  });

  describe('POST /api/groups', () => {
    it('should create a new group', async () => {
      const response = await request(makeApp(testUser1))
        .post('/api/groups')
        .send({ name: 'New Test Group' })
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.name).toBe('New Test Group');
      expect(response.body).toHaveProperty('group_id');

      // Verify the creator was added to the group as owner (keyed on user_uuid =
      // Users.id UUID; the old Auth0-string user_id column was removed in Plan 09).
      const userGroup = await UserGroup.findOne({
        where: {
          user_uuid: testUser1.id,
          group_id: response.body.id
        }
      });
      expect(userGroup).not.toBeNull();
      expect(userGroup.role).toBe('owner');
    });

    it('should return 401 when unauthenticated', async () => {
      const response = await request(makeApp(null))
        .post('/api/groups')
        .send({ name: 'New Test Group' })
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });
  });

  describe('POST /api/groups/:group_id/users', () => {
    it('should add user to group when actor is owner/admin', async () => {
      const testGroup = await Group.create({
        group_id: 'test-group-3',
        name: 'Test Group 3'
      });
      // Actor must be owner/admin to add members (BE-044 authz gate).
      await addToGroup(testUser1, testGroup, 'owner');

      const response = await request(makeApp(testUser1))
        .post(`/api/groups/${testGroup.id}/users`)
        .send({ user_id: testUser2.user_id })
        .expect(200);

      expect(response.body.message).toBe('User added to group successfully');

      // Verify the added user (keyed on user_uuid = Users.id UUID; the old
      // Auth0-string user_id column was removed in Plan 09).
      const userGroup = await UserGroup.findOne({
        where: {
          user_uuid: testUser2.id,
          group_id: testGroup.id
        }
      });
      expect(userGroup).not.toBeNull();
    });

    it('should return 403 when actor is not owner/admin', async () => {
      const testGroup = await Group.create({
        group_id: 'test-group-3b',
        name: 'Test Group 3b'
      });
      // testUser1 is only a plain member here — not allowed to add members.
      await addToGroup(testUser1, testGroup, 'member');

      const response = await request(makeApp(testUser1))
        .post(`/api/groups/${testGroup.id}/users`)
        .send({ user_id: testUser2.user_id })
        .expect(403);

      expect(response.body.error).toContain('owners and admins');
    });

    it('should not create duplicate if user already in group', async () => {
      const testGroup = await Group.create({
        group_id: `test-group-4-${Date.now()}`,
        name: 'Test Group 4'
      });

      await addToGroup(testUser1, testGroup, 'owner');

      const response = await request(makeApp(testUser1))
        .post(`/api/groups/${testGroup.id}/users`)
        .send({ user_id: testUser1.user_id })
        .expect(200);

      expect(response.body.message).toBe('User added to group successfully');
    });

    it('should return 404 if target user not found', async () => {
      const testGroup = await Group.create({
        group_id: 'test-group-5',
        name: 'Test Group 5'
      });
      await addToGroup(testUser1, testGroup, 'owner');

      const response = await request(makeApp(testUser1))
        .post(`/api/groups/${testGroup.id}/users`)
        .send({ user_id: 'non-existent-user' })
        .expect(404);

      expect(response.body.error).toBe('User or Group not found');
    });

    it('should return 403 if group not found (authz gate runs first)', async () => {
      // The owner/admin authz check runs before the existence lookup, so a
      // non-existent group yields 403 (actor is not owner/admin of it).
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(makeApp(testUser1))
        .post(`/api/groups/${fakeId}/users`)
        .send({ user_id: testUser1.user_id })
        .expect(403);

      expect(response.body.error).toContain('owners and admins');
    });
  });

  // Phase 87.3 PR-C ROSTER ALIAS (plan 09 Task 2, LOCKED decision — flips the
  // old D-12 sub-shim pin): the roster user_id field NAME is retained but its
  // VALUE is now the member's Users.id UUID. No sub crosses the wire; the
  // through-role (User.UserGroup.role) survives the alias mapping.
  describe('GET /api/groups/:group_id/users (PR-C aliased roster wire shape)', () => {
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    it('serializes roster user_id ALIASED to the member UUID — never the Auth0 sub', async () => {
      const authSub = 'google-oauth2|108246800000000000001';
      const member = await makeUser({ user_id: authSub, username: 'd12rosteruser' });
      const grp = await Group.create({ group_id: `d12-roster-${Date.now()}`, name: 'D12 Roster Group' });
      // Active member → the member-caller branch returns the full group.Users roster.
      await addToGroup(member, grp, 'owner');

      const res = await request(makeApp(member))
        .get(`/api/groups/${grp.id}/users`)
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      const entry = res.body.find(u => u.username === 'd12rosteruser');
      expect(entry).toBeDefined();
      // PR-C alias: user_id VALUE = the member's Users.id UUID (name stable).
      expect(entry.user_id).toBe(member.id);
      expect(entry.user_id).toMatch(UUID_V4);
      expect(entry.user_id).not.toBe(authSub);
      expect(entry.user_id).not.toMatch(SUB_RE);
      // The UUID PK field is unchanged and equals the aliased user_id.
      expect(entry.id).toMatch(UUID_V4);
      expect(entry.id).toBe(entry.user_id);
      // The through-role survives the alias mapping (ManageMembers reads it).
      expect(entry.UserGroup).toBeDefined();
      expect(entry.UserGroup.role).toBe('owner');
    });
  });

  // F2 (#1 + #5): join-by-token auto-provision must not trust an unverified token
  // email and must not 500 on an email UNIQUE collision.
  describe('POST /api/groups/join-by-token — auto-provision hardening (F2)', () => {
    // Local app that injects the FULL req.user (makeApp only forwards user_id+email;
    // these tests need email_verified too).
    function makeTokenApp(actor) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = actor; next(); });
      app.use('/api/groups', groupRoutes);
      return app;
    }

    it('retries with the synthetic fallback when a VERIFIED token email collides with an existing user', async () => {
      // An existing user already owns this email (Users.email is UNIQUE, notNull).
      await makeUser({ user_id: 'auth0|f2-victim', username: 'f2victim', email: 'taken-f2@example.com' });
      const grp = await Group.create({
        group_id: `f2-collide-${Date.now()}`, name: 'F2 Collide',
        invite_token: `tok-f2-collide-${Date.now()}`,
      });

      const newSub = 'auth0|f2-new-joiner';
      const res = await request(makeTokenApp({ user_id: newSub, email: 'taken-f2@example.com', email_verified: true }))
        .post('/api/groups/join-by-token')
        .send({ token: grp.invite_token })
        .expect(200);
      expect(res.body.success).toBe(true);

      // The first-time joiner provisioned with the SYNTHETIC fallback (sub sanitized),
      // NOT the colliding verified email — and no raw 500 escaped.
      const created = await User.scope('withContactInfo').findOne({ where: { user_id: newSub } });
      expect(created).not.toBeNull();
      expect(created.email).toBe('auth0-f2-new-joiner@auth0.local');
      expect(await UserGroup.count({ where: { user_uuid: created.id, group_id: grp.id } })).toBe(1);
    });

    it('does NOT persist an UNVERIFIED token email — provisions with the synthetic fallback', async () => {
      const grp = await Group.create({
        group_id: `f2-unver-${Date.now()}`, name: 'F2 Unverified',
        invite_token: `tok-f2-unver-${Date.now()}`,
      });
      const newSub = 'auth0|f2-unverified-joiner';
      await request(makeTokenApp({ user_id: newSub, email: 'unverified-f2@example.com', email_verified: false }))
        .post('/api/groups/join-by-token')
        .send({ token: grp.invite_token })
        .expect(200);

      const created = await User.scope('withContactInfo').findOne({ where: { user_id: newSub } });
      expect(created.email).toBe('auth0-f2-unverified-joiner@auth0.local');
    });
  });
});

// ============================================================================
// Phase 87.3 PR-C (plan 09, amended D1 contraction): the five group-admin
// mutations resolve their target-user identifier UUID-ONLY — the PR-A sub
// fallback (the AF6 dual-key window) is CLOSED now that PR-B (plan 05) cut the
// ManageMembers senders to member.id. The UUID shape succeeds; a sub-shaped
// target rejects as not-found (accepted stale-bundle trade-off — never re-add
// the fallback). The POST /:group_id/users friend-invite/add-member path is
// the SOLE RETAINED dual-key (outside D1's endpoint list).
//
// Real-DB (factories). Run ALONE per the never-green-locally caveat:
//   npm test -- tests/routes/groups.test.js
// ============================================================================
describe('Group admin mutations — UUID-only target resolution (87.3 PR-C contraction)', () => {
  function makeApp(actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = actor ? { user_id: actor.user_id, email: actor.email } : undefined;
      next();
    });
    app.use('/api/groups', groupRoutes);
    return app;
  }

  let owner;
  let member;
  let group;

  beforeEach(async () => {
    owner = await makeUser({ user_id: 'auth0|dk-owner', username: 'dk-owner' });
    member = await makeUser({ user_id: 'auth0|dk-member', username: 'dk-member' });
    group = await Group.create({ group_id: `dk-group-${Date.now()}`, name: 'Dual-Key Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(member, group, 'member');
  });

  // ---- POST /:group_id/users add-member/friend-invite path ----
  // The SOLE retained dual-key after the amended-D1 contraction (outside D1's
  // endpoint list): both identifier shapes keep working here.
  it('add-member: accepts a UUID-shaped target user_id (post-PR-C roster shape) -> 200', async () => {
    const newcomer = await makeUser({ user_id: 'auth0|dk-newcomer', username: 'dk-newcomer' });
    const res = await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users`)
      .send({ user_id: newcomer.id }) // UUID, not the sub
      .expect(200);
    expect(res.body.message).toBe('User added to group successfully');
    const ug = await UserGroup.findOne({ where: { user_uuid: newcomer.id, group_id: group.id } });
    expect(ug).not.toBeNull();
  });

  it('add-member: still accepts a sub-shaped target user_id (the retained dual-key) -> 200', async () => {
    const newcomer = await makeUser({ user_id: 'auth0|dk-newcomer2', username: 'dk-newcomer2' });
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users`)
      .send({ user_id: newcomer.user_id }) // Auth0 sub
      .expect(200);
    const ug = await UserGroup.findOne({ where: { user_uuid: newcomer.id, group_id: group.id } });
    expect(ug).not.toBeNull();
  });

  it('add-member: rejects a non-string user_id body (87.3 review #6 input hygiene) -> 400', async () => {
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users`)
      .send({ user_id: ['auth0|dk-array', 'auth0|dk-array2'] }) // array — must not coerce
      .expect(400);
  });

  // ---- PUT /:group_id/users/:target_user_id/role ----
  it('role change: accepts a UUID-shaped target -> 200 and updates the role', async () => {
    const res = await request(makeApp(owner))
      .put(`/api/groups/${group.id}/users/${member.id}/role`) // UUID
      .send({ role: 'admin' })
      .expect(200);
    expect(res.body.role).toBe('admin');
    const ug = await UserGroup.findOne({ where: { user_uuid: member.id, group_id: group.id } });
    expect(ug.role).toBe('admin');
  });

  it('role change: REJECTS a sub-shaped target (D1 contraction — sub fallback removed) -> 404, role unchanged', async () => {
    await request(makeApp(owner))
      .put(`/api/groups/${group.id}/users/${encodeURIComponent(member.user_id)}/role`) // sub
      .send({ role: 'admin' })
      .expect(404);
    const ug = await UserGroup.findOne({ where: { user_uuid: member.id, group_id: group.id } });
    expect(ug.role).toBe('member'); // unchanged — no fail-open
  });

  // ---- DELETE /:group_id/users/:target_user_id ----
  it('remove: accepts a UUID-shaped target -> 200 and removes the membership', async () => {
    await request(makeApp(owner))
      .delete(`/api/groups/${group.id}/users/${member.id}`) // UUID
      .expect(200);
    const ug = await UserGroup.findOne({ where: { user_uuid: member.id, group_id: group.id, status: 'active' } });
    expect(ug).toBeNull();
  });

  it('remove: the owner cannot remove THEMSELVES via their UUID -> 400 (self-guard on resolved identity)', async () => {
    const res = await request(makeApp(owner))
      .delete(`/api/groups/${group.id}/users/${owner.id}`) // owner's OWN uuid
      .expect(400);
    expect(res.body.error).toMatch(/cannot remove themselves/i);
    // Still an owner — the guard fired, no fail-open.
    const ug = await UserGroup.findOne({ where: { user_uuid: owner.id, group_id: group.id, status: 'active' } });
    expect(ug.role).toBe('owner');
  });

  it('remove: REJECTS a sub-shaped target (D1 contraction) -> 404, membership intact', async () => {
    await request(makeApp(owner))
      .delete(`/api/groups/${group.id}/users/${encodeURIComponent(member.user_id)}`) // sub
      .expect(404);
    const ug = await UserGroup.findOne({ where: { user_uuid: member.id, group_id: group.id, status: 'active' } });
    expect(ug).not.toBeNull(); // still a member — no fail-open
  });

  it('remove: a non-admin caller is 403d BEFORE any target resolution (87.3 review #3, WR-01 — no user-existence oracle)', async () => {
    // A plain member probing an arbitrary (nonexistent) UUID must get the SAME
    // uniform 403 as probing a real one — never a 404 that leaks existence.
    const res = await request(makeApp(member))
      .delete(`/api/groups/${group.id}/users/99999999-9999-4999-8999-999999999999`)
      .expect(403);
    expect(res.body.error).toMatch(/owners and admins/i);
  });

  // ---- POST /:group_id/users/:target_user_id/approve + /reject ----
  it('approve: accepts a UUID-shaped pending-member target -> 200', async () => {
    const pending = await makeUser({ user_id: 'auth0|dk-pending', username: 'dk-pending' });
    await addToGroup(pending, group, 'pending');
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users/${pending.id}/approve`) // UUID
      .expect(200);
    const ug = await UserGroup.findOne({ where: { user_uuid: pending.id, group_id: group.id } });
    expect(ug.role).toBe('member');
  });

  it('reject: accepts a UUID-shaped pending-member target -> 200 and removes it', async () => {
    const pending = await makeUser({ user_id: 'auth0|dk-pending2', username: 'dk-pending2' });
    await addToGroup(pending, group, 'pending');
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users/${pending.id}/reject`) // UUID
      .expect(200);
    const ug = await UserGroup.findOne({ where: { user_uuid: pending.id, group_id: group.id } });
    expect(ug).toBeNull();
  });

  // 87.3 code-review H2 (flipped at PR-C per amended D1): approve/reject keep
  // their sub-shape coverage, but the pinned behavior is now REJECTION — the
  // sub fallback is removed, so a sub-shaped target 404s and mutates nothing.
  it('approve: REJECTS a sub-shaped pending-member target (D1 contraction) -> 404, still pending', async () => {
    const pending = await makeUser({ user_id: 'auth0|dk-pending3', username: 'dk-pending3' });
    await addToGroup(pending, group, 'pending');
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users/${encodeURIComponent(pending.user_id)}/approve`) // sub
      .expect(404);
    const ug = await UserGroup.findOne({ where: { user_uuid: pending.id, group_id: group.id } });
    expect(ug.role).toBe('pending'); // unchanged — no fail-open
  });

  it('reject: REJECTS a sub-shaped pending-member target (D1 contraction) -> 404, row survives', async () => {
    const pending = await makeUser({ user_id: 'auth0|dk-pending4', username: 'dk-pending4' });
    await addToGroup(pending, group, 'pending');
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users/${encodeURIComponent(pending.user_id)}/reject`) // sub
      .expect(404);
    const ug = await UserGroup.findOne({ where: { user_uuid: pending.id, group_id: group.id } });
    expect(ug).not.toBeNull(); // still present — no fail-open
  });

  // ---- POST /:group_id/transfer-ownership ----
  it('transfer-ownership: accepts a UUID-shaped new_owner_user_id -> 200, swaps roles, echoes UUIDs (Req 2)', async () => {
    const res = await request(makeApp(owner))
      .post(`/api/groups/${group.id}/transfer-ownership`)
      .send({ new_owner_user_id: member.id }) // UUID
      .expect(200);
    expect(res.body.success).toBe(true);
    // PR-C: both echoed identifiers carry the Users.id UUIDs, never a sub.
    expect(res.body.new_owner_user_id).toBe(member.id);
    expect(res.body.previous_owner_user_id).toBe(owner.id);
    const ownerUg = await UserGroup.findOne({ where: { user_uuid: owner.id, group_id: group.id } });
    const memberUg = await UserGroup.findOne({ where: { user_uuid: member.id, group_id: group.id } });
    expect(ownerUg.role).toBe('admin');
    expect(memberUg.role).toBe('owner');
  });

  it('transfer-ownership: REJECTS a sub-shaped new_owner_user_id (D1 contraction) -> 404, roles unchanged', async () => {
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/transfer-ownership`)
      .send({ new_owner_user_id: member.user_id }) // sub
      .expect(404);
    const ownerUg = await UserGroup.findOne({ where: { user_uuid: owner.id, group_id: group.id } });
    const memberUg = await UserGroup.findOne({ where: { user_uuid: member.id, group_id: group.id } });
    expect(ownerUg.role).toBe('owner'); // unchanged — no fail-open
    expect(memberUg.role).toBe('member');
  });

  it('transfer-ownership: rejects a self-transfer via the UUID shape -> 400 (guard on resolved identity)', async () => {
    const res = await request(makeApp(owner))
      .post(`/api/groups/${group.id}/transfer-ownership`)
      .send({ new_owner_user_id: owner.id }) // owner's OWN uuid
      .expect(400);
    expect(res.body.error).toMatch(/yourself/i);
    // No fail-open: owner is still owner.
    const ownerUg = await UserGroup.findOne({ where: { user_uuid: owner.id, group_id: group.id } });
    expect(ownerUg.role).toBe('owner');
  });

  it('transfer-ownership: rejects a non-string new_owner_user_id body (87.3 review #6 input hygiene) -> 400', async () => {
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/transfer-ownership`)
      .send({ new_owner_user_id: [member.id] }) // array — must not coerce
      .expect(400);
    const memberUg = await UserGroup.findOne({ where: { user_uuid: member.id, group_id: group.id } });
    expect(memberUg.role).toBe('member');
  });
});
