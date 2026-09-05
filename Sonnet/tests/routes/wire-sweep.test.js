// tests/routes/wire-sweep.test.js
//
// Phase 87.3 PR-C (plan 09, Task 3) — SPEC Req 1 response sweep, as amended by
// user D3: no API JSON response OUTSIDE the named allowlist below contains an
// Auth0-sub-shaped value (`auth0|...`, `google-oauth2|...`, `apple|...`) in ANY
// field, at ANY nesting depth. The sweep RECURSES the JSON, so nested User
// includes are in scope exactly like flat fields.
//
// COVERAGE CLAIM (stated precisely — never whole-API): Req 1 is proven for the
// grep-derived IN-SCOPE endpoint inventory (Task 2b: every res.json-reachable
// serialization in routes/ whose response carried a sub-typed user-reference
// field — includes with attribute lists AND explicit response-object literals).
// A red on any nested `user_id` is a missed nested-include strip to fix at its
// owning task — NEVER an allowlist addition.
//
// Phase 88.8 plan 08 adds a THIRD describe block at the foot of this file with
// its own, separate and narrower coverage claim: on the six payloads that phase
// widened, `picture_url` is PRESENT (key present even when null) and `email`,
// `phone` and `email_changed_at` are ABSENT at any depth; plus friend search
// carries no `picture_url`. It claims nothing about any other endpoint or any
// other field, and it does NOT widen the Req 1 claim above.
//
// ============================================================================
// ALLOWLIST NOW EMPTY (Phase 87.4 Plan 11, PR-2).
//
// The two former exclusions — the groupPromptSettings surface and the entire
// availability/prompt subsystem — were deferred INTO Phase 87.4 by 87.3
// (`.planning/deferred/phase-87.4.md`). Phase 87.4 converted every one of their
// emissions to the Users.id UUID (Plans 04/08/09 + this plan's Task 1), so the
// allowlist is now EMPTY and the availability + prompt-settings endpoints below
// (formerly excluded) are exercised for a sub-free assertion in the second
// describe block of this suite. "No Auth0 sub on the wire" is universal again
// (outside DB internals + the auth boundary). A red is a regression to fix at
// its owning task, never a re-added allowlist entry.
// ============================================================================
//
// Real-DB (factories; sequelize.sync via tests/globalSetup.js; per-test
// TRUNCATE via tests/setup.js). Run ALONE (Pitfall 6 — shared-Postgres suite):
//   npm test -- tests/routes/wire-sweep.test.js
// CI Postgres is authoritative.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// rsvp.js / eventBrings.js mount verifyAuth0Token per-route — stub it; the
// harness injects req.user below (mirrors rsvp.test.js).
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

// users.js reaches for the Auth0 Management API on profile-fixup branches —
// never let a test hit the network (mirrors users.test.js).
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('not configured in tests')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

// Phase 87.4 Plan 11: the prompt-settings + availability-prompt routers reach for
// Redis-backed BullMQ (promptScheduler, reminderService) and Resend (emailService).
// Stub them so requiring/exercising the routers never boots Redis or hits the network.
jest.mock('../../schedulers/promptScheduler', () => ({
  upsertSinglePromptScheduler: jest.fn().mockResolvedValue(),
  removePromptScheduler: jest.fn().mockResolvedValue(),
}));
jest.mock('../../services/reminderService', () => ({
  scheduleReminders: jest.fn().mockResolvedValue({ scheduled: false }),
  scheduleDeadlineJob: jest.fn().mockResolvedValue({ scheduled: false }),
}));
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  actual.isConfigured = jest.fn().mockReturnValue(true);
  return actual;
});

const request = require('supertest');
const express = require('express');
const { UniqueConstraintError } = require('sequelize');

const friendshipsRoutes = require('../../routes/friendships');
const groupsRoutes = require('../../routes/groups');
const usersRoutes = require('../../routes/users');
const rsvpRoutes = require('../../routes/rsvp');
const eventBringsRoutes = require('../../routes/eventBrings');
const eventsRoutes = require('../../routes/events');
const listsRoutes = require('../../routes/lists');
const gameReviewsRoutes = require('../../routes/gameReviews');
const ballotRoutes = require('../../routes/ballot');
// Phase 87.4 Plan 11 (PR-2): the formerly-allowlisted availability + prompt-settings
// surface is now swept. Mount the routers on a second app below.
const availabilityRoutes = require('../../routes/availability');
const availabilityPromptRoutes = require('../../routes/availabilityPrompt');
const availabilitySuggestionRoutes = require('../../routes/availabilitySuggestion');
const groupPromptSettingsRoutes = require('../../routes/groupPromptSettings');
const availabilityResponseRoutes = require('../../routes/availabilityResponse');
const availabilityPrefillRoutes = require('../../routes/availabilityPrefill');
// Real magic-token minting for the two magic-token-authed endpoints (NOT Auth0).
process.env.MAGIC_TOKEN_SECRET = process.env.MAGIC_TOKEN_SECRET || 'wire-sweep-test-secret';
const magicTokenService = require('../../services/magicTokenService');

const {
  Event,
  EventParticipation,
  Game,
  // Phase 88.8 plan 08: the avatar block re-reads a seeded row unscoped to get
  // its email for the friend-search probe (defaultScope excludes email).
  User,
  Friendship,
  AvailabilityPrompt,
  AvailabilityResponse,
  GroupPromptSettings,
  UserAvailability,
} = require('../../models');
const {
  makeUser,
  makeGroup,
  addToGroup,
  makeEventRsvp,
  makeEventBring,
  makeFriendship,
  makeUserGame,
  makeGameReview,
  makeEventBallotOption,
  makeEventBallotVote,
  makeAvailabilitySuggestion,
} = require('../factories');

// ---------------------------------------------------------------------------
// The centralized sub matcher (Req 1 — single shared constant, Don't
// Hand-Roll). Mirrors the D-05 pin regex used across the route suites.
// ---------------------------------------------------------------------------
const SUB_MATCHER = /^(auth0|google-oauth2|apple)\|/;

