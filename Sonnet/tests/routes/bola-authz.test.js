// tests/routes/bola-authz.test.js
//
// Cross-actor 403 / PII-stripping regression for the OPEN BOLA holes closed in
// Plan 83-05 (BSEC-01/02). Uses the req.user-injecting stubAuth harness
// (tests/helpers/authStub.js) mounted BEFORE the router so the 403 branch is
// actually reachable (Pitfall 1) — otherwise an undefined req.user short-circuits
// every check at the 401 guard and the 403 path is never exercised.
//
// DB NOTE: these assertions create reviews / groups / events, so they require a
// Postgres test database. In environments without a sandbox DB they are
// CI-deferred (run at phase end against the CI Postgres service container) —
// mirroring 83-01/03/04. They are NOT faked.

const request = require('supertest');
const express = require('express');
const { stubAuth } = require('../helpers/authStub');
const gameReviewRoutes = require('../../routes/gameReviews');
const groupRoutes = require('../../routes/groups');
const eventRoutes = require('../../routes/events');
const feedbackRoutes = require('../../routes/feedback');
const { optionalAuth } = require('../../middleware/auth0');
const {
  GameReview, User, Group, Game, UserGroup, Event, EventParticipation, Feedback, sequelize,
} = require('../../models');

// Build an app with a fixed stubbed actor mounted before the router under test.
const appWith = (actor, mountPath, routes, { optional = false } = {}) => {
  const app = express();
  app.use(express.json());
  if (optional) {
    // Feedback runs under mount-level optionalAuth in production; emulate it but
    // force req.user to the stubbed actor (or null) so requirePlatformAdmin sees
    // exactly what the production gate would hand it.
    app.use((req, _res, next) => { req.user = actor; next(); });
  } else {
    app.use(stubAuth(actor));
  }
  app.use(mountPath, routes);
  return app;
};

