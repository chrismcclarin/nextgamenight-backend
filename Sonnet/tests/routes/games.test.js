// tests/routes/games.test.js
const request = require('supertest');
const express = require('express');
const gameRoutes = require('../../routes/games');
const { Game, Event, GameReview, Group, User, UserGroup, sequelize } = require('../../models');

// Create test app
const app = express();
app.use(express.json());
app.use('/api/games', gameRoutes);

describe('Game Routes', () => {
  // Clean up database before each test
  beforeEach(async () => {
    await GameReview.destroy({ where: {} });
    // Phase 88.2: Event is paranoid (plan 01), so a plain destroy here STAMPS
    // rows and leaves them physically in place — a leftover soft-deleted row is
    // indistinguishable from the regression the 88.2 tests below exist to catch.
    // tests/ is deliberately outside the F-02 CI gate (fixtures legitimately
    // clean up), so nothing else would have flagged this.
    await Event.destroy({ where: {}, force: true });
    await Game.destroy({ where: {} });
  });

  // NOTE: no afterAll(sequelize.close()) — connection lifecycle is owned by
  // tests/globalTeardown.js (BTEST-02).

  // GET /api/games (catalog listing) DELETED in 87.5 review SW-02 — zero product
  // callers, and its ?group_id arm attached group reviews + usernames to an
  // unauthenticated response. Pin the 404 (same precedent as the deleted lists
  // routes) so a re-added route is a deliberate act, not a silent regression.
  describe('GET /api/games — deleted route (SW-02)', () => {
    it('404s — no route responds on the deleted catalog path', async () => {
      await request(app).get('/api/games').expect(404);
    });

    it('404s with the group_id review-leak query too', async () => {
      await request(app).get('/api/games?group_id=g1').expect(404);
    });
  });

  describe('GET /api/games/:id', () => {
    it('should get game by ID', async () => {
      const testGame = await Game.create({
        name: 'Test Game',
        is_custom: true
      });

      const response = await request(app)
        .get(`/api/games/${testGame.id}`)
        .expect(200);

      expect(response.body.id).toBe(testGame.id);
      expect(response.body.name).toBe('Test Game');
    });

    it('should return 404 if game not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(app)
        .get(`/api/games/${fakeId}`)
        .expect(404);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Game not found');
    });
  });

  // POST /api/games (create custom game) DELETED — 87.6 dead-api-surface cleanup
  // (Tier 1, item 1). Zero product callers; custom-create capability is
  // superseded by the live POST /games/resolve (which does Game.create with
  // is_custom:true). A deleted route 404s before any handler/middleware runs, so
  // pin with a plain request against this suite's own mounted app (no actor seam
  // needed — this suite has none) and include a body so the router 404s before
  // any would-be validation. Mirrors the 87.5 WR-02 / SW-02 deletion precedent.
  describe('POST /api/games (deleted 87.6 games-custom-CRUD)', () => {
    it('404s — route deleted', async () => {
      await request(app)
        .post('/api/games')
        .send({ name: 'New Custom Game', min_players: 2, max_players: 4 })
        .expect(404);
    });
  });

  // PUT /api/games/:id (update game) DELETED — 87.6 dead-api-surface cleanup
  // (Tier 3, item 18; owner batch decision 2026-07-22). No FE wrapper, zero
  // callers. Custom-game edit capability is owned by a pending future feature
  // (todo 2026-07-22-edit-and-remove-custom-games-feature.md). 404 pin.
  describe('PUT /api/games/:id (deleted 87.6 games-custom-CRUD)', () => {
    it('404s — route deleted', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await request(app)
        .put(`/api/games/${fakeId}`)
        .send({ name: 'Updated' })
        .expect(404);
    });
  });

  // DELETE /api/games/:id (delete game) DELETED — 87.6 dead-api-surface cleanup
  // (Tier 3, item 19; owner batch decision 2026-07-22). No FE wrapper, zero
  // callers. Custom-game remove capability is owned by the same pending future
  // feature as PUT (todo 2026-07-22-edit-and-remove-custom-games-feature.md). 404 pin.
  describe('DELETE /api/games/:id (deleted 87.6 games-custom-CRUD)', () => {
    it('404s — route deleted', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await request(app)
        .delete(`/api/games/${fakeId}`)
        .expect(404);
    });
  });

  // GET /api/games/for-event/:group_id/:user_id (event-form game picker) DELETED
  // — 87.6 dead-api-surface cleanup (Tier 1, item 2). Zero product callers (the
  // gamesAPI.getGamesForEvent wrapper was dead); superseded by the live
  // GET /games/search-all picker (GameComboInput on the event form). Net-new 404
  // pin (this route had no behavioral block to convert); plain request against
  // this suite's mounted app (no actor seam) with a valid :group_id/:user_id path.
  describe('GET /api/games/for-event/:group_id/:user_id (deleted 87.6 for-event)', () => {
    it('404s — route deleted', async () => {
      const fakeGroupId = '00000000-0000-0000-0000-000000000000';
      const fakeUserId = '11111111-1111-1111-1111-111111111111';
      await request(app)
        .get(`/api/games/for-event/${fakeGroupId}/${fakeUserId}`)
        .expect(404);
    });
  });
});


