// tests/routes/accountDeletion.test.js
// Phase 87.2 / Plan 05 (REQ-1, REQ-2, REQ-6): route-grain tests for the self-serve
// account-deletion HTTP surface.
//
// Strategy (per plan): mock the SERVICE boundary (accountDeletionService), the Auth0
// Management client, the queues (__mocks__), and the model layer so the route handlers
// are exercised in isolation with no DB/Redis of their own. setupFilesAfterEnv binds to
// the REAL models BEFORE this file's jest.mock registers, so the shared per-test DB
// lifecycle (authenticate + truncate) is unaffected — only routes/users.js sees the mock.
//
// Coverage:
//   - Pre-flight GET /users/me/deletion-blockers: owner-blocked 200 {groups:[...]},
//     non-blocked 200 {groups: []}, unauthenticated 401, stale-session 410 (never 500).
//   - REQ-1: no cross-user delete — no target param exists; body/param injection ignored.
//   - REQ-2: owner gate @409 with details.groups (envelope); member (non-owner) → 200.
//   - REQ-6: repeat DELETE → HTTP 410 + code account_deleted on the Phase 85 envelope;
//            tombstoned-sub JIT GET → 410 envelope + NO Users row created;
//            search-by-tombstoned-email → NO Users row created + normal not-found shape.

process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

// ---- accountDeletionService (service boundary) ----
const mockDeleteAccount = jest.fn();
const mockGetDeletionBlockers = jest.fn();
// Phase 88.8 plan 07 (R7): the pre-flight route no longer emits the tombstone envelope
// unconditionally for a null row — it asks the SERVICE's shared classifier, so the two
// deletion endpoints can never disagree about a missing row. That means the route-grain
// tests drive the 410-vs-404 split through THIS mock, not through mockIsTombstoned
// below: the model mock is never reached once the service boundary is stubbed. The real
// tombstone-first ordering inside classifyMissingRow is pinned in
// tests/services/accountDeletionService.test.js, where the service is NOT mocked.
const mockClassifyMissingRow = jest.fn();
jest.mock('../../services/accountDeletionService', () => ({
  deleteAccount: (...a) => mockDeleteAccount(...a),
  getDeletionBlockers: (...a) => mockGetDeletionBlockers(...a),
  classifyMissingRow: (...a) => mockClassifyMissingRow(...a),
  applyDispositions: jest.fn(),
}));

// ---- auth0Service (Auth0 Management lookups on the JIT / search paths) ----
const mockGetUserById = jest.fn();
const mockSearchUsersByEmail = jest.fn();
const mockExtractUserDetails = jest.fn();
jest.mock('../../services/auth0Service', () => ({
  getUserById: (...a) => mockGetUserById(...a),
  searchUsersByEmail: (...a) => mockSearchUsersByEmail(...a),
  extractUserDetails: (...a) => mockExtractUserDetails(...a),
}));

// ---- smsService (required at users.js module top; avoid Twilio side effects) ----
jest.mock('../../services/smsService', () => ({ send: jest.fn() }));

// ---- models ----
const mockUserScopeFindOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockUserFindOrCreate = jest.fn();
const mockUserCreate = jest.fn();
const mockIsTombstoned = jest.fn();
jest.mock('../../models', () => ({
  User: {
    scope: jest.fn(() => ({ findOne: (...a) => mockUserScopeFindOne(...a) })),
    findOne: (...a) => mockUserFindOne(...a),
    findOrCreate: (...a) => mockUserFindOrCreate(...a),
    create: (...a) => mockUserCreate(...a),
  },
  Group: {},
  UserGroup: {},
  PendingAuth0Deletion: {
    isTombstoned: (...a) => mockIsTombstoned(...a),
  },
  sequelize: { transaction: jest.fn() },
}));

// ---- queues (__mocks__) ----
jest.mock('../../queues');

const userRoutes = require('../../routes/users');
const { stubAuth } = require('../helpers/authStub');

// App WITH an injected verified actor (req.user).
function makeApp(userId) {
  const a = express();
  a.use(express.json());
  a.use(stubAuth({ user_id: userId, email: `${userId}@example.com` }));
  a.use('/api/users', userRoutes);
  return a;
}

