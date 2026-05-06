// tests/routes/polls.test.js
// Integration tests for the polls REST surface (POLL-01).
// Exercises the locked CONTEXT decisions:
//   D-POLL-CREATE-02 — active members only on create
//   D-POLL-CREATE-04 — lifecycle (manual / deadline / consensus)
//   D-POLL-CREATE-05 — consensus = 100% of active members
//   D-POLL-CREATE-09 — 1-14 day window
//   D-POLL-CREATE-10 — one open poll per group (DB partial unique index → 409)
//   D-POLL-CREATE-11 — running heatmap visibility (responses included in GET)
//   Lazy-on-read deadline auto-close on GETs.
//
// Auth0 middleware is short-circuited by injecting `req.user` ahead of the
// router (the same pattern other test files in this repo use; the verifyAuth0Token
// middleware is mounted at the server.js level, NOT inside routes/polls.js).
const request = require('supertest');
const express = require('express');

// Mock notificationService BEFORE requiring pollService so we don't actually
// fire emails/SMS during tests.
jest.mock('../../services/notificationService', () => {
  const sendCalls = [];
  return {
    send: jest.fn(async (...args) => { sendCalls.push(args); return { email: null, sms: null }; }),
    sendToMany: jest.fn(async () => []),
    getPreference: jest.fn(() => true),
    __sendCalls: sendCalls,
  };
});

const pollRoutes = require('../../routes/polls');
const { Poll, PollResponse, User, Group, UserGroup, sequelize } = require('../../models');

// Helper: build a test app that injects req.user (no real Auth0).
function makeApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: userId, email: `${userId}@example.com` };
    next();
  });
  app.use('/api/polls', pollRoutes);
  return app;
}

