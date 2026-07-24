// tests/routes/games.test.js
const request = require('supertest');
const express = require('express');
const gameRoutes = require('../../routes/games');
const { Game, Event, GameReview, sequelize } = require('../../models');

// Create test app
const app = express();
app.use(express.json());
app.use('/api/games', gameRoutes);

describe('Game Routes', () => {
  // Clean up database before each test
  beforeEach(async () => {
    await GameReview.destroy({ where: {} });
    await Event.destroy({ where: {} });
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
});

