// tests/routes/friendships.test.js
// Phase 87 / BINT-01 (T-87-07): friend-request idempotency under a concurrent
// duplicate.
// Phase 87.1 / BINT-02 (D-11/D-12, Plan 87.1-05): friendship authz cutover onto
// the Users.id UUID keyspace (requester_uuid/addressee_uuid).
// Phase 87.3 PR-C (plan 09): the wire contract is now UUID-carrying — the flat
// requester_id/addressee_id fields CARRY the Users.id UUID (SPEC Req 2, names
// stable), the nested Requester/Addressee includes are sub-free (id/username
// only), GET /search drops its flat user_id (BE-12, D1), and POST /request is
// UUID-ONLY (D1 contraction — the PR-A sub fallback is removed).
//
// CRITICAL test-fidelity caveat (RESEARCH Pitfall 2): the Friendship unique
// constraint is a FUNCTIONAL `LEAST/GREATEST` index defined ONLY in a migration
// — it is absent from the model, so sequelize.sync() does NOT build it. A real-DB
// race therefore CANNOT throw a UniqueConstraintError on the sync-built test DB.
// This suite MOCKS Friendship.create to throw once, driving the absorb branch.
//
// SANDBOX NOTE (confirmed Plans 01-04): this suite is deliberately mock-based
// (jest.spyOn on model methods + injected req.user) — no real rows, no DB
// connection. The authoritative gate is BE PR CI Postgres. The mocks let us
// assert the UUID-keyed authz + the PR-C UUID wire contract without a live DB.
//
// Behaviors covered:
//   1. request happy path -> 201, flat fields carry the Users.id UUIDs.
//   2. request idempotency: concurrent duplicate -> 201 (not 500), one row.
//   3. accept: real addressee CAN accept (200); a non-addressee CANNOT (403).
//   4. decline: real addressee CAN decline (200); a non-addressee CANNOT (403).
//   5. delete: requester/addressee CAN unfriend (200); an outsider CANNOT (403).
//   6. declined-re-request DIRECTIONALITY SWAP: A req B, B declines, B re-requests
//      A -> the UUID direction swaps; only A can now accept, B cannot self-accept.
//   7. GET wire shape: requester_id/addressee_id carry the UUIDs; the nested
//      includes are sub-free; friend-derive returns the correct counterpart.
//   8. GET directional: a pending request surfaces in BOTH the received (addressee)
//      and sent (requester) lists, UUIDs on the wire in both.
//   9. D1 contraction: POST /request rejects a sub-shaped target as not-found.
//  10. GET /search (BE-12): no flat user_id, no sub anywhere in the body.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const { Op, UniqueConstraintError } = require('sequelize');
const friendshipsRoutes = require('../../routes/friendships');
const { Friendship, User } = require('../../models');

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

// --- Identity fixtures: Auth0 string <-> Users.id UUID surrogate ---
const REQUESTER = 'auth0|friend-requester';
const ADDRESSEE = 'auth0|friend-addressee';
const OUTSIDER = 'auth0|friend-outsider';
const REQUESTER_UUID = '11111111-1111-1111-1111-111111111111';
const ADDRESSEE_UUID = '22222222-2222-2222-2222-222222222222';
const OUTSIDER_UUID = '33333333-3333-3333-3333-333333333333';

const USERS = {
  [REQUESTER]: { id: REQUESTER_UUID, user_id: REQUESTER, username: 'requester' },
  [ADDRESSEE]: { id: ADDRESSEE_UUID, user_id: ADDRESSEE, username: 'addressee' },
  [OUTSIDER]: { id: OUTSIDER_UUID, user_id: OUTSIDER, username: 'outsider' },
};

// Wire-shape regexes (Phase 87.3): the PR-C contract is UUID-only on the wire;
// the Auth0 sub is provider-prefixed and must never appear.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_RE = /^(auth0|google-oauth2|apple)\|/;

