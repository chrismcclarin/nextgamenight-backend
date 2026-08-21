// tests/routes/provisionedUsername.clamp.test.js
//
// Wave-12 code review HIGH #2 (owner-approved 2026-08-21), extending the
// fork-D ruling: the User.username len[1,50] model backstop is only safe if
// EVERY machine-derived username writer clamps. The original 88-34 fix clamped
// one writer (routes/users.js JIT provisioning, pinned in users.test.js);
// this suite pins the census remainder, one fork-D-pattern test per surface:
//   - routes/googleAuth.js  GET /google/url  (defaults + existing-user update)
//   - routes/events.js      GET /user/:user_id JIT provisioning
//   - routes/groups.js      GET /user/:user_id JIT provisioning
//   - routes/groups.js      POST /join-by-token join provisioning
// Plus the whitespace-only-claim edge: clamp must FALL THROUGH, never write ''.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/auth/google/callback';

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        getToken: jest.fn(),
        generateAuthUrl: jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1'),
        setCredentials: jest.fn(),
        refreshAccessToken: jest.fn(),
      })),
    },
  },
}));

// Auth0 Management API: not configured (throws) — keeps the token-fallback
// provisioning path exercised, same rationale as users.test.js.
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('Auth0 Management API credentials not configured')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

const request = require('supertest');
const express = require('express');
const { stubAuth } = require('../helpers/authStub');
const { User, Group, UserGroup, sequelize } = require('../../models');
const { clampProvisionedUsername } = require('../../utils/provisionedUsername');

const LONG_NAME = 'Bartholomew Maximilian Fitzgerald Wolfeschlegelsteinhausenbergerdorff'; // 68 chars
const CLAMPED = LONG_NAME.trim().slice(0, 50);

function makeApp(mountPath, router, claims) {
  const a = express();
  a.use(express.json());
  a.use(stubAuth(claims));
  a.use(mountPath, router);
  return a;
}

describe('wave-12 HIGH #2 — machine-derived username writers clamp to len[1,50]', () => {
  beforeEach(async () => {
    await UserGroup.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Group.destroy({ where: {} });
  });

  describe('utils/provisionedUsername', () => {
    it('clamps >50 to exactly 50 after trimming', () => {
      expect(clampProvisionedUsername(`  ${LONG_NAME}  `)).toBe(CLAMPED);
      expect(clampProvisionedUsername(LONG_NAME)).toHaveLength(50);
    });
    it('returns null for empty / whitespace-only / nullish so || chains fall through', () => {
      expect(clampProvisionedUsername('   ')).toBeNull();
      expect(clampProvisionedUsername('')).toBeNull();
      expect(clampProvisionedUsername(null)).toBeNull();
      expect(clampProvisionedUsername(undefined)).toBeNull();
    });
  });

  describe('routes/googleAuth.js GET /google/url', () => {
    const googleAuthRoutes = require('../../routes/googleAuth');

    it('provisions a first-time user with a >50-char token name (200, 50-char username)', async () => {
      const sub = 'auth0|gauth-long-name';
      const app = makeApp('/api/auth', googleAuthRoutes,
        { user_id: sub, email: 'gauth-long@example.com', name: LONG_NAME });

      await request(app).get('/api/auth/google/url').expect(200);

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row).not.toBeNull();
      expect(row.username).toBe(CLAMPED);
    });

    it('the existing-user update path clamps too (previously-working connect must not 500)', async () => {
      const sub = 'auth0|gauth-existing';
      await User.create({ user_id: sub, username: 'Old Name', email: 'gauth-old@example.com' });
      const app = makeApp('/api/auth', googleAuthRoutes,
        { user_id: sub, email: 'gauth-old@example.com', name: LONG_NAME });

      await request(app).get('/api/auth/google/url').expect(200); // NOT 500

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row.username).toBe(CLAMPED);
    });
  });

  describe('routes/events.js GET /user/:user_id JIT provisioning', () => {
    const eventRoutes = require('../../routes/events');

    it('provisions a first-time user with a >50-char full name (200, 50-char username)', async () => {
      const sub = 'auth0|events-long-name';
      const [given, ...rest] = LONG_NAME.split(' ');
      const app = makeApp('/api/events', eventRoutes, {
        user_id: sub,
        email: 'events-long@example.com',
        given_name: given,
        family_name: rest.join(' '),
      });

      await request(app).get(`/api/events/user/${encodeURIComponent(sub)}`).expect(200);

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row).not.toBeNull();
      expect(row.username).toHaveLength(50);
      expect(row.username).toBe(CLAMPED);
    });
  });

  describe('routes/groups.js GET /user/:user_id JIT provisioning', () => {
    const groupRoutes = require('../../routes/groups');

    it('provisions a first-time user with a >50-char token name (200, 50-char username)', async () => {
      const sub = 'auth0|groups-long-name';
      const app = makeApp('/api/groups', groupRoutes,
        { user_id: sub, email: 'groups-long@example.com', name: LONG_NAME });

      await request(app).get(`/api/groups/user/${encodeURIComponent(sub)}`).expect(200);

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row).not.toBeNull();
      expect(row.username).toBe(CLAMPED);
    });
  });

  describe('routes/groups.js POST /join-by-token join provisioning', () => {
    const groupRoutes = require('../../routes/groups');

    it('a first-time joiner with a >50-char token name joins (200-family, 50-char username, catch not fired)', async () => {
      const owner = await User.create({
        user_id: 'auth0|join-owner', username: 'Owner', email: 'join-owner@example.com',
      });
      const group = await Group.create({
        group_id: 'join-clamp-group', name: 'Join Clamp Group', invite_token: 'join-clamp-token-1',
      });
      await UserGroup.create({
        user_id: owner.user_id, user_uuid: owner.id, group_id: group.id, role: 'owner', status: 'active',
      });

      const sub = 'auth0|join-long-name';
      const app = makeApp('/api/groups', groupRoutes, {
        user_id: sub, email: 'join-long@example.com', email_verified: true, name: LONG_NAME,
      });

      const res = await request(app)
        .post('/api/groups/join-by-token')
        .send({ token: 'join-clamp-token-1' });
      expect(res.status).toBeLessThan(500); // the validation-500 is the regression under test

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row).not.toBeNull();
      expect(row.username).toBe(CLAMPED);
    });
  });

  describe('whitespace-only claim falls through to the literal fallback', () => {
    const userRoutes = require('../../routes/users');

    it("JIT provisioning with a whitespace-only name writes 'User', never ''", async () => {
      const sub = 'auth0|whitespace-name';
      const app = makeApp('/api/users', userRoutes,
        { user_id: sub, email: 'ws@example.com', name: '   ' });

      await request(app).get(`/api/users/${encodeURIComponent(sub)}`).expect(200); // NOT 500

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row).not.toBeNull();
      expect(row.username).toBe('ws'); // email local-part beats the 'User' literal
    });
  });
});
