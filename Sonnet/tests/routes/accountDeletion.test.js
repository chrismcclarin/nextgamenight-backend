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
jest.mock('../../services/accountDeletionService', () => ({
  deleteAccount: (...a) => mockDeleteAccount(...a),
  getDeletionBlockers: (...a) => mockGetDeletionBlockers(...a),
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

    const res = await request(makeApp('auth0|ghost'))
      .get('/api/users/me/deletion-blockers')
      .expect(410);

    expect(res.body.code).toBe('account_deleted');
    // Never fed a null row into getDeletionBlockers.
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

  it('JIT: Auth0 identity lookup returns null (deleted in Auth0) → 410, NO token-claims fallback create', async () => {
    mockUserScopeFindOne.mockResolvedValueOnce(null); // no existing row
    mockIsTombstoned.mockResolvedValueOnce(false); // no marker yet, but Auth0 is gone
    mockGetUserById.mockResolvedValueOnce(null); // Auth0 identity deleted

    const res = await request(makeApp('auth0|authgone'))
      .get('/api/users/auth0|authgone')
      .expect(410);

    expect(res.body.code).toBe('account_deleted');
    expect(mockUserFindOrCreate).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  it('search-by-email whose Auth0 sub is tombstoned → NO Users row created, normal not-found shape', async () => {
    mockUserScopeFindOne.mockResolvedValueOnce(null); // not in our DB
    mockSearchUsersByEmail.mockResolvedValueOnce([{ user_id: 'auth0|deleted-friend' }]);
    mockExtractUserDetails.mockReturnValueOnce({
      user_id: 'auth0|deleted-friend',
      email: 'deleted-friend@example.com',
      username: 'gone',
    });
    mockIsTombstoned.mockResolvedValueOnce(true); // searched user is tombstoned

    const res = await request(makeApp('auth0|searcher'))
      .get('/api/users/search/email/deleted-friend%40example.com')
      .expect(404);

    // Normal DB-miss not-found shape — leaks nothing about the deletion.
    expect(res.body.error).toBe('User not found');
    expect(mockUserFindOrCreate).not.toHaveBeenCalled();
    expect(mockUserCreate).not.toHaveBeenCalled();
  });
});