// Stub User.findOne to resolve Auth0 string -> Users row (the once-per-handler
// caller resolution) and User.findByPk for the UUID-only target resolution
// (resolveTargetUserUuidOnly, PR-C).
const USERS_BY_UUID = Object.fromEntries(
  Object.values(USERS).map((u) => [u.id, u])
);
function stubUsers() {
  jest.spyOn(User, 'findOne').mockImplementation(async ({ where }) => USERS[where.user_id] || null);
  jest.spyOn(User, 'findByPk').mockImplementation(async (id) => USERS_BY_UUID[id] || null);
}

// A fake Friendship instance with a spyable update()/destroy(). Mirrors the
// real post-87.1 toJSON shape: UUID endpoint columns + the (now sub-free)
// nested Requester/Addressee includes.
function fakeFriendship(overrides = {}) {
  const f = {
    id: 'friendship-1',
    requester_uuid: REQUESTER_UUID,
    addressee_uuid: ADDRESSEE_UUID,
    status: 'pending',
    Requester: { id: REQUESTER_UUID, username: 'requester' },
    Addressee: { id: ADDRESSEE_UUID, username: 'addressee' },
    ...overrides,
  };
  f.update = jest.fn(async (patch) => { Object.assign(f, patch); return f; });
  f.destroy = jest.fn(async () => {});
  return f;
}

// Assert a wire body honors the PR-C contract: flat requester_id/addressee_id
// CARRY the Users.id UUIDs (names stable, SPEC Req 2), never a sub.
function expectUuidWire(body, { requester, addressee }) {
  expect(body.requester_id).toBe(requester);
  expect(body.addressee_id).toBe(addressee);
  expect(body.requester_id).toMatch(UUID_RE);
  expect(body.addressee_id).toMatch(UUID_RE);
  expect(body.requester_id).not.toMatch(SUB_RE);
  expect(body.addressee_id).not.toMatch(SUB_RE);
}

afterEach(() => {
  jest.restoreAllMocks();
  currentActor = null;
});

describe('POST /friendships/request — idempotency (BINT-01 / T-87-07) + PR-C UUID wire', () => {
  beforeEach(() => {
    currentActor = REQUESTER;
    stubUsers();
  });

  it('happy path: no existing friendship -> creates a pending request (201) with UUID-carrying wire', async () => {
    const created = {
      id: 'friendship-1',
      requester_uuid: REQUESTER_UUID,
      addressee_uuid: ADDRESSEE_UUID,
      status: 'pending',
    };
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create').mockResolvedValue(created);

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE_UUID }); // PR-C: senders pass the UUID

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'friendship-1', status: 'pending' });
    // PR-C (Req 2): flat fields carry the Users.id UUIDs.
    expectUuidWire(res.body, { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requester_uuid: REQUESTER_UUID, addressee_uuid: ADDRESSEE_UUID })
    );
  });

  it('absorbs a concurrent duplicate: UniqueConstraintError -> 201 success (no 500), exactly one row, UUID wire', async () => {
    const winner = fakeFriendship({ id: 'friendship-winner' });

    const findOneSpy = jest
      .spyOn(Friendship, 'findOne')
      .mockResolvedValueOnce(null) // existence pre-check
      .mockResolvedValueOnce(winner); // absorb re-find (no includes)

    const createSpy = jest
      .spyOn(Friendship, 'create')
      .mockRejectedValueOnce(new UniqueConstraintError({}));

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE_UUID });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'friendship-winner', status: 'pending' });
    expectUuidWire(res.body, { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(findOneSpy).toHaveBeenCalledTimes(2);
  });

  it('404s when the addressee UUID has no Users row (genuine not-found)', async () => {
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create');

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: '99999999-9999-4999-8999-999999999999' });

    expect(res.status).toBe(404);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// Phase 87.3 PR-C (plan 09, user D1 contraction): POST /request resolves its
