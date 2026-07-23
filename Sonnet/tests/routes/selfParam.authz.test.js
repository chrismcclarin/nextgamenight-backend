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
  // games.js search-all mounts optionalAuth (ML-06 gate); pass through so the
  // harness-injected req.user (below) is what matchesSelf sees.
  optionalAuth: (req, _res, next) => next(),
}));

// users.js reaches for the Auth0 Management API on profile-fixup branches —
// never let a test hit the network (mirrors wire-sweep.test.js). getUserById
// resolving to a truthy object keeps the self-read on the existing-row path.
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('not configured in tests')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

// 87.5-05: the users.js phone endpoints (POST /phone, POST /phone/verify) reach
// Twilio Verify AFTER the matchesSelf gate. Stub the SDK so the authorized path
// resolves without a network call — the verify check returns 'approved' so the
// mutation (phone_verified) applies for the caller.
jest.mock('twilio', () => {
  const verifications = { create: jest.fn().mockResolvedValue({ status: 'pending' }) };
  const verificationChecks = { create: jest.fn().mockResolvedValue({ status: 'approved' }) };
  return jest.fn(() => ({
    verify: { v2: { services: () => ({ verifications, verificationChecks }) } },
  }));
});
process.env.TWILIO_VERIFY_SERVICE_SID = 'VAtest0000000000000000000000000000';
process.env.TWILIO_ACCOUNT_SID = 'ACtest0000000000000000000000000000';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';

