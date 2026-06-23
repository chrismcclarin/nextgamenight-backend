// tests/routes/googleAuth.test.js
// D-04 / BSEC-03: Google OAuth state is a server-stored single-use nonce.
//
// Proves:
//   - the callback resolves user_id FROM the stored row, not the client
//   - a forged / missing / replayed nonce is rejected (no token exchange, error redirect)
//   - the SUCCESS redirect target equals the stored allow-listed frontend_url
//   - the ERROR-path redirect is derived from the resolved row's frontend_url
//     (or env default) — NOT from re-parsing req.query.state; an attacker-supplied
//     state cannot influence the error redirect
//
// Real-DB for SingleUseToken + User; the googleapis token exchange is mocked so
// no real network call happens. Runs against the Postgres service container in CI.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'test-client-secret';
process.env.GOOGLE_REDIRECT_URI =
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/auth/google/callback';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ---- Mock googleapis: control the token exchange without a network call ----
const mockGetToken = jest.fn();
const mockGenerateAuthUrl = jest.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?mock=1');

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        getToken: (...args) => mockGetToken(...args),
        generateAuthUrl: (...args) => mockGenerateAuthUrl(...args),
        setCredentials: jest.fn(),
        refreshAccessToken: jest.fn(),
      })),
    },
  },
}));

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const googleAuthRoutes = require('../../routes/googleAuth');
const { User, SingleUseToken, sequelize } = require('../../models');

// App: callback is PUBLIC (no auth). Inject req.user for the authed /url mint test.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { user_id: 'auth0|gauth-test-user', email: 'gauth@test.com', name: 'GAuth Tester' };
  next();
});
app.use('/api/auth', googleAuthRoutes);

describe('Google OAuth single-use nonce state (D-04 / BSEC-03)', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
    await User.create({ user_id: 'auth0|gauth-test-user', username: 'GAuth Tester', email: 'gauth@test.com' });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    await SingleUseToken.destroy({ where: {} });
    mockGetToken.mockReset();
    mockGenerateAuthUrl.mockClear();
  });

  describe('GET /api/auth/google/url — mint', () => {
    it('mints a SingleUseToken oauth_state row with an allow-listed frontend_url and passes only the nonce as state', async () => {
      const res = await request(app)
        .get('/api/auth/google/url')
        .query({ frontend_url: 'http://localhost:3000' });

      expect(res.status).toBe(200);
      expect(res.body.authUrl).toBeTruthy();

      const rows = await SingleUseToken.findAll({ where: { purpose: 'oauth_state' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe('auth0|gauth-test-user');
      expect(rows[0].frontend_url).toBe('http://localhost:3000');
      expect(rows[0].status).toBe('active');

      // state passed to Google === the stored nonce (opaque, not base64-JSON).
      const stateArg = mockGenerateAuthUrl.mock.calls[0][0].state;
      expect(stateArg).toBe(rows[0].nonce);
    });

    it('rejects (falls back) a non-allow-listed frontend_url — attacker origin is never stored', async () => {
      const res = await request(app)
        .get('/api/auth/google/url')
        .query({ frontend_url: 'https://evil.example.com' });

      expect(res.status).toBe(200);
      const rows = await SingleUseToken.findAll({ where: { purpose: 'oauth_state' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].frontend_url).not.toContain('evil.example.com');
      expect(rows[0].frontend_url).toBe('http://localhost:3000');
    });
  });

  describe('GET /api/auth/google/callback — resolve + consume', () => {
    async function mintNonce(overrides = {}) {
      const nonce = crypto.randomBytes(32).toString('base64url');
      await SingleUseToken.create({
        nonce,
        user_id: 'auth0|gauth-test-user',
        purpose: 'oauth_state',
        frontend_url: 'http://localhost:3000',
        status: 'active',
        expires_at: new Date(Date.now() + 30 * 60 * 1000),
        ...overrides,
      });
      return nonce;
    }

    it('Test 3: resolves user_id from the row and redirects to the stored allow-listed frontend_url on success', async () => {
      const nonce = await mintNonce();
      mockGetToken.mockResolvedValue({
        tokens: { access_token: 'acc-tok', refresh_token: 'ref-tok' },
      });

      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code', state: nonce });

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/userProfile/?google_calendar=connected');

      // Token was stored against the row's user_id (resolved from the row, not the client).
      const user = await User.findOne({ where: { user_id: 'auth0|gauth-test-user' } });
      expect(user.google_calendar_token).toBe('acc-tok');
      expect(user.google_calendar_enabled).toBe(true);

      // Nonce is consumed (single-use).
      const row = await SingleUseToken.findOne({ where: { nonce } });
      expect(row.status).toBe('used');
    });

    it('Test 3b: a forged / unknown nonce is rejected (no token exchange) and redirects to the env default error page', async () => {
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code', state: 'forged-nonce-not-in-db' });

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('google_calendar=error');
      expect(res.headers.location.startsWith('http://localhost:3000/')).toBe(true);
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    it('Test 3c: a replayed nonce (already used) is rejected on the second callback', async () => {
      const nonce = await mintNonce();
      mockGetToken.mockResolvedValue({ tokens: { access_token: 'acc-tok' } });

      const first = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'code-1', state: nonce });
      expect(first.headers.location).toContain('google_calendar=connected');

      mockGetToken.mockClear();
      const second = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'code-2', state: nonce });
      expect(second.headers.location).toContain('google_calendar=error');
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    it('Test 4: on token-exchange failure the error redirect uses the resolved row frontend_url — NOT a client-supplied state', async () => {
      // Mint a row whose allow-listed frontend_url is the only legitimate origin.
      const nonce = await mintNonce({ frontend_url: 'http://localhost:3000' });
      mockGetToken.mockRejectedValue(new Error('token exchange boom'));

      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code', state: nonce });

      expect(res.status).toBe(302);
      // Error redirect derives from the row, not from req.query.state.
      expect(res.headers.location.startsWith('http://localhost:3000/userProfile/?google_calendar=error')).toBe(true);
      expect(res.headers.location).not.toContain('evil');
    });

    it('Test 4b: an attacker-supplied state cannot influence the error redirect (no row -> env default, never reflected)', async () => {
      // A base64-JSON-looking state with an attacker frontend_url must NOT be parsed.
      const malicious = Buffer.from(
        JSON.stringify({ user_id: 'auth0|attacker', frontend_url: 'https://evil.example.com' })
      ).toString('base64url');

      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'auth-code', state: malicious });

      expect(res.status).toBe(302);
      expect(res.headers.location).not.toContain('evil.example.com');
      expect(res.headers.location.startsWith('http://localhost:3000/')).toBe(true);
    });
  });
});