// client-supplied addressee_user_id UUID-ONLY — the PR-A sub fallback (AF7) is
// removed now that PR-B (plan 06, AF12b) cut every FE sender to the nested
// `.id`. The UUID shape succeeds; a sub-shaped target rejects as not-found.
describe('POST /friendships/request — UUID-only target resolution (87.3 PR-C contraction)', () => {
  beforeEach(() => {
    currentActor = REQUESTER;
    stubUsers();
  });

  it('accepts a UUID-shaped addressee_user_id -> 201, UUID-carrying wire', async () => {
    const created = {
      id: 'friendship-1',
      requester_uuid: REQUESTER_UUID,
      addressee_uuid: ADDRESSEE_UUID,
      status: 'pending',
    };
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create').mockResolvedValue(created);

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE_UUID });

    expect(res.status).toBe(201);
    // Resolved via User.findByPk (the ONLY resolution path post-contraction).
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requester_uuid: REQUESTER_UUID, addressee_uuid: ADDRESSEE_UUID })
    );
    expectUuidWire(res.body, { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });
  });

  it('REJECTS a sub-shaped addressee_user_id (D1 contraction — sub fallback removed) -> 404, no create', async () => {
    // Pre-contraction this succeeded via the sub fallback. Post-PR-C a sub is
    // not-found by design (accepted stale-bundle trade-off — never re-add).
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create');

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE }); // Auth0 sub — no longer resolves

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('rejects a self-request via the UUID shape -> 400 (guard on resolved identity, no fail-open)', async () => {
    const createSpy = jest.spyOn(Friendship, 'create');
    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: REQUESTER_UUID }); // caller's OWN UUID

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a self-request via the sub shape is a 404 post-contraction (sub no longer resolves at all)', async () => {
    const createSpy = jest.spyOn(Friendship, 'create');
    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: REQUESTER }); // caller's OWN sub

    expect(res.status).toBe(404);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a UUID-addressed request does not slip past the duplicate check -> 409', async () => {
    // An existing accepted friendship (either direction) must be detected even
    // when the new request addresses the target by UUID.
    const findOneSpy = jest.spyOn(Friendship, 'findOne').mockResolvedValue(
      fakeFriendship({ status: 'accepted' })
    );
    const createSpy = jest.spyOn(Friendship, 'create');

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE_UUID });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already friends/i);
    expect(createSpy).not.toHaveBeenCalled();
    // 87.3 code-review #13: findOne is mocked unconditionally, so the 409 alone
    // proves nothing about HOW the duplicate check was keyed. Pin the where
    // clause: both Op.or arms must key the RESOLVED UUID pair (caller + resolved
    // addressee), not the raw param.
    const dupWhere = findOneSpy.mock.calls[0][0].where;
    expect(dupWhere[Op.or]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requester_uuid: REQUESTER_UUID, addressee_uuid: ADDRESSEE_UUID }),
        expect.objectContaining({ requester_uuid: ADDRESSEE_UUID, addressee_uuid: REQUESTER_UUID }),
      ])
    );
  });
});

describe('POST /friendships/:id/accept — ownership gate on UUID (D-11)', () => {
  beforeEach(stubUsers);

  it('the REAL addressee CAN accept (200) and gets a UUID-carrying wire', async () => {
    currentActor = ADDRESSEE;
    const friendship = fakeFriendship();
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(friendship);

    const res = await request(app).post('/api/friendships/friendship-1/accept');

    expect(res.status).toBe(200);
    expect(friendship.update).toHaveBeenCalledWith({ status: 'accepted' });
    expect(res.body.status).toBe('accepted');
    expectUuidWire(res.body, { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });
    // PR-C nested strip: the nested includes are sub-free.
    expect(res.body.Requester.user_id).toBeUndefined();
    expect(res.body.Addressee.user_id).toBeUndefined();
  });

  it('a NON-addressee (the requester) CANNOT accept -> 403, no status change', async () => {
    currentActor = REQUESTER; // requester is not the addressee
    const friendship = fakeFriendship();
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(friendship);

    const res = await request(app).post('/api/friendships/friendship-1/accept');

    expect(res.status).toBe(403);
    expect(friendship.update).not.toHaveBeenCalled();
  });

  it('an unrelated outsider CANNOT accept -> 403', async () => {
    currentActor = OUTSIDER;
    const friendship = fakeFriendship();
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(friendship);

    const res = await request(app).post('/api/friendships/friendship-1/accept');

    expect(res.status).toBe(403);
    expect(friendship.update).not.toHaveBeenCalled();
  });
});

