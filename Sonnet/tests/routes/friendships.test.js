// tests/routes/friendships.test.js
// Phase 87 / BINT-01 (T-87-07): friend-request idempotency under a concurrent
// duplicate.
// Phase 87.1 / BINT-02 (D-11/D-12, Plan 87.1-05): friendship authz cutover onto
// the Users.id UUID keyspace (requester_uuid/addressee_uuid) + the D-10/D-12
// wire shim that keeps requester_id/addressee_id serialized as Auth0 strings.
//
// CRITICAL test-fidelity caveat (RESEARCH Pitfall 2): the Friendship unique
// constraint is a FUNCTIONAL `LEAST/GREATEST` index defined ONLY in a migration
// — it is absent from the model, so sequelize.sync() does NOT build it. A real-DB
// race therefore CANNOT throw a UniqueConstraintError on the sync-built test DB.
// This suite MOCKS Friendship.create to throw once, driving the absorb branch.
//
// SANDBOX NOTE (confirmed Plans 01-04): the local test Postgres is UNREACHABLE,
// so this suite is deliberately mock-based (jest.spyOn on model methods + injected
// req.user) — no real rows, no DB connection. The authoritative gate is BE PR CI
// Postgres. The mocks let us assert the UUID-keyed authz + the Auth0-string wire
// contract without a live DB.
//
// Behaviors covered:
//   1. request happy path -> 201, Auth0-string wire, no *_uuid leak.
//   2. request idempotency: concurrent duplicate -> 201 (not 500), one row.
//   3. accept: real addressee CAN accept (200); a non-addressee CANNOT (403).
//   4. decline: real addressee CAN decline (200); a non-addressee CANNOT (403).
//   5. delete: requester/addressee CAN unfriend (200); an outsider CANNOT (403).
//   6. declined-re-request DIRECTIONALITY SWAP: A req B, B declines, B re-requests
//      A -> the UUID direction swaps; only A can now accept, B cannot self-accept.
//   7. GET wire shape: requester_id/addressee_id are the Auth0 subs, not UUIDs;
//      friend-derive returns the correct counterpart.
//   8. GET directional: a pending request surfaces in BOTH the received (addressee)
//      and sent (requester) lists, Auth0 strings on the wire in both.

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

// D-05 include-pin shapes (Phase 87.3 Task 1): the nested User.id the FE cutover
// (PR-B) will compare against is a UUID; the Auth0 sub is provider-prefixed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_RE = /^(auth0|google-oauth2|apple)\|/;

// Stub User.findOne to resolve Auth0 string -> Users row (the once-per-handler
// resolution every re-keyed gate now performs).
//
// Phase 87.3 (PR-A expand): the target identifier is now dual-keyed via
// resolveTargetUser — a UUID-shaped param resolves through User.findByPk, a
// sub-shaped param through User.findOne. Stub BOTH so both identifier shapes
// resolve to the same fixtures.
const USERS_BY_UUID = Object.fromEntries(
  Object.values(USERS).map((u) => [u.id, u])
);
function stubUsers() {
  jest.spyOn(User, 'findOne').mockImplementation(async ({ where }) => USERS[where.user_id] || null);
  jest.spyOn(User, 'findByPk').mockImplementation(async (id) => USERS_BY_UUID[id] || null);
}

// A fake Friendship instance with a spyable update()/destroy(). Carries BOTH
// keyspaces + the Requester/Addressee includes so we can assert the shim strips
// the *_uuid columns and emits the Auth0 strings.
function fakeFriendship(overrides = {}) {
  const f = {
    id: 'friendship-1',
    requester_id: REQUESTER,
    requester_uuid: REQUESTER_UUID,
    addressee_id: ADDRESSEE,
    addressee_uuid: ADDRESSEE_UUID,
    status: 'pending',
    Requester: { id: REQUESTER_UUID, user_id: REQUESTER, username: 'requester' },
    Addressee: { id: ADDRESSEE_UUID, user_id: ADDRESSEE, username: 'addressee' },
    ...overrides,
  };
  f.update = jest.fn(async (patch) => { Object.assign(f, patch); return f; });
  f.destroy = jest.fn(async () => {});
  return f;
}

