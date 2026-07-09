// tests/routes/users.timezone-autocreate.test.js
// Phase 78 / TZ-01: tests for the GET /api/users/:user_id auto-create handler's
// optional ?timezone= query-param accept + validate + persist flow.
//
// The auto-create branch fires when:
//   1. The user does NOT exist in the DB
//   2. req.user.user_id === req.params.user_id (Auth0 token matches)
//
// In the production app, verifyAuth0Token sets req.user. For tests, we mount
// a small middleware that injects req.user from a header so we can exercise the
// auto-create branch without standing up a real Auth0 token.

const request = require('supertest');
const express = require('express');
const userRoutes = require('../../routes/users');
const { User, Group, UserGroup, sequelize } = require('../../models');

// Mock auth0Service so Auth0 Management API calls don't fire during tests.
// extractUserDetails / getUserById are called inside the auto-create branch; we
// THROW (Management API not configured — the real not-configured behavior) so
// the handler falls back to req.user (token) data — the simpler happy path we
// want to exercise here. NOTE (Phase 87.2 / REQ-6): a RESOLVED null now means
// "Auth0 identity deleted (404)" and makes the JIT branch refuse with the 410
// account_deleted envelope, so mockResolvedValue(null) is no longer a valid
// stand-in for "unavailable".
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('Auth0 Management API credentials not configured')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

const app = express();
app.use(express.json());
// Test-only middleware: inject req.user from x-test-user-id header so the
// auto-create branch's `req.user.user_id === req.params.user_id` guard passes.
app.use((req, _res, next) => {
  const tid = req.headers['x-test-user-id'];
  const temail = req.headers['x-test-user-email'];
  if (tid) {
    req.user = {
      user_id: tid,
      email: temail || `${tid.replace(/[|:]/g, '-')}@test.local`,
      username: (temail && temail.split('@')[0]) || 'TestUser',
    };
  }
  next();
});
app.use('/api/users', userRoutes);

describe('GET /api/users/:user_id — auto-create timezone persistence (TZ-01)', () => {
  beforeEach(async () => {
    await UserGroup.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Group.destroy({ where: {} });
  });

  // NOTE: no afterAll(sequelize.close()) — connection lifecycle is owned by
  // tests/globalTeardown.js (BTEST-02).

  it('persists a valid IANA timezone on first creation when supplied as query param', async () => {
    const userId = 'auth0|tz-create-1';
    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=America/Los_Angeles`)
      .set('x-test-user-id', userId)
      .set('x-test-user-email', 'tzcreate1@example.com');

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.timezone).toBe('America/Los_Angeles');
  });

  it('leaves timezone null on first creation when no timezone supplied', async () => {
    const userId = 'auth0|tz-create-2';
    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}`)
      .set('x-test-user-id', userId)
      .set('x-test-user-email', 'tzcreate2@example.com');

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.timezone).toBeNull();
  });

  it('accepts legacy alias (US/Pacific) verbatim — no canonicalization', async () => {
    const userId = 'auth0|tz-create-3';
    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=US/Pacific`)
      .set('x-test-user-id', userId)
      .set('x-test-user-email', 'tzcreate3@example.com');

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.timezone).toBe('US/Pacific');
  });

  it('returns 400 with "Invalid IANA timezone string" for an unknown TZ on first creation', async () => {
    const userId = 'auth0|tz-create-4';
    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=Not/AReal_Zone`)
      .set('x-test-user-id', userId)
      .set('x-test-user-email', 'tzcreate4@example.com');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid IANA timezone string');
    // Confirm the user was NOT created
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser).toBeNull();
  });

  it('treats empty-string timezone as absent (creates with timezone=null, no 400)', async () => {
    const userId = 'auth0|tz-create-5';
    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=`)
      .set('x-test-user-id', userId)
      .set('x-test-user-email', 'tzcreate5@example.com');

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.timezone).toBeNull();
  });

  it('accepts timezone via request body as fallback when no query param', async () => {
    // Note: GET requests don't typically carry bodies, but Express/supertest
    // allow it and our handler accepts body as fallback per the plan.
    const userId = 'auth0|tz-create-6';
    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}`)
      .set('x-test-user-id', userId)
      .set('x-test-user-email', 'tzcreate6@example.com')
      .send({ timezone: 'Europe/Berlin' });

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser).not.toBeNull();
    expect(dbUser.timezone).toBe('Europe/Berlin');
  });

  it('query param wins over body when both present', async () => {
    const userId = 'auth0|tz-create-7';
    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=America/New_York`)
      .set('x-test-user-id', userId)
      .set('x-test-user-email', 'tzcreate7@example.com')
      .send({ timezone: 'Europe/Berlin' });

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser.timezone).toBe('America/New_York');
  });
});
