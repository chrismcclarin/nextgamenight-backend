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

  afterAll(async () => {
    await sequelize.close();
  });

  describe('GET /api/games', () => {
    it('should get all games', async () => {
      // Create test games
      await Game.create({
        name: 'Test Game 1',
        is_custom: true
      });
      await Game.create({
        name: 'Test Game 2',
        is_custom: false
      });

      const response = await request(app)
        .get('/api/games')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter games by search query', async () => {
      await Game.create({ name: 'Catan', is_custom: true });
      await Game.create({ name: 'Ticket to Ride', is_custom: true });
      await Game.create({ name: 'Monopoly', is_custom: true });

      const response = await request(app)
        .get('/api/games?search=Catan')
        .expect(200);

      expect(response.body.length).toBe(1);
      expect(response.body[0].name).toContain('Catan');
    });

    it('should filter games by is_custom', async () => {
      await Game.create({ name: 'Custom Game', is_custom: true });
      await Game.create({ name: 'BGG Game', is_custom: false, bgg_id: 123 });

      const response = await request(app)
        .get('/api/games?is_custom=true')
        .expect(200);

      expect(response.body.every(game => game.is_custom === true)).toBe(true);
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

  describe('POST /api/games', () => {
    it('should create a custom game', async () => {
      const gameData = {
        name: 'New Custom Game',
        min_players: 2,
        max_players: 4,
        playing_time: 60
      };

      const response = await request(app)
        .post('/api/games')
        .send(gameData)
        .expect(200);

      expect(response.body.name).toBe(gameData.name);
      expect(response.body.is_custom).toBe(true);
      expect(response.body.bgg_id).toBeNull();
    });

    it('should return 500 if required fields are missing', async () => {
      const response = await request(app)
        .post('/api/games')
        .send({})
        .expect(500);

      expect(response.body).toHaveProperty('error');
    });

    // BSEC-01 / D-05C: mass-assignment guard. A client must not be able to
    // override the server-forced is_custom/bgg_id columns via POST body.
    it('should not honor a client-forged is_custom/bgg_id on create', async () => {
      const response = await request(app)
        .post('/api/games')
        .send({
          name: 'Forged Game',
          is_custom: false,   // attempt to forge a non-custom game
          bgg_id: 99999        // attempt to forge a BGG id
        })
        .expect(200);

      // Handler force-sets is_custom:true / bgg_id:null — the forged values
      // are ignored even though they are columns (they're in fields:, but the
      // handler's explicit object wins on create).
      expect(response.body.is_custom).toBe(true);
      expect(response.body.bgg_id).toBeNull();
    });

    // BSEC-01 / D-05C: a body key that is NOT a real column / not in the
    // allow-list must not be persisted (Sequelize fields: drops it silently).
    it('should not persist a non-allow-listed body key on create', async () => {
      const response = await request(app)
        .post('/api/games')
        .send({
          name: 'Clean Game',
          totally_made_up_column: 'evil'
        })
        .expect(200);

      const reloaded = await Game.findByPk(response.body.id);
      expect(reloaded).not.toBeNull();
      // The bogus key is not a model attribute, so it never reaches the row.
      expect(reloaded.get('totally_made_up_column')).toBeUndefined();
      expect(reloaded.dataValues.totally_made_up_column).toBeUndefined();
    });
  });

  describe('PUT /api/games/:id', () => {
    it('should update a game', async () => {
      const testGame = await Game.create({
        name: 'Original Name',
        is_custom: true
      });

      const updateData = {
        name: 'Updated Name',
        min_players: 3
      };

      const response = await request(app)
        .put(`/api/games/${testGame.id}`)
        .send(updateData)
        .expect(200);

      expect(response.body.name).toBe(updateData.name);
      expect(response.body.min_players).toBe(updateData.min_players);
    });

    it('should return 404 if game not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(app)
        .put(`/api/games/${fakeId}`)
        .send({ name: 'Updated' })
        .expect(404);

      expect(response.body.error).toBe('Game not found');
    });

    // BSEC-01 / D-05C: a client must not be able to flip is_custom or forge
    // bgg_id via PUT — those columns are excluded from the update allow-list.
    it('should not allow flipping is_custom or forging bgg_id on update', async () => {
      const testGame = await Game.create({
        name: 'BGG Game',
        is_custom: false,
        bgg_id: 12345
      });

      const response = await request(app)
        .put(`/api/games/${testGame.id}`)
        .send({
          name: 'Renamed',
          is_custom: true,   // attempt to flip to custom
          bgg_id: 67890       // attempt to forge a different bgg_id
        })
        .expect(200);

      // Allowed field changed...
      expect(response.body.name).toBe('Renamed');
      // ...but the protected columns are unchanged (not in fields: allow-list).
      const reloaded = await Game.findByPk(testGame.id);
      expect(reloaded.is_custom).toBe(false);
      expect(reloaded.bgg_id).toBe(12345);
    });
  });

  describe('DELETE /api/games/:id', () => {
    it('should delete a game', async () => {
      const testGame = await Game.create({
        name: 'Game to Delete',
        is_custom: true
      });

      const response = await request(app)
        .delete(`/api/games/${testGame.id}`)
        .expect(200);

      expect(response.body.message).toBe('Game deleted successfully');

      // Verify game is deleted
      const deletedGame = await Game.findByPk(testGame.id);
      expect(deletedGame).toBeNull();
    });

    it('should return 404 if game not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(app)
        .delete(`/api/games/${fakeId}`)
        .expect(404);

      expect(response.body.error).toBe('Game not found');
    });
  });
});