// Assert a wire body honors the D-10/D-12 contract: Auth0-string id fields, no
// surrogate UUID leak.
function expectAuth0Wire(body, { requester, addressee }) {
  expect(body.requester_id).toBe(requester);
  expect(body.addressee_id).toBe(addressee);
  expect(body).not.toHaveProperty('requester_uuid');
  expect(body).not.toHaveProperty('addressee_uuid');
}

afterEach(() => {
  jest.restoreAllMocks();
  currentActor = null;
});

describe('POST /friendships/request — idempotency (BINT-01 / T-87-07) + D-12 wire', () => {
  beforeEach(() => {
    currentActor = REQUESTER;
    stubUsers();
  });

  it('happy path: no existing friendship -> creates a pending request (201) with Auth0-string wire', async () => {
    const created = {
      id: 'friendship-1',
      requester_id: REQUESTER,
      requester_uuid: REQUESTER_UUID,
      addressee_id: ADDRESSEE,
      addressee_uuid: ADDRESSEE_UUID,
      status: 'pending',
    };
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create').mockResolvedValue(created);

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'friendship-1', status: 'pending' });
    // D-12: Auth0 strings on the wire, no *_uuid leak.
    expectAuth0Wire(res.body, { requester: REQUESTER, addressee: ADDRESSEE });
    // Create keyed the UUID columns (dual-writing the Auth0 strings).
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requester_uuid: REQUESTER_UUID, addressee_uuid: ADDRESSEE_UUID })
    );
  });

  it('absorbs a concurrent duplicate: UniqueConstraintError -> 201 success (no 500), exactly one row, Auth0-string wire', async () => {
    const winner = fakeFriendship({ id: 'friendship-winner' });

    const findOneSpy = jest
      .spyOn(Friendship, 'findOne')
      .mockResolvedValueOnce(null) // existence pre-check
      .mockResolvedValueOnce(winner); // absorb re-find (with includes)

    const createSpy = jest
      .spyOn(Friendship, 'create')
      .mockRejectedValueOnce(new UniqueConstraintError({}));

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE });

    expect(res.status).not.toBe(500);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'friendship-winner', status: 'pending' });
    expectAuth0Wire(res.body, { requester: REQUESTER, addressee: ADDRESSEE });

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(findOneSpy).toHaveBeenCalledTimes(2);
  });

  it('404s when the addressee has no local Users row (Rule 2 guard)', async () => {
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create');

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: 'auth0|ghost-user' });

    expect(res.status).toBe(404);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// Phase 87.3 (PR-A expand, Task 3): POST /request resolves its client-supplied