// 87.5-05: userGames POST /import-bgg-collection hits the BGG XML API AFTER the
// matchesSelf gate. Stub the collection fetch so the authorized path returns an
// empty import (proves the gate passed + handler keys on the token, not the param).
jest.mock('../../services/bggService', () => ({
  getUserCollection: jest.fn().mockResolvedValue([]),
  getGameById: jest.fn().mockResolvedValue({}),
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
// 87.5-05: the three routers whose self-param gates were swapped/folded in this plan.
const groupsRoutes = require('../../routes/groups');
const googleAuthRoutes = require('../../routes/googleAuth');
const userGamesRoutes = require('../../routes/userGames');

const { Event, Game, UserAvailability, UserGame, User } = require('../../models');
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
// 87.5-05: mount the swapped/folded routers at their server.js paths so the
// full self-param family is exercised end to end.
app.use('/api/groups', groupsRoutes);
app.use('/api/auth', googleAuthRoutes);
app.use('/api/user-games', userGamesRoutes);

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
    it('availability GET /user/:user_id/patterns returns the caller UUID-keyed rows for the UUID shape', async () => {
      // Phase 87.5: the store is rekeyed to user_uuid (Users.id UUID).
      await UserAvailability.create({
        user_uuid: caller.id,
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
        user_uuid: caller.id, // Phase 87.5: rekeyed to user_uuid (Users.id UUID)
        type: 'recurring_pattern',
        pattern_data: { dayOfWeek: 1, startTime: '10:00', endTime: '12:00', timezone: 'UTC' },
        start_date: '2026-06-04',
        timezone: 'UTC',
      });
      const theirs = await UserAvailability.create({
        user_uuid: other.id, // Phase 87.5: rekeyed to user_uuid (Users.id UUID)
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

  // --------------------------------------------------------------------------
  // 87.4 code-review H-1: the previously URL-param-gated lists routes
  // (player-wins, most-played, least-played, player-picks, by-theme,
  // alphabetical, player-games, *-by-id) now follow the SAME self-param
  // dual-accept + token-sub isActiveMember pattern as /games and /players.
  // Assert a representative route across both keyspaces + the member gate + BOLA.
  // --------------------------------------------------------------------------
  describe('lists H-1 family — self-param dual-accept + active-member gate', () => {
    // Positive (authorizes + query executes) assertions use the surviving
    // /by-theme route (healthy query, identical self-param gate). The aggregation
    // routes (most-played, least-played, alphabetical, player-games) carried
    // PRE-EXISTING query defects that 500'd for any authorized caller and were
    // DELETED in 87.5-06 (SPEC Req 9/10); WR-02 (87.5 review) then deleted the
    // per-player wins/picks routes (player-wins-by-id + name-keyed siblings) for
    // the same always-empty-predicate defect class. Deleted routes are pinned 404.
    it('by-theme authorizes for the caller OWN UUID shape (member)', async () => {
      const res = await request(app).get(`/api/lists/by-theme/${group.id}/strategy/${caller.id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('by-theme authorizes for the caller OWN sub shape (member)', async () => {
      const res = await request(app).get(
        `/api/lists/by-theme/${group.id}/strategy/${encodeURIComponent(caller.user_id)}`
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('player-wins-by-id 404s — route deleted in WR-02 (87.5 review, dead always-empty query)', async () => {
      const res = await request(app).get(
        `/api/lists/player-wins-by-id/${group.id}/${caller.id}/${caller.id}`
      );
      expect(res.status).toBe(404);
    });

    it('by-theme 403s a caller who is NOT an active member (self-param passes, member gate fails)', async () => {
      // `other` is a real user but was never added to `group`. Acting AS other with
      // other OWN identity: matchesSelf passes, isActiveMember(other, group) 403s.
      currentActor = other.user_id;
      const res = await request(app).get(`/api/lists/by-theme/${group.id}/strategy/${other.id}`);
      expect(res.status).toBe(403);
    });

    // 87.5-06 (SPEC Req 9/10): most-played was deleted along with least-played,
    // alphabetical, and player-games. Its former BOLA-guard coverage (a member
    // requesting ANOTHER user's UUID as the self-param must 403 before the query)
    // is re-pointed to the surviving /by-theme route, which carries the SAME
    // matchesSelf gate — so the security assertion is preserved, not dropped.
    it('by-theme 403s a member requesting ANOTHER user UUID as the self-param (BOLA guard, pre-query)', async () => {
      const res = await request(app).get(`/api/lists/by-theme/${group.id}/strategy/${other.id}`);
      expect(res.status).toBe(403);
    });

    it('most-played 404s — route deleted in 87.5-06 (no stale 403 against a gone route)', async () => {
      const res = await request(app).get(`/api/lists/most-played/${group.id}/${other.id}`);
      expect(res.status).toBe(404);
    });
  });

  // --------------------------------------------------------------------------
  // 87.4 code-review L-7: Plan 02 deleted the dead player-games-by-id endpoint
  // (path :group_id/:player_user_id/:user_id). Pin that no route responds on it.
  // --------------------------------------------------------------------------
  describe('lists L-7 — deleted player-games-by-id path 404s', () => {
    it('GET /api/lists/player-games-by-id/... has no route (404)', async () => {
      const res = await request(app).get(
        `/api/lists/player-games-by-id/${group.id}/${caller.id}/${caller.id}`
      );
      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // 87.5-05 — the 11 swapped gates (users.js x9, groups.js, googleAuth.js) +
  // the 4 userGames fold-ins, all now on the shared matchesSelf dual-accept.
  // Each family asserts the FULL shape (D-09, no auth-only degrade):
  //   own-sub PASS / own-UUID PASS + correct-data-or-mutation (KEYMISS) /
  //   other-user UUID 403 / garbage 403.
  // The reject halves are table-driven across ALL 15 gates at the end.
  // ==========================================================================

  // --- users.js: 9 self-param families — own-UUID authorizes + the caller's OWN
  // row is read/mutated (these handlers key on the token sub, so a UUID param must
  // still resolve to the caller — the KEYMISS invariant for self-mutating routes).
  describe('87.5-05 users.js families — own-sub/own-UUID authorize + mutate the caller row', () => {
    it('PUT /:user_id/tutorial dual-accepts and mutates the caller tutorial_version', async () => {
      const bySub = await request(app)
        .put(`/api/users/${encodeURIComponent(caller.user_id)}/tutorial`)
        .send({ version: 5 });
      expect(bySub.status).toBe(200);
      expect(bySub.body.tutorial_version).toBe(5);

      const byUuid = await request(app)
        .put(`/api/users/${caller.id}/tutorial`)
        .send({ version: 7 });
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.tutorial_version).toBe(7);
      const reloaded = await User.findByPk(caller.id);
      expect(reloaded.tutorial_version).toBe(7); // caller's OWN row mutated (KEYMISS)
    });

    it('DELETE /:user_id/tutorial dual-accepts and resets the caller tutorial_version', async () => {
      const byUuid = await request(app).delete(`/api/users/${caller.id}/tutorial`);
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.tutorial_version).toBe(0);
      const bySub = await request(app).delete(
        `/api/users/${encodeURIComponent(caller.user_id)}/tutorial`
      );
      expect(bySub.status).toBe(200);
    });

    it('PUT /:user_id/username dual-accepts and returns the caller OWN aliased row', async () => {
      const byUuid = await request(app)
        .put(`/api/users/${caller.id}/username`)
        .send({ username: 'renamed-self' });
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.id).toBe(caller.id); // toSelfWire aliases user_id → UUID
      expect(byUuid.body.username).toBe('renamed-self');
      const bySub = await request(app)
        .put(`/api/users/${encodeURIComponent(caller.user_id)}/username`)
        .send({ username: 'renamed-again' });
      expect(bySub.status).toBe(200);
    });

    it('POST /:user_id/refresh dual-accepts and returns the caller OWN row', async () => {
      // auth0Service.getUserById is mocked to reject → handler falls back to the
      // existing caller row (still 200), proving the gate + self-read on the UUID arm.
      const byUuid = await request(app).post(`/api/users/${caller.id}/refresh`);
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.id).toBe(caller.id);
      const bySub = await request(app).post(
        `/api/users/${encodeURIComponent(caller.user_id)}/refresh`
      );
      expect(bySub.status).toBe(200);
    });

    it('PATCH /:user_id/notification-preferences dual-accepts and mutates the caller prefs', async () => {
      const prefs = { event_created: { email: false, sms: false }, reminder: { email: true, sms: false } };
      const byUuid = await request(app)
        .patch(`/api/users/${caller.id}/notification-preferences`)
        .send({ preferences: prefs });
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.id).toBe(caller.id);
      expect(byUuid.body.notification_preferences.reminder.email).toBe(true);
      const bySub = await request(app)
        .patch(`/api/users/${encodeURIComponent(caller.user_id)}/notification-preferences`)
        .send({ preferences: prefs });
      expect(bySub.status).toBe(200);
    });

    it('PATCH /:user_id/timezone dual-accepts and mutates the caller timezone', async () => {
      const byUuid = await request(app)
        .patch(`/api/users/${caller.id}/timezone`)
        .send({ timezone: 'America/New_York' });
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.timezone).toBe('America/New_York');
      const reloaded = await User.findByPk(caller.id);
      expect(reloaded.timezone).toBe('America/New_York'); // caller's OWN row (KEYMISS)
      const bySub = await request(app)
        .patch(`/api/users/${encodeURIComponent(caller.user_id)}/timezone`)
        .send({ timezone: 'UTC' });
      expect(bySub.status).toBe(200);
    });

    it('POST /:user_id/phone dual-accepts and saves the phone on the caller row', async () => {
      const byUuid = await request(app)
        .post(`/api/users/${caller.id}/phone`)
        .send({ phone: '+14155552671' });
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.status).toBe('verification_sent');
      const withPhone = await User.scope('withContactInfo').findByPk(caller.id);
      expect(withPhone.phone).toBe('+14155552671'); // caller's OWN row mutated (KEYMISS)
      const bySub = await request(app)
        .post(`/api/users/${encodeURIComponent(caller.user_id)}/phone`)
        .send({ phone: '+14155552671' });
      expect(bySub.status).toBe(200);
    });

    it('POST /:user_id/phone/verify dual-accepts and marks the caller phone verified', async () => {
      await caller.update({ phone: '+14155552671', phone_verified: false });
      const byUuid = await request(app)
        .post(`/api/users/${caller.id}/phone/verify`)
        .send({ code: '123456' });
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.verified).toBe(true); // twilio mock → 'approved'
      const withPhone = await User.scope('withContactInfo').findByPk(caller.id);
      expect(withPhone.phone_verified).toBe(true); // caller's OWN row mutated (KEYMISS)
    });

    it('DELETE /:user_id/phone dual-accepts and clears the caller phone', async () => {
      await caller.update({ phone: '+14155552671', phone_verified: true });
      const byUuid = await request(app).delete(`/api/users/${caller.id}/phone`);
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.id).toBe(caller.id); // toSelfWire self row (default scope strips phone)
      const withPhone = await User.scope('withContactInfo').findByPk(caller.id);
      expect(withPhone.phone).toBeNull(); // caller's OWN row mutated (KEYMISS)
    });
  });

  // --- groups.js GET /user/:user_id — own-UUID authorizes AND returns the caller's
  // OWN groups (UserGroup is user_uuid-keyed; a UUID param must resolve, not miss).
  describe('87.5-05 groups.js GET /user/:user_id — own-UUID authorizes + correct data (KEYMISS)', () => {
    it('returns the caller groups for the UUID shape', async () => {
      const res = await request(app).get(`/api/groups/user/${caller.id}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.some((g) => g.id === group.id)).toBe(true); // caller is a member
    });

    it('also authorizes + returns for the own-sub shape', async () => {
      const res = await request(app).get(
        `/api/groups/user/${encodeURIComponent(caller.user_id)}`
      );
      expect(res.status).toBe(200);
      expect(res.body.some((g) => g.id === group.id)).toBe(true);
    });
  });

  // --- googleAuth.js GET /google/status/:user_id — own-UUID authorizes; the handler
  // reads the caller's connection status keyed on the token sub, so a UUID param
  // still returns the caller's own status (connected:false — no token seeded).
  describe('87.5-05 googleAuth.js GET /google/status/:user_id — own-UUID authorizes + correct data', () => {
    it('returns the caller connection status for the UUID shape', async () => {
      const res = await request(app).get(`/api/auth/google/status/${caller.id}`);
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false); // caller has no google token
    });

    it('also authorizes for the own-sub shape', async () => {
      const res = await request(app).get(
        `/api/auth/google/status/${encodeURIComponent(caller.user_id)}`
      );
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(false);
    });
  });

  // --- userGames.js — the 4 fold-ins. Each handler keys its data on the caller row
  // resolved from the token (or matchesSelf's memoized selfUser), so a UUID param
  // authorizes AND returns/mutates the caller's OWN collection (KEYMISS).
  describe('87.5-05 userGames.js fold-ins — own-UUID authorizes + correct data (KEYMISS)', () => {
    it('GET /user/:user_id returns the caller OWNED games for the UUID shape', async () => {
      await makeUserGame(caller, game); // UserGame.user_id = caller.id (UUID surface)
      const byUuid = await request(app).get(`/api/user-games/user/${caller.id}`);
      expect(byUuid.status).toBe(200);
      expect(Array.isArray(byUuid.body)).toBe(true);
      expect(byUuid.body.some((g) => g.id === game.id)).toBe(true); // caller's game, not empty
      const bySub = await request(app).get(
        `/api/user-games/user/${encodeURIComponent(caller.user_id)}`
      );
      expect(bySub.status).toBe(200);
      expect(bySub.body.some((g) => g.id === game.id)).toBe(true);
    });

    it('POST /user/:user_id/game/:game_id adds to the caller collection for the UUID shape', async () => {
      const res = await request(app).post(`/api/user-games/user/${caller.id}/game/${game.id}`);
      expect(res.status).toBe(200);
      const row = await UserGame.findOne({ where: { user_id: caller.id, game_id: game.id } });
      expect(row).toBeTruthy(); // added to the CALLER collection (KEYMISS)
    });

    it('DELETE /user/:user_id/game/:game_id removes from the caller collection for the UUID shape', async () => {
      await makeUserGame(caller, game);
      const res = await request(app).delete(`/api/user-games/user/${caller.id}/game/${game.id}`);
      expect(res.status).toBe(200);
      const row = await UserGame.findOne({ where: { user_id: caller.id, game_id: game.id } });
      expect(row).toBeNull(); // removed from the CALLER collection (KEYMISS)
    });

    it('POST /user/:user_id/import-bgg-collection authorizes for the UUID shape (bggService stubbed)', async () => {
      const byUuid = await request(app)
        .post(`/api/user-games/user/${caller.id}/import-bgg-collection`)
        .send({ bgg_username: 'someuser' });
      expect(byUuid.status).toBe(200);
      expect(byUuid.body.imported).toBe(0); // empty stubbed collection, gate passed
      const bySub = await request(app)
        .post(`/api/user-games/user/${encodeURIComponent(caller.user_id)}/import-bgg-collection`)
        .send({ bgg_username: 'someuser' });
      expect(bySub.status).toBe(200);
    });
  });

  // --- Reject/BOLA across ALL 15 swapped gates: another user's UUID and a garbage
  // param both 403. Table-driven so every gate is proven, not just a representative.
  // For import-bgg the body must be valid so the request reaches the handler gate
  // (the BGG/UUID validators run first and would otherwise 400 before the gate).
  describe('87.5-05 reject/BOLA across all 15 swapped gates — other-user UUID 403 + garbage 403', () => {
    const rejectCases = [
      { name: 'users PUT /tutorial', method: 'put', path: (id) => `/api/users/${id}/tutorial`, body: { version: 1 } },
      { name: 'users DELETE /tutorial', method: 'delete', path: (id) => `/api/users/${id}/tutorial` },
      { name: 'users PUT /username', method: 'put', path: (id) => `/api/users/${id}/username`, body: { username: 'x' } },
      { name: 'users POST /refresh', method: 'post', path: (id) => `/api/users/${id}/refresh` },
      { name: 'users PATCH /notification-preferences', method: 'patch', path: (id) => `/api/users/${id}/notification-preferences`, body: { preferences: { event_created: { email: true } } } },
      { name: 'users PATCH /timezone', method: 'patch', path: (id) => `/api/users/${id}/timezone`, body: { timezone: 'UTC' } },
      { name: 'users POST /phone', method: 'post', path: (id) => `/api/users/${id}/phone`, body: { phone: '+14155552671' } },
      { name: 'users POST /phone/verify', method: 'post', path: (id) => `/api/users/${id}/phone/verify`, body: { code: '123456' } },
      { name: 'users DELETE /phone', method: 'delete', path: (id) => `/api/users/${id}/phone` },
      { name: 'groups GET /user', method: 'get', path: (id) => `/api/groups/user/${id}` },
      { name: 'googleAuth GET /google/status', method: 'get', path: (id) => `/api/auth/google/status/${id}` },
      { name: 'userGames GET /user', method: 'get', path: (id) => `/api/user-games/user/${id}` },
      { name: 'userGames POST /game', method: 'post', path: (id) => `/api/user-games/user/${id}/game/${game.id}` },
      { name: 'userGames DELETE /game', method: 'delete', path: (id) => `/api/user-games/user/${id}/game/${game.id}` },
      { name: 'userGames POST /import-bgg-collection', method: 'post', path: (id) => `/api/user-games/user/${id}/import-bgg-collection`, body: { bgg_username: 'someuser' } },
    ];

    rejectCases.forEach(({ name, method, path, body }) => {
      it(`${name} 403s on ANOTHER user's UUID (BOLA guard)`, async () => {
        const r = request(app)[method](path(other.id));
        const res = body ? await r.send(body) : await r;
        expect(res.status).toBe(403);
      });

      it(`${name} 403s on a garbage self-param`, async () => {
        const r = request(app)[method](path('garbage-not-me'));
        const res = body ? await r.send(body) : await r;
        expect(res.status).toBe(403);
      });
    });
  });
});
