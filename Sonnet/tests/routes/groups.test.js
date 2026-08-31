// tests/routes/groups.test.js
const request = require('supertest');
const express = require('express');
const groupRoutes = require('../../routes/groups');
const { Group, User, UserGroup, Event, Game } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

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

  // Phase 87.6 (groups-add-user, Tier 1): POST /:group_id/users DELETED. Superseded
  // by the invite / QR join flows (join-by-token + group invites). Zero FE callers
  // of addUserToGroup (multi-line-aware `rg -U` re-confirmation, 2026-07-24 — a
  // single-line grep MISSES the `router.post(\n '/:group_id/users',` def). The prior
  // BE-044 owner/admin-gate + resolve-target behavioral assertions retire WITH the
  // route. Seed an owner + real group so the 404 unambiguously means "route removed",
  // not a live handler's authz/not-found branch. GET /:group_id/users (roster) is a
  // DIFFERENT live route, pinned separately below.
  describe('POST /api/groups/:group_id/users (deleted 87.6 groups-add-user)', () => {
    it('404s — route deleted', async () => {
      const testGroup = await Group.create({
        group_id: 'test-group-3-deleted',
        name: 'Test Group 3 (deleted-route pin)'
      });
      await addToGroup(testUser1, testGroup, 'owner');

      await request(makeApp(testUser1))
        .post(`/api/groups/${testGroup.id}/users`)
        .send({ user_id: testUser2.user_id })
        .expect(404);
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

  // ---- POST /:group_id/users add-member path — DELETED (Phase 87.6 groups-add-user) ----
  // This was the SOLE retained dual-key add-member/friend-invite route after the
  // 87.3 amended-D1 contraction. It is removed this phase (Tier 1 — superseded by
  // the invite / QR join flows). Its prior behavioral cases (UUID target,
  // sub-shaped dual-key, and the review #6 non-string input-hygiene 400) retire
  // WITH the route — the dual-key resolution + validator surface no longer exists.
  // Pin here too so the deletion is proven from THIS block's actor seam (the
  // canonical pin also lives in the 'GET/POST roster' block above).
  it('add-member POST /:group_id/users 404s — route deleted (87.6 groups-add-user)', async () => {
    const newcomer = await makeUser({ user_id: 'auth0|dk-newcomer', username: 'dk-newcomer' });
    await request(makeApp(owner))
      .post(`/api/groups/${group.id}/users`)
      .send({ user_id: newcomer.id })
      .expect(404);
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

// ============================================================================
// Phase 88.2 Plan 06 Task 3 — GET /api/groups/:group_id/deletion-impact (D-06)
//
// The Danger Zone's server-side source of truth for the blast radius. Owner-only,
// 404 on a soft-deleted group, and counts computed here rather than in the client
// (a client-side count risks telling the owner "4 events" while 37 are hidden).
// ============================================================================
describe('GET /api/groups/:group_id/deletion-impact', () => {
  let owner;
  let member;
  let outsider;
  let group;

  beforeEach(async () => {
    owner = await makeUser({ username: 'impact-owner' });
    member = await makeUser({ username: 'impact-member' });
    outsider = await makeUser({ username: 'impact-outsider' });
    group = await Group.create({ group_id: `impact-${Date.now()}`, name: 'Impact Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(member, group, 'member');
  });

  /** Stamp the group + its memberships, matching the real soft-delete discipline. */
  async function stamp(groupId) {
    const deletedAt = new Date();
    await Group.update(
      { deletedAt, purge_after: new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000) },
      { where: { id: groupId }, silent: true }
    );
    await UserGroup.update({ deletedAt }, { where: { group_id: groupId }, silent: true });
    await Event.update({ deletedAt }, { where: { group_id: groupId }, silent: true });
  }

  it('returns the REAL member and event counts, cross-checked against direct model counts', async () => {
    // 6 active members total (the owner + 5 more; `member` from the beforeEach is one).
    for (let i = 0; i < 4; i += 1) {
      const extra = await makeUser({ username: `impact-extra-${i}` });
      await addToGroup(extra, group, i === 0 ? 'admin' : 'member');
    }
    await Event.bulkCreate(
      Array.from({ length: 37 }, (_, i) => ({
        group_id: group.id,
        start_date: new Date(Date.UTC(2026, 8, 1 + i, 18, 0, 0)),
        status: 'scheduled',
      }))
    );

    const res = await request(makeApp(owner))
      .get(`/api/groups/${group.id}/deletion-impact`)
      .expect(200);

    // Cross-checked against the database, not against the constants used to seed —
    // a seeding bug would otherwise agree with itself.
    const actualMembers = await UserGroup.count({
      where: { group_id: group.id, status: 'active' },
    });
    const actualEvents = await Event.count({ where: { group_id: group.id } });

    expect(res.body.member_count).toBe(actualMembers);
    expect(res.body.event_count).toBe(actualEvents);
    expect(res.body.member_count).toBe(6);
    expect(res.body.event_count).toBe(37);
  });

  it('the response body keys are exactly member_count, event_count and recovery_window_days', async () => {
    const res = await request(makeApp(owner))
      .get(`/api/groups/${group.id}/deletion-impact`)
      .expect(200);

    expect(Object.keys(res.body).sort()).toEqual(
      ['event_count', 'member_count', 'recovery_window_days'].sort()
    );
    // Served so the Danger Zone copy does not hard-code 30 in a second place.
    expect(res.body.recovery_window_days).toBe(30);
  });

  it('excludes invited and declined memberships from member_count', async () => {
    const invited = await makeUser({ username: 'impact-invited' });
    const declined = await makeUser({ username: 'impact-declined' });
    await UserGroup.create({
      user_uuid: invited.id, group_id: group.id, role: 'member', status: 'invited',
    });
    await UserGroup.create({
      user_uuid: declined.id, group_id: group.id, role: 'member', status: 'declined',
    });

    const res = await request(makeApp(owner))
      .get(`/api/groups/${group.id}/deletion-impact`)
      .expect(200);

    // Only the owner + the active member.
    expect(res.body.member_count).toBe(2);
  });

  it('403s a role-member caller ON A LIVE GROUP', async () => {
    const res = await request(makeApp(member))
      .get(`/api/groups/${group.id}/deletion-impact`)
      .expect(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  it('403s a caller with no membership at all ON A LIVE GROUP', async () => {
    await request(makeApp(outsider))
      .get(`/api/groups/${group.id}/deletion-impact`)
      .expect(403);
  });

  it('404s a SOFT-DELETED group for its own former OWNER (the AF-2 guard-order pin)', async () => {
    await stamp(group.id);

    // Asserted as the owner, not as a stranger: this is the exact case that flips to
    // 403 if the existence check is ever reordered behind the ownership check, because
    // the owner's own membership row is stamped too.
    const res = await request(makeApp(owner))
      .get(`/api/groups/${group.id}/deletion-impact`)
      .expect(404);
    expect(res.body.error).toBe('Group not found');
  });

  it('404s a well-formed UUID that was never a group', async () => {
    await request(makeApp(owner))
      .get('/api/groups/11111111-2222-4333-8444-555555555555/deletion-impact')
      .expect(404);
  });

  it('rejects a malformed group_id at the validator, before any DB read', async () => {
    const spy = jest.spyOn(Group, 'findByPk');
    try {
      await request(makeApp(owner))
        .get('/api/groups/not-a-uuid/deletion-impact')
        .expect(400);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('401s an unauthenticated caller', async () => {
    await request(makeApp(null))
      .get(`/api/groups/${group.id}/deletion-impact`)
      .expect(401);
  });
});

// ---------------------------------------------------------------------------
// Phase 88-34 Task 2 (WI-B2) — "Last Game" means the latest PAST game.
//
// The GET /api/groups/user/:user_id Event include (read by grouplist.js:230 as
// `group.Events?.[0]`) had NO where clause and ordered by createdAt DESC, so a
// future event created today won "Last Game".
// ---------------------------------------------------------------------------
describe('Phase 88-34 WI-B2 — Last Game include means PAST (history)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let owner, group, oldGame, recentGame, futureGame;

  const lastGameOf = async () => {
    const res = await request(makeApp(owner))
      .get(`/api/groups/user/${owner.user_id}`)
      .expect(200);
    return res.body.find((g) => g.id === group.id);
  };

  beforeEach(async () => {
    owner = await makeUser({ user_id: 'test-user-lastgame', username: 'lastgameowner' });
    group = await makeGroup({ group_id: 'test-group-lastgame', name: 'Last Game Group' });
    await addToGroup(owner, group, 'owner');
    oldGame = await Game.create({ name: 'Old Game', is_custom: true });
    recentGame = await Game.create({ name: 'Recent Game', is_custom: true });
    futureGame = await Game.create({ name: 'Future Game', is_custom: true });
  });

  it('a FUTURE event is invisible to Last Game — the latest PAST one wins', async () => {
    await Event.create({
      group_id: group.id, game_id: oldGame.id,
      start_date: new Date(Date.now() - 30 * DAY_MS), status: 'completed',
    });
    await Event.create({
      group_id: group.id, game_id: recentGame.id,
      start_date: new Date(Date.now() - 2 * DAY_MS), status: 'completed',
    });
    // Created LAST (so it wins createdAt DESC) and dated in the future — the
    // exact shape the walk caught.
    await Event.create({
      group_id: group.id, game_id: futureGame.id,
      start_date: new Date(Date.now() + 5 * DAY_MS), status: 'scheduled',
    });

    const g = await lastGameOf();
    expect(g.Events).toHaveLength(1);
    expect(g.Events[0].Game.name).toBe('Recent Game');
  });

  it('orders by start_date, not createdAt (a backfilled OLD session is not "last")', async () => {
    // Inserted second but played long ago: createdAt DESC would pick it.
    await Event.create({
      group_id: group.id, game_id: recentGame.id,
      start_date: new Date(Date.now() - 2 * DAY_MS), status: 'completed',
    });
    await Event.create({
      group_id: group.id, game_id: oldGame.id,
      start_date: new Date(Date.now() - 300 * DAY_MS), status: 'completed',
    });

    const g = await lastGameOf();
    expect(g.Events[0].Game.name).toBe('Recent Game');
  });

  it('excludes cancelled past events', async () => {
    await Event.create({
      group_id: group.id, game_id: recentGame.id,
      start_date: new Date(Date.now() - 10 * DAY_MS), status: 'completed',
    });
    await Event.create({
      group_id: group.id, game_id: oldGame.id,
      start_date: new Date(Date.now() - 1 * DAY_MS), status: 'cancelled',
    });

    const g = await lastGameOf();
    expect(g.Events[0].Game.name).toBe('Recent Game');
  });

  // The parent-drop class: with limit + where, a required/INNER join would drop
  // the whole Group row. A group whose only events are future must STILL return.
  it('(parent-drop pin, required:false) a group with ONLY future events still returns, with lastGame empty', async () => {
    await Event.create({
      group_id: group.id, game_id: futureGame.id,
      start_date: new Date(Date.now() + 5 * DAY_MS), status: 'scheduled',
    });

    const g = await lastGameOf();
    expect(g).toBeDefined();
    expect(g.id).toBe(group.id);
    expect(g.Events).toHaveLength(0);
  });

  it('(parent-drop pin) a group with ZERO events still returns', async () => {
    const g = await lastGameOf();
    expect(g).toBeDefined();
    expect(g.Events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 88.3.1 plan 02 Task 3 — PUT /:group_id/settings colour storage.
//
// This route had ZERO tests before this block (grep 'settings' on this file
// returned nothing), which is why the phase adds them here rather than only
// pinning the new field: an untested route is where a new column goes to be
// silently dropped.
//
// The two-column contract (CONTEXT D-01 / D-06):
//   color_preset     one of the eight preset ids -> the new path
//   background_color a legacy or custom #rrggbb  -> still supported, forever
//   both null        "no colour" (D-06's tap-again-to-clear payload)
// The backend STORES and RETURNS; it never derives, resolves or renders. Every
// round-trip case below asserts BOTH the response body AND a fresh findByPk,
// because they can disagree (the handler returns the in-memory instance) and
// SPEC Req 5's guarantee is about what was PERSISTED.
// ---------------------------------------------------------------------------
describe('PUT /:group_id/settings — colour preset storage (SPEC Req 5, D-01/D-06)', () => {
  let owner;
  let plainMember;
  let group;

  beforeEach(async () => {
    owner = await makeUser({ user_id: 'auth0|cp-owner', username: 'cp-owner' });
    plainMember = await makeUser({ user_id: 'auth0|cp-member', username: 'cp-member' });
    group = await makeGroup({ name: 'Colour Preset Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(plainMember, group, 'member');
  });

  const putSettings = (actor, body) =>
    request(makeApp(actor)).put(`/api/groups/${group.id}/settings`).send(body);

  // Read the row back WITHOUT the in-memory instance the handler returned.
  const reloadColour = async () => {
    const fresh = await Group.findByPk(group.id);
    return { color_preset: fresh.color_preset, background_color: fresh.background_color };
  };

  it('accepts a preset id and round-trips it byte-identical, in the body AND the row', async () => {
    const res = await putSettings(owner, { color_preset: 'blue', background_color: null }).expect(200);

    expect(res.body.color_preset).toBe('blue');
    expect(res.body.background_color).toBeNull();
    // The stored value is the WORD, never a resolved hex — D-01's whole point,
    // and SPEC's "the stored value never becomes a rendered value".
    await expect(reloadColour()).resolves.toEqual({ color_preset: 'blue', background_color: null });
  });

  it('still accepts a legacy/custom hex — D-01 keeps the fallback path open', async () => {
    const res = await putSettings(owner, { background_color: '#123456', color_preset: null }).expect(200);

    expect(res.body.background_color).toBe('#123456');
    expect(res.body.color_preset).toBeNull();
    await expect(reloadColour()).resolves.toEqual({ color_preset: null, background_color: '#123456' });
  });

  it('accepts BOTH null — this is D-06 tap-again-to-clear and must NOT 400', async () => {
    // Seed a colour first, so the clear has something to clear.
    await group.update({ color_preset: 'rose', background_color: '#3e133c' });

    const res = await putSettings(owner, { color_preset: null, background_color: null }).expect(200);

    expect(res.body.color_preset).toBeNull();
    expect(res.body.background_color).toBeNull();
    await expect(reloadColour()).resolves.toEqual({ color_preset: null, background_color: null });
  });

  it('normalises an empty / whitespace-only preset to NULL rather than storing it', async () => {
    // A stored '' is the worst outcome available: not a valid preset, and NOT
    // matched by the remap migration's `color_preset IS NULL` predicate, so the
    // row would be skipped forever. The validator's sanitizer collapses it.
    const res = await putSettings(owner, { color_preset: '   ' }).expect(200);

    expect(res.body.color_preset).toBeNull();
    const stored = await reloadColour();
    expect(stored.color_preset).toBeNull();
    expect(stored.color_preset).not.toBe('');
  });

  it('trims surrounding whitespace off an otherwise-valid preset id', async () => {
    await putSettings(owner, { color_preset: ' teal ' }).expect(200);
    await expect(reloadColour()).resolves.toMatchObject({ color_preset: 'teal' });
  });

  it('REJECTS an unknown preset id with a message naming the allowed ids', async () => {
    const res = await putSettings(owner, { color_preset: 'blurple' }).expect(400);

    const fieldError = res.body.errors.find((e) => e.field === 'color_preset');
    expect(fieldError).toBeDefined();
    expect(fieldError.message).toMatch(/red, orange, amber, green, teal, blue, violet, rose/);
    // Nothing was written.
    await expect(reloadColour()).resolves.toMatchObject({ color_preset: null });
  });

  it('REJECTS a HEX sent in the preset field — the two shapes are not interchangeable', async () => {
    // If a hex were accepted here the round-trip guarantee would be meaningless:
    // the frontend resolver looks the value up in the preset table, so a stored
    // hex in this column renders as nothing at all.
    const res = await putSettings(owner, { color_preset: '#00274d' }).expect(400);

    const fieldError = res.body.errors.find((e) => e.field === 'color_preset');
    expect(fieldError.message).toMatch(/must be one of/i);
    await expect(reloadColour()).resolves.toMatchObject({ color_preset: null });
  });

  it('REJECTS a non-string preset', async () => {
    const res = await putSettings(owner, { color_preset: 7 }).expect(400);
    const fieldError = res.body.errors.find((e) => e.field === 'color_preset');
    expect(fieldError.message).toMatch(/must be a string/i);
  });

  it('403s a plain member — the owner/admin gate is unchanged and still fires', async () => {
    const res = await putSettings(plainMember, { color_preset: 'blue' }).expect(403);

    expect(res.body.error).toMatch(/owners and admins/i);
    await expect(reloadColour()).resolves.toMatchObject({ color_preset: null });
  });

  // DECISION Phase 88.3.1 (colour vs. image precedence) — pinned so a future
  // "tidy-up" cannot turn this into a 400 or a silent null without reading the
  // marker at routes/groups.js. A conflicting pair STORES BOTH and 200s; the
  // image wins for RENDERING, decided by the frontend renderer that already
  // exists. A 400 here would make every legacy group that already carries both
  // permanently unsaveable (their picker seeds both, so the next save sends
  // both) — and this ships in BE PR-1, which merges first.
  it('stores BOTH a colour and an image when sent together, and 200s (precedence is a RENDER rule)', async () => {
    const res = await putSettings(owner, {
      color_preset: 'green',
      background_image_url: 'https://example.com/bg.png',
    }).expect(200);

    expect(res.body.color_preset).toBe('green');
    expect(res.body.background_image_url).toBe('https://example.com/bg.png');

    const fresh = await Group.findByPk(group.id);
    expect(fresh.color_preset).toBe('green');
    expect(fresh.background_image_url).toBe('https://example.com/bg.png');
  });

  // Anti-vacuity / mass assignment. AMENDMENT S (verified 2026-08-29): the guard
  // on this route is NOT the `validateStrict` matchedData strip — that middleware
  // has zero route usages and this route wires plain `validateGroupUpdate`. The
  // guard is the handler's explicit key-by-key `updateData` build
  // (routes/groups.js:1505-1524). This case proves THAT: a real column that is
  // not one of the four declared fields must not move, even though it is a valid
  // column name that Sequelize would happily have written.
  it('an undeclared body key does not reach the row — the explicit destructure is the guard', async () => {
    const originalName = group.name;

    await putSettings(owner, { color_preset: 'violet', name: 'HIJACKED' }).expect(200);

    const fresh = await Group.findByPk(group.id);
    expect(fresh.color_preset).toBe('violet'); // the declared field landed
    expect(fresh.name).toBe(originalName);     // the undeclared one did not
  });
});