// Recursively walk a JSON body collecting every string value that is
// sub-shaped, with its path for a readable failure message.
function collectSubHits(node, path = '$', hits = []) {
  if (typeof node === 'string') {
    if (SUB_MATCHER.test(node)) hits.push(`${path} = ${node}`);
    return hits;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectSubHits(v, `${path}[${i}]`, hits));
    return hits;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      // KEYS are wire values too: a sub-keyed map (e.g. an aggregation
      // serialized without Object.values) must red the sweep, not pass it.
      if (SUB_MATCHER.test(k)) hits.push(`${path}.<key> = ${k}`);
      collectSubHits(v, `${path}.${k}`, hits);
    }
    return hits;
  }
  return hits;
}

function expectSubFree(res, label) {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  const hits = collectSubHits(res.body);
  if (hits.length > 0) {
    // A readable failure: which endpoint leaked, where, and what.
    throw new Error(
      `Sub-shaped value(s) on the wire from ${label} (Req 1 violation — fix at the owning task, never allowlist):\n  ${hits.join('\n  ')}`
    );
  }
}

// Harness: inject a verified req.user ahead of every router (mirrors the real
// verifyAuth0Token middleware server.js mounts).
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/friendships', friendshipsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/rsvp', rsvpRoutes);
app.use('/api/event-brings', eventBringsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/lists', listsRoutes);
app.use('/api/game-reviews', gameReviewsRoutes);
app.use('/api/ballot', ballotRoutes);

describe('Wire sweep (87.3-09 Req 1): no Auth0 sub crosses the wire outside the named allowlist', () => {
  // Deliberately provider-diverse subs so the matcher's alternation is exercised.
  let owner; // auth0|...
  let member; // google-oauth2|...
  let friendUser; // auth0|...
  let group;
  let game;
  let winnerEvent; // completed, with Winner + PickedBy + participants
  let futureEvent; // scheduled, with RSVPs/brings/ballot

  beforeEach(async () => {
    owner = await makeUser({ username: 'sweep-owner' }); // auth0|test-...
    member = await makeUser({
      user_id: `google-oauth2|10824680${Date.now()}`,
      username: 'sweep-member',
    });
    friendUser = await makeUser({ username: 'sweep-friend' });

    group = await makeGroup({ name: 'Sweep Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(member, group, 'member');

    game = await Game.create({ name: 'Sweep Game', is_custom: true });

    // Completed event with a real Winner + PickedBy + BOTH participants —
    // seeds the lists games-with-winners winners/pickers NON-EMPTY (the alias
    // assertion is meaningless on an empty aggregation).
    winnerEvent = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      status: 'completed',
      winner_id: member.id,
      picked_by_id: owner.id,
    });
    await EventParticipation.create({ event_id: winnerEvent.id, user_id: owner.id, score: 10 });
    await EventParticipation.create({ event_id: winnerEvent.id, user_id: member.id, score: 12 });

    // Future event carrying RSVPs, brings, and a ballot (created_by is an
    // Auth0-sub DB column — the sweep proves it never serializes).
    futureEvent = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
      rsvp_deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      ballot_status: 'open',
    });
    await EventParticipation.create({ event_id: futureEvent.id, user_id: owner.id });
    await makeEventRsvp(futureEvent, owner, { status: 'yes' });
    await makeEventRsvp(futureEvent, member, { status: 'maybe' });
    await makeEventBring(futureEvent, owner, game);
    const ballotOption = await makeEventBallotOption(futureEvent, owner, { game_id: game.id });
    await makeEventBallotVote(ballotOption, member);

    // Library ownership — seeds owners[] AND members[] NON-EMPTY.
    await makeUserGame(owner, game);
    await makeUserGame(member, game);

    // Reviews — the gameDetail surface (reviewer's nested User).
    await makeGameReview(member, group, game, { rating: 4.5, review_text: 'sweep review' });

    // Accepted friendship for the list derive; friend NOT in the group.
    await makeFriendship(owner, friendUser, { status: 'accepted' });

    currentActor = owner.user_id;
  });

  afterEach(() => {
    currentActor = null;
    jest.restoreAllMocks();
  });

  it('group rosters: GET /groups/user/:user_id AND GET /groups/:group_id/users (aliased user_id = UUID)', async () => {
    const mine = await request(app).get(`/api/groups/user/${encodeURIComponent(owner.user_id)}`);
    expectSubFree(mine, 'GET /groups/user/:user_id');
    // Non-vacuous: the roster actually rendered members with aliased user_id.
    const grp = mine.body.find((g) => g.id === group.id);
    expect(grp.Users.length).toBeGreaterThanOrEqual(2);
    for (const u of grp.Users) expect(u.user_id).toBe(u.id);

    const roster = await request(app).get(`/api/groups/${group.id}/users`);
    expectSubFree(roster, 'GET /groups/:group_id/users');
    expect(roster.body.length).toBeGreaterThanOrEqual(2);
    for (const u of roster.body) expect(u.user_id).toBe(u.id);
  });

  it('group library: GET /groups/:group_id/library with NON-EMPTY owners[] and members[] (uniform alias)', async () => {
    const res = await request(app).get(`/api/groups/${group.id}/library`);
    expectSubFree(res, 'GET /groups/:group_id/library');
    // Non-vacuous seeding: both halves of the GroupLibrary intra-payload join.
    expect(res.body.games.length).toBeGreaterThan(0);
    expect(res.body.games[0].owners.length).toBeGreaterThan(0);
    expect(res.body.members.length).toBeGreaterThanOrEqual(2);
    // Uniform alias: owners[].user_id joins members[].user_id UUID-to-UUID.
    const memberIds = new Set(res.body.members.map((m) => m.user_id));
    for (const o of res.body.games[0].owners) {
      expect(memberIds.has(o.user_id)).toBe(true);
    }
  });

  it('friendships: list, /search (BE-12), and the request-create/duplicate-race/accept/decline mutation responses', async () => {
    const list = await request(app).get('/api/friendships');
    expectSubFree(list, 'GET /friendships');
    expect(list.body.length).toBeGreaterThan(0); // non-vacuous

    const search = await request(app).get(
      `/api/friendships/search?email=${encodeURIComponent(friendUser.email)}`
    );
    expectSubFree(search, 'GET /friendships/search (BE-12)');
    expect(search.body.id).toBe(friendUser.id);
    expect(search.body).not.toHaveProperty('user_id'); // the D1 flat drop

    // CREATE-path response (member -> friendUser, by UUID — the contracted shape).
    currentActor = member.user_id;
    const create = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: friendUser.id });
    expect(create.status).toBe(201);
    expectSubFree(create, 'POST /friendships/request (create path)');
    const pendingId = create.body.id;

    // ACCEPT response (friendUser accepts member's pending request).
    currentActor = friendUser.user_id;
    const accept = await request(app).post(`/api/friendships/${pendingId}/accept`);
    expect(accept.status).toBe(200);
    expectSubFree(accept, 'POST /friendships/:id/accept');

    // DUPLICATE/RACE-path response: drive the UniqueConstraintError absorb
    // branch (the functional LEAST/GREATEST index is migration-only, so a real
    // race cannot fire on the sync-built test DB). Seed the "winner" row for
    // real, skip the pre-check ONCE (as the losing racer would), and make
    // create throw ONCE — the absorb re-find then hits the REAL seeded row.
    const raceWinnerRow = await makeFriendship(owner, member, { status: 'pending' });
    currentActor = owner.user_id;
    jest.spyOn(Friendship, 'findOne').mockResolvedValueOnce(null); // pre-check misses (race window)
    jest.spyOn(Friendship, 'create').mockRejectedValueOnce(new UniqueConstraintError({}));
    const race = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: member.id });
    expect(race.status).toBe(201);
    expect(race.body.id).toBe(raceWinnerRow.id); // the absorb re-found the winner
    expectSubFree(race, 'POST /friendships/request (duplicate/race path)');
    jest.restoreAllMocks();

    // DECLINE response (member is the addressee of the seeded pending row).
    currentActor = member.user_id;
    const decline = await request(app).post(`/api/friendships/${raceWinnerRow.id}/decline`);
    expect(decline.status).toBe(200);
    expectSubFree(decline, 'POST /friendships/:id/decline');
  });

  it('RSVPs: GET /rsvp/event/:id list AND the POST /rsvp write response (flats carry UUID)', async () => {
    const list = await request(app).get(`/api/rsvp/event/${futureEvent.id}`);
    expectSubFree(list, 'GET /rsvp/event/:event_id');
    expect(list.body.rsvps.length).toBeGreaterThanOrEqual(2); // non-vacuous
    for (const r of list.body.rsvps) expect(r.user_id).toBe(r.User.id);

    const write = await request(app)
      .post('/api/rsvp')
      .send({ event_id: futureEvent.id, status: 'yes' });
    expectSubFree(write, 'POST /rsvp (write response)');
    expect(write.body.user_id).toBe(owner.id);
  });

  it('brings: GET /event-brings/event/:id list (flats carry UUID)', async () => {
    const res = await request(app).get(`/api/event-brings/event/${futureEvent.id}`);
    expectSubFree(res, 'GET /event-brings/event/:event_id');
    expect(res.body.length).toBeGreaterThan(0); // non-vacuous
    for (const b of res.body) expect(b.user_id).toBe(b.User.id);
  });

  it('events: group list (participant rosters) AND event detail with a Winner', async () => {
    const groupEvents = await request(app).get(`/api/events/group/${group.id}`);
    expectSubFree(groupEvents, 'GET /events/group/:group_id');
    const withWinner = groupEvents.body.find((e) => e.id === winnerEvent.id);
    expect(withWinner.Winner).toBeTruthy(); // non-vacuous Winner
    expect(withWinner.EventParticipations.length).toBeGreaterThanOrEqual(2);

    const detail = await request(app).get(`/api/events/${winnerEvent.id}`);
    expectSubFree(detail, 'GET /events/:event_id (with Winner)');
    expect(detail.body.Winner.id).toBe(member.id);

    const userEvents = await request(app).get(
      `/api/events/user/${encodeURIComponent(owner.user_id)}`
    );
    expectSubFree(userEvents, 'GET /events/user/:user_id');
    expect(userEvents.body.length).toBeGreaterThan(0);
  });

  it('game reviews: the review list endpoint (nested reviewer User sub-free)', async () => {
    const byGame = await request(app).get(
      `/api/game-reviews/game/${game.id}/group/${group.id}`
    );
    expectSubFree(byGame, 'GET /game-reviews/game/:game_id/group/:group_id');
    expect(byGame.body.length).toBeGreaterThan(0); // non-vacuous
    expect(byGame.body[0].User.id).toBe(member.id);
    expect(byGame.body[0].User.user_id).toBeUndefined();

    // GET /game-reviews/user/:user_id/group/:group_id DELETED — Phase 87.6
    // (gameReviews, Tier-3). expectSubFree requires a 2xx; a deleted route 404s,
    // so it cannot be sub-free-probed and is dropped from this sweep. Resurrection
    // guard: the gameReviews deletion tombstone (routes/gameReviews.js). The live
    // /game/:game_id/group/:group_id twin above still proves the nested-reviewer strip.
  });

  it('ballot: GET /ballot/:eventId (created_by sub column never serializes)', async () => {
    const res = await request(app).get(`/api/ballot/${futureEvent.id}`);
    expectSubFree(res, 'GET /ballot/:eventId');
    expect(res.body.options.length).toBeGreaterThan(0); // non-vacuous
  });

  it('lists: games-with-winners (winners/pickers NON-EMPTY, aliased — UUID values)', async () => {
    const games = await request(app).get(
      `/api/lists/games/${group.id}/${encodeURIComponent(owner.user_id)}`
    );
    expectSubFree(games, 'GET /lists/games/:group_id/:user_id');
    const g = games.body.find((x) => x.id === game.id);
    // Non-vacuous: the winners/pickers aggregation actually rendered entries.
    expect(g.winners.length).toBeGreaterThan(0);
    expect(g.pickers.length).toBeGreaterThan(0);
    expect(g.winners[0].user_id).toBe(member.id); // ALIAS: UUID, name stable
    expect(g.pickers[0].user_id).toBe(owner.id);

    // GET /lists/players/:group_id/:user_id DELETED — Phase 87.6 (lists, Tier-3).
    // A deleted route 404s and cannot be sub-free-probed (expectSubFree requires a
    // 2xx), so it is dropped from this sweep. Resurrection guard: lists.test.js
    // `GET /api/lists/players/... (deleted 87.6 lists)` 404 pin.
  });

  it('users: /users/:user_id (aliased self read)', async () => {
    const self = await request(app).get(
      `/api/users/${encodeURIComponent(owner.user_id)}`
    );
    expectSubFree(self, 'GET /users/:user_id (self)');
    expect(self.body.user_id).toBe(owner.id); // alias — name stable, UUID value

    // GET /users/search/email/:email DELETED — Phase 87.6 (users-search-email,
    // Tier 1). A deleted route 404s and cannot be sub-free-probed (expectSubFree
    // requires a 2xx), so it is dropped from this sweep. Resurrection guards:
    // accountDeletion.test.js search-by-email 404 pin + the deletion tombstone in
    // routes/users.js.
  });

  it('users write echoes: PUT username, PATCH notification-preferences, DELETE phone (toSelfWire aliased on every echo)', async () => {
    // PRC-H2: every self-write echoes the row via toSelfWire — pin each echo
    // sub-free AND aliased so a single-call-site revert (res.json(user)) reds.
    const rename = await request(app)
      .put(`/api/users/${encodeURIComponent(owner.user_id)}/username`)
      .send({ username: 'sweep-renamed' });
    expectSubFree(rename, 'PUT /users/:user_id/username');
    expect(rename.body.user_id).toBe(owner.id);

    const prefs = await request(app)
      .patch(`/api/users/${encodeURIComponent(owner.user_id)}/notification-preferences`)
      .send({ preferences: { reminder: { email: true, sms: false } } });
    expectSubFree(prefs, 'PATCH /users/:user_id/notification-preferences');
    expect(prefs.body.user_id).toBe(owner.id);

    const phoneGone = await request(app).delete(
      `/api/users/${encodeURIComponent(owner.user_id)}/phone`
    );
    expectSubFree(phoneGone, 'DELETE /users/:user_id/phone');
    expect(phoneGone.body.user_id).toBe(owner.id);

    // POST /users/:user_id/refresh echo REMOVED — route DELETED (Phase 87.6
    // users-refresh, Tier 3). A deleted route 404s and cannot be sub-free-probed.
    // Resurrection guards: selfParam.authz.test.js POST /refresh 404 pin + the
    // deletion tombstone in routes/users.js.
  });

  it('events write echo: PUT /events/:id response (formatEventWithCustomParticipants on the cleaned includes)', async () => {
    const updated = await request(app)
      .put(`/api/events/${futureEvent.id}`)
      .send({ title: 'Sweep Updated' });
    expectSubFree(updated, 'PUT /events/:id (write echo)');
  });
});