describe('POST /friendships/:id/decline — ownership gate on UUID (D-11)', () => {
  beforeEach(stubUsers);

  it('the REAL addressee CAN decline (200), UUID-carrying wire', async () => {
    currentActor = ADDRESSEE;
    const friendship = fakeFriendship();
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(friendship);

    const res = await request(app).post('/api/friendships/friendship-1/decline');

    expect(res.status).toBe(200);
    expect(friendship.update).toHaveBeenCalledWith({ status: 'declined' });
    expectUuidWire(res.body, { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });
  });

  it('a NON-addressee CANNOT decline -> 403', async () => {
    currentActor = REQUESTER;
    const friendship = fakeFriendship();
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(friendship);

    const res = await request(app).post('/api/friendships/friendship-1/decline');

    expect(res.status).toBe(403);
    expect(friendship.update).not.toHaveBeenCalled();
  });
});

describe('DELETE /friendships/:id — unfriend gate on UUID (D-11)', () => {
  beforeEach(stubUsers);

  it('the requester CAN unfriend (200)', async () => {
    currentActor = REQUESTER;
    const friendship = fakeFriendship({ status: 'accepted' });
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(friendship);

    const res = await request(app).delete('/api/friendships/friendship-1');

    expect(res.status).toBe(200);
    expect(friendship.destroy).toHaveBeenCalled();
  });

  it('the addressee CAN unfriend (200)', async () => {
    currentActor = ADDRESSEE;
    const friendship = fakeFriendship({ status: 'accepted' });
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(friendship);

    const res = await request(app).delete('/api/friendships/friendship-1');

    expect(res.status).toBe(200);
    expect(friendship.destroy).toHaveBeenCalled();
  });

  it('an outsider CANNOT unfriend -> 403, no destroy', async () => {
    currentActor = OUTSIDER;
    const friendship = fakeFriendship({ status: 'accepted' });
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(friendship);

    const res = await request(app).delete('/api/friendships/friendship-1');

    expect(res.status).toBe(403);
    expect(friendship.destroy).not.toHaveBeenCalled();
  });
});

describe('Declined-re-request DIRECTIONALITY SWAP (MED/LOW adopt-all, mandated)', () => {
  beforeEach(stubUsers);

  it('A req B, B declines, B re-requests A -> UUID direction swaps; only A can accept, B cannot self-accept', async () => {
    // Original row: A(=REQUESTER) -> B(=ADDRESSEE), now declined.
    const declinedRow = fakeFriendship({ status: 'declined' });
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(declinedRow);

    // B re-requests A: caller = B (ADDRESSEE), target = A (REQUESTER) — by UUID (PR-C).
    currentActor = ADDRESSEE;
    const reReq = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: REQUESTER_UUID });

    expect(reReq.status).toBe(200);
    // The existing row's UUID direction SWAPPED to B->A.
    expect(declinedRow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        requester_uuid: ADDRESSEE_UUID, // B is now the requester
        addressee_uuid: REQUESTER_UUID, // A is now the addressee
        status: 'pending',
      })
    );
    // PR-C: the wire carries the swapped UUIDs (re-request direction).
    expectUuidWire(reReq.body, { requester: ADDRESSEE_UUID, addressee: REQUESTER_UUID });

    // Behavioral proof of the swap: the row is now B(requester)->A(addressee).
    const swapped = fakeFriendship({
      requester_uuid: ADDRESSEE_UUID,
      addressee_uuid: REQUESTER_UUID,
      status: 'pending',
      Requester: { id: ADDRESSEE_UUID, username: 'addressee' },
      Addressee: { id: REQUESTER_UUID, username: 'requester' },
    });
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(swapped);

    // A (the new addressee) CAN accept.
    currentActor = REQUESTER;
    const aAccepts = await request(app).post('/api/friendships/friendship-1/accept');
    expect(aAccepts.status).toBe(200);
    expect(swapped.update).toHaveBeenCalledWith({ status: 'accepted' });

    // B (the re-requester, now the requester) CANNOT self-accept.
    swapped.status = 'pending';
    swapped.update.mockClear();
    currentActor = ADDRESSEE;
    const bAccepts = await request(app).post('/api/friendships/friendship-1/accept');
    expect(bAccepts.status).toBe(403);
    expect(swapped.update).not.toHaveBeenCalled();
  });
});

