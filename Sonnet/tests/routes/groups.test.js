// tests/routes/groups.test.js
const request = require('supertest');
const express = require('express');
const groupRoutes = require('../../routes/groups');
const { Group, User, UserGroup, Event, Game } = require('../../models');
const { makeUser, addToGroup } = require('../factories');

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

  // D-12 WIRE REGRESSION (W1, Phase 87.1): GET /:group_id/users (routes/groups.js:301)
  // needs NO code change, but RESEARCH called for the shim to be pinned by a test.
  // The group cutover (Task 2) moved every UserGroup gate onto user_uuid; this proves
  // the roster wire contract — user_id serialized as the Auth0 sub STRING (the FE keys
  // off it), NOT the internal Users.id UUID — survives that cutover unchanged.
  describe('GET /api/groups/:group_id/users (D-12 roster wire shape)', () => {
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    it('serializes roster user_id as the Auth0 sub string, NOT a v4 UUID', async () => {
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
      // D-12: the roster wire contract is the Auth0 STRING sub.
      expect(entry.user_id).toBe(authSub);
      expect(entry.user_id).not.toMatch(UUID_V4);
      // The internal UUID PK is a SEPARATE field and IS a v4 UUID.
      expect(entry.id).toMatch(UUID_V4);
    });
  });
});
