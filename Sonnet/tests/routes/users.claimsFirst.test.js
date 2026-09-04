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
// THESE ASSERTIONS ARE DURABLE. Plan 04 moved the rule out of routes/users.js and into
// services/provisioningService.js; this file describes the OBSERVABLE contract and
// survived that move with its three email assertions untouched. Plan 04 Task 3(b)
// exempts this file BY NAME from the `email_verified: true` harness repair applied to
// the other suites — arms 2 and 3 deliberately inject an unverified / absent claim, and
// that is the rule under test. If a future change makes this suite red, the SERVICE is
// wrong; do not fix the test.
//
// ONE assertion did change in plan 04, and it got STRICTER, not looser: arm 2's
// getUserById count went 1 -> 0 when the second Management call site was collapsed into
// the service. The reason is written at that line.
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

    // The WHOLE REQUEST made zero Management calls — the claim was present, so the
    // vendor was never consulted on any path.
    //
    // RESTORED TO THE PLAN-01 NUMBER BY PLAN 04 (2026-09-04), exactly as the note this
    // replaces predicted. Plan 01 had to assert 1 here because GET /api/users/:user_id
    // carried a SECOND Auth0 Management call site — the "fix an incorrect
    // email/username" repair block (routes/users.js:431-479 at the time) — which fired
    // on the same request whenever the row ended up with an @auth0.local address, and
    // which had NO email_verified gate at all: with a working Management API it would
    // have written the vendor's address onto the row regardless of verification,
    // silently undoing the R3 rule this arm enforces. Plan 04 collapsed BOTH call sites
    // into services/provisioningService.js, so the count is genuinely 0 now.
    //
    // This is the STRICTER assertion, not a weakened one — 0 is what plan 01's own plan
    // text asked for and could not reach. The two email assertions above are unchanged,
    // and this file remains exempt from the email_verified harness repair (plan 04 Task
    // 3(b)): its arms deliberately inject an unverified claim.
    expect(auth0Service.getUserById).toHaveBeenCalledTimes(0);
  });

  it('ARM 3: NO email claim falls back to exactly one Auth0 Management API lookup', async () => {
    const userId = 'auth0|claims-first-absent';
    currentUser = {
      user_id: userId,
      // no email claim at all
      name: 'Claimless Person',
    };

    // DEVIATION FROM PLAN 01, recorded deliberately: the plan's harness leaves
    // getUserById REJECTING for this arm too. Under plan 01 a rejecting stub created the
    // row synthetic, which then tripped the downstream repair block and produced TWO
    // calls, not the one the plan asserts. (Plan 04 collapsed that second call site, so
    // a rejecting stub would now produce exactly one — but keeping the RESOLVING stub is
    // still the stronger assertion, and the count below is unchanged either way.)
    // Resolving the lookup is both the realistic fallback scenario and strictly stronger:
    // it proves the fallback is invoked AND that its answer is the one persisted.
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
  // -------------------------------------------------------------------------
  // Phase 88.8 plan 04 (Task 3a) — the KEYSPACE pin.
  //
  // requireParamMatchesToken('user_id') accepts the caller's own Users.id UUID as well
  // as their Auth0 sub (middleware/objectAuth.js:59-84, the Phase 87.4 M-4 KEYMISS
  // path). Before plan 04, a UUID-shaped param could never enter the create or repair
  // branches because BOTH were wrapped in `req.user.user_id === req.params.user_id`.
  // Plan 04 deleted those branches and their guards, so the ONLY thing keeping a UUID
  // out of Users.user_id (which holds SUBS) is that the delegate keys on the TOKEN sub.
  // Get that wrong and the phase mints a NEW row keyed by a UUID and hands it back as
  // the caller's own profile — a class-2 hygiene row of exactly the kind plan 05's
  // report exists to find.
  //
  // Nothing else catches a regression here: no shipped frontend caller passes a UUID to
  // this route today (usersAPI.getUser has one caller, src/lib/hooks/useSelfIdentity.ts:94,
  // which passes user.sub) and no other backend test does either — but
  // src/app/userProfile/page.js:527, :600 and :656 already send the UUID to this route's
  // phone siblings, so the keyspace is live on that page.
  // -------------------------------------------------------------------------
  it('KEYSPACE: a UUID-shaped self-param provisions nothing new and returns the caller\'s own row', async () => {
    const userId = 'auth0|claims-first-uuid-param';
    const seeded = await User.create({
      user_id: userId,
      username: 'Seeded Person',
      email: 'seeded@example.com',
    });
    const before = await User.count();

    currentUser = { user_id: userId };

    const res = await request(app).get(`/api/users/${seeded.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(seeded.id);
    expect(await User.count()).toBe(before);
    // A healthy row with absent claims never consults the vendor.
    expect(auth0Service.getUserById).toHaveBeenCalledTimes(0);
  });
});
