// tests/routes/users.test.js
const request = require('supertest');
const express = require('express');

// Mock auth0Service — previously this suite hit the REAL Auth0 Management API
// (getUserById 404'd for fake test subs and the route fell back to token data).
// Phase 87.2 / REQ-6 changed the contract: a resolved null (Auth0 404) now means
// "identity deleted" and the JIT branch refuses with the 410 account_deleted
// envelope. Simulate the not-configured behavior (THROW) so the token-fallback
// auto-provision path stays exercised — and no real network call fires in tests.
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('Auth0 Management API credentials not configured')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

const userRoutes = require('../../routes/users');
const { stubAuth } = require('../helpers/authStub');
const { User, Group, UserGroup, sequelize } = require('../../models');

// Create test app
const app = express();
app.use(express.json());
app.use('/api/users', userRoutes);

// Build an app that injects a fixed verified actor (req.user) before the router,
// so routes deriving the subject from the JWT (e.g. POST / — BE-049) are exercised.
function makeApp(userId) {
  const a = express();
  a.use(express.json());
  a.use(stubAuth({ user_id: userId, email: `${userId}@example.com` }));
  a.use('/api/users', userRoutes);
  return a;
}

describe('User Routes', () => {
  // Clean up database before each test
  beforeEach(async () => {
    await UserGroup.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Group.destroy({ where: {} });
  });

  // NOTE: no afterAll(sequelize.close()) — connection lifecycle is owned by
  // tests/globalTeardown.js (BTEST-02).

  // Phase 87.6 (users-create, Tier 1): POST /api/users DELETED. The self-upsert
  // capability is superseded by the JIT auto-create branch in GET /:user_id
  // (Phase 78 TZ-01) — exercised by the "auto-provision on first read" test in the
  // GET block below. Zero FE callers of createOrUpdateUser. The prior BE-049
  // forged-body-user_id assertions retire WITH the route: the write surface they
  // guarded no longer exists, so the tampering vector is structurally gone.
  describe('POST /api/users (deleted 87.6 users-create)', () => {
    it('404s — route deleted', async () => {
      await request(makeApp('test-user-1'))
        .post('/api/users')
        .send({ username: 'testuser', email: 'test@example.com' })
        .expect(404);
    });
  });

  describe('GET /api/users/:user_id', () => {
    it('should get user by user_id (PR-C: response user_id aliased to the UUID)', async () => {
      // Create test user
      const testUser = await User.create({
        user_id: 'test-user-3',
        username: 'testuser3',
        email: 'test3@example.com'
      });

      // 83-05 gates GET /:user_id with requireParamMatchesToken — the verified
      // actor must match the path param, so inject req.user for that user.
      const response = await request(makeApp(testUser.user_id))
        .get(`/api/users/${testUser.user_id}`)
        .expect(200);

      // Phase 87.3 PR-C (BE-10, locked alias): user_id NAME stays, VALUE is the
      // Users.id UUID; `.id` remains the identity read the FE hook consumes.
      expect(response.body.id).toBe(testUser.id);
      expect(response.body.user_id).toBe(testUser.id);
      expect(response.body.username).toBe(testUser.username);
    });

    it('should auto-provision the authenticated user on first read (Phase 78)', async () => {
      // GET /:user_id auto-creates the verified user if their row does not yet
      // exist (TZ-01 auto-create), so a self-read of a brand-new id returns 200
      // with a freshly-created row rather than 404.
      const response = await request(makeApp('auth0|first-time-user'))
        .get('/api/users/auth0|first-time-user')
        .expect(200);

      const created = await User.findOne({ where: { user_id: 'auth0|first-time-user' } });
      expect(created).not.toBeNull();
      // PR-C alias: the echoed user_id is the freshly-provisioned row's UUID.
      expect(response.body.user_id).toBe(created.id);
      expect(response.body.id).toBe(created.id);
    });

    it('should include groups when user has groups', async () => {
      // Create user and group
      const testUser = await User.create({
        user_id: 'test-user-4',
        username: 'testuser4',
        email: 'test4@example.com'
      });

      const testGroup = await Group.create({
        group_id: 'test-group-4',
        name: 'Test Group'
      });

      // Phase 87.1 (Plan 09 cutover): UserGroup is keyed on user_uuid ONLY — the
      // legacy Auth0-string user_id column was removed from the model.
      await UserGroup.create({
        user_uuid: testUser.id, // Users.id UUID (the join key)
        group_id: testGroup.id
      });

      const response = await request(makeApp(testUser.user_id))
        .get(`/api/users/${testUser.user_id}`)
        .expect(200);

      expect(response.body).toHaveProperty('Groups');
      expect(Array.isArray(response.body.Groups)).toBe(true);
    });
  });

  // Phase 87.6 (users-search-email, Tier 1): GET /search/email/:email DELETED.
  // Superseded by friendshipsAPI.searchUserByEmail → GET /friendships/search
  // (BE-12). The WR-01 cross-user PII assertions retire WITH the route — the
  // vulnerability class (this route leaking a victim's phone) disappears with the
  // handler. The surviving /friendships/search route carries its own hardened
  // PII-projection regression net (friendships.test.js BE-12, strengthened in the
  // SAME commit that retired this block — exact-projection + PII-victim assertion,
  // replacing the mocked-only arrayContaining check). See T-87.6-03.
  describe('GET /api/users/search/email/:email (deleted 87.6 users-search-email)', () => {
    const enc = (e) => encodeURIComponent(e);
    it('404s — route deleted', async () => {
      await request(makeApp('auth0|wr01-caller'))
        .get(`/api/users/search/email/${enc('wr01-victim@example.com')}`)
        .expect(404);
    });
  });

  // Phase 87.6 (users-refresh, Tier 3, owner batch decision 2026-07-22):
  // POST /:user_id/refresh DELETED. Redundant with the JIT auto-create branch in
  // GET /:user_id, which reconciles email/username from Auth0 on read. Zero FE
  // callers; no /users/:id/refresh path literal in periodictabletop/src. Net-new
  // pin — no prior behavioral block existed for this route.
  describe('POST /api/users/:user_id/refresh (deleted 87.6 users-refresh)', () => {
    it('404s — route deleted', async () => {
      await request(makeApp('auth0|refresh-caller'))
        .post('/api/users/auth0|refresh-caller/refresh')
        .send({})
        .expect(404);
    });
  });
});