// ===========================================================================
// Phase 87.4 Plan 11 (PR-2): the formerly-allowlisted availability + prompt-settings
// surface. The allowlist is now EMPTY — every endpoint below is exercised for a
// sub-free assertion, INCLUDING the three the first cut of this suite skipped
// while claiming complete exercise (PR2-H1, 87.4-review): POST
// /prompts/:promptId/suggestions/refresh, POST /suggestions/:suggestionId/convert,
// and GET /groups/:groupId/prompts/active. The two magic-token-authed endpoints
// (availability-responses / availability-prefill) mint a REAL magic token (they do
// NOT use Auth0). availability-prefill/gcal is CLEAN by construction (emits only
// { slot_ids, count }) but returns 400 without a live Google Calendar connection —
// its error body is still asserted sub-free via expectBodySubFree.
// ===========================================================================

// A second app carrying the availability + prompt-settings routers (matches the
// server.js mount prefixes). The same req.user injection harness is reused.
let availActor = null;
const availApp = express();
availApp.use(express.json());
availApp.use((req, _res, next) => {
  if (availActor) req.user = { user_id: availActor };
  next();
});
availApp.use('/api/availability', availabilityRoutes);
availApp.use('/api/groups', groupPromptSettingsRoutes);
availApp.use('/api', availabilitySuggestionRoutes);
availApp.use('/api', availabilityPromptRoutes);
availApp.use('/api/availability-responses', availabilityResponseRoutes); // magic-token
availApp.use('/api/availability-prefill', availabilityPrefillRoutes); // magic-token

