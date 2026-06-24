// tests/routes/events.test.js
const request = require('supertest');
const express = require('express');
const eventRoutes = require('../../routes/events');
const { Event, Game, User, Group, EventParticipation, UserGroup } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

// The event routes derive the actor from req.user (BE-040/BE-044 / BSEC-01
// default-deny authz, Phase 83) and always membership-check. Build a per-test
// app that injects req.user ahead of the router (mirrors authStub.js + the
// leave-cascade suites). Without it every handler short-circuits at 401.
function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor ? { user_id: actor.user_id, email: actor.email } : undefined;
    next();
  });
  app.use('/api/events', eventRoutes);
  return app;
}

describe('Event Routes', () => {
  let testUser1, testUser2, testGroup, testGame;

  // Seed in beforeEach so fixtures survive the global per-test TRUNCATE
  // (plan-01 isolation harness). Connection lifecycle is owned by
  // tests/globalTeardown.js — this suite never calls sequelize.close().
  // testUser1 is the group OWNER (passes member + owner/admin gates);
  // testUser2 is a non-member (used for the 403 path).
  beforeEach(async () => {
    testUser1 = await makeUser({ user_id: 'test-user-events-1', username: 'testuser1' });
    testUser2 = await makeUser({ user_id: 'test-user-events-2', username: 'testuser2' });

    testGroup = await makeGroup({ group_id: 'test-group-events-1', name: 'Test Group' });

    testGame = await Game.create({
      name: 'Test Game',
      is_custom: true
    });

    // testUser1 is the owner of the group (Auth0 string user_id via factory).
    await addToGroup(testUser1, testGroup, 'owner');
  });

  describe('GET /api/events/group/:group_id', () => {
    it('should get all events for a group (member access)', async () => {
      await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      const response = await request(makeApp(testUser1))
        .get(`/api/events/group/${testGroup.id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should return 403 if actor not in group', async () => {
      const response = await request(makeApp(testUser2))
        .get(`/api/events/group/${testGroup.id}`)
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Access denied to this group');
    });

    it('should return 401 if unauthenticated', async () => {
      const response = await request(makeApp(null))
        .get(`/api/events/group/${testGroup.id}`)
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });
  });

  describe('POST /api/events', () => {
    it('should create a new event', async () => {
      const eventData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date().toISOString(),
        duration_minutes: 60
      };

      const response = await request(makeApp(testUser1))
        .post('/api/events')
        .send(eventData)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.group_id).toBe(testGroup.id);
      expect(response.body.game_id).toBe(testGame.id);
    });

    it('should create event with participants', async () => {
      const eventData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date().toISOString(),
        participants: [
          {
            // EventParticipation.user_id is a UUID (User.id) — correct to use .id here.
            user_id: testUser1.id,
            score: 100,
            placement: 1
          }
        ]
      };

      const response = await request(makeApp(testUser1))
        .post('/api/events')
        .send(eventData)
        .expect(200);

      expect(response.body).toHaveProperty('EventParticipations');
      expect(response.body.EventParticipations.length).toBe(1);
    });

    it('should return 403 if actor not a member of the group', async () => {
      const eventData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date().toISOString(),
        duration_minutes: 60
      };

      const response = await request(makeApp(testUser2))
        .post('/api/events')
        .send(eventData)
        .expect(403);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('PUT /api/events/:id', () => {
    it('should update an event', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      const updateData = {
        duration_minutes: 120,
        comments: 'Updated comment'
      };

      const response = await request(makeApp(testUser1))
        .put(`/api/events/${event.id}`)
        .send(updateData)
        .expect(200);

      expect(response.body.duration_minutes).toBe(updateData.duration_minutes);
      expect(response.body.comments).toBe(updateData.comments);
    });

    it('should update event participants', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      await EventParticipation.create({
        event_id: event.id,
        user_id: testUser1.id, // EventParticipation.user_id is UUID — correct.
        score: 50
      });

      const updateData = {
        participants: [
          {
            user_id: testUser1.id, // UUID — correct.
            score: 100,
            placement: 1
          }
        ]
      };

      const response = await request(makeApp(testUser1))
        .put(`/api/events/${event.id}`)
        .send(updateData)
        .expect(200);

      expect(response.body.EventParticipations.length).toBe(1);
      // score is DECIMAL(10,2); pg/Sequelize serializes it as a string.
      expect(Number(response.body.EventParticipations[0].score)).toBe(100);
    });

    it('should return 404 if event not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(makeApp(testUser1))
        .put(`/api/events/${fakeId}`)
        .send({ duration_minutes: 120 })
        .expect(404);

      expect(response.body.error).toBe('Event not found');
    });
  });

  describe('DELETE /api/events/:id', () => {
    it('should delete an event', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      const response = await request(makeApp(testUser1))
        .delete(`/api/events/${event.id}`)
        .expect(200);

      expect(response.body.message).toBe('Event deleted successfully');

      // Verify event is deleted
      const deletedEvent = await Event.findByPk(event.id);
      expect(deletedEvent).toBeNull();
    });

    it('should delete event and its participations', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      await EventParticipation.create({
        event_id: event.id,
        user_id: testUser1.id, // UUID — correct.
        score: 100
      });

      await request(makeApp(testUser1))
        .delete(`/api/events/${event.id}`)
        .expect(200);

      // Verify participations are deleted
      const participations = await EventParticipation.findAll({
        where: { event_id: event.id }
      });
      expect(participations.length).toBe(0);
    });

    it('should return 404 if event not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(makeApp(testUser1))
        .delete(`/api/events/${fakeId}`)
        .expect(404);

      expect(response.body.error).toBe('Event not found');
    });
  });
});
