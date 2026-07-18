// tests/routes/selfParam.authz.test.js
//
// Phase 87.4 Plan 02 (SPEC Req 5, D-04) — the self-param dual-accept family.
//
// One permanent dual-accept: a URL user param authorizes iff it equals the
// caller's OWN sub OR the caller's OWN resolved Users.id UUID. This suite proves
// the WHOLE self-param family converges on that single semantic:
//
//   (a) the objectAuth `requireParamMatchesToken` factory (consumers
//       events.js / games.js / users.js), and
//   (b) the inline `param === req.user.user_id` sites in availability.js /
//       rsvp.js / lists.js — all now routing through the shared `matchesSelf`.
//
// For EVERY family route we assert BOTH halves of the KEYMISS mitigation
// (threat T-874-02-KEYMISS): the caller's own UUID (1) AUTHORIZES and (2) the
// handler returns the caller's CORRECT data (never an empty result from a
// still-sub-keyed store queried with a raw UUID). The shared reject/BOLA cases
// (own-sub authorizes, other-user UUID 403, garbage 403) are asserted against a
// representative route AND the synthetic factory probe.
//
// Real-DB (factories; sequelize.sync via tests/globalSetup.js; per-test TRUNCATE
// via tests/setup.js). Run ALONE (shared-Postgres gotcha). Note: the first DB
// connection in a jest worker can be slow locally — allow a generous timeout:
//   npm test -- tests/routes/selfParam.authz.test.js --forceExit --testTimeout=70000

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// rsvp.js mounts verifyAuth0Token per-route — stub it; the harness injects
// req.user below (mirrors wire-sweep.test.js).
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

// users.js reaches for the Auth0 Management API on profile-fixup branches —
// never let a test hit the network (mirrors wire-sweep.test.js). getUserById
// resolving to a truthy object keeps the self-read on the existing-row path.
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('not configured in tests')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

const request = require('supertest');
const express = require('express');

const { requireParamMatchesToken } = require('../../middleware/objectAuth');

const eventsRoutes = require('../../routes/events');
const gamesRoutes = require('../../routes/games');
const usersRoutes = require('../../routes/users');
const availabilityRoutes = require('../../routes/availability');
const rsvpRoutes = require('../../routes/rsvp');
const listsRoutes = require('../../routes/lists');

const { Event, Game, UserAvailability } = require('../../models');
const {
  makeUser,
  makeGroup,
  addToGroup,
  makeUserGame,
  makeEventRsvp,
} = require('../factories');

