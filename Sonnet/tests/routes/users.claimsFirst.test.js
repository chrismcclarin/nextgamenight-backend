// tests/routes/users.claimsFirst.test.js
// Phase 88.8 / BOPS-05 (SPEC R2) — the tracer's acceptance test.
//
// Pins the THREE-WAY claims-first rule on the JIT create branch of
// GET /api/users/:user_id:
//   1. email claim present AND email_verified === true -> the REAL address is persisted
//      and auth0Service.getUserById is NEVER called
//   2. email claim present but email_verified ABSENT   -> the synthetic <sub>@auth0.local
//      address is persisted (never the claim address) and getUserById is STILL never
//      called — a present-but-unverified claim is not a reason to phone the vendor
//   3. no email claim at all                            -> exactly ONE getUserById call
//
// getUserById is stubbed to REJECT throughout (the real "Management API is broken"
// behaviour that has been live since 2026-04), so arm 1 passing proves the provisioning
// path no longer depends on the Management API at all.
//
// THESE ASSERTIONS ARE DURABLE. Plan 04 moves the rule out of routes/users.js and into
// services/provisioningService.js; this file describes the OBSERVABLE contract and must
// survive that move unedited (plan 04 Task 3(b) exempts it by name).
//
// Harness shape copied from tests/routes/users.timezone-autocreate.test.js:12-48.

const request = require('supertest');
const express = require('express');

jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('Auth0 Management API credentials not configured')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  // Faithful stand-in for the real extractUserDetails contract (services/auth0Service.js:214-220)
  // so ARM 3 can exercise the fallback with a Management API that actually answers.
  extractUserDetails: jest.fn((u) => ({
    user_id: (u && u.user_id) || null,
    email: (u && u.email) || null,
    username: (u && u.username) || null,
    email_verified: Boolean(u && u.email_verified),
    picture: (u && u.picture) || null,
  })),
}));

const userRoutes = require('../../routes/users');
const auth0Service = require('../../services/auth0Service');
const { User, Group, UserGroup } = require('../../models');

// Test-only middleware standing in for verifyAuth0Token: injects the req.user shape the
// real middleware builds from the token's namespaced claims. The per-test claim shape is
// carried on the app-level `currentUser` box so one app can serve all three arms.
let currentUser = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentUser) req.user = currentUser;
  next();
});
app.use('/api/users', userRoutes);

describe('GET /api/users/:user_id — claims-first provisioning (BOPS-05 / SPEC R2)', () => {
  beforeEach(async () => {
    currentUser = null;
    jest.clearAllMocks();
    auth0Service.getUserById.mockRejectedValue(
      new Error('Auth0 Management API credentials not configured')
    );
    await UserGroup.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Group.destroy({ where: {} });
  });

  // NOTE: no afterAll(sequelize.close()) — connection lifecycle is owned by
  // tests/globalTeardown.js (BTEST-02).

  it('ARM 1: a VERIFIED email claim provisions the real address with ZERO Management API calls', async () => {
    const userId = 'auth0|claims-first-verified';
    currentUser = {
      user_id: userId,
      email: 'real@example.com',
      email_verified: true,
      name: 'Real Person',
    };

    const res = await request(app).get(`/api/users/${encodeURIComponent(userId)}`);

    expect(res.status).toBe(200);

    const dbUser = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.email).toBe('real@example.com');

    // The whole point of BOPS-05: the vendor is off the first-login critical path.
    expect(auth0Service.getUserById).not.toHaveBeenCalled();
  });

  it('ARM 2: a present-but-UNVERIFIED email claim persists the synthetic address, and still makes ZERO Management API calls', async () => {
    const userId = 'auth0|claims-first-unverified';
    currentUser = {
      user_id: userId,
      email: 'unverified@example.com',
      // email_verified deliberately ABSENT — the middleware defaults it to false, and an
      // absent verification claim must be treated as unverified.
      name: 'Unverified Person',
    };

    const res = await request(app).get(`/api/users/${encodeURIComponent(userId)}`);

    expect(res.status).toBe(200);

    // THE load-bearing assertion of this arm (SPEC R3): an unverified claim must never
    // become a Users.email. This one is durable and must survive plan 04 untouched.
    const dbUser = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.email).toBe(`${userId.replace(/[|:]/g, '-')}@auth0.local`);
    expect(dbUser.email).not.toBe('unverified@example.com');

    // The CREATE branch made zero Management calls — the claim was present, so it was
    // never consulted.
    //
    // DEVIATION FROM PLAN 01, recorded deliberately (see 88.8-01-SUMMARY.md): the plan
    // asked for `toHaveBeenCalledTimes(0)` here. That is not reachable from plan 01's
    // scope. GET /api/users/:user_id has a SECOND Auth0 Management call site — the
    // "fix an incorrect email/username" repair block (routes/users.js:420-462), which
    // fires on the SAME request whenever the row ends up with an @auth0.local address.
    // Plan 01's guard was scoped to the create branch only, so the ONE call recorded
    // here comes from that repair block, not from provisioning.
    //
    // FOR PLAN 04: the repair block has NO email_verified gate at all — with a working
    // Management API it will write the vendor's email onto the row regardless of
    // verification, which silently undoes the R3 rule this arm enforces. Collapsing
    // both call sites into provisionOrRepair is what closes it. When plan 04 does that,
    // this count legitimately becomes 0; the two email assertions above do not change.
    expect(auth0Service.getUserById).toHaveBeenCalledTimes(1);
  });

  it('ARM 3: NO email claim falls back to exactly one Auth0 Management API lookup', async () => {
    const userId = 'auth0|claims-first-absent';
    currentUser = {
      user_id: userId,
      // no email claim at all
      name: 'Claimless Person',
    };

    // DEVIATION FROM PLAN 01, recorded deliberately: the plan's harness leaves
    // getUserById REJECTING for this arm too. With a rejecting stub the row is created
    // synthetic, which then trips the downstream repair block (routes/users.js:420) and
    // produces TWO calls, not the one the plan asserts. Resolving the lookup is both the
    // realistic fallback scenario and a strictly stronger assertion: it proves the
    // fallback is invoked AND that its answer is the one persisted.
    auth0Service.getUserById.mockResolvedValueOnce({
      user_id: userId,
      email: 'fallback-real@example.com',
      email_verified: true,
      username: 'fallbackuser',
    });

    const res = await request(app).get(`/api/users/${encodeURIComponent(userId)}`);

    expect(res.status).toBe(200);
    expect(auth0Service.getUserById).toHaveBeenCalledTimes(1);

    const dbUser = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.email).toBe('fallback-real@example.com');
  });
});