// Sub-free assertion that does NOT require a 2xx (for the magic gcal endpoint whose
// success path needs a live Google connection — the 400 body must still be sub-free).
function expectBodySubFree(res, label) {
  const hits = collectSubHits(res.body);
  if (hits.length > 0) {
    throw new Error(
      `Sub-shaped value(s) on the wire from ${label} (Req 1 violation):\n  ${hits.join('\n  ')}`
    );
  }
}

describe('Wire sweep (87.4-11 PR-2): availability + prompt-settings — allowlist emptied', () => {
  let owner; // auth0|...
  let member; // google-oauth2|...
  let group;
  let prompt;
  let scheduleId;

  beforeEach(async () => {
    owner = await makeUser({ username: 'avail-owner', email_notifications_enabled: true });
    member = await makeUser({
      user_id: `google-oauth2|9021${Date.now()}`,
      username: 'avail-member',
      email_notifications_enabled: true,
    });
    group = await makeGroup({ name: 'Avail Sweep Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(member, group, 'member');

    // Active prompt created by the owner.
    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      status: 'active',
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      week_identifier: `avail-${Date.now()}`,
      created_by_user_id: owner.id,
    });

    // A member response (user_uuid-keyed row — Phase 87.5 D-04 re-keyed the table;
    // the emission must still not leak the sub).
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_uuid: member.id, // AvailabilityResponse re-keyed onto user_uuid (Phase 87.5 D-04)
      time_slots: [{ start: new Date().toISOString(), end: new Date(Date.now() + 36e5).toISOString(), preference: 'preferred' }],
      user_timezone: 'UTC',
      submitted_at: new Date(),
    });

    // A recurring availability pattern for the owner (user_uuid-keyed row) so patterns /
    // heatmap / overlaps render non-empty and prove the emission carries the UUID.
    await UserAvailability.create({
      user_uuid: owner.id, // UserAvailability re-keyed onto user_uuid (Phase 87.5)
      type: 'recurring_pattern',
      pattern_data: { dayOfWeek: 3, startTime: '18:00', endTime: '22:00' },
      start_date: '2026-01-01',
      timezone: 'UTC',
    });

    // A suggestion (participant_user_ids UUID array post Plan 03) for the suggestions GET.
    await makeAvailabilitySuggestion(prompt, member);

    // A prompt-settings row with a schedule scoped to the member (stored UUID).
    const settings = await GroupPromptSettings.create({
      group_id: group.id,
      schedule_timezone: 'UTC',
      created_by_user_id: owner.id,
      template_config: {
        schedules: [{
          id: `sched-${group.id}`,
          is_active: true,
          game_id: null,
          selected_member_ids: [member.id], // stored UUID
          schedule_day_of_week: 3,
          schedule_time: '19:00',
          schedule_timezone: 'UTC',
        }],
      },
    });
    scheduleId = settings.template_config.schedules[0].id;

    availActor = owner.user_id;
  });

  afterEach(() => {
    availActor = null;
    jest.clearAllMocks();
  });

  it('prompt-settings: GET (members[].user_id UUID + selected_member_ids UUID, no sub)', async () => {
    const res = await request(availApp).get(`/api/groups/${group.id}/prompt-settings`);
    expectSubFree(res, 'GET /groups/:group_id/prompt-settings');
    // Non-vacuous: members rendered, user_id is the UUID (== id), never a sub.
    expect(res.body.members.length).toBeGreaterThanOrEqual(2);
    for (const m of res.body.members) {
      expect(m.user_id).toBe(m.id);
      expect(m.user_id).not.toMatch(SUB_MATCHER);
    }
    // selected_member_ids emitted as the raw stored UUID (shim removed).
    const sched = res.body.schedules.find((s) => s.id === scheduleId);
    expect(sched.selected_member_ids).toEqual([member.id]);
  });

  it('prompt-settings: POST create + PATCH update + toggle + DELETE schedule echoes (sub-free)', async () => {
    const create = await request(availApp)
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({ schedule_day_of_week: 4, schedule_time: '20:00', schedule_timezone: 'UTC', selected_member_ids: [member.user_id] });
    expect(create.status).toBe(201);
    expectSubFree(create, 'POST /groups/:group_id/prompt-settings/schedules');
    // The sub-shaped input self-healed to the UUID on the echo.
    expect(create.body.schedule.selected_member_ids).toEqual([member.id]);
    const newId = create.body.schedule.id;

    const patch = await request(availApp)
      .patch(`/api/groups/${group.id}/prompt-settings/schedules/${newId}`)
      .send({ selected_member_ids: [member.user_id] });
    expectSubFree(patch, 'PATCH /groups/:group_id/prompt-settings/schedules/:id');
    expect(patch.body.schedule.selected_member_ids).toEqual([member.id]);

    const toggle = await request(availApp)
      .patch(`/api/groups/${group.id}/prompt-settings/schedules/${newId}/toggle`);
    expectSubFree(toggle, 'PATCH .../schedules/:id/toggle');

    const del = await request(availApp)
      .delete(`/api/groups/${group.id}/prompt-settings/schedules/${newId}`);
    expectSubFree(del, 'DELETE .../schedules/:id');
  });

  it('availability self-CRUD: POST recurring, POST override, GET patterns (caller UUID emitted)', async () => {
    // GET /availability/user/:user_id (bare) DELETED — Phase 87.6 (87.6-07,
    // Tier 1); a deleted route 404s and cannot be sub-free-probed. Resurrection
    // guard: deadRoutes.pin.test.js availability orphan pin. The live
    // /recurring|override|patterns reads below still carry the UUID-emission sweep.
    const recurring = await request(availApp)
      .post(`/api/availability/user/${encodeURIComponent(owner.user_id)}/recurring`)
      .send({ dayOfWeek: 5, startTime: '18:00', endTime: '21:00', start_date: '2026-01-01', timezone: 'UTC' });
    expectSubFree(recurring, 'POST /availability/user/:user_id/recurring');
    expect(recurring.body.user_id).not.toMatch(SUB_MATCHER);

    const override = await request(availApp)
      .post(`/api/availability/user/${encodeURIComponent(owner.user_id)}/override`)
      .send({ date: '2026-08-01', startTime: '10:00', endTime: '12:00', isAvailable: true, timezone: 'UTC' });
    expectSubFree(override, 'POST /availability/user/:user_id/override');

    const patterns = await request(availApp).get(`/api/availability/user/${encodeURIComponent(owner.user_id)}/patterns`);
    expectSubFree(patterns, 'GET /availability/user/:user_id/patterns');
  });

  it('availability group: GET heatmap (member payload UUIDs)', async () => {
    // GET /availability/group/:group_id/overlaps DELETED — Phase 87.6 (87.6-07,
    // Tier 2); a deleted route 404s and cannot be sub-free-probed. Resurrection
    // guards: deadRoutes.pin.test.js + availability.membershipGate.test.js 404 pins.
    // The live /heatmap successor below carries the member-payload UUID sweep.
    const heatmap = await request(availApp).get(`/api/availability/group/${group.id}/heatmap`);
    expectSubFree(heatmap, 'GET /availability/group/:group_id/heatmap');
  });

  it('availability prompts: GET /prompts/:id, respondents, heatmap, group open list (UUID rosters)', async () => {
    const detail = await request(availApp).get(`/api/prompts/${prompt.id}`);
    expectSubFree(detail, 'GET /prompts/:promptId');

    const respondents = await request(availApp).get(`/api/prompts/${prompt.id}/respondents`);
    expectSubFree(respondents, 'GET /prompts/:promptId/respondents');
    expect(respondents.body.length).toBeGreaterThanOrEqual(2); // non-vacuous
    for (const r of respondents.body) expect(r.user_id).not.toMatch(SUB_MATCHER);

    const heatmap = await request(availApp).get(`/api/prompts/${prompt.id}/heatmap`);
    expectSubFree(heatmap, 'GET /prompts/:promptId/heatmap');

    const open = await request(availApp).get(`/api/groups/${group.id}/prompts/open`);
    expectSubFree(open, 'GET /groups/:groupId/prompts/open');
  });

  // GET /prompts/:promptId/suggestions DELETED — Phase 87.6 (availability-
  // suggestions, Tier 2); a deleted route 404s and cannot be sub-free-probed, so
  // its sweep block is removed. Resurrection guard: deadRoutes.pin.test.js
  // `GET /api/prompts/:promptId/suggestions (deleted 87.6 availability-suggestions)`.

  // PR2-H1 (87.4-review): the formerly-excluded endpoints the coverage claim named
  // — POST suggestions/:id/convert + GET prompts/active — are exercised for real
  // below. (POST /prompts/:id/suggestions/refresh, also named there, was DELETED in
  // Phase 87.6 availability-suggestions Tier 2; a deleted route 404s and cannot be
  // sub-free-probed, so its sweep block is removed. Resurrection guard:
  // deadRoutes.pin.test.js POST .../suggestions/refresh 404 pin.)

  it('availability suggestions: POST /suggestions/:id/convert creates the event — 201 body sub-free (PR2-H1)', async () => {
    // Fresh suggestion with NO tentative gcal holds (post-commit hold cleanup then
    // has nothing to reach Google for; test users hold no calendar tokens anyway).
    const convertible = await makeAvailabilitySuggestion(prompt, member, {
      tentative_calendar_event_ids: {},
    });

    const convert = await request(availApp)
      .post(`/api/suggestions/${convertible.id}/convert`)
      .send({ send_emails: false });
    expect(convert.status).toBe(201);
    expectSubFree(convert, 'POST /suggestions/:suggestionId/convert');
    // Non-vacuous: a real event with the seeded UUID participant was created.
    expect(convert.body.event_id).toBeDefined();
    expect(convert.body.event.participant_count).toBe(1);
  });

  it('availability prompts: GET /groups/:groupId/prompts/active returns the raw prompt row sub-free (PR2-H1)', async () => {
    const active = await request(availApp).get(`/api/groups/${group.id}/prompts/active`);
    expectSubFree(active, 'GET /groups/:groupId/prompts/active');
    // Non-vacuous: the seeded active prompt is the one returned.
    expect(active.body.prompt).toBeTruthy();
    expect(active.body.prompt.id).toBe(prompt.id);
  });

  it('magic-token: availability-responses POST + GET (minted token, no Auth0) — sub-free', async () => {
    const token = await magicTokenService.generateToken(
      { user_id: member.user_id, username: member.username },
      { id: prompt.id },
      168
    );

    const post = await request(availApp)
      .post('/api/availability-responses')
      .send({
        magic_token: token,
        time_slots: [{ start: new Date().toISOString(), end: new Date(Date.now() + 36e5).toISOString(), preference: 'preferred' }],
        user_timezone: 'UTC',
      });
    expectSubFree(post, 'POST /availability-responses (magic token)');

    const get = await request(availApp).get(`/api/availability-responses/${prompt.id}?magic_token=${encodeURIComponent(token)}`);
    expectSubFree(get, 'GET /availability-responses/:promptId (magic token)');
  });

  it('magic-token: availability-prefill saved (2xx) + gcal (400 body sub-free) — no sub either way', async () => {
    const token = await magicTokenService.generateToken(
      { user_id: member.user_id, username: member.username },
      { id: prompt.id },
      168
    );

    const saved = await request(availApp)
      .post('/api/availability-prefill/saved')
      .send({ magic_token: token, start_date: '2026-08-01', num_days: 7, timezone: 'UTC' });
    expectSubFree(saved, 'POST /availability-prefill/saved (magic token)');

    // gcal returns 400 without a live Google connection — CLEAN by construction
    // (emits only { slot_ids, count }); assert its error body is sub-free.
    const gcal = await request(availApp)
      .post('/api/availability-prefill/gcal')
      .send({ magic_token: token, start_date: '2026-08-01', num_days: 7, timezone: 'UTC' });
    expectBodySubFree(gcal, 'POST /availability-prefill/gcal (magic token)');
  });
});

