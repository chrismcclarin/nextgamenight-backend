// tests/routes/userGames.test.js
// Phase 87.3 PR-C (plan 09, Rule 2 deviation): GET /user-games/user/:user_id is
// a SELF-ONLY route whose gate historically compared the param against the
// caller's Auth0 sub. PR-C aliases the self-identity response's `user_id` to
// the Users.id UUID (BE-10), and BringGamePicker feeds `self.user_id` into this
// route — so the self-gate now accepts EITHER of the caller's own identifiers
// (sub OR Users.id UUID). Both arms compare against the JWT-resolved caller
// row; another user's identifier (either shape) stays 403.
//
// Real-DB (factories). Run ALONE per the never-green-locally caveat:
//   npm test -- tests/routes/userGames.test.js
require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const userGamesRoutes = require('../../routes/userGames');
const { UserGame, Game } = require('../../models');
const { makeUser } = require('../factories');

let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/user-games', userGamesRoutes);

describe('GET /user-games/user/:user_id — self-gate accepts BOTH caller identifier shapes (87.3 PR-C)', () => {
  let owner;
  let other;
  let game;

  beforeEach(async () => {
    owner = await makeUser({ username: 'ug-owner' });
    other = await makeUser({ username: 'ug-other' });
    game = await Game.create({ name: 'UG Gate Game', is_custom: true });
    // UserGame.user_id is the Users.id UUID keyspace.
    await UserGame.create({ user_id: owner.id, game_id: game.id });
  });

  afterEach(() => {
    currentActor = null;
  });

  it('caller can read their own games via their Auth0 sub (legacy arm)', async () => {
    currentActor = owner.user_id;
    const res = await request(app).get(
      `/api/user-games/user/${encodeURIComponent(owner.user_id)}`
    );
    expect(res.status).toBe(200);
    expect(res.body.find((g) => g.id === game.id)).toBeDefined();
  });

  it('caller can read their own games via their Users.id UUID (PR-C arm — BringGamePicker sends the aliased self.user_id)', async () => {
    currentActor = owner.user_id;
    const res = await request(app).get(`/api/user-games/user/${owner.id}`);
    expect(res.status).toBe(200);
    expect(res.body.find((g) => g.id === game.id)).toBeDefined();
  });

  it("ANOTHER user's UUID is still 403 (the gate stays strictly self-only)", async () => {
    currentActor = other.user_id;
    const res = await request(app).get(`/api/user-games/user/${owner.id}`);
    expect(res.status).toBe(403);
  });

  it("ANOTHER user's sub is still 403", async () => {
    currentActor = other.user_id;
    const res = await request(app).get(
      `/api/user-games/user/${encodeURIComponent(owner.user_id)}`
    );
    expect(res.status).toBe(403);
  });
});

describe('userGames WRITE routes — same dual-armed self-gate (PR-C review #19)', () => {
  let owner;
  let other;
  let game;

  beforeEach(async () => {
    owner = await makeUser({ username: 'ugw-owner' });
    other = await makeUser({ username: 'ugw-other' });
    game = await Game.create({ name: 'UG Write Game', is_custom: true });
  });

  afterEach(() => {
    currentActor = null;
  });

  it('POST add-game accepts the caller UUID arm and writes to the CALLER row', async () => {
    currentActor = owner.user_id;
    const res = await request(app).post(
      `/api/user-games/user/${owner.id}/game/${game.id}`
    );
    expect(res.status).toBe(200);
    const row = await UserGame.findOne({ where: { user_id: owner.id, game_id: game.id } });
    expect(row).not.toBeNull();
  });

  it("POST add-game with ANOTHER user's identifier is 403 (pre-fix it had NO gate)", async () => {
    currentActor = other.user_id;
    const res = await request(app).post(
      `/api/user-games/user/${owner.id}/game/${game.id}`
    );
    expect(res.status).toBe(403);
    const row = await UserGame.findOne({ where: { user_id: owner.id, game_id: game.id } });
    expect(row).toBeNull();
  });

  it('DELETE remove-game accepts the caller UUID arm; another user 403s', async () => {
    await UserGame.create({ user_id: owner.id, game_id: game.id });

    currentActor = other.user_id;
    const denied = await request(app).delete(
      `/api/user-games/user/${owner.id}/game/${game.id}`
    );
    expect(denied.status).toBe(403);

    currentActor = owner.user_id;
    const ok = await request(app).delete(
      `/api/user-games/user/${owner.id}/game/${game.id}`
    );
    expect(ok.status).toBe(200);
    const row = await UserGame.findOne({ where: { user_id: owner.id, game_id: game.id } });
    expect(row).toBeNull();
  });

  it("import-bgg-collection with ANOTHER user's UUID is 403 before any BGG call", async () => {
    currentActor = other.user_id;
    const res = await request(app)
      .post(`/api/user-games/user/${owner.id}/import-bgg-collection`)
      .send({ bgg_username: 'someone' });
    expect(res.status).toBe(403);
  });
});