// ============================================================================
// quick-261027-glg (amends Phase 88.2 plan 04 Task 5, AF-10 / AF-12): GET
// /api/games/:id carries NO GameReviews payload at all.
//
// Until quick-261027-glg this route included every live group's reviews, and
// 88.2 AF-10 filtered a soft-deleted group's reviews out with an inner join
// (GameReview is deliberately NON-paranoid, D-01, so it has no self-defence).
// The include was then deleted as dead payload: 0 frontend readers, and the
// game page reads its reviews from the membership-checked
// GET /game-reviews/game/:game_id/group/:group_id. Deleting it also closed the
// cross-group exposure (adversarial review #317 of Phase 88.6.1), where any
// signed-in caller received every live group's review text, group id and
// reviewer username for any game.
//
// The fixtures stay as they were so these tests prove ABSENCE with reviews from
// a live AND a soft-deleted group present on the same game.
// ============================================================================
describe('quick-261027-glg — GET /api/games/:id carries no GameReviews payload (amends 88.2 AF-10)', () => {
  let game;
  let liveGroup;
  let deadGroup;
  let reviewer;

  beforeEach(async () => {
    // Note: this harness injects no req.user at all, which is a STRICTER caller
    // than the plan's "member of neither group" — nothing here can be mistaken for
    // an implicit membership grant.
    reviewer = await User.create({
      user_id: 'auth0|af10-reviewer', username: 'af10-reviewer', email: 'af10-reviewer@example.com',
    });
    liveGroup = await Group.create({ group_id: 'af10-live', name: 'AF10 Live Group' });
    deadGroup = await Group.create({ group_id: 'af10-dead', name: 'AF10 Doomed Group' });

    // ONE shared game with a live AND a hidden review on the same parent row, so
    // the tests below can prove NEITHER review reaches the payload (the include
    // that once joined them is gone — quick-261027-glg).
    game = await Game.create({ name: 'AF10 Shared Game', is_custom: true });

    await GameReview.create({
      game_id: game.id, group_id: liveGroup.id, user_id: reviewer.id,
      rating: 5, review_text: 'LIVE-GROUP-REVIEW-TEXT',
    });
    await GameReview.create({
      game_id: game.id, group_id: deadGroup.id, user_id: reviewer.id,
      rating: 1, review_text: 'HIDDEN-GROUP-REVIEW-TEXT',
    });
  });

  const softDelete = async (group) => {
    const deletedAt = new Date();
    await Group.update({ deletedAt }, { where: { id: group.id }, silent: true });
    await UserGroup.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
    await Event.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
  };

  // Recursive scan — the hidden group's id must not appear at ANY nesting depth.
  const containsValue = (node, needle) => {
    if (node === null || node === undefined) return false;
    if (typeof node === 'string') return node === needle;
    if (Array.isArray(node)) return node.some((v) => containsValue(v, needle));
    if (typeof node === 'object') return Object.values(node).some((v) => containsValue(v, needle));
    return false;
  };

  it('soft-deleted AND live group reviews exist: no GameReviews key, neither group\'s id or review text', async () => {
    await softDelete(deadGroup);

    const res = await request(app).get(`/api/games/${game.id}`).expect(200);

    expect(res.body.id).toBe(game.id);
    expect(res.body.GameReviews).toBeUndefined();
    expect(Object.keys(res.body)).not.toContain('GameReviews');

    // Neither group's id at any depth, nor either review text.
    expect(containsValue(res.body, liveGroup.id)).toBe(false);
    expect(containsValue(res.body, deadGroup.id)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('LIVE-GROUP-REVIEW-TEXT');
    expect(JSON.stringify(res.body)).not.toContain('HIDDEN-GROUP-REVIEW-TEXT');

    // Seed control: the absence is not an empty seed.
    expect(await GameReview.count({ where: { game_id: game.id } })).toBe(2);
  });

  it('(both groups live) still no GameReviews key: the payload was removed, not filtered', async () => {
    const res = await request(app).get(`/api/games/${game.id}`).expect(200);

    expect(res.body.id).toBe(game.id);
    expect(res.body.GameReviews).toBeUndefined();
    expect(Object.keys(res.body)).not.toContain('GameReviews');

    expect(containsValue(res.body, liveGroup.id)).toBe(false);
    expect(containsValue(res.body, deadGroup.id)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('LIVE-GROUP-REVIEW-TEXT');
    expect(JSON.stringify(res.body)).not.toContain('HIDDEN-GROUP-REVIEW-TEXT');

    expect(await GameReview.count({ where: { game_id: game.id } })).toBe(2);
  });

  it('no reviewer username, group name or group id reaches the body', async () => {
    await softDelete(deadGroup);

    const res = await request(app).get(`/api/games/${game.id}`).expect(200);
    const body = JSON.stringify(res.body);

    expect(res.body.id).toBe(game.id);
    expect(body).not.toContain(reviewer.username);
    expect(body).not.toContain(liveGroup.name);
    expect(body).not.toContain(deadGroup.name);
    expect(body).not.toContain(liveGroup.id);
    expect(body).not.toContain(deadGroup.id);

    const keys = Object.keys(res.body);
    expect(keys).not.toContain('User');
    expect(keys).not.toContain('Group');
    expect(keys).not.toContain('GameReviews');

    expect(await GameReview.count({ where: { game_id: game.id } })).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 88-34 Task 2 (WI-B2, fork B) — GET /api/games/:id ships NO Events key.
//
// The Event include here was dead payload (zero FE readers: gameDetail calls
// this route, does setGame(gameData), and never reads game.Events — its Game
// Sessions list consumes GET /events/group/:group_id instead). It was also an
// INNER JOIN, so a game with zero events 404'd, and it was group-agnostic on a
// group-blind route, so it leaked every group's sessions for a game.
// ---------------------------------------------------------------------------
describe('Phase 88-34 WI-B2 — GET /api/games/:id carries no Events payload (fork B)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('response has NO Events key, even for a game that HAS events', async () => {
    const game = await Game.create({ name: 'Include-Deleted Game', is_custom: true });
    const group = await Group.create({ group_id: 'gid-88-34-fb', name: 'FB Group' });
    await Event.create({
      group_id: group.id, game_id: game.id,
      start_date: new Date(Date.now() - 3 * DAY_MS), status: 'completed',
    });

    const res = await request(app).get(`/api/games/${game.id}`).expect(200);

    expect(res.body.id).toBe(game.id);
    expect(res.body.Events).toBeUndefined();
    expect(Object.keys(res.body)).not.toContain('Events');
  });

  // The include-404 class dies with the include: an INNER JOIN on Events made a
  // game with zero events unreachable (AutoFix#2, resolved-by-deletion).
  it('a game with ZERO events returns 200, not 404', async () => {
    const game = await Game.create({ name: 'Eventless Game', is_custom: true });

    const res = await request(app).get(`/api/games/${game.id}`).expect(200);
    expect(res.body.id).toBe(game.id);
    expect(res.body.name).toBe('Eventless Game');
  });

  // r1 triage #5: the 500 handler used to return raw error.message (Sequelize
  // errors leak column/constraint names and SQL fragments).
  it('the 500 handler does not leak raw error detail to the client', async () => {
    const spy = jest
      .spyOn(Game, 'findByPk')
      .mockRejectedValueOnce(new Error('column "secret_internal_col" does not exist'));
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app)
      .get('/api/games/00000000-0000-0000-0000-000000000001')
      .expect(500);

    expect(res.body.error).toBe('Unable to retrieve game');
    expect(JSON.stringify(res.body)).not.toContain('secret_internal_col');

    spy.mockRestore();
    logSpy.mockRestore();
  });
});