// ---------------------------------------------------------------------------
// Phase 88-34 Task 4 (fork D, owner-ruled 2026-08-20) — the provisioning clamp.
//
// The JIT provisioning branch derives username from Auth0 and, at :257-262,
// given_name + family_name OVERRIDES everything. Real people have full names
// longer than 50 characters. Once User.username carries a len[1,50] backstop, a
// bare backstop with no clamp 500s their FIRST LOGIN — an outage with no
// user-side workaround. Ruled: clamp at the writer, keep the backstop.
// ---------------------------------------------------------------------------
describe('Phase 88-34 Task 4 — provisioning clamps the Auth0-derived username (fork D)', () => {
  beforeEach(async () => {
    await UserGroup.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Group.destroy({ where: {} });
  });

  // Same shape as makeApp above, but with the long-name Auth0 claims attached.
  const makeAppWithClaims = (claims) => {
    const a = express();
    a.use(express.json());
    a.use(stubAuth(claims));
    a.use('/api/users', userRoutes);
    return a;
  };

  it('(fork D repro) first login with a >50-char Auth0 full name succeeds with a 50-char username', async () => {
    const sub = 'auth0|very-long-name-user';
    const givenName = 'Bartholomew Maximilian Fitzgerald';   // 33
    const familyName = 'Wolfeschlegelsteinhausenbergerdorff'; // 34 => 68 with the space

    const res = await request(makeAppWithClaims({
      user_id: sub,
      email: 'long-name@example.com',
      given_name: givenName,
      family_name: familyName,
    }))
      .get(`/api/users/${sub}`)
      .expect(200); // NOT 500 — that is the whole point of this test

    const created = await User.findOne({ where: { user_id: sub } });
    expect(created).not.toBeNull();
    expect(created.username).toHaveLength(50);
    expect(created.username).toBe(`${givenName} ${familyName}`.slice(0, 50));
    expect(res.body.id).toBe(created.id);
  });

  it('the !created needsUpdate path clamps too (both write paths covered)', async () => {
    const sub = 'auth0|existing-generic-user';
    // A pre-existing row whose username is still the generic placeholder — the
    // condition the needsUpdate branch exists for.
    await User.create({ user_id: sub, username: 'User', email: 'generic@example.com' });

    // The !created branch is only reachable through the route's RACE window:
    // the initial self-read misses, so the handler enters the JIT block, but
    // findOrCreate then finds the row that appeared in between. Simulate that
    // by making the FIRST scoped lookup miss while the row genuinely exists —
    // this is the only way to exercise the second write path through the route,
    // and it is the exact concurrency shape that branch was written for.
    const scopeSpy = jest.spyOn(User, 'scope').mockImplementationOnce(() => ({
      findByPk: async () => null,
      findOne: async () => null,
    }));

    const givenName = 'Bartholomew Maximilian Fitzgerald';
    const familyName = 'Wolfeschlegelsteinhausenbergerdorff';

    try {
      await request(makeAppWithClaims({
        user_id: sub,
        email: 'generic-updated@example.com',
        given_name: givenName,
        family_name: familyName,
      }))
        .get(`/api/users/${sub}`)
        .expect(200); // NOT 500 — an unclamped update would violate len[1,50]
    } finally {
      scopeSpy.mockRestore();
    }

    const updated = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
    expect(updated.username).toHaveLength(50);
    expect(updated.username).toBe(`${givenName} ${familyName}`.slice(0, 50));
    // Rule-1 regression (found by this test): the needsUpdate branch used to
    // throw on `newUser.email.includes(...)` because findOrCreate returned a
    // DEFAULT-SCOPED instance with no `email`, so the whole repair path was dead
    // and silently swallowed by the catch. If this assertion regresses, the
    // findOrCreate lost its withContactInfo scope.
    expect(updated.email).toBe('generic-updated@example.com');
  });

  it('a normal-length name is untouched by the clamp', async () => {
    const sub = 'auth0|short-name-user';
    await request(makeAppWithClaims({
      user_id: sub,
      email: 'short@example.com',
      given_name: 'Ada',
      family_name: 'Lovelace',
    }))
      .get(`/api/users/${sub}`)
      .expect(200);

    const created = await User.findOne({ where: { user_id: sub } });
    expect(created.username).toBe('Ada Lovelace');
  });

  it('(backstop pin) the model still rejects a >50-char username on a direct write', async () => {
    await expect(
      User.create({
        user_id: 'auth0|direct-write',
        username: 'Z'.repeat(51),
        email: 'direct@example.com',
      })
    ).rejects.toThrow();
  });
});
