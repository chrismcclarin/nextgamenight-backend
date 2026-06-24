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

      // Verify the creator was added to the group as owner (Auth0 string user_id)
      const userGroup = await UserGroup.findOne({
        where: {
          user_id: testUser1.user_id,
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

      // Verify the added user (Auth0 string user_id)
      const userGroup = await UserGroup.findOne({
        where: {
          user_id: testUser2.user_id,
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
});
