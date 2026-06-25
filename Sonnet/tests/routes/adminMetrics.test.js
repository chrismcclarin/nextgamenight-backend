// tests/routes/adminMetrics.test.js
//
// requirePlatformAdmin allow/deny regression (D-02 / BSEC-02 / BE-096).
//
// Proves the platform-admin gate on the operator surfaces:
//   1. non-admin (is_platform_admin false) → 403
//   2. seeded admin (is_platform_admin true) → 200 (handler success path)
//   3. no req.user (anonymous) → 403
//
// The gate is requirePlatformAdmin from middleware/adminAuth.js. We mount the
// real adminMetrics router behind stubAuth (req.user injection, per 83-01) +
// requirePlatformAdmin, varying the seeded flag per test. is_platform_admin is
// a DB-only column (never mass-assignable), so the admin fixture is seeded via
// an explicit .update({ is_platform_admin: true }, { fields: ['is_platform_admin'] })
// — mirroring how the migration UPDATE seeds the operator's row.
const request = require('supertest');
const express = require('express');

// The adminMetrics router internally mounts verifyAuth0Token ahead of
// requirePlatformAdmin (routes/adminMetrics.js:31). Without this pass-through
// the seeded-admin request hits a REAL Auth0 token check and gets 401 instead
// of reaching the handler (200). We neutralize ONLY the Auth0-token layer; the
// real requirePlatformAdmin gate from middleware/adminAuth is left intact (this
// suite exists to exercise that gate).
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

const { stubAuth } = require('../helpers/authStub');
const { requirePlatformAdmin } = require('../../middleware/adminAuth');
const adminMetricsRoutes = require('../../routes/adminMetrics');
const { User } = require('../../models');

// Build an app whose adminMetrics router is gated by requirePlatformAdmin,
// with a stubbed req.user (or none) injected before it.
function buildApp(stubUser) {
  const app = express();
  app.use(express.json());
  if (stubUser) {
    app.use(stubAuth(stubUser));
  }
  app.use('/api', requirePlatformAdmin, adminMetricsRoutes);
  return app;
}

describe('requirePlatformAdmin gate on /api/admin/metrics (BSEC-02)', () => {
  let adminUser, nonAdminUser;

  // Seed per-test (NOT once-per-suite): the global tests/setup.js beforeEach
  // TRUNCATEs every table before each test, which would wipe a once-per-suite
  // seed and leave requirePlatformAdmin's DB lookup with no is_platform_admin
  // row -> the seeded-admin->200 test would 403. Jest runs the global setup.js
  // hook BEFORE this block-local one, so this re-seed lands on the freshly
  // truncated, schema-intact DB. (Deferred to plan 05 by plan 01 L172.)
  beforeEach(async () => {
    const ts = Date.now();

    nonAdminUser = await User.create({
      user_id: `test-nonadmin-${ts}`,
      username: `nonadmin-${ts}`,
      email: `nonadmin-${ts}@example.com`,
    });

    adminUser = await User.create({
      user_id: `test-admin-${ts}`,
      username: `admin-${ts}`,
      email: `admin-${ts}@example.com`,
    });
    // Seed the platform-admin flag the way the migration does: an explicit
    // DB write of the DB-only column (never via create-defaults / mass-assign).
    await adminUser.update(
      { is_platform_admin: true },
      { fields: ['is_platform_admin'] }
    );
  });

  // afterAll destroy is redundant under the per-test TRUNCATE (each test starts
  // from an empty DB) but kept as harmless belt-and-suspenders cleanup.
  afterAll(async () => {
    if (adminUser) await adminUser.destroy();
    if (nonAdminUser) await nonAdminUser.destroy();
  });

  test('non-admin user (is_platform_admin false) → 403', async () => {
    const app = buildApp({ user_id: nonAdminUser.user_id });
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin access required/i);
  });

  test('seeded platform admin (is_platform_admin true) → not gated (200)', async () => {
    const app = buildApp({ user_id: adminUser.user_id });
    const res = await request(app).get('/api/admin/metrics');
    // The gate passes; the handler returns its success payload (200). It must
    // NOT be a 403 from the gate.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('period', '30d');
  });

  test('no req.user (anonymous) → 403', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/api/admin/metrics');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin access required/i);
  });
});