// ===========================================================================
// Phase 88.8 plan 08 (D-23, SPEC R11 as amended by A6) — the avatar sweep.
//
// COVERAGE CLAIM (stated precisely — NOT widened by accident, and NOT a claim
// about the whole API): for the SIX payloads the phase widened — the group
// roster (BOTH branches of GET /groups/:group_id/users), the event participant
// list, the RSVP roster, the RSVP write echo, the friends list and the brings
// list — this block claims exactly two things:
//   (+) `picture_url` is PRESENT as a key on the user-shaped objects, including
//       when the stored value is null. An absent key and a null key are
//       different on the wire and the frontend schema declares the field
//       optional-and-nullable, so only the PRESENT-KEY assertion proves the
//       projection actually landed.
//   (-) `email`, `phone` and `email_changed_at` are ABSENT at ANY nesting
//       depth. THREE fields, not two: SPEC A12 withdrew the second address
//       column an earlier draft of this truth named, and `email_changed_at`
//       (plan 02, D-36) took its place in the models/User.js defaultScope
//       exclude list and therefore in this assertion.
// Plus one negative surface: GET /friendships/search carries NO `picture_url`
// — it is a LOOKUP, one line away in the same route file from the two widened
// friendship includes, which is exactly why it needs an assertion and not a
// convention (T-88.8-38 / R10).
//
// The allowlist above stays EMPTY. A red here is a regression to fix at its
// owning task, NEVER an allowlist addition.
//
// Run ALONE (Pitfall 6 — shared-Postgres suite), same as the blocks above.
// ===========================================================================

