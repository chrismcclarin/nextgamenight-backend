// tests/routes/games.searchAll.keymiss.test.js
//
// KEYMISS regression (87.5-06, T-875-06-SEARCHALL). GET /api/games/search-all is a
// PUBLIC route (no auth gate), so its ?user_id query-param is the ONLY place the
// caller's identifier is interpreted. Plan 11 (FE) flips the searchAll senders from
// the caller's Auth0 sub to their Users.id UUID. Before this plan the subject
// resolver was sub-only (User.findOne on user_id), so a UUID-identified caller
// silently got ZERO local results while BGG results kept rendering. This plan gives
// the resolver the same dual sub-or-UUID resolution the sibling /games/for-event
// route already uses. This suite proves both identifier shapes resolve the SAME
// caller and surface the same non-empty local results — it is NAMED and STANDALONE
// (its own file, declared in the plan's files_modified) so its absence is a hard
// verify failure, never silently skipped behind a broader passing suite.
//
// DB-backed suite — run ALONE (shared-Postgres gotcha): npx jest <this file>.

const request = require('supertest');
const express = require('express');
const gameRoutes = require('../../routes/games');
const { Game } = require('../../models');
const { makeUser, makeUserGame } = require('../factories');

const app = express();
app.use(express.json());
app.use('/api/games', gameRoutes);

describe('GET /api/games/search-all — subject resolver dual-accepts sub or Users.id UUID (KEYMISS)', () => {
  let user;
  let game;

  beforeEach(async () => {
    user = await makeUser();
    // A game the caller "owns" (UserGame is keyed on user.id UUID) whose name
    // matches the search query — this is what should surface in `local` results.
    game = await Game.create({ name: 'Wingspan KEYMISS Fixture', is_custom: true });
    await makeUserGame(user, game);
  });

  it('returns non-empty local results when the caller is identified by their Users.id UUID (the shape Plan 11 sends)', async () => {
    const res = await request(app)
      .get('/api/games/search-all')
      .query({ query: 'Wingspan', user_id: user.id }) // UUID shape
      .expect(200);

    expect(Array.isArray(res.body.local)).toBe(true);
    // The regression this test guards: a sub-only resolver would return [] here.
    expect(res.body.local.length).toBeGreaterThan(0);
    expect(res.body.local.some(g => g.id === game.id)).toBe(true);
  });

  it('returns the SAME local results when the caller is identified by their Auth0 sub (parity — no regression for legacy senders)', async () => {
    const res = await request(app)
      .get('/api/games/search-all')
      .query({ query: 'Wingspan', user_id: user.user_id }) // sub shape
      .expect(200);

    expect(Array.isArray(res.body.local)).toBe(true);
    expect(res.body.local.some(g => g.id === game.id)).toBe(true);
  });
});
