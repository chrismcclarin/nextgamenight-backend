// tests/routes/lists.test.js
const request = require('supertest');
const express = require('express');
const listRoutes = require('../../routes/lists');
const { Event, Game, Group, User, UserGroup, EventParticipation } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

// Most list routes derive the actor from the URL :user_id param; the /players
// route (hardened in 87.3 PR-C, review #7) authorizes on req.user like its
// /games sibling — inject a mutable actor for those tests.
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/lists', listRoutes);

describe('List Routes', () => {
  let testUser1, testUser2, testGroup, testGame1, testGame2, testEvent1, testEvent2;

  // Seed in beforeEach so fixtures survive the global per-test TRUNCATE
  // (plan-01 isolation harness). Connection lifecycle is owned by
  // tests/globalTeardown.js — this suite never calls sequelize.close().
  beforeEach(async () => {
    testUser1 = await makeUser({ username: 'testuser1' });
    testUser2 = await makeUser({ username: 'testuser2' });

    testGroup = await makeGroup({ name: 'Test Group' });

    testGame1 = await Game.create({
      name: 'Test Game 1',
      is_custom: true,
      theme: 'Strategy'
    });

    testGame2 = await Game.create({
      name: 'Test Game 2',
      is_custom: true,
      theme: 'Party'
    });

    // Add user1 to group (Auth0 string user_id via factory).
    await addToGroup(testUser1, testGroup);

    // Create events
    testEvent1 = await Event.create({
      group_id: testGroup.id,
      game_id: testGame1.id,
      start_date: new Date('2024-01-01'),
      winner_id: testUser1.id,
      picked_by_id: testUser1.id,
      status: 'completed'
    });

    testEvent2 = await Event.create({
      group_id: testGroup.id,
      game_id: testGame2.id,
      start_date: new Date('2024-01-02'),
      winner_id: testUser2.id,
      picked_by_id: testUser1.id,
      status: 'completed'
    });

    // Create participations
    await EventParticipation.create({
      event_id: testEvent1.id,
      user_id: testUser1.id,
      score: 100,
      placement: 1
    });

    await EventParticipation.create({
      event_id: testEvent2.id,
      user_id: testUser1.id,
      score: 50,
      placement: 2
    });

    await EventParticipation.create({
      event_id: testEvent2.id,
      user_id: testUser2.id,
      score: 100,
      placement: 1
    });
  });

  // Every route in this file now authorizes on req.user (token sub) like the
  // /games + /players siblings (87.4 code-review H-1). Reset the shared actor
  // after each test so a set actor never leaks into the next case.
  afterEach(() => {
    currentActor = null;
  });

  // 87.5 code-review WR-02: the player-wins routes (by name + by-id) were deleted
  // under the Plan-06 dead-route policy — player-wins-by-id filtered on a user_id
  // never selected in its includes (always returned []); player-wins (by name)
  // was functional but had zero FE callers. These now assert the routes are gone
  // (404), mirroring the 87.5-06 deletion precedent below.
  describe('GET /api/lists/player-wins/:group_id/:player_name/:user_id (deleted 87.5 WR-02)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/player-wins/${testGroup.id}/testuser1/${testUser1.user_id}`)
        .expect(404);
    });
  });

  describe('GET /api/lists/player-wins-by-id/:group_id/:player_user_id/:user_id (deleted 87.5 WR-02)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/player-wins-by-id/${testGroup.id}/${testUser1.user_id}/${testUser1.user_id}`)
        .expect(404);
    });
  });

  // 87.5-06 (SPEC Req 9/10): the /most-played and /least-played sort routes were
  // deleted (they 500'd on main, zero FE callers; capability preserved by the
  // unified /lists/games sort/order params). These now assert the routes are gone
  // (404), giving Req 10's "routes return 404" acceptance an executable assertion.
  describe('GET /api/lists/most-played/:group_id/:user_id (deleted 87.5-06)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/most-played/${testGroup.id}/${testUser1.user_id}`)
        .expect(404);
    });
  });

  describe('GET /api/lists/least-played/:group_id/:user_id (deleted 87.5-06)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/least-played/${testGroup.id}/${testUser1.user_id}`)
        .expect(404);
    });
  });

  // 87.5 code-review WR-02: the player-picks routes (by name + by-id) were deleted
  // under the Plan-06 dead-route policy — player-picks-by-id filtered on a user_id
  // never selected in its include (always returned []); player-picks (by name) was
  // functional but had zero FE callers. Assert the routes are gone (404).
  describe('GET /api/lists/player-picks/:group_id/:player_name/:user_id (deleted 87.5 WR-02)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/player-picks/${testGroup.id}/testuser1/${testUser1.user_id}`)
        .expect(404);
    });
  });

  describe('GET /api/lists/player-picks-by-id/:group_id/:player_user_id/:user_id (deleted 87.5 WR-02)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/player-picks-by-id/${testGroup.id}/${testUser1.user_id}/${testUser1.user_id}`)
        .expect(404);
    });
  });

  // 87.6-06 (SPEC Req 2/3): the games-by-theme route was deleted. ⚠ The
  // 87.5-interview KEEP is REVERSED here — the owner overturned it and re-decided
  // delete on 2026-07-22. Zero FE callers; future themed-browsing owned by
  // `2026-07-22-themed-and-player-count-list-browsing-feature.md`. Assert 404.
  describe('GET /api/lists/by-theme/:group_id/:theme/:user_id (deleted 87.6 lists)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/by-theme/${testGroup.id}/Strategy/${testUser1.user_id}`)
        .expect(404);
    });
  });

  // 87.5-06 (SPEC Req 9/10): /alphabetical and /player-games were deleted (they
  // 500'd on main, zero FE callers; alphabetical listing preserved by the unified
  // /lists/games sort/order params). Assert the routes are gone (404).
  describe('GET /api/lists/alphabetical/:group_id/:user_id (deleted 87.5-06)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/alphabetical/${testGroup.id}/${testUser1.user_id}`)
        .expect(404);
    });
  });

  describe('GET /api/lists/player-games/:group_id/:player_name/:user_id (deleted 87.5-06)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/player-games/${testGroup.id}/testuser1/${testUser1.user_id}`)
        .expect(404);
    });
  });

  describe('GET /api/lists/player-games-by-id/:group_id/:player_user_id/:user_id', () => {
    // SKIP(87): same pre-existing `as: 'Players'` invalid-alias bug as
    // player-games (User associated to Event multiple times). Owned by
    // Phase 87 (Data Integrity). See deferred-items.md.
    it.skip('should get all games played by a specific player by user_id', async () => {
      const response = await request(app)
        .get(`/api/lists/player-games-by-id/${testGroup.id}/${testUser1.user_id}/${testUser1.user_id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });
  });

  // 87.6-06 (SPEC Req 2/3): the all-players-in-a-group aggregation route was
  // deleted (zero FE callers; future player-count browsing owned by
  // `2026-07-22-themed-and-player-count-list-browsing-feature.md`). The route's
  // own 403-spoof + UUID-shape coverage drops with it — route gone = no surface.
  // Assert 404.
  describe('GET /api/lists/players/:group_id/:user_id (deleted 87.6 lists)', () => {
    it('404s — route deleted', async () => {
      currentActor = testUser1.user_id;
      await request(app)
        .get(`/api/lists/players/${testGroup.id}/${testUser1.user_id}`)
        .expect(404);
    });
  });
});


// ---------------------------------------------------------------------------
// Phase 88-34 Task 2 (WI-B2) — play stats mean HISTORY.
//
// GET /api/lists/games/:group_id/:user_id computed play_count / last_played /
// first_played (and winner/picker tallies) from EVERY event, so scheduling next
// Saturday's game night immediately bumped that game's play_count and set
// last_played to a FUTURE date.
//
// Ruled scope (2026-08-20): stats only. List MEMBERSHIP is unchanged — a game
// whose only events are future still appears, with play_count 0/last_played null.
// ---------------------------------------------------------------------------
describe('Phase 88-34 WI-B2 — play_count/last_played ignore future events', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let actor, group, playedGame, futureOnlyGame;

  const fetchGames = async () => {
    currentActor = actor.user_id;
    const res = await request(app)
      .get(`/api/lists/games/${group.id}/${actor.user_id}`)
      .expect(200);
    return res.body;
  };

  beforeEach(async () => {
    actor = await makeUser({ user_id: 'test-user-hist-stats', username: 'histactor' });
    group = await makeGroup({ group_id: 'test-group-hist-stats', name: 'History Stats Group' });
    await addToGroup(actor, group);
    playedGame = await Game.create({ name: 'Played Game', is_custom: true });
    futureOnlyGame = await Game.create({ name: 'Future Only Game', is_custom: true });
  });

  afterEach(() => {
    currentActor = null;
  });

  it('a future event does NOT bump play_count and does NOT become last_played', async () => {
    await Event.create({
      group_id: group.id, game_id: playedGame.id,
      start_date: new Date(Date.now() - 10 * DAY_MS), status: 'completed',
    });
    await Event.create({
      group_id: group.id, game_id: playedGame.id,
      start_date: new Date(Date.now() + 10 * DAY_MS), status: 'scheduled',
    });

    const entry = (await fetchGames()).find((g) => g.id === playedGame.id);
    expect(entry.play_count).toBe(1);
    expect(new Date(entry.last_played).getTime()).toBeLessThan(Date.now());
  });

  it('the PAST event still counts (the filter is not over-broad)', async () => {
    await Event.create({
      group_id: group.id, game_id: playedGame.id,
      start_date: new Date(Date.now() - 20 * DAY_MS), status: 'completed',
    });
    await Event.create({
      group_id: group.id, game_id: playedGame.id,
      start_date: new Date(Date.now() - 5 * DAY_MS), status: 'completed',
    });

    const entry = (await fetchGames()).find((g) => g.id === playedGame.id);
    expect(entry.play_count).toBe(2);
  });

  it('cancelled past events do not count as plays', async () => {
    await Event.create({
      group_id: group.id, game_id: playedGame.id,
      start_date: new Date(Date.now() - 5 * DAY_MS), status: 'completed',
    });
    await Event.create({
      group_id: group.id, game_id: playedGame.id,
      start_date: new Date(Date.now() - 2 * DAY_MS), status: 'cancelled',
    });

    const entry = (await fetchGames()).find((g) => g.id === playedGame.id);
    expect(entry.play_count).toBe(1);
  });

  // MEMBERSHIP is deliberately NOT gated — the ruled reading. A game whose only
  // events are future must still APPEAR in the list, with zeroed stats.
  it('(membership pin) a game whose ONLY events are future still appears, with play_count 0 / last_played null', async () => {
    await Event.create({
      group_id: group.id, game_id: futureOnlyGame.id,
      start_date: new Date(Date.now() + 4 * DAY_MS), status: 'scheduled',
    });

    const entry = (await fetchGames()).find((g) => g.id === futureOnlyGame.id);
    expect(entry).toBeDefined();
    expect(entry.play_count).toBe(0);
    expect(entry.last_played).toBeNull();
  });
});