// The three fields that must never cross the user boundary. Kept as ONE
// constant so a future addition is a single edit, and asserted RECURSIVELY via
// the same walk shape the sub matcher above already uses — a top-level
// `not.toHaveProperty` would miss a nested User include, which is precisely
// where these leak.
// `revert_available` (Phase 88.8 round 2 HIGH-B) is a self-only DERIVED key assigned
// by toSelfWire / emailChangeBody alone; it says whether THIS caller may revert their
// address and has no business on anyone else's payload. Forbidden at any depth for
// the same reason as `email_changed_at`.
const FORBIDDEN_USER_PII = ['email', 'phone', 'email_changed_at', 'revert_available'];

function collectKeyHits(node, keys, path = '$', hits = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectKeyHits(v, keys, `${path}[${i}]`, hits));
    return hits;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (keys.includes(k)) hits.push(`${path}.${k} = ${JSON.stringify(v)}`);
      collectKeyHits(v, keys, `${path}.${k}`, hits);
    }
    return hits;
  }
  return hits;
}

function expectNoUserPII(body, label) {
  const hits = collectKeyHits(body, FORBIDDEN_USER_PII);
  if (hits.length > 0) {
    throw new Error(
      `Forbidden user PII on the wire from ${label} (T-88.8-37 — picture_url is the ONLY user field 88.8 adds; fix at the owning projection, never allowlist):\n  ${hits.join('\n  ')}`
    );
  }
}

