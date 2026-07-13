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
// field — includes with attribute lists AND explicit response-object literals)
// MINUS the named per-endpoint allowlist below. A red on any nested `user_id`
// is a missed Task 1/2b nested-include strip to fix at its owning task — NEVER
// an allowlist addition.
//
// ============================================================================
// NAMED KNOWN-EMITTING ALLOWLIST — the ONLY sanctioned exclusions (both
// deferred to Phase 87.4; per-endpoint, not blanket):
//
// 1. groupPromptSettings surface (user D3 — deliberate bidirectional
//    Auth0-keyspace contract; the FE round-trips member rosters and the
//    selected_member_ids fanout in the SUB keyspace, and the in-code comment
//    warns UUIDs would silently defeat the fanout. Cannot be flipped by
//    serialization edits alone — converts in Phase 87.4 with a bidirectional
//    keyspace migration):
//      GET    /api/groups/:group_id/prompt-settings
//      POST   /api/groups/:group_id/prompt-settings/schedules
//      PATCH  /api/groups/:group_id/prompt-settings/schedules/:schedule_id
//      DELETE /api/groups/:group_id/prompt-settings/schedules/:schedule_id
//      PATCH  /api/groups/:group_id/prompt-settings/schedules/:schedule_id/toggle
//
// 2. Availability family (owner decision 2026-07-12 — the entire
//    availability/prompt subsystem is removed from Phase 87.3 and rescoped to
//    Phase 87.4; its serialization surfaces convert there with the rest of the
//    subsystem):
//      routes/availability.js self-availability CRUD + group overlap/heatmap:
//        GET  /api/availability/user/:user_id
//        POST /api/availability/user/:user_id/recurring
//        POST /api/availability/user/:user_id/override
//        GET  /api/availability/user/:user_id/patterns
//        GET  /api/availability/group/:group_id/overlaps
//        GET  /api/availability/group/:group_id/heatmap
//      routes/availabilityPrompt.js prompts + respondents + heatmap:
//        GET  /api/prompts/:promptId ; GET /api/prompts/:promptId/respondents
//        GET  /api/prompts/:promptId/heatmap ; GET /api/groups/:groupId/prompts/*
//      routes/availabilitySuggestion.js suggestions (+ convert):
//        GET  /api/prompts/:promptId/suggestions ; POST .../refresh ; .../convert
//      routes/availabilityResponse.js + availabilityPrefill.js (magic-token):
//        POST /api/availability-responses ; GET /api/availability-responses/:promptId
//        POST /api/availability-prefill/gcal ; POST /api/availability-prefill/saved
//
// These endpoints are NOT exercised for a sub-free assertion and NOT cleaned in
// this phase — they are named here so the sweep has a sanctioned resolution
// rather than overclaiming whole-API coverage. Follow-up: Phase 87.4.
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

const {
  Event,
  EventParticipation,
  Game,
  Friendship,
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

  it('game reviews: the review list endpoints (nested reviewer User sub-free)', async () => {
    const byGame = await request(app).get(
      `/api/game-reviews/game/${game.id}/group/${group.id}`
    );
    expectSubFree(byGame, 'GET /game-reviews/game/:game_id/group/:group_id');
    expect(byGame.body.length).toBeGreaterThan(0); // non-vacuous
    expect(byGame.body[0].User.id).toBe(member.id);
    expect(byGame.body[0].User.user_id).toBeUndefined();

    const byUser = await request(app).get(
      `/api/game-reviews/user/${member.id}/group/${group.id}`
    );
    expectSubFree(byUser, 'GET /game-reviews/user/:user_id/group/:group_id');
    expect(byUser.body.length).toBeGreaterThan(0);
  });

  it('ballot: GET /ballot/:eventId (created_by sub column never serializes)', async () => {
    const res = await request(app).get(`/api/ballot/${futureEvent.id}`);
    expectSubFree(res, 'GET /ballot/:eventId');
    expect(res.body.options.length).toBeGreaterThan(0); // non-vacuous
  });

  it('lists: games-with-winners (winners/pickers NON-EMPTY, aliased) AND player-stats (D3 — UUID values)', async () => {
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

    const players = await request(app).get(
      `/api/lists/players/${group.id}/${encodeURIComponent(owner.user_id)}`
    );
    expectSubFree(players, 'GET /lists/players/:group_id/:user_id');
    expect(players.body.length).toBeGreaterThanOrEqual(2); // non-vacuous (D3)
  });

  it('users: /users/:user_id (aliased self read) AND /users/search/email/:email (BE-11 dropped)', async () => {
    const self = await request(app).get(
      `/api/users/${encodeURIComponent(owner.user_id)}`
    );
    expectSubFree(self, 'GET /users/:user_id (self)');
    expect(self.body.user_id).toBe(owner.id); // alias — name stable, UUID value

    const crossSearch = await request(app).get(
      `/api/users/search/email/${encodeURIComponent(member.email)}`
    );
    expectSubFree(crossSearch, 'GET /users/search/email/:email (non-self)');
    expect(crossSearch.body).not.toHaveProperty('user_id'); // BE-11 drop
  });

  it('users write echoes: PUT username, PATCH notification-preferences, DELETE phone, POST refresh (toSelfWire aliased on every echo)', async () => {
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

    // auth0Service.getUserById is mocked to reject, so this exercises the
    // Auth0-failure branch — which still echoes the local row via toSelfWire.
    const refreshed = await request(app).post(
      `/api/users/${encodeURIComponent(owner.user_id)}/refresh`
    );
    expectSubFree(refreshed, 'POST /users/:user_id/refresh (Auth0-failure branch)');
    expect(refreshed.body.user_id).toBe(owner.id);
  });

  it('events write echo: PUT /events/:id response (formatEventWithCustomParticipants on the cleaned includes)', async () => {
    const updated = await request(app)
      .put(`/api/events/${futureEvent.id}`)
      .send({ title: 'Sweep Updated' });
    expectSubFree(updated, 'PUT /events/:id (write echo)');
  });
});
