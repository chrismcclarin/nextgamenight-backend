// tests/routes/games.searchAll.keymiss.test.js
//
// KEYMISS regression (87.5-06, T-875-06-SEARCHALL) + ML-06 personalization gate
// (87.5 adversarial review). GET /api/games/search-all stays on the public
// allow-list for its catalog/BGG arm, but the ?user_id PERSONALIZATION arm is
// token-gated: it runs only when a verified bearer identity (optionalAuth →
// req.user) matchesSelf the ?user_id param, in EITHER keyspace (sub or Users.id
// UUID). Plan 11 (FE) flips the searchAll senders from the caller's Auth0 sub to
// their Users.id UUID; before 87.5-06 the subject resolver was sub-only, so a
// UUID-identified caller silently got ZERO local results while BGG results kept
// rendering. This suite proves: (1) both identifier shapes resolve the SAME
// authenticated caller and surface the same non-empty local results, and (2) the
// ML-06 gate — anonymous callers and non-self ?user_id probes get NO local
// results (BGG-only), closing the unauthenticated UUID collection-enumeration
// probe. It is NAMED and STANDALONE (its own file, declared in the plan's
// files_modified) so its absence is a hard verify failure.
//
// DB-backed suite — run ALONE (shared-Postgres gotcha): npx jest <this file>.

const request = require('supertest');
const express = require('express');

// ML-06: search-all mounts optionalAuth route-level. Stub it with a
// test-controlled identity injector: `mockCurrentActor` (an Auth0 sub) becomes
// req.user, null means anonymous. matchesSelf then sees exactly what the real
// verified-token path would produce.
let mockCurrentActor = null;
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
  optionalAuth: (req, _res, next) => {
    req.user = mockCurrentActor ? { user_id: mockCurrentActor } : null;
    next();
  },
}));

const gameRoutes = require('../../routes/games');
const { Game } = require('../../models');
const { makeUser, makeUserGame } = require('../factories');

const app = express();
app.use(express.json());
app.use('/api/games', gameRoutes);

describe('GET /api/games/search-all — self-only personalization, dual keyspace (KEYMISS + ML-06)', () => {
  let user;
  let game;

  beforeEach(async () => {
    mockCurrentActor = null;
    user = await makeUser();
    // A game the caller "owns" (UserGame is keyed on user.id UUID) whose name
    // matches the search query — this is what should surface in `local` results.
    game = await Game.create({ name: 'Wingspan KEYMISS Fixture', is_custom: true });
    await makeUserGame(user, game);
  });

  it('returns non-empty local results for the AUTHENTICATED caller identified by their Users.id UUID (the shape Plan 11 sends)', async () => {
    mockCurrentActor = user.user_id;
    const res = await request(app)
      .get('/api/games/search-all')
      .query({ query: 'Wingspan', user_id: user.id }) // UUID shape
      .expect(200);

    expect(Array.isArray(res.body.local)).toBe(true);
    // The regression this test guards: a sub-only resolver would return [] here.
    expect(res.body.local.length).toBeGreaterThan(0);
    expect(res.body.local.some(g => g.id === game.id)).toBe(true);
  });

  it('returns the SAME local results for the AUTHENTICATED caller identified by their Auth0 sub (parity — no regression for legacy senders)', async () => {
    mockCurrentActor = user.user_id;
    const res = await request(app)
      .get('/api/games/search-all')
      .query({ query: 'Wingspan', user_id: user.user_id }) // sub shape
      .expect(200);

    expect(Array.isArray(res.body.local)).toBe(true);
    expect(res.body.local.some(g => g.id === game.id)).toBe(true);
  });

  it('ML-06: an ANONYMOUS caller passing a valid Users.id UUID gets NO local results (BGG-only — the enumeration probe is closed)', async () => {
    mockCurrentActor = null; // no bearer token
    const res = await request(app)
      .get('/api/games/search-all')
      .query({ query: 'Wingspan', user_id: user.id })
      .expect(200); // route stays public — it degrades, never 401s

    expect(res.body.local).toEqual([]);
  });

  it('ML-06: an authenticated caller passing ANOTHER user\'s UUID gets NO local results (matchesSelf BOLA guard)', async () => {
    const other = await makeUser();
    mockCurrentActor = other.user_id; // verified as `other`
    const res = await request(app)
      .get('/api/games/search-all')
      .query({ query: 'Wingspan', user_id: user.id }) // probing user's UUID
      .expect(200);

    expect(res.body.local).toEqual([]);
  });
});