// addressee_user_id DUAL-KEYED — Users.id UUID first (the post-PR-C shape plan
// 06 will send), Auth0 sub fallback (today's shape). Both shapes must work for
// the whole expand window, and the self-request guard must fire on the RESOLVED
// identity for BOTH shapes (a raw sub-vs-UUID compare would fail-open).
describe('POST /friendships/request — dual-key target resolution (87.3 PR-A expand)', () => {
  beforeEach(() => {
    currentActor = REQUESTER;
    stubUsers();
  });

  it('accepts a UUID-shaped addressee_user_id (post-PR-C shape) -> 201, wire still Auth0 subs', async () => {
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
      .send({ addressee_user_id: ADDRESSEE_UUID }); // UUID, not the sub

    expect(res.status).toBe(201);
    // Resolved via User.findByPk (UUID path) to the same addressee row.
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requester_uuid: REQUESTER_UUID, addressee_uuid: ADDRESSEE_UUID })
    );
    // Response serialization is UNCHANGED — the flat wire fields stay Auth0 subs,
    // sourced from the resolved row (not the raw UUID param).
    expectAuth0Wire(res.body, { requester: REQUESTER, addressee: ADDRESSEE });
  });

  it('still accepts a sub-shaped addressee_user_id (expand-window back-compat) -> 201', async () => {
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(null);
    const createSpy = jest.spyOn(Friendship, 'create').mockResolvedValue({
      id: 'friendship-1',
      requester_uuid: REQUESTER_UUID,
      addressee_uuid: ADDRESSEE_UUID,
      status: 'pending',
    });

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE }); // Auth0 sub

    expect(res.status).toBe(201);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ requester_uuid: REQUESTER_UUID, addressee_uuid: ADDRESSEE_UUID })
    );
    expectAuth0Wire(res.body, { requester: REQUESTER, addressee: ADDRESSEE });
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

  it('rejects a self-request via the sub shape -> 400', async () => {
    const createSpy = jest.spyOn(Friendship, 'create');
    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: REQUESTER }); // caller's OWN sub

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a UUID-addressed request does not slip past the sub-keyed duplicate check -> 409', async () => {
    // An existing accepted friendship (either direction) must be detected even
    // when the new request addresses the target by UUID.
    jest.spyOn(Friendship, 'findOne').mockResolvedValue(
      fakeFriendship({ status: 'accepted' })
    );
    const createSpy = jest.spyOn(Friendship, 'create');

    const res = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: ADDRESSEE_UUID });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already friends/i);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('POST /friendships/:id/accept — ownership gate on UUID (D-11)', () => {
  beforeEach(stubUsers);

  it('the REAL addressee CAN accept (200) and gets an Auth0-string wire', async () => {
    currentActor = ADDRESSEE;
    const friendship = fakeFriendship();
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(friendship);

    const res = await request(app).post('/api/friendships/friendship-1/accept');

    expect(res.status).toBe(200);
    expect(friendship.update).toHaveBeenCalledWith({ status: 'accepted' });
    expect(res.body.status).toBe('accepted');
    expectAuth0Wire(res.body, { requester: REQUESTER, addressee: ADDRESSEE });
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

  it('the REAL addressee CAN decline (200), Auth0-string wire', async () => {
    currentActor = ADDRESSEE;
    const friendship = fakeFriendship();
    jest.spyOn(Friendship, 'findByPk').mockResolvedValue(friendship);

    const res = await request(app).post('/api/friendships/friendship-1/decline');

    expect(res.status).toBe(200);
    expect(friendship.update).toHaveBeenCalledWith({ status: 'declined' });
    expectAuth0Wire(res.body, { requester: REQUESTER, addressee: ADDRESSEE });
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

    // B re-requests A: caller = B (ADDRESSEE), target = A (REQUESTER).
    currentActor = ADDRESSEE;
    const reReq = await request(app)
      .post('/api/friendships/request')
      .send({ addressee_user_id: REQUESTER });

    expect(reReq.status).toBe(200);
    // The existing row's UUID direction SWAPPED to B->A. Phase 87.1 (Plan 09): the
    // old Auth0-string requester_id/addressee_id columns were removed from the model,
    // so the update writes ONLY the UUID endpoints + status.
    expect(declinedRow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        requester_uuid: ADDRESSEE_UUID, // B is now the requester
        addressee_uuid: REQUESTER_UUID, // A is now the addressee
        status: 'pending',
      })
    );
    expect(declinedRow.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ requester_id: expect.anything() })
    );
    // Wire stays Auth0 strings (re-request direction), no *_uuid leak.
    expectAuth0Wire(reReq.body, { requester: ADDRESSEE, addressee: REQUESTER });

    // Behavioral proof of the swap: the row is now B(requester)->A(addressee).
    const swapped = fakeFriendship({
      requester_id: ADDRESSEE,
      requester_uuid: ADDRESSEE_UUID,
      addressee_id: REQUESTER,
      addressee_uuid: REQUESTER_UUID,
      status: 'pending',
      Requester: USERS[ADDRESSEE],
      Addressee: USERS[REQUESTER],
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

describe('GET /friendships — D-12 wire shim + UUID where-branches', () => {
  beforeEach(stubUsers);

  it('accepted branch: emits Auth0-string requester_id/addressee_id (the sub, not a UUID) and derives the counterpart friend', async () => {
    currentActor = REQUESTER;
    const row = fakeFriendship({ status: 'accepted' });
    const findAllSpy = jest.spyOn(Friendship, 'findAll').mockResolvedValue([row]);

    const res = await request(app).get('/api/friendships');

    expect(res.status).toBe(200);
    const [f] = res.body;
    // Auth0 subs on the wire, never the UUID.
    expect(f.requester_id).toBe(REQUESTER);
    expect(f.requester_id).not.toBe(REQUESTER_UUID);
    expect(f.addressee_id).toBe(ADDRESSEE);
    expect(f).not.toHaveProperty('requester_uuid');
    expect(f).not.toHaveProperty('addressee_uuid');
    // D-05 INCLUDE-PIN (Phase 87.3 Task 1): the nested Requester.id / Addressee.id
    // the FE cutover (PR-B) will compare against MUST be the UUID, never the sub.
    // If a future change (e.g. PR-C's flat-field flip) drops the nested id, this
    // fails — the regression net PR-C depends on.
    expect(f.Requester.id).toMatch(UUID_RE);
    expect(f.Requester.id).not.toMatch(SUB_RE);
    expect(f.Addressee.id).toMatch(UUID_RE);
    expect(f.Addressee.id).not.toMatch(SUB_RE);
    // friend-derive: caller is the requester -> friend is the Addressee.
    expect(f.friend.user_id).toBe(ADDRESSEE);
    // accepted where-branch (Op.or) keyed the UUID columns, not the Auth0 strings.
    const whereArg = findAllSpy.mock.calls[0][0].where;
    expect(whereArg[Op.or][0].requester_uuid).toBe(REQUESTER_UUID);
    expect(whereArg[Op.or][1].addressee_uuid).toBe(REQUESTER_UUID);
    expect(whereArg[Op.or][0].requester_id).toBeUndefined();
  });

  it('a pending request surfaces in BOTH received (addressee) and sent (requester) lists, Auth0 strings in both (mandated directional test)', async () => {
    const pending = fakeFriendship({ status: 'pending' });

    // received: the ADDRESSEE views incoming pending requests.
    currentActor = ADDRESSEE;
    const findAllReceived = jest.spyOn(Friendship, 'findAll').mockResolvedValue([pending]);
    const received = await request(app).get('/api/friendships?status=pending&direction=received');
    expect(received.status).toBe(200);
    expectAuth0Wire(received.body[0], { requester: REQUESTER, addressee: ADDRESSEE });
    // received branch keys addressee_uuid = caller.id.
    expect(findAllReceived.mock.calls[0][0].where.addressee_uuid).toBe(ADDRESSEE_UUID);
    jest.restoreAllMocks();
    stubUsers();

    // sent: the REQUESTER views their outgoing pending requests.
    currentActor = REQUESTER;
    const findAllSent = jest.spyOn(Friendship, 'findAll').mockResolvedValue([pending]);
    const sent = await request(app).get('/api/friendships?status=pending&direction=sent');
    expect(sent.status).toBe(200);
    expectAuth0Wire(sent.body[0], { requester: REQUESTER, addressee: ADDRESSEE });
    // sent branch keys requester_uuid = caller.id.
    expect(findAllSent.mock.calls[0][0].where.requester_uuid).toBe(REQUESTER_UUID);
  });

  it('default (non-accepted, no direction) branch also keys the UUID columns and strips *_uuid', async () => {
    currentActor = REQUESTER;
    const row = fakeFriendship({ status: 'blocked' });
    const findAllSpy = jest.spyOn(Friendship, 'findAll').mockResolvedValue([row]);

    const res = await request(app).get('/api/friendships?status=blocked');

    expect(res.status).toBe(200);
    expectAuth0Wire(res.body[0], { requester: REQUESTER, addressee: ADDRESSEE });
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
