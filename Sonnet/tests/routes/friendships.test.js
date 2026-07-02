// tests/routes/friendships.test.js
// Phase 87 / BINT-01 (T-87-07): friend-request idempotency under a concurrent
// duplicate.
//
// NEW file (Wave-0 gap). CRITICAL test-fidelity caveat (RESEARCH Pitfall 2):
// the Friendship unique constraint is a FUNCTIONAL `LEAST/GREATEST` index
// defined ONLY in a migration — it is absent from the model, so
// sequelize.sync() does NOT build it. A real-DB race therefore CANNOT throw a
// UniqueConstraintError on the sync-built test DB. This suite must instead MOCK
// `Friendship.create` to throw a UniqueConstraintError once, driving the
// route's absorb branch directly. (The RSVP race is real-DB — EventRsvp's
// unique index IS in its model. See rsvp.test.js.)
//
// Behaviors covered:
//   1. happy path: no existing friendship -> create -> 201 with the row.
//   2. idempotency: a concurrent duplicate wins the race -> Friendship.create
//      throws UniqueConstraintError -> the route absorbs it, re-finds the
//      winning row, and returns the SAME (byte-identical) 201 success shape the
//      happy path returns — NOT a 500. Exactly one row is reported.
//
// The route mounts behind verifyAuth0Token in server.js; here we inject req.user
// ahead of the router (mirrors invites.test.js). Friendship model methods are
// spied so no real rows are needed (and the migration-only index is irrelevant).

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const { UniqueConstraintError } = require('sequelize');
const friendshipsRoutes = require('../../routes/friendships');
const { Friendship } = require('../../models');

// Harness: inject a verified req.user before the router (mirrors the real
// verifyAuth0Token middleware server.js mounts).
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/friendships', friendshipsRoutes);

const REQUESTER = 'auth0|friend-requester';
const ADDRESSEE = 'auth0|friend-addressee';

describe('POST /friendships/request — idempotency (BINT-01 / T-87-07)', () => {
  beforeEach(() => {
    currentActor = REQUESTER;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('happy path: no existing friendship -> creates a pending request (201)', async () => {
    const created = {
      id: 'friendship-1',
      requester_id: REQUESTER,
      addressee_id: ADDRESSEE,
      status: 'pending',
    };
    // No existing friendship in either direction.
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create').mockResolvedValue(created);

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject(created);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('absorbs a concurrent duplicate: UniqueConstraintError -> 201 success (no 500), exactly one row', async () => {
    // The winning concurrent request created this row between our pre-check and
    // our create. The absorb path must re-find it and return it verbatim.
    const winner = {
      id: 'friendship-winner',
      requester_id: REQUESTER,
      addressee_id: ADDRESSEE,
      status: 'pending',
    };

    // Pre-check (:150) sees nothing -> route takes the create branch. The absorb
    // re-find (post-violation) returns the winning row.
    const findOneSpy = jest
      .spyOn(Friendship, 'findOne')
      .mockResolvedValueOnce(null) // existence pre-check
      .mockResolvedValueOnce(winner); // absorb re-find

    // The functional LEAST/GREATEST unique index (migration-only) rejects the
    // duplicate — simulated here since sync() does not build it.
    const createSpy = jest
      .spyOn(Friendship, 'create')
      .mockRejectedValueOnce(new UniqueConstraintError({}));

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE });

    // Degrades to success, NOT a 500.
    expect(res.status).not.toBe(500);
    expect(res.status).toBe(201);
    // Byte-identical response shape: the same serialized Friendship row the
    // happy path returns (adversarial-review acceptance criterion).
    expect(res.body).toMatchObject(winner);

    // Exactly one create was attempted; the loser re-found the single winner.
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(findOneSpy).toHaveBeenCalledTimes(2);
  });
});
