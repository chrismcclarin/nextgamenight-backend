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

// Phase 88.8 (SPEC R3): every claim object below that carries an `email` also carries
// `email_verified: true`. An email is adopted ONLY when the token says Auth0 verified it,
// and an absent flag reads as UNVERIFIED — which provisions the synthetic
// <sub>@auth0.local address instead of the injected one. Each case here is a normal
// verified signup (this suite is about the len[1,50] username clamp, not the unverified
// posture), so the flag is load-bearing, not decoration. The join case at the bottom
// already carried it, because routes/groups.js:806 is the one shipped writer that has
// always checked verification.

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
        { user_id: sub, email: 'gauth-long@example.com', email_verified: true, name: LONG_NAME });

      await request(app).get('/api/auth/google/url').expect(200);

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row).not.toBeNull();
      expect(row.username).toBe(CLAMPED);
    });

    it('the existing-user update path clamps too (previously-working connect must not 500)', async () => {
      const sub = 'auth0|gauth-existing';
      await User.create({ user_id: sub, username: 'Old Name', email: 'gauth-old@example.com' });
      const app = makeApp('/api/auth', googleAuthRoutes,
        { user_id: sub, email: 'gauth-old@example.com', email_verified: true, name: LONG_NAME });

      await request(app).get('/api/auth/google/url').expect(200); // NOT 500

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row.username).toBe(CLAMPED);
    });

    // --------------------------------------------------------------------
    // Phase 88.8 plan 06, DECISION R3 (SPEC A1). Before this plan, GET
    // /google/url resolved `email` as `req.user?.email || req.query.email` and
    // the existing-user branch wrote it with NO email_verified check anywhere in
    // the file — so any authenticated caller could set their own UNIQUE identity
    // column, which routes/invites.js:593/:664/:757 treat as an authorization
    // gate, from a query string. The query-string fallbacks are deleted and
    // email adoption belongs to the service's verified-only repair.
    //
    // These live in THIS suite, not googleAuth.test.js, because this file already
    // mocks services/auth0Service (:36-40) — an unmocked absent/unverified claim
    // path would make a real 10-second Management call.
    // --------------------------------------------------------------------
    describe('email adoption on the OAuth-URL mint (Phase 88.8 R3)', () => {
      it('a ?email= query param cannot touch Users.email — verified req.user for the ORIGINAL address', async () => {
        const sub = 'auth0|gauth-qs-verified';
        await User.create({ user_id: sub, username: 'QS Verified', email: 'gauth-qs-v@example.com' });

        await request(makeApp('/api/auth', googleAuthRoutes,
          { user_id: sub, email: 'gauth-qs-v@example.com', email_verified: true, name: 'QS Verified' }))
          .get('/api/auth/google/url')
          .query({ email: 'attacker@evil.example' })
          .expect(200);

        const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
        expect(row.email).toBe('gauth-qs-v@example.com');
      });

      it('a ?email= query param cannot touch Users.email — UNVERIFIED req.user.email of a DIFFERENT address', async () => {
        const sub = 'auth0|gauth-qs-unverified';
        await User.create({ user_id: sub, username: 'QS Unverified', email: 'gauth-qs-u@example.com' });

        await request(makeApp('/api/auth', googleAuthRoutes,
          { user_id: sub, email: 'someone-else@example.com', email_verified: false, name: 'QS Unverified' }))
          .get('/api/auth/google/url')
          .query({ email: 'attacker@evil.example' })
          .expect(200);

        const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
        expect(row.email).toBe('gauth-qs-u@example.com');
      });

      // T-88.8-30. The defaults this plan replaced passed `email: email || null`
      // into Users.email, declared allowNull:false — a latent 500 on any Google
      // connect whose token carried no address. The service's last resort is the
      // synthetic address, never null, so the INSERT cannot violate NOT NULL.
      it('a brand-new sub whose token carries NO email provisions a synthetic address, not a NOT NULL violation', async () => {
        const sub = 'auth0|gauth-no-email';

        await request(makeApp('/api/auth', googleAuthRoutes,
          { user_id: sub, name: 'No Email Person' }))
          .get('/api/auth/google/url')
          .expect(200); // NOT 500

        const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
        expect(row).not.toBeNull();
        expect(row.email).toBe('auth0-gauth-no-email@auth0.local');
      });
    });

    // --------------------------------------------------------------------
    // Phase 88.8 code review round 2 HIGH-C (2026-09-05). For an Auth0 database
    // (username-password) connection the `name` claim defaults to the user's EMAIL
    // ADDRESS. Before this fix the existing-row refresh above ran
    // `clampProvisionedUsername(claims.name)` directly, with no address filter, so a
    // Calendar connect published the address as the PUBLIC username. The route now
    // runs its candidates through the service's `makeUsernamePicker`, against both the
    // token address and the stored row address.
    // --------------------------------------------------------------------
    describe('existing-row username refresh never publishes an address (round 2 HIGH-C)', () => {
      it('a `name` claim equal to the token email is refused; the stored username survives', async () => {
        const sub = 'auth0|gauth-name-is-email';
        await User.create({ user_id: sub, username: 'Real Name', email: 'name-is-email@example.com' });

        await request(makeApp('/api/auth', googleAuthRoutes, {
          user_id: sub, email: 'name-is-email@example.com', email_verified: true,
          name: 'name-is-email@example.com',
        })).get('/api/auth/google/url').expect(200);

        const row = await User.findOne({ where: { user_id: sub } });
        expect(row.username).toBe('Real Name');
      });

      it('the compare is normalised: a case- and whitespace-variant of the address is still refused', async () => {
        const sub = 'auth0|gauth-name-is-email-variant';
        await User.create({ user_id: sub, username: 'Real Name', email: 'variant@example.com' });

        await request(makeApp('/api/auth', googleAuthRoutes, {
          user_id: sub, email: 'variant@example.com', email_verified: true,
          name: '  VARIANT@Example.COM  ',
        })).get('/api/auth/google/url').expect(200);

        const row = await User.findOne({ where: { user_id: sub } });
        expect(row.username).toBe('Real Name');
      });

      it('a refused `name` falls through to `nickname` (the chain is filtered per candidate, not abandoned)', async () => {
        const sub = 'auth0|gauth-name-is-email-nick';
        await User.create({ user_id: sub, username: 'Old Name', email: 'with-nick@example.com' });

        await request(makeApp('/api/auth', googleAuthRoutes, {
          user_id: sub, email: 'with-nick@example.com', email_verified: true,
          name: 'with-nick@example.com', nickname: 'nicky',
        })).get('/api/auth/google/url').expect(200);

        const row = await User.findOne({ where: { user_id: sub } });
        expect(row.username).toBe('nicky');
      });

      it('the STORED row address is refused too, when it differs from the token address', async () => {
        // After an in-app email change the row holds the new address while the token
        // still carries the old one. Neither may become the public name.
        const sub = 'auth0|gauth-name-is-stored-email';
        await User.create({ user_id: sub, username: 'Real Name', email: 'stored-new@example.com' });

        await request(makeApp('/api/auth', googleAuthRoutes, {
          user_id: sub, email: 'token-old@example.com', email_verified: true,
          name: 'stored-new@example.com',
        })).get('/api/auth/google/url').expect(200);

        const row = await User.findOne({ where: { user_id: sub } });
        expect(row.username).toBe('Real Name');
      });

      it('an ordinary display name still refreshes (the filter does not over-reach)', async () => {
        const sub = 'auth0|gauth-ordinary-refresh';
        await User.create({ user_id: sub, username: 'Old Name', email: 'ordinary@example.com' });

        await request(makeApp('/api/auth', googleAuthRoutes, {
          user_id: sub, email: 'ordinary@example.com', email_verified: true, name: 'New Name',
        })).get('/api/auth/google/url').expect(200);

        const row = await User.findOne({ where: { user_id: sub } });
        expect(row.username).toBe('New Name');
      });
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
        email_verified: true,
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
        { user_id: sub, email: 'groups-long@example.com', email_verified: true, name: LONG_NAME });

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
        { user_id: sub, email: 'ws@example.com', email_verified: true, name: '   ' });

      await request(app).get(`/api/users/${encodeURIComponent(sub)}`).expect(200); // NOT 500

      const row = await User.findOne({ where: { user_id: sub } });
      expect(row).not.toBeNull();
      expect(row.username).toBe('ws'); // email local-part beats the 'User' literal
    });
  });
});