describe('GET /friendships — PR-C UUID wire + UUID where-branches', () => {
  beforeEach(stubUsers);

  it('accepted branch: flat requester_id/addressee_id carry the UUIDs, nested includes are sub-free, friend-derive returns the counterpart', async () => {
    currentActor = REQUESTER;
    const row = fakeFriendship({ status: 'accepted' });
    const findAllSpy = jest.spyOn(Friendship, 'findAll').mockResolvedValue([row]);

    const res = await request(app).get('/api/friendships');

    expect(res.status).toBe(200);
    const [f] = res.body;
    // PR-C (Req 2): the flat fields carry the Users.id UUIDs, never a sub.
    expect(f.requester_id).toBe(REQUESTER_UUID);
    expect(f.requester_id).not.toMatch(SUB_RE);
    expect(f.addressee_id).toBe(ADDRESSEE_UUID);
    expect(f.addressee_id).not.toMatch(SUB_RE);
    // D-05 INCLUDE-PIN: the nested Requester.id / Addressee.id the FE compares
    // against MUST be the UUID; the nested sub user_id is REMOVED (PR-C strip).
    expect(f.Requester.id).toMatch(UUID_RE);
    expect(f.Requester.id).not.toMatch(SUB_RE);
    expect(f.Requester.user_id).toBeUndefined();
    expect(f.Addressee.id).toMatch(UUID_RE);
    expect(f.Addressee.id).not.toMatch(SUB_RE);
    expect(f.Addressee.user_id).toBeUndefined();
    // friend-derive: caller is the requester -> friend is the Addressee.
    expect(f.friend.id).toBe(ADDRESSEE_UUID);
    expect(f.friend.user_id).toBeUndefined();
    // accepted where-branch (Op.or) keyed the UUID columns.
    const whereArg = findAllSpy.mock.calls[0][0].where;
    expect(whereArg[Op.or][0].requester_uuid).toBe(REQUESTER_UUID);
    expect(whereArg[Op.or][1].addressee_uuid).toBe(REQUESTER_UUID);
    expect(whereArg[Op.or][0].requester_id).toBeUndefined();
    // 87.3 code-review H1: findAll is MOCKED, so the nested-id assertions above
    // only exercise the fixture — they would stay green if USER_INCLUDES dropped
    // 'id'. Make the pin bite on the QUERY: assert the include requests exactly
    // the sub-free nested projection the FE cutover depends on (id + username,
    // NO user_id — the PR-C contracted end state).
    const includeArg = findAllSpy.mock.calls[0][0].include;
    expect(includeArg).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          as: 'Requester',
          attributes: expect.arrayContaining(['id', 'username']),
        }),
        expect.objectContaining({
          as: 'Addressee',
          attributes: expect.arrayContaining(['id', 'username']),
        }),
      ])
    );
    for (const inc of includeArg) {
      expect(inc.attributes).not.toContain('user_id');
    }
  });

  it('a pending request surfaces in BOTH received (addressee) and sent (requester) lists, UUIDs in both (mandated directional test)', async () => {
    const pending = fakeFriendship({ status: 'pending' });

    // received: the ADDRESSEE views incoming pending requests.
    currentActor = ADDRESSEE;
    const findAllReceived = jest.spyOn(Friendship, 'findAll').mockResolvedValue([pending]);
    const received = await request(app).get('/api/friendships?status=pending&direction=received');
    expect(received.status).toBe(200);
    expectUuidWire(received.body[0], { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });
    // received branch keys addressee_uuid = caller.id.
    expect(findAllReceived.mock.calls[0][0].where.addressee_uuid).toBe(ADDRESSEE_UUID);
    jest.restoreAllMocks();
    stubUsers();

    // sent: the REQUESTER views their outgoing pending requests.
    currentActor = REQUESTER;
    const findAllSent = jest.spyOn(Friendship, 'findAll').mockResolvedValue([pending]);
    const sent = await request(app).get('/api/friendships?status=pending&direction=sent');
    expect(sent.status).toBe(200);
    expectUuidWire(sent.body[0], { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });
    // sent branch keys requester_uuid = caller.id.
    expect(findAllSent.mock.calls[0][0].where.requester_uuid).toBe(REQUESTER_UUID);
  });

  it('default (non-accepted, no direction) branch also keys the UUID columns and carries UUIDs on the wire', async () => {
    currentActor = REQUESTER;
    const row = fakeFriendship({ status: 'blocked' });
    const findAllSpy = jest.spyOn(Friendship, 'findAll').mockResolvedValue([row]);

    const res = await request(app).get('/api/friendships?status=blocked');

    expect(res.status).toBe(200);
    expectUuidWire(res.body[0], { requester: REQUESTER_UUID, addressee: ADDRESSEE_UUID });
    const whereArg = findAllSpy.mock.calls[0][0].where;
    expect(whereArg[Op.or][0].requester_uuid).toBe(REQUESTER_UUID);
    expect(whereArg[Op.or][1].addressee_uuid).toBe(REQUESTER_UUID);
  });

  it('a caller with no Users row gets an empty list (fail-safe)', async () => {
    currentActor = 'auth0|ghost';
    const findAllSpy = jest.spyOn(Friendship, 'findAll');

    const res = await request(app).get('/api/friendships');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(findAllSpy).not.toHaveBeenCalled();
  });
});