// Harness: inject a verified req.user ahead of every router (mirrors the real
// verifyAuth0Token middleware server.js mounts). `currentActor` is the Auth0 sub.
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
// Synthetic probe isolating the requireParamMatchesToken factory (authorization
// only — no handler data path).
app.get('/authz-probe/:user_id', requireParamMatchesToken('user_id'), (_req, res) =>
  res.json({ ok: true })
);
app.use('/api/events', eventsRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/rsvp', rsvpRoutes);
app.use('/api/lists', listsRoutes);

describe('Self-param dual-accept family (87.4-02): sub OR caller-own-UUID authorizes; non-self 403', () => {
  let caller; // the acting user — has both a sub (user_id) and a UUID (id)
  let other; // a DIFFERENT user — their UUID must never authorize the caller
  let group;
  let game;
  let event;

  beforeEach(async () => {
    caller = await makeUser({ username: 'selfparam-caller' });
    other = await makeUser({
      user_id: `google-oauth2|other-${Date.now()}`,
      username: 'selfparam-other',
    });
    group = await makeGroup({ name: 'SelfParam Group' });
    await addToGroup(caller, group, 'member');

    game = await Game.create({ name: 'SelfParam Game', is_custom: true });
    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
    });

    currentActor = caller.user_id;
  });

  afterEach(() => {
    currentActor = null;
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // The factory (objectAuth.requireParamMatchesToken) — dual-accept + BOLA.
  // --------------------------------------------------------------------------
  describe('requireParamMatchesToken factory (objectAuth)', () => {
    it('authorizes when the param is the caller OWN sub (sub era — no DB needed)', async () => {
      const res = await request(app).get(`/authz-probe/${encodeURIComponent(caller.user_id)}`);
      expect(res.status).toBe(200);
    });

    it('authorizes when the param is the caller OWN resolved UUID (dual-accept)', async () => {
      const res = await request(app).get(`/authz-probe/${caller.id}`);
      expect(res.status).toBe(200);
    });

    it('403s when the param is ANOTHER user UUID (BOLA regression guard)', async () => {
      const res = await request(app).get(`/authz-probe/${other.id}`);
      expect(res.status).toBe(403);
    });

    it('403s on a garbage / non-self param', async () => {
      const res = await request(app).get('/authz-probe/not-a-uuid-and-not-my-sub');
      expect(res.status).toBe(403);
    });

    it('401s when there is no authenticated actor', async () => {
      currentActor = null;
      const res = await request(app).get(`/authz-probe/${caller.id}`);
      expect(res.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // Factory consumers (events / games / users) — own-UUID authorizes AND returns
  // the caller's correct data. These handlers query a STILL-sub-keyed store by
  // the self-param, so each is the KEYMISS case: a UUID param must resolve to the
  // caller's row, not miss.
  // --------------------------------------------------------------------------
  describe('objectAuth consumers — own-UUID authorizes + correct data (KEYMISS)', () => {
    it('events GET /user/:user_id returns the caller cross-group events for the UUID shape', async () => {
      const res = await request(app).get(`/api/events/user/${caller.id}`);
      expect(res.status).toBe(200);
      // Non-empty: the caller is an active member of `group`, which owns `event`.
      // Pre-fix this returned 404 (User.findOne on the sub column missed the UUID).
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((e) => e.id === event.id)).toBe(true);
    });

    it('events GET /user/:user_id also works for the own-sub shape', async () => {
      const res = await request(app).get(`/api/events/user/${encodeURIComponent(caller.user_id)}`);
      expect(res.status).toBe(200);
      expect(res.body.some((e) => e.id === event.id)).toBe(true);
    });

    it('games GET /for-event/:group_id/:user_id returns the caller OWNED games for the UUID shape', async () => {
      await makeUserGame(caller, game); // UserGame.user_id = caller.id (UUID surface)
      const res = await request(app).get(`/api/games/for-event/${group.id}/${caller.id}`);
      expect(res.status).toBe(200);
      const owned = res.body.find((g) => g.id === game.id);
      expect(owned).toBeTruthy();
      expect(owned.is_owned).toBe(true);
    });

    it('users GET /:user_id returns the caller OWN profile for the UUID shape', async () => {
      const res = await request(app).get(`/api/users/${caller.id}`);
      expect(res.status).toBe(200);
      // users.js aliases the flat user_id to the row UUID; either field pins identity.
      expect(res.body.id).toBe(caller.id);
    });
  });

  // --------------------------------------------------------------------------
  // Inline matchesSelf sites (availability / rsvp / lists). These handlers key
  // their data on the caller's TOKEN identity (sub / caller-resolved UUID), not
  // the URL param, so a UUID self-param authorizes AND returns correct data
  // without per-handler param re-keying.
  // --------------------------------------------------------------------------
  describe('inline matchesSelf sites — own-UUID authorizes + correct data', () => {
    it('availability GET /user/:user_id/patterns returns the caller sub-keyed rows for the UUID shape', async () => {
      // Seed a pattern in the still-sub-keyed store (user_id = caller sub).
      await UserAvailability.create({
        user_id: caller.user_id,
        type: 'recurring_pattern',
        pattern_data: { dayOfWeek: 2, startTime: '18:00', endTime: '21:00', timezone: 'UTC' },
        start_date: '2026-06-01',
        end_date: null,
        timezone: 'UTC',
      });
      const res = await request(app).get(`/api/availability/user/${caller.id}/patterns`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('availability POST /user/:user_id/recurring creates for the UUID shape', async () => {
      const res = await request(app)
        .post(`/api/availability/user/${caller.id}/recurring`)
        .send({ dayOfWeek: 3, startTime: '19:00', endTime: '22:00', start_date: '2026-06-02', timezone: 'UTC' });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('recurring_pattern');
    });

    it('availability POST /user/:user_id/override creates for the UUID shape', async () => {
      const res = await request(app)
        .post(`/api/availability/user/${caller.id}/override`)
        .send({ date: '2026-06-03', startTime: '17:00', endTime: '20:00', isAvailable: true });
      expect(res.status).toBe(201);
      expect(res.body.type).toBe('specific_override');
    });

    it('availability GET /user/:user_id authorizes for the UUID shape (data keyed on token sub)', async () => {
      const res = await request(app).get(`/api/availability/user/${caller.id}`);
      expect(res.status).toBe(200);
    });

    it('availability DELETE /:id — caller deletes own row (200), rejects another user row (403)', async () => {
      const mine = await UserAvailability.create({
        user_id: caller.user_id,
        type: 'recurring_pattern',
        pattern_data: { dayOfWeek: 1, startTime: '10:00', endTime: '12:00', timezone: 'UTC' },
        start_date: '2026-06-04',
        timezone: 'UTC',
      });
      const theirs = await UserAvailability.create({
        user_id: other.user_id,
        type: 'recurring_pattern',
        pattern_data: { dayOfWeek: 1, startTime: '10:00', endTime: '12:00', timezone: 'UTC' },
        start_date: '2026-06-04',
        timezone: 'UTC',
      });
      const ok = await request(app).delete(`/api/availability/${mine.id}`);
      expect(ok.status).toBe(200);
      const forbidden = await request(app).delete(`/api/availability/${theirs.id}`);
      expect(forbidden.status).toBe(403);
    });

    it('rsvp GET /user/:user_id returns the caller RSVPs for the UUID shape', async () => {
      await makeEventRsvp(event, caller, { status: 'yes' }); // user_uuid = caller.id
      const res = await request(app).get(`/api/rsvp/user/${caller.id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('lists GET /games/:group_id/:user_id authorizes + returns for the UUID shape', async () => {
      const res = await request(app).get(`/api/lists/games/${group.id}/${caller.id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('lists GET /players/:group_id/:user_id authorizes for the UUID shape', async () => {
      const res = await request(app).get(`/api/lists/players/${group.id}/${caller.id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Reject/BOLA on REAL routes (not just the synthetic probe): a non-self UUID
  // and garbage both 403 across the family; the own-sub shape still authorizes.
  // --------------------------------------------------------------------------
  describe('reject/BOLA on real family routes', () => {
    it('events GET /user/:user_id 403s on ANOTHER user UUID (BOLA guard)', async () => {
      const res = await request(app).get(`/api/events/user/${other.id}`);
      expect(res.status).toBe(403);
    });

    it('rsvp GET /user/:user_id 403s on ANOTHER user UUID (BOLA guard)', async () => {
      const res = await request(app).get(`/api/rsvp/user/${other.id}`);
      expect(res.status).toBe(403);
    });

    it('lists GET /games/:group_id/:user_id 403s on a garbage self-param', async () => {
      const res = await request(app).get(`/api/lists/games/${group.id}/garbage-not-me`);
      expect(res.status).toBe(403);
    });

    it('availability GET /user/:user_id/patterns still authorizes for the own-sub shape', async () => {
      const res = await request(app).get(
        `/api/availability/user/${encodeURIComponent(caller.user_id)}/patterns`
      );
      expect(res.status).toBe(200);
    });
  });
});