describe('Poll Routes (POLL-01)', () => {
  let group;
  const owner = { user_id: 'auth0|poll-owner', email: 'owner@example.com', username: 'owner' };
  const member = { user_id: 'auth0|poll-member', email: 'member@example.com', username: 'member' };
  const stranger = { user_id: 'auth0|poll-stranger', email: 'stranger@example.com', username: 'stranger' };

  beforeAll(async () => {
    await sequelize.sync();
    // Sequelize.sync() does NOT recreate the partial unique index from the
    // migration (Sequelize doesn't model partial indexes). Re-create it here
    // so the D-POLL-CREATE-10 one-open-per-group enforcement is testable.
    await sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "polls_one_open_per_group_idx"
         ON "Polls" ("group_id") WHERE status = 'open';`
    );
  });

  beforeEach(async () => {
    // Order matters: kill PollResponse → Poll → UserGroup → Group/User
    await PollResponse.destroy({ where: {} });
    await Poll.destroy({ where: {} });
    await UserGroup.destroy({ where: {} });
    await Group.destroy({ where: {} });
    await User.destroy({ where: { user_id: [owner.user_id, member.user_id, stranger.user_id] } });

    await User.create(owner);
    await User.create(member);
    await User.create(stranger);
    group = await Group.create({ group_id: `polltest-${Date.now()}`, name: 'PollTestGroup' });
    await UserGroup.create({ user_id: owner.user_id, group_id: group.id, status: 'active', role: 'owner' });
    await UserGroup.create({ user_id: member.user_id, group_id: group.id, status: 'active', role: 'member' });
    // stranger is NOT in the group
  });

  // Note: do NOT call sequelize.close() in afterAll — tests/setup.js owns the
  // shared connection lifecycle. Closing here would break other test files
  // that run after this one in the same Jest process.

  describe('POST /api/polls', () => {
    it('creates a poll for an active member and returns 201', async () => {
      const app = makeApp(owner.user_id);
      const res = await request(app)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('open');
      expect(res.body.group_id).toBe(group.id);
      expect(res.body.created_by_user_id).toBe(owner.user_id);
    });

    it('returns 403 for a non-member', async () => {
      const app = makeApp(stranger.user_id);
      await request(app)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(403);
    });

    it('returns 409 if a poll is already open in that group (D-POLL-CREATE-10)', async () => {
      const app = makeApp(owner.user_id);
      await request(app)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      const res = await request(app)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-08',
          date_window_end: '2030-06-14',
          response_deadline: '2030-06-07T18:00:00.000Z',
        })
        .expect(409);
      expect(res.body.error).toMatch(/already.*open/i);
    });

    it('returns 400 if the date window exceeds 14 days (D-POLL-CREATE-09)', async () => {
      const app = makeApp(owner.user_id);
      await request(app)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-30',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(400);
    });

    it('returns 400 if response_deadline is not before window start', async () => {
      const app = makeApp(owner.user_id);
      await request(app)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-06-02T18:00:00.000Z',
        })
        .expect(400);
    });
  });

  describe('POST /api/polls/:id/responses', () => {
    it('upserts a response — second call from same user updates rather than duplicates', async () => {
      // Owner creates poll
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      const pollId = create.body.id;

      // Member responds
      const memberApp = makeApp(member.user_id);
      const r1 = await request(memberApp)
        .post(`/api/polls/${pollId}/responses`)
        .send({ slot_data: [{ date: '2030-06-01', slot: '2030-06-01T19:00:00.000Z', available: true }] })
        .expect(200);
      expect(r1.body.poll_id).toBe(pollId);
      expect(r1.body.user_id).toBe(member.user_id);

      // Member updates
      const r2 = await request(memberApp)
        .post(`/api/polls/${pollId}/responses`)
        .send({ slot_data: [{ date: '2030-06-02', slot: '2030-06-02T19:00:00.000Z', available: true }] })
        .expect(200);
      expect(r2.body.id).toBe(r1.body.id); // same row

      const count = await PollResponse.count({ where: { poll_id: pollId, user_id: member.user_id } });
      expect(count).toBe(1);
    });

    it('returns 403 if responder is not an active member', async () => {
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      const strangerApp = makeApp(stranger.user_id);
      await request(strangerApp)
        .post(`/api/polls/${create.body.id}/responses`)
        .send({ slot_data: [] })
        .expect(403);
    });

    it('auto-closes with reason=consensus once 100% of active members respond (D-POLL-CREATE-04/05)', async () => {
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      const pollId = create.body.id;

      // Owner responds
      await request(ownerApp)
        .post(`/api/polls/${pollId}/responses`)
        .send({ slot_data: [{ date: '2030-06-01', slot: '2030-06-01T19:00:00.000Z', available: true }] })
        .expect(200);
      // Member responds → 100% — should auto-close consensus
      const memberApp = makeApp(member.user_id);
      await request(memberApp)
        .post(`/api/polls/${pollId}/responses`)
        .send({ slot_data: [{ date: '2030-06-01', slot: '2030-06-01T19:00:00.000Z', available: true }] })
        .expect(200);

      // checkAutoClose runs in the background after submit. Poll the DB briefly.
      let final;
      for (let i = 0; i < 20; i++) {
        final = await Poll.findByPk(pollId);
        if (final.status === 'closed') break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(final.status).toBe('closed');
      expect(final.close_reason).toBe('consensus');
    });
  });

  describe('POST /api/polls/:id/close', () => {
    it('creator can manually end the poll (D-POLL-CREATE-13)', async () => {
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      const res = await request(ownerApp)
        .post(`/api/polls/${create.body.id}/close`)
        .expect(200);
      expect(res.body.status).toBe('closed');
      expect(res.body.close_reason).toBe('manual');
    });

    it('non-creator non-admin members cannot close', async () => {
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      const memberApp = makeApp(member.user_id);
      await request(memberApp)
        .post(`/api/polls/${create.body.id}/close`)
        .expect(403);
    });
  });

  describe('Lazy-on-read deadline auto-close (D-POLL-CREATE-04 REQUIRED path)', () => {
    it('GET /api/polls/:id force-closes a poll past its deadline before returning', async () => {
      // Create a poll directly with deadline in the past (bypass route validation)
      const poll = await Poll.create({
        group_id: group.id,
        created_by_user_id: owner.user_id,
        date_window_start: '2030-06-01',
        date_window_end: '2030-06-07',
        response_deadline: new Date(Date.now() - 60_000), // 1 min ago
      });

      const app = makeApp(owner.user_id);
      const res = await request(app).get(`/api/polls/${poll.id}`).expect(200);
      expect(res.body.status).toBe('closed');
      expect(res.body.close_reason).toBe('deadline');
    });

    it('GET /api/polls/group/:groupId returns null after lazy auto-close clears the active surface', async () => {
      await Poll.create({
        group_id: group.id,
        created_by_user_id: owner.user_id,
        date_window_start: '2030-06-01',
        date_window_end: '2030-06-07',
        response_deadline: new Date(Date.now() - 60_000),
      });

      const app = makeApp(owner.user_id);
      const res = await request(app).get(`/api/polls/group/${group.id}`).expect(200);
      // getActivePoll only returns 'open' polls, so after deadline auto-close it should be null
      expect(res.body).toBeNull();
    });
  });

  describe('GET /api/polls/group/:groupId — running heatmap (D-POLL-CREATE-11)', () => {
    it('returns the active poll with PollResponses included', async () => {
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);

      const memberApp = makeApp(member.user_id);
      await request(memberApp)
        .post(`/api/polls/${create.body.id}/responses`)
        .send({ slot_data: [{ date: '2030-06-01', slot: '2030-06-01T19:00:00.000Z', available: true }] })
        .expect(200);

      const res = await request(ownerApp).get(`/api/polls/group/${group.id}`).expect(200);
      expect(res.body.id).toBe(create.body.id);
      expect(Array.isArray(res.body.PollResponses)).toBe(true);
      // The owner has 0 responses + member has 1 — but we only created member's response
      const memberResp = res.body.PollResponses.find((r) => r.user_id === member.user_id);
      expect(memberResp).toBeDefined();
    });
  });

  describe('POST /api/polls/:id/dismiss-notification', () => {
    it('creator can dismiss; non-creator gets 403', async () => {
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);
      const pollId = create.body.id;

      // Member tries — 403
      const memberApp = makeApp(member.user_id);
      await request(memberApp).post(`/api/polls/${pollId}/dismiss-notification`).expect(403);

      // Creator dismisses
      const res = await request(ownerApp).post(`/api/polls/${pollId}/dismiss-notification`).expect(200);
      expect(res.body.closed_notification_dismissed_at).toBeTruthy();
    });
  });

  describe('GET /api/polls/pending-for-me', () => {
    it('returns open polls in groups the caller is in AND has not responded to; excludes responded polls', async () => {
      const ownerApp = makeApp(owner.user_id);
      const create = await request(ownerApp)
        .post('/api/polls')
        .send({
          group_id: group.id,
          date_window_start: '2030-06-01',
          date_window_end: '2030-06-07',
          response_deadline: '2030-05-31T18:00:00.000Z',
        })
        .expect(201);

      // Member's pending list should include this poll
      const memberApp = makeApp(member.user_id);
      const before = await request(memberApp).get('/api/polls/pending-for-me').expect(200);
      expect(before.body.find((p) => p.id === create.body.id)).toBeDefined();

      // After responding, it should drop out
      await request(memberApp)
        .post(`/api/polls/${create.body.id}/responses`)
        .send({ slot_data: [{ date: '2030-06-01', slot: '2030-06-01T19:00:00.000Z', available: true }] })
        .expect(200);

      // Wait for any auto-close fan-out in flight
      await new Promise(r => setTimeout(r, 50));

      const after = await request(memberApp).get('/api/polls/pending-for-me').expect(200);
      expect(after.body.find((p) => p.id === create.body.id)).toBeUndefined();

      // Stranger — not a member of any group — gets []
      const strangerApp = makeApp(stranger.user_id);
      const strangerList = await request(strangerApp).get('/api/polls/pending-for-me').expect(200);
      expect(strangerList.body).toEqual([]);
    });
  });
});
