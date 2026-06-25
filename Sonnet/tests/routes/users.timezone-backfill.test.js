// tests/routes/users.timezone-backfill.test.js
// Phase 78 / TZ-01: tests for the GET /api/users/:user_id existing-user
// null-timezone backfill safety net.
//
// Contract (per CONTEXT D-Backend):
//   - user.timezone === null  + valid detected TZ supplied -> backfill (UPDATE), emit Sentry breadcrumb
//   - user.timezone !== null  (anything, including 'UTC')   -> NEVER overwrite. No breadcrumb.
//   - user.timezone === null  + no TZ / empty / invalid     -> no-op (validation rejects invalid before reaching backfill)
//
// Strict null equality is the only guard. 'UTC' rows are treated as legitimate
// explicit choices (user manually cleaned production pre-Phase-78); they must
// remain untouched.

const request = require('supertest');
const express = require('express');

// Spy on Sentry.addBreadcrumb before requiring the route. Because @sentry/node
// is initialized in server.js only when SENTRY_DSN is set, the route file uses
// a defensive try/require pattern — we want to assert the breadcrumb call
// regardless of whether the SDK actually flushes anything.
// Variable names MUST be prefixed with `mock` (case-insensitive) per Jest's
// hoist-safety rule for jest.mock() factories.
const mockSentryAddBreadcrumb = jest.fn();
const mockSentryCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  addBreadcrumb: (...args) => mockSentryAddBreadcrumb(...args),
  captureException: (...args) => mockSentryCaptureException(...args),
}));

jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockResolvedValue(null),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

const userRoutes = require('../../routes/users');
const { User, Group, UserGroup, sequelize } = require('../../models');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const tid = req.headers['x-test-user-id'];
  if (tid) {
    req.user = {
      user_id: tid,
      email: `${tid.replace(/[|:]/g, '-')}@test.local`,
      username: 'TestUser',
    };
  }
  next();
});
app.use('/api/users', userRoutes);

describe('GET /api/users/:user_id — null-timezone backfill (TZ-01)', () => {
  beforeEach(async () => {
    await UserGroup.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Group.destroy({ where: {} });
    mockSentryAddBreadcrumb.mockClear();
    mockSentryCaptureException.mockClear();
  });

  // NOTE: no afterAll(sequelize.close()) — connection lifecycle is owned by
  // tests/globalTeardown.js (BTEST-02).

  it('backfills timezone when user exists with timezone=null and valid TZ supplied', async () => {
    const userId = 'auth0|tz-backfill-1';
    await User.create({
      user_id: userId,
      email: 'backfill1@example.com',
      username: 'backfill1',
      timezone: null,
    });

    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=America/Denver`)
      .set('x-test-user-id', userId);

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser.timezone).toBe('America/Denver');

    // Sentry breadcrumb on backfill event
    expect(mockSentryAddBreadcrumb).toHaveBeenCalledTimes(1);
    const bc = mockSentryAddBreadcrumb.mock.calls[0][0];
    expect(bc.category).toBe('auth.timezone-backfill');
    expect(bc.level).toBe('info');
    expect(bc.data).toMatchObject({ user_id: userId, timezone: 'America/Denver' });
  });

  it('NEVER overwrites a non-null stored timezone (divergent detected TZ)', async () => {
    const userId = 'auth0|tz-backfill-2';
    await User.create({
      user_id: userId,
      email: 'backfill2@example.com',
      username: 'backfill2',
      timezone: 'America/New_York',
    });

    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=Europe/Berlin`)
      .set('x-test-user-id', userId);

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser.timezone).toBe('America/New_York'); // unchanged
    expect(mockSentryAddBreadcrumb).not.toHaveBeenCalled();
  });

  it('NEVER overwrites legacy UTC stored timezone — user has explicitly picked UTC', async () => {
    const userId = 'auth0|tz-backfill-3';
    await User.create({
      user_id: userId,
      email: 'backfill3@example.com',
      username: 'backfill3',
      timezone: 'UTC',
    });

    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=America/Los_Angeles`)
      .set('x-test-user-id', userId);

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser.timezone).toBe('UTC'); // sacrosanct — even 'UTC' isn't touched
    expect(mockSentryAddBreadcrumb).not.toHaveBeenCalled();
  });

  it('does not write when stored TZ matches detected TZ (no-op)', async () => {
    const userId = 'auth0|tz-backfill-4';
    await User.create({
      user_id: userId,
      email: 'backfill4@example.com',
      username: 'backfill4',
      timezone: 'America/Los_Angeles',
    });

    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=America/Los_Angeles`)
      .set('x-test-user-id', userId);

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser.timezone).toBe('America/Los_Angeles');
    expect(mockSentryAddBreadcrumb).not.toHaveBeenCalled();
  });

  it('does not write when stored TZ is null but no TZ is supplied', async () => {
    const userId = 'auth0|tz-backfill-5';
    await User.create({
      user_id: userId,
      email: 'backfill5@example.com',
      username: 'backfill5',
      timezone: null,
    });

    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}`)
      .set('x-test-user-id', userId);

    expect(res.status).toBe(200);
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser.timezone).toBeNull();
    expect(mockSentryAddBreadcrumb).not.toHaveBeenCalled();
  });

  it('returns 400 (and does NOT touch the user row) when invalid TZ supplied to existing null user', async () => {
    const userId = 'auth0|tz-backfill-6';
    await User.create({
      user_id: userId,
      email: 'backfill6@example.com',
      username: 'backfill6',
      timezone: null,
    });

    const res = await request(app)
      .get(`/api/users/${encodeURIComponent(userId)}?timezone=Not/AReal_Zone`)
      .set('x-test-user-id', userId);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid IANA timezone string');
    const dbUser = await User.findOne({ where: { user_id: userId } });
    expect(dbUser.timezone).toBeNull();
    expect(mockSentryAddBreadcrumb).not.toHaveBeenCalled();
  });
});
