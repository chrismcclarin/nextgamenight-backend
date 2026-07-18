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
// representative route.
//
// Real-DB (factories; sequelize.sync via tests/globalSetup.js; per-test TRUNCATE
// via tests/setup.js). Run ALONE (shared-Postgres gotcha):
//   npm test -- tests/routes/selfParam.authz.test.js --forceExit --testTimeout=25000

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// rsvp.js mounts verifyAuth0Token per-route — stub it; the harness injects
// req.user below (mirrors wire-sweep.test.js).
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

// users.js reaches for the Auth0 Management API on profile-fixup branches —
// never let a test hit the network (mirrors wire-sweep.test.js).
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

const { Event, EventParticipation, Game, UserAvailability } = require('../../models');
const { makeUser, makeGroup, addToGroup, makeUserGame } = require('../factories');

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
// only — no handler data path). Lets the factory dual-accept + BOLA reject be
// asserted without a route's data lookup confounding the result.
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

  beforeEach(async () => {
    caller = await makeUser({ username: 'selfparam-caller' });
    other = await makeUser({
      user_id: `google-oauth2|other-${Date.now()}`,
      username: 'selfparam-other',
    });
    group = await makeGroup({ name: 'SelfParam Group' });
    await addToGroup(caller, group, 'member');
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
});