// Assert the key is PRESENT (even when null) on every element, and report which
// element failed. `rows` must already have been guarded as non-empty.
function expectPictureUrlKey(rows, label) {
  rows.forEach((row, i) => {
    if (!Object.prototype.hasOwnProperty.call(row, 'picture_url')) {
      throw new Error(
        `${label}[${i}] has NO picture_url key (an absent key !== a null key; the projection did not land): ${JSON.stringify(row)}`
      );
    }
  });
}

describe('Wire sweep (88.8-08 R11/A6): picture_url present on the six chip payloads, three PII fields absent', () => {
  const AVATAR = 'https://lh3.googleusercontent.com/a/sweep-avatar=s96-c';

  let withAvatar; // group member + participant, picture_url NON-NULL
  let withoutAvatar; // group member + participant, picture_url NULL (nullable shape)
  let gameOnly; // participant on the event but NOT a group member (branch 2 caller)
  let group;
  let game;
  let event;

  beforeEach(async () => {
    withAvatar = await makeUser({ username: 'chip-with', picture_url: AVATAR });
    withoutAvatar = await makeUser({ username: 'chip-without' }); // picture_url defaults null
    gameOnly = await makeUser({ username: 'chip-gameonly', picture_url: AVATAR });

    group = await makeGroup({ name: 'Chip Sweep Group' });
    await addToGroup(withAvatar, group, 'owner');
    await addToGroup(withoutAvatar, group, 'member');
    // gameOnly is DELIBERATELY not added to the group — that is what makes the
    // caller take branch 2 of GET /groups/:group_id/users.

    game = await Game.create({ name: 'Chip Sweep Game', is_custom: true });

    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
      // A name-only participant with no user row behind it — the serializer
      // must emit an EXPLICIT picture_url: null for this one.
      custom_participants: [{ username: 'Kitchen Table Steve', score: null, placement: null }],
    });
    await EventParticipation.create({ event_id: event.id, user_id: withAvatar.id });
    await EventParticipation.create({ event_id: event.id, user_id: withoutAvatar.id });
    await EventParticipation.create({ event_id: event.id, user_id: gameOnly.id });

    await makeEventRsvp(event, withAvatar, { status: 'yes' });
    await makeEventRsvp(event, withoutAvatar, { status: 'maybe' });
    await makeEventBring(event, withAvatar, game);
    await makeEventBring(event, withoutAvatar, game);

    await makeFriendship(withAvatar, withoutAvatar, { status: 'accepted' });

    currentActor = withAvatar.user_id;
  });

  afterEach(() => {
    currentActor = null;
  });

  it('group roster — MEMBER branch of GET /groups/:group_id/users carries picture_url (value AND null), no PII', async () => {
    const res = await request(app).get(`/api/groups/${group.id}/users`);
    expect(res.status).toBe(200);
    // Anti-vacuity: a zero-length roster makes every assertion below vacuous.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);

    expectPictureUrlKey(res.body, 'GET /groups/:group_id/users (member branch)');
    // Both halves of the nullable shape are exercised on a real response.
    const seeded = res.body.find((u) => u.id === withAvatar.id);
    const nulled = res.body.find((u) => u.id === withoutAvatar.id);
    expect(seeded.picture_url).toBe(AVATAR);
    expect(nulled.picture_url).toBeNull();

    expectNoUserPII(res.body, 'GET /groups/:group_id/users (member branch)');
    expectSubFree(res, 'GET /groups/:group_id/users (member branch)');
  });

  it('group roster — GAME-ONLY branch carries picture_url through the fail-closed stripMemberPII allow-list', async () => {
    // THE reason Task 1's allow-list edit exists. stripMemberPII is fail-CLOSED,
    // so before that edit this branch dropped picture_url silently: avatars that
    // work for group members and vanish for game-only participants, one branch
    // of one endpoint, no error and no log.
    currentActor = gameOnly.user_id;
    const res = await request(app).get(`/api/groups/${group.id}/users`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Anti-vacuity: co-attendees PLUS the injected synthetic caller row.
    expect(res.body.length).toBeGreaterThanOrEqual(2);

    expectPictureUrlKey(res.body, 'GET /groups/:group_id/users (game-only branch)');

    // The co-attendee row came through the strip and kept its avatar.
    const stripped = res.body.find((u) => u.id === withAvatar.id);
    expect(stripped).toBeTruthy();
    expect(stripped.picture_url).toBe(AVATAR);

    // The injected synthetic caller row (UserGroup === null is the Phase 71.1
    // game-only signal) also goes through the strip, and also keeps its avatar.
    const callerRow = res.body.find((u) => u.id === gameOnly.id);
    expect(callerRow).toBeTruthy();
    expect(callerRow.UserGroup).toBeNull();
    expect(callerRow.picture_url).toBe(AVATAR);

    expectNoUserPII(res.body, 'GET /groups/:group_id/users (game-only branch)');
    expectSubFree(res, 'GET /groups/:group_id/users (game-only branch)');
  });

  it('event participants — the hand-copy serializer emits picture_url, and an EXPLICIT null for name-only participants', async () => {
    const res = await request(app).get(`/api/events/${event.id}`);
    expect(res.status).toBe(200);
    const parts = res.body.EventParticipations;
    // Anti-vacuity: 3 real participants + 1 custom.
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(4);

    expectPictureUrlKey(parts, 'GET /events/:event_id EventParticipations');

    const seeded = parts.find((p) => p.user_id === withAvatar.id);
    const nulled = parts.find((p) => p.user_id === withoutAvatar.id);
    expect(seeded.picture_url).toBe(AVATAR);
    expect(nulled.picture_url).toBeNull();

    // The name-only row: EXPLICIT null, not an omitted key. Same reason the row
    // already emits an explicit `user_id: null`.
    const custom = parts.find((p) => p.is_custom === true);
    expect(custom).toBeTruthy();
    expect(custom.username).toBe('Kitchen Table Steve');
    expect(Object.prototype.hasOwnProperty.call(custom, 'picture_url')).toBe(true);
    expect(custom.picture_url).toBeNull();

    expectNoUserPII(res.body, 'GET /events/:event_id');
    expectSubFree(res, 'GET /events/:event_id');
  });

  it('RSVP roster — GET /rsvp/event/:event_id nested User carries picture_url, no PII', async () => {
    const res = await request(app).get(`/api/rsvp/event/${event.id}`);
    expect(res.status).toBe(200);
    const users = res.body.rsvps.map((r) => r.User);
    expect(users.length).toBeGreaterThanOrEqual(2); // anti-vacuity

    expectPictureUrlKey(users, 'GET /rsvp/event/:event_id rsvps[].User');
    expect(users.find((u) => u.id === withAvatar.id).picture_url).toBe(AVATAR);
    expect(users.find((u) => u.id === withoutAvatar.id).picture_url).toBeNull();

    expectNoUserPII(res.body, 'GET /rsvp/event/:event_id');
    expectSubFree(res, 'GET /rsvp/event/:event_id');
  });

  it('RSVP write echo — POST /rsvp nested User carries picture_url (echo and roster must not disagree)', async () => {
    const res = await request(app)
      .post('/api/rsvp')
      .send({ event_id: event.id, status: 'yes' });
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.body.User).toBeTruthy(); // anti-vacuity

    expectPictureUrlKey([res.body.User], 'POST /rsvp body.User');
    expect(res.body.User.picture_url).toBe(AVATAR);

    expectNoUserPII(res.body, 'POST /rsvp (write echo)');
    expectSubFree(res, 'POST /rsvp (write echo)');
  });

  it('friends list — GET /friendships Requester/Addressee carry picture_url (value AND null), no PII', async () => {
    const res = await request(app).get('/api/friendships');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0); // anti-vacuity

    const people = res.body.flatMap((f) => [f.Requester, f.Addressee]).filter(Boolean);
    expect(people.length).toBeGreaterThanOrEqual(2); // anti-vacuity
    expectPictureUrlKey(people, 'GET /friendships Requester/Addressee');
    expect(people.find((p) => p.id === withAvatar.id).picture_url).toBe(AVATAR);
    expect(people.find((p) => p.id === withoutAvatar.id).picture_url).toBeNull();

    expectNoUserPII(res.body, 'GET /friendships');
    expectSubFree(res, 'GET /friendships');
  });

  it('brings list — GET /event-brings/event/:event_id nested User carries picture_url, no PII', async () => {
    const res = await request(app).get(`/api/event-brings/event/${event.id}`);
    expect(res.status).toBe(200);
    const users = res.body.map((b) => b.User).filter(Boolean);
    expect(users.length).toBeGreaterThanOrEqual(2); // anti-vacuity

    expectPictureUrlKey(users, 'GET /event-brings/event/:event_id [].User');
    expect(users.find((u) => u.id === withAvatar.id).picture_url).toBe(AVATAR);
    expect(users.find((u) => u.id === withoutAvatar.id).picture_url).toBeNull();

    expectNoUserPII(res.body, 'GET /event-brings/event/:event_id');
    expectSubFree(res, 'GET /event-brings/event/:event_id');
  });

  it('friend SEARCH — GET /friendships/search must NOT carry picture_url (lookup, not a roster: T-88.8-38 / R10)', async () => {
    // The negative surface. This projection sits ~200 lines from the two
    // friendship includes widened in the same file and in the same commit, and
    // widening it turns an identity oracle into an enumeration surface. The
    // seeded target HAS a stored avatar, so a widened projection would show up
    // as a real value here — this assertion is non-vacuous by construction.
    const target = await User.unscoped().findByPk(withoutAvatar.id);
    await target.update({ picture_url: AVATAR });

    const res = await request(app).get(
      `/api/friendships/search?email=${encodeURIComponent(target.email)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(withoutAvatar.id); // anti-vacuity: a real row came back
    expect(res.body).not.toHaveProperty('picture_url');
    expect(Object.keys(res.body).sort()).toEqual(['id', 'username']);

    expectNoUserPII(res.body, 'GET /friendships/search');
    expectSubFree(res, 'GET /friendships/search');
  });
});
