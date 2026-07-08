// tests/routes/eventBrings.test.js
// Phase 87.1 (BINT-02, D-11/D-12): EventBring ownership + RSVP-yes gates and wire
// shims on the UUID keyspace. This file is NEW — before this phase the
// eventBrings.js:142 DELETE ownership gate had NO coverage anywhere (Nyquist).
//
// Covers:
//   (a) DELETE ownership gate on the UUID keyspace — POSITIVE (owner 200 + row
//       gone) and NEGATIVE (non-owner 403 + row survives). A negative-only suite
//       would pass even if every owner were wrongly 403'd (Pitfall 1).
//   (b) POSITIVE PUT /my-brings — an RSVP'd-yes user (RSVP keyed user_uuid ONLY)
//       can set brings; the response BODY carries the submitted brings (proving
//       the transactional re-fetch keys user_uuid) and each row's user_id is the
//       caller's Auth0 sub, not a UUID (D-12 shim on the write-path response).
//   (c) GET /event response-shape — each bring serializes user_id as the Auth0
//       sub string, not a UUID (D-12 shim).
//
// Real-DB (sequelize.sync via tests/globalSetup.js; per-test TRUNCATE via
// tests/setup.js). verifyAuth0Token is stubbed to a passthrough; req.user is
// injected ahead of the router (mirrors rsvp.test.js). Run ALONE:
//   npm test -- tests/routes/eventBrings.test.js
require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const eventBringsRoutes = require('../../routes/eventBrings');
const {
  EventBring,
  Event,
  Game,
  UserGame,
} = require('../../models');
const {
  makeUser,
  makeGroup,
  addToGroup,
  makeEventRsvp,
  makeEventBring,
} = require('../factories');

// Shared actor ref injected ahead of the router (mirrors verifyAuth0Token).
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/brings', eventBringsRoutes);

describe('EventBring UUID keyspace ownership + wire (Phase 87.1)', () => {
  let owner;
  let other;
  let group;
  let game;
  let event;

  beforeEach(async () => {
    owner = await makeUser({ username: 'brings-owner' });
    other = await makeUser({ username: 'brings-other' });
    group = await makeGroup({ name: 'Brings Group' });
    game = await Game.create({ name: 'Brings Game', is_custom: true });
    // Membership so canReadEventScopedSurface authorizes the GET /event read.
    await addToGroup(owner, group, 'member');
    await addToGroup(other, group, 'member');
    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
    });
  });

  afterEach(() => {
    currentActor = null;
    jest.restoreAllMocks();
  });

  // ---- (a) DELETE ownership gate ----
  it('DELETE: the bring owner can remove their own bring (UUID gate positive)', async () => {
    const bring = await makeEventBring(event, owner, game);
    currentActor = owner.user_id;
    const res = await request(app).delete(`/api/brings/${bring.id}`);
    expect(res.status).toBe(200);
    expect(await EventBring.findByPk(bring.id)).toBeNull();
  });

  it('DELETE: a non-owner cannot remove someone else\'s bring (UUID gate negative)', async () => {
    const bring = await makeEventBring(event, owner, game);
    currentActor = other.user_id;
    const res = await request(app).delete(`/api/brings/${bring.id}`);
    expect(res.status).toBe(403);
    expect(await EventBring.findByPk(bring.id)).not.toBeNull();
  });

  it('DELETE: an unresolvable caller fails closed with 403, not a 500', async () => {
    const bring = await makeEventBring(event, owner, game);
    currentActor = 'auth0|brings-ghost-no-users-row';
    const res = await request(app).delete(`/api/brings/${bring.id}`);
    expect(res.status).toBe(403);
    expect(await EventBring.findByPk(bring.id)).not.toBeNull();
  });

  // ---- (b) PUT /my-brings RSVP-yes gate + re-fetch body + D-12 shim ----
  it('PUT /my-brings: an RSVP\'d-yes user (RSVP keyed user_uuid ONLY) can set brings; the response body carries them with D-12 user_id shape', async () => {
    // UUID-only RSVP: user_id is a non-matching sentinel so an Auth0-keyed
    // RSVP-yes gate would 403 — only a user_uuid-keyed gate matches.
    await makeEventRsvp(event, owner, {
      status: 'yes',
      user_id: `auth0|uuid-only-sentinel-${Date.now()}`,
    });
    // UserGame ownership (UserGame.user_id is the User.id UUID).
    await UserGame.create({ user_id: owner.id, game_id: game.id });

    currentActor = owner.user_id;
    const res = await request(app)
      .put(`/api/brings/event/${event.id}/my-brings`)
      .send({ game_ids: [game.id] });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Response BODY contains the submitted bring — proves the ~113-120
    // transactional re-fetch matched on the UUID keyspace (not an empty body).
    const row = res.body.find(r => r.game_id === game.id);
    expect(row).toBeDefined();
    // D-12: the returned row serializes user_id as the caller's Auth0 sub, not a
    // UUID, and does not leak a raw user_uuid on the wire.
    expect(row.user_id).toBe(owner.user_id);
    expect(row.user_uuid).toBeUndefined();

    // The persisted bring is keyed on user_uuid.
    const persisted = await EventBring.findOne({
      where: { event_id: event.id, user_uuid: owner.id, game_id: game.id },
    });
    expect(persisted).not.toBeNull();
  });

  it('PUT /my-brings: a user without a yes RSVP is 403\'d', async () => {
    // No RSVP seeded → the RSVP-yes gate (keyed user_uuid) must 403.
    await UserGame.create({ user_id: owner.id, game_id: game.id });
    currentActor = owner.user_id;
    const res = await request(app)
      .put(`/api/brings/event/${event.id}/my-brings`)
      .send({ game_ids: [game.id] });
    expect(res.status).toBe(403);
  });

  // ---- (c) GET /event response-shape (D-12) ----
  it('GET /event serializes each bring user_id as the Auth0 sub string, not a UUID (D-12)', async () => {
    await makeEventBring(event, owner, game);
    currentActor = owner.user_id;
    const res = await request(app).get(`/api/brings/event/${event.id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find(b => b.id);
    expect(row).toBeDefined();
    expect(row.user_id).toBe(owner.user_id); // Auth0 sub, D-12
    expect(row.user_uuid).toBeUndefined();   // no raw UUID leak
  });
});