// Phase 87.3 PR-C (BE-12, user D1 resolution): GET /search drops its flat sub
// user_id — the SOLE sanctioned drop of this phase. The friends page (its only
// FE consumer) reads foundUser.id (plan 06).
describe('GET /friendships/search — BE-12 flat user_id DROPPED (PR-C)', () => {
  it('the search result carries id/username only — no user_id, no sub anywhere', async () => {
    currentActor = REQUESTER;
    // The route queries by email with a projected attribute list; return the
    // projected shape the contracted route selects.
    const findOneSpy = jest.spyOn(User, 'findOne').mockResolvedValue({
      id: ADDRESSEE_UUID,
      username: 'addressee',
    });

    const res = await request(app).get('/api/friendships/search?email=addressee@example.com');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ADDRESSEE_UUID);
    expect(res.body.username).toBe('addressee');
    expect(res.body).not.toHaveProperty('user_id');
    expect(JSON.stringify(res.body)).not.toMatch(/(auth0|google-oauth2|apple)\|/);
    // Query-shape pin: the projection no longer selects the sub column.
    const attrs = findOneSpy.mock.calls[0][0].attributes;
    expect(attrs).toEqual(expect.arrayContaining(['id', 'username']));
    expect(attrs).not.toContain('user_id');
  });
});