describe('BOLA cross-actor 403 regression (Plan 83-05)', () => {
  let owner, attacker, group, game;
  const ts = Date.now();

  beforeAll(async () => {
    owner = await User.create({
      user_id: `bola-owner-${ts}`, username: `owner-${ts}`, email: `owner-${ts}@example.com`,
    });
    attacker = await User.create({
      user_id: `bola-attacker-${ts}`, username: `attacker-${ts}`, email: `attacker-${ts}@example.com`,
    });
    group = await Group.create({ group_id: `bola-group-${ts}`, name: 'BOLA Group' });
    game = await Game.create({ name: `BOLA Game ${ts}`, is_custom: true });
    // owner is an active member; attacker is NOT (Auth0-string user_id — matches isActiveMember).
    await UserGroup.create({ user_id: owner.user_id, group_id: group.id, role: 'owner', status: 'active' });
  });

  afterAll(async () => {
    await EventParticipation.destroy({ where: {} });
    await Event.destroy({ where: {} });
    await GameReview.destroy({ where: {} });
    await Feedback.destroy({ where: {} });
    await UserGroup.destroy({ where: {} });
    await Group.destroy({ where: {} });
    await Game.destroy({ where: {} });
    await User.destroy({ where: {} });
    await sequelize.close();
  });

  // ---- Test 1: gameReviews DELETE — cross-actor spoof → 403 (BE-100) ----------
  describe('DELETE /api/game-reviews/:id (BE-100)', () => {
    it('rejects an attacker deleting the owner\'s review even with spoofed body.user_id → 403', async () => {
      const review = await GameReview.create({
        user_id: owner.id, group_id: group.id, game_id: game.id, rating: 4,
      });
      const app = appWith({ user_id: attacker.user_id }, '/api/game-reviews', gameReviewRoutes);
      const res = await request(app)
        .delete(`/api/game-reviews/${review.id}`)
        .send({ user_id: owner.user_id }); // spoof — must be ignored
      expect(res.status).toBe(403);
      // review still exists
      expect(await GameReview.findByPk(review.id)).not.toBeNull();
    });

    it('lets the owner delete their own review → 200', async () => {
      // The prior test leaves a review for the same (user_id, group_id, game_id);
      // GameReview has a unique index on that triple, so clear it before re-creating.
      await GameReview.destroy({ where: { user_id: owner.id, group_id: group.id, game_id: game.id } });
      const review = await GameReview.create({
        user_id: owner.id, group_id: group.id, game_id: game.id, rating: 5,
      });
      const app = appWith({ user_id: owner.user_id }, '/api/game-reviews', gameReviewRoutes);
      const res = await request(app).delete(`/api/game-reviews/${review.id}`).send({});
      expect(res.status).toBe(200);
      expect(await GameReview.findByPk(review.id)).toBeNull();
    });
  });

  // ---- Test 2: groups GET /:group_id — non-member 403, no invite_token (BE-043)
  describe('GET /api/groups/:group_id (BE-043)', () => {
    it('non-member → 403', async () => {
      const app = appWith({ user_id: attacker.user_id }, '/api/groups', groupRoutes);
      const res = await request(app).get(`/api/groups/${group.id}`);
      expect(res.status).toBe(403);
    });

    it('member → 200 and response has NO invite_token', async () => {
      const app = appWith({ user_id: owner.user_id }, '/api/groups', groupRoutes);
      const res = await request(app).get(`/api/groups/${group.id}`);
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty('invite_token');
    });
  });

  // ---- Test 3: events GET /group/:group_id — always membership-check, no email (BE-040)
  describe('GET /api/events/group/:group_id (BE-040)', () => {
    it('non-member with NO query param does NOT bypass the gate → 403', async () => {
      const app = appWith({ user_id: attacker.user_id }, '/api/events', eventRoutes);
      const res = await request(app).get(`/api/events/group/${group.id}`); // no ?user_id
      expect(res.status).toBe(403);
    });

    it('member → 200 and participation roster carries NO email', async () => {
      const event = await Event.create({
        group_id: group.id, title: 'BOLA Event', start_date: new Date(),
      });
      await EventParticipation.create({ event_id: event.id, user_id: owner.id });
      const app = appWith({ user_id: owner.user_id }, '/api/events', eventRoutes);
      const res = await request(app).get(`/api/events/group/${group.id}`);
      expect(res.status).toBe(200);
      const participations = res.body.flatMap((e) => e.EventParticipations || []);
      participations.forEach((p) => {
        if (p.User) expect(p.User).not.toHaveProperty('email');
      });
    });
  });

  // ---- Test 4: feedback GET / — non-platform-admin / null req.user → 403 (BE-099)
  describe('GET /api/feedback (BE-099)', () => {
    it('null req.user (no token) → 403 (not 401)', async () => {
      const app = appWith(null, '/api/feedback', feedbackRoutes, { optional: true });
      const res = await request(app).get('/api/feedback');
      expect(res.status).toBe(403);
    });

    it('non-platform-admin authed user → 403', async () => {
      const app = appWith({ user_id: attacker.user_id }, '/api/feedback', feedbackRoutes, { optional: true });
      const res = await request(app).get('/api/feedback');
      expect(res.status).toBe(403);
    });
  });

  // ---- Test 5: groups POST /:group_id/users — owner/admin only (BE-044) --------
  describe('POST /api/groups/:group_id/users (BE-044)', () => {
    it('non-member/non-admin attacker → 403 and no membership created', async () => {
      const target = await User.create({
        user_id: `bola-target-${ts}`, username: `target-${ts}`, email: `target-${ts}@example.com`,
      });
      const app = appWith({ user_id: attacker.user_id }, '/api/groups', groupRoutes);
      const res = await request(app)
        .post(`/api/groups/${group.id}/users`)
        .send({ user_id: target.user_id });
      expect(res.status).toBe(403);
      const membership = await UserGroup.findOne({ where: { user_id: target.user_id, group_id: group.id } });
      expect(membership).toBeNull();
    });

    it('owner → 200 and the target user is added as a member', async () => {
      const target = await User.create({
        user_id: `bola-target2-${ts}`, username: `target2-${ts}`, email: `target2-${ts}@example.com`,
      });
      const app = appWith({ user_id: owner.user_id }, '/api/groups', groupRoutes);
      const res = await request(app)
        .post(`/api/groups/${group.id}/users`)
        .send({ user_id: target.user_id });
      expect(res.status).toBe(200);
      const membership = await UserGroup.findOne({ where: { user_id: target.user_id, group_id: group.id } });
      expect(membership).not.toBeNull();
      expect(membership.role).toBe('member');
    });
  });
});