// Phase 88.8 (BOPS-05): an authenticated actor whose token carries NO email claim.
// This is the shape the REQ-6 identity-gone guard still runs on — see the note on that
// test. makeApp() above injects an email claim, which under the claims-first rule skips
// the Auth0 Management lookup entirely.
function makeAppNoEmailClaim(userId) {
  const a = express();
  a.use(express.json());
  a.use(stubAuth({ user_id: userId }));
  a.use('/api/users', userRoutes);
  return a;
}

// App WITHOUT any actor (unauthenticated) — req.user is undefined.
function makeAnonApp() {
  const a = express();
  a.use(express.json());
  a.use('/api/users', userRoutes);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no tombstone unless a test opts in.
  mockIsTombstoned.mockResolvedValue(false);
  // Phase 88.8 plan 07 (R7): steady-state default matches mockIsTombstoned(false) — a
  // missing row with no tombstone is the never-provisioned case. Tests that mean "this
  // account really was deleted" opt into 'not_found' explicitly.
  mockClassifyMissingRow.mockResolvedValue('not_provisioned');
});

describe('GET /api/users/me/deletion-blockers (pre-flight)', () => {
  it('owner of an active group with other members → 200 { groups: [{id,name,memberCount}] }', async () => {
    mockUserFindOne.mockResolvedValueOnce({ id: 'uuid-owner', user_id: 'auth0|owner' });
    mockGetDeletionBlockers.mockResolvedValueOnce([
      { id: 'grp-1', name: 'Sunday Crew', memberCount: 4 },
    ]);

    const res = await request(makeApp('auth0|owner'))
      .get('/api/users/me/deletion-blockers')
      .expect(200);

    expect(res.body).toEqual({ groups: [{ id: 'grp-1', name: 'Sunday Crew', memberCount: 4 }] });
    // Never emits the DELETE-only owner_of_active_groups error code.
    expect(res.body.code).toBeUndefined();
    // Resolves the caller's Users.id (UUID) and feeds THAT to getDeletionBlockers.
    expect(mockGetDeletionBlockers).toHaveBeenCalledWith('uuid-owner');
  });

  it('non-blocked user → 200 { groups: [] }', async () => {
    mockUserFindOne.mockResolvedValueOnce({ id: 'uuid-plain', user_id: 'auth0|plain' });
    mockGetDeletionBlockers.mockResolvedValueOnce([]);

    const res = await request(makeApp('auth0|plain'))
      .get('/api/users/me/deletion-blockers')
      .expect(200);

    expect(res.body).toEqual({ groups: [] });
  });

  it('unauthenticated → 401 (and never the owner_of_active_groups code)', async () => {
    const res = await request(makeAnonApp())
      .get('/api/users/me/deletion-blockers')
      .expect(401);

    expect(res.body.code).toBe('unauthorized');
    expect(mockGetDeletionBlockers).not.toHaveBeenCalled();
  });

  it('authenticated caller whose Users row is gone (stale session) → 410 account_deleted, never 500', async () => {
    mockUserFindOne.mockResolvedValueOnce(null); // row already deleted
    // AMENDED Phase 88.8 plan 07 (R7): this test's NAME is about a genuinely DELETED
    // account, so it must opt into the tombstone classification explicitly. Without this
    // line the steady-state default (never-provisioned) would silently turn it into the
    // 404 case and it would stop asserting what it says it asserts. The 404 case has its
    // own sibling test immediately below.
    mockClassifyMissingRow.mockResolvedValueOnce('not_found');

    const res = await request(makeApp('auth0|ghost'))
      .get('/api/users/me/deletion-blockers')
      .expect(410);

    expect(res.body.code).toBe('account_deleted');
    // Never fed a null row into getDeletionBlockers.
    expect(mockGetDeletionBlockers).not.toHaveBeenCalled();
    expect(mockClassifyMissingRow).toHaveBeenCalledWith('auth0|ghost');
  });

  // Phase 88.8 plan 07 (SPEC R7, D-19 backend half) — the never-provisioned split.
  it('authenticated caller with no row AND no tombstone → 404 not_provisioned, never 410', async () => {
    mockUserFindOne.mockResolvedValueOnce(null); // no row was ever created
    // mockClassifyMissingRow defaults to 'not_provisioned' (no tombstone).

    const res = await request(makeApp('auth0|never-had-one'))
      .get('/api/users/me/deletion-blockers')
      .expect(404);

    expect(res.body.code).toBe('not_provisioned');
    // The user is NOT told their account was deleted — that is the whole point of R7.
    expect(res.body.code).not.toBe('account_deleted');
    expect(res.body).toHaveProperty('message');
    // The reason the pre-flight short-circuits at all survives unchanged: a null row
    // must never reach the blockers query.
    expect(mockGetDeletionBlockers).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/users/me (REQ-1 / REQ-2 / REQ-6)', () => {
  it('REQ-1: ignores body/param injection — deletes only the token caller', async () => {
    mockDeleteAccount.mockResolvedValueOnce({ status: 'deleted' });

    await request(makeApp('auth0|caller'))
      .delete('/api/users/me')
      .send({ user_id: 'auth0|victim', userId: 'auth0|victim' })
      .expect(200);

    // The service is invoked with the TOKEN sub, never the injected body value.
    expect(mockDeleteAccount).toHaveBeenCalledWith({ userId: 'auth0|caller' });
  });

  it('REQ-1: no bare DELETE /:user_id route exists — a target-param delete 404s (deletes nobody)', async () => {
    await request(makeApp('auth0|caller'))
      .delete('/api/users/auth0|victim')
      .expect(404);

    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('unauthenticated DELETE → 401', async () => {
    const res = await request(makeAnonApp())
      .delete('/api/users/me')
      .expect(401);

    expect(res.body.code).toBe('unauthorized');
    expect(mockDeleteAccount).not.toHaveBeenCalled();
  });

  it('REQ-2 (Test A): owner of a populated group → 409 owner_of_active_groups with details.groups, nothing deleted', async () => {
    mockDeleteAccount.mockResolvedValueOnce({
      status: 'blocked',
      groups: [{ id: 'grp-9', name: 'Board Night', memberCount: 3 }],
    });

    const res = await request(makeApp('auth0|owner'))
      .delete('/api/users/me')
      .expect(409);

    expect(res.body.code).toBe('owner_of_active_groups');
    expect(res.body.details).toEqual({ groups: [{ id: 'grp-9', name: 'Board Night', memberCount: 3 }] });
  });

  it('REQ-2 (Test C): a member/admin who owns nothing blocking → 200 deleted', async () => {
    mockDeleteAccount.mockResolvedValueOnce({ status: 'deleted' });

    const res = await request(makeApp('auth0|member'))
      .delete('/api/users/me')
      .expect(200);

    expect(res.body).toHaveProperty('message');
  });

  it('REQ-6: repeat DELETE (service not_found) → HTTP 410 + code account_deleted on the envelope', async () => {
    mockDeleteAccount.mockResolvedValueOnce({ status: 'not_found' });

    const res = await request(makeApp('auth0|already-gone'))
      .delete('/api/users/me')
      .expect(410);

    expect(res.body.code).toBe('account_deleted');
    // Never a bare 401 and never a raw non-envelope 410.
    expect(res.body).toHaveProperty('message');
  });

  // Phase 88.8 plan 07 (SPEC R7) — the DELETE half of the same split. The service
  // resolves the 410-vs-404 question via classifyMissingRow and hands the route a
  // distinct status; the route only maps status -> envelope code.
  it('R7: a sub that never had a row (service not_provisioned) → HTTP 404 + code not_provisioned', async () => {
    mockDeleteAccount.mockResolvedValueOnce({ status: 'not_provisioned' });

    const res = await request(makeApp('auth0|never-had-one'))
      .delete('/api/users/me')
      .expect(404);

    expect(res.body.code).toBe('not_provisioned');
    // Must NOT claim a deletion happened.
    expect(res.body.code).not.toBe('account_deleted');
    expect(res.body).toHaveProperty('message');
  });
});

describe('REQ-6 orphaned-token re-provision guard (JIT + search)', () => {
  it('JIT: GET /users/:sub for a tombstoned own-sub → 410 account_deleted, NO Users row created', async () => {
    mockUserScopeFindOne.mockResolvedValueOnce(null); // no existing row
    mockIsTombstoned.mockResolvedValueOnce(true); // tombstone present

    const res = await request(makeApp('auth0|tombstoned'))
      .get('/api/users/auth0|tombstoned')
      .expect(410);

    expect(res.body.code).toBe('account_deleted');
    expect(mockUserFindOrCreate).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  // AMENDED Phase 88.8 plan 01 (BOPS-05, claims-first provisioning). This guard fires
  // inside the Auth0 Management lookup, and that lookup now runs ONLY when the access
  // token carries no email claim (SPEC R2). So the actor here must be claim-less — with
  // an email claim the Management API is never called and this guard cannot run. The
  // claims-path residual is pinned by the test immediately below; it is not erased.
  it('JIT (no email claim): Auth0 identity lookup returns null (deleted in Auth0) → 410, NO token-claims fallback create', async () => {
    mockUserScopeFindOne.mockResolvedValueOnce(null); // no existing row
    mockIsTombstoned.mockResolvedValueOnce(false); // no marker yet, but Auth0 is gone
    mockGetUserById.mockResolvedValueOnce(null); // Auth0 identity deleted

    const res = await request(makeAppNoEmailClaim('auth0|authgone'))
      .get('/api/users/auth0|authgone')
      .expect(410);

    expect(res.body.code).toBe('account_deleted');
    expect(mockUserFindOrCreate).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  // NAMED RESIDUAL of Phase 88.8 BOPS-05, pinned here on purpose so it is visible in the
  // security suite rather than only in a plan document. Plan 01 threat register T-88.8-02
  // records it as ACCEPTED, and routes/users.js carries the matching DECISION marker.
  //
  // What changed: when the token carries an email claim, provisioning no longer calls the
  // Auth0 Management API at all — which is the entire point of BOPS-05 (that call had been
  // 403ing since 2026-04 and was minting synthetic @auth0.local addresses). The Phase 87.2
  // SPEC Req 6 "identity deleted from the Auth0 dashboard → 410" guard lives inside that
  // call, so it cannot fire on the claims path.
  //
  // Why the exposure is bounded: a token carrying claims proves the identity existed when
  // the token was minted, so the only window is an identity deleted from the dashboard
  // AFTER its token was minted and within that token's remaining lifetime. The row created
  // carries the caller's own real verified address (no privilege gain), the tombstone guard
  // (PendingAuth0Deletion.isTombstoned — the test above this one) still runs on BOTH paths,
  // and the R6 account-hygiene script lists such rows under "Auth0 identity gone".
  //
  // If a future phase restores a Management check on the claims path, this test SHOULD
  // fail — that is the signal, not a regression. Do not delete it to keep the suite quiet.
  it('JIT (email claim present): the Management lookup is skipped, so the identity-gone 410 does NOT fire — accepted residual T-88.8-02', async () => {
    mockUserScopeFindOne.mockResolvedValueOnce(null); // no existing row
    mockIsTombstoned.mockResolvedValueOnce(false);
    mockGetUserById.mockResolvedValueOnce(null); // would have meant "deleted in Auth0"

    await request(makeApp('auth0|authgone-with-claim')).get('/api/users/auth0|authgone-with-claim');

    // The vendor was never consulted — that is the change BOPS-05 exists to make.
    expect(mockGetUserById).not.toHaveBeenCalled();
  });

  // GET /api/users/search/email/:email DELETED — Phase 87.6 (users-search-email,
  // Tier 1). The route is gone, so a request 404s at the Express routing layer
  // (default 404 — NO JSON body contract, so the prior `{error:'User not found'}`
  // body-shape assertion no longer applies and would fail on the empty default
  // 404 body). A deleted route trivially creates no Users row and leaks nothing
  // about a tombstoned account — the "no JIT provisioning via search" invariant
  // is preserved below. Resurrection guards: wire-sweep.test.js no longer probes
  // it + the deletion tombstone in routes/users.js.
  it('search-by-email route is DELETED (87.6) → routing 404, no Users row, no deletion leak', async () => {
    const res = await request(makeApp('auth0|searcher'))
      .get('/api/users/search/email/deleted-friend%40example.com');
    expect(res.status).toBe(404); // routing-layer 404 (Express default, no body contract)
    expect(mockUserFindOrCreate).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });
});
