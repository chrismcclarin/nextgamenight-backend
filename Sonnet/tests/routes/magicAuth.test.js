// tests/routes/magicAuth.test.js
// Integration tests for magic auth API endpoints

// Set up test environment
require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Set a test secret if not already set
if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

// Phase 87.5 (WR-01): mock magicTokenService so a single validate call can be
// forced to throw, exercising the outer catch block. Defaults delegate to the
// real implementation via requireActual, so every other test keeps using real
// token generation/validation unchanged.
jest.mock('../../services/magicTokenService', () => {
  const actual = jest.requireActual('../../services/magicTokenService');
  return {
    ...actual,
    validateToken: jest.fn((...args) => actual.validateToken(...args)),
  };
});

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const magicAuthRoutes = require('../../routes/magicAuth');
const { validateToken: mockedValidateToken } = require('../../services/magicTokenService');
const { User, Group, AvailabilityPrompt, MagicToken, TokenAnalytics, sequelize } = require('../../models');
const { generateToken } = require('../../services/magicTokenService');

// Create test app with just magic auth routes (no Auth0 middleware)
const app = express();
app.use(express.json());
app.use('/api/magic-auth', magicAuthRoutes);

describe('Magic Auth API', () => {
  let testUser, testGroup, testPrompt, validToken;

  // Schema is built once by tests/globalSetup.js; the global beforeEach
  // TRUNCATEs all tables, so the fixtures must be seeded per-test (beforeEach).
  beforeEach(async () => {
    // Create test fixtures
    testUser = await User.create({
      user_id: 'auth0|magic-api-test',
      username: 'Magic Test User',
      email: 'magic-api@test.com'
    });

    testGroup = await Group.create({
      name: 'Magic Test Group',
      group_id: 'magic-test-group-001'
    });

    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W05-magic-api'
    });

    // Generate a valid token for tests
    validToken = await generateToken(testUser, testPrompt);
  });

  describe('POST /api/magic-auth/validate', () => {
    it('returns 400 when no token provided', async () => {
      const res = await request(app)
        .post('/api/magic-auth/validate')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('token_invalid');
      expect(res.body.error).toBe('Token is required');
      expect(res.body.error).toBe(res.body.message); // legacy alias (= message)
      expect(res.body.details.action).toBe('request_new'); // action moved under details
    });

    it('returns valid response with user info for valid token', async () => {
      // Generate a fresh token for this test
      const freshToken = await generateToken(testUser, testPrompt);

      const res = await request(app)
        .post('/api/magic-auth/validate')
        .send({ token: freshToken });

      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.user.name).toBe('Magic Test User');
      expect(res.body.prompt_id).toBe(testPrompt.id);
      expect(res.body.expiresAt).toBeDefined();
      expect(res.body.graceUsed).toBe(false);
    });

    it('returns generic error for invalid token', async () => {
      const res = await request(app)
        .post('/api/magic-auth/validate')
        .send({ token: 'not.a.valid.token' });

      expect(res.status).toBe(400); // status STAYS 400 (token_invalid anchored to 400)
      expect(res.body.code).toBe('token_invalid');
      expect(res.body.error).toBe(res.body.message); // one generic message, no per-reason prose
      expect(res.body.details.action).toBe('request_new');
    });

    it('tracks successful validation attempt in analytics', async () => {
      // Generate a fresh token for this test
      const freshToken = await generateToken(testUser, testPrompt);

      await request(app)
        .post('/api/magic-auth/validate')
        .send({ token: freshToken });

      // Wait a moment for async tracking
      await new Promise(resolve => setTimeout(resolve, 100));

      const analytics = await TokenAnalytics.findAll({
        where: { validation_success: true }
      });

      expect(analytics.length).toBeGreaterThanOrEqual(1);
      expect(analytics[0].validation_success).toBe(true);
      expect(analytics[0].token_id).toBeDefined();
    });

    it('tracks failed validation with failure reason', async () => {
      await request(app)
        .post('/api/magic-auth/validate')
        .send({ token: 'invalid.token.here' });

      // Wait a moment for async tracking
      await new Promise(resolve => setTimeout(resolve, 100));

      const analytics = await TokenAnalytics.findAll({
        where: { validation_success: false }
      });

      expect(analytics.length).toBeGreaterThanOrEqual(1);
      expect(analytics[0].validation_success).toBe(false);
      expect(analytics[0].failure_reason).toBeDefined();
    });

    it('returns generic error for revoked token', async () => {
      // Create a token then revoke it
      const newToken = await generateToken(testUser, testPrompt);
      const decoded = jwt.decode(newToken);

      await MagicToken.update(
        { status: 'revoked' },
        { where: { token_id: decoded.jti } }
      );

      const res = await request(app)
        .post('/api/magic-auth/validate')
        .send({ token: newToken });

      expect(res.status).toBe(400); // status STAYS 400 (token_invalid anchored to 400)
      expect(res.body.code).toBe('token_invalid');
      expect(res.body.error).toBe(res.body.message); // generic message identical across reject reasons
      expect(res.body.details.action).toBe('request_new');
    });

    it('tracks revoked token validation attempt', async () => {
      // Create and revoke a token
      const revokedToken = await generateToken(testUser, testPrompt);
      const decoded = jwt.decode(revokedToken);

      await MagicToken.update(
        { status: 'revoked' },
        { where: { token_id: decoded.jti } }
      );

      await request(app)
        .post('/api/magic-auth/validate')
        .send({ token: revokedToken });

      // Wait for async tracking
      await new Promise(resolve => setTimeout(resolve, 100));

      const analytics = await TokenAnalytics.findAll({
        where: {
          validation_success: false,
          failure_reason: 'token_revoked'
        }
      });

      expect(analytics.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 500 (not a hung request) when validation throws server-side', async () => {
      // Phase 87.5 (WR-01) regression guard: force the outer catch to run. Before
      // the fix `token` was declared inside the try, so extractTokenId(token) in
      // the catch threw a ReferenceError, the 500 was never sent, and the request
      // hung. With `token` hoisted above the try, the catch cleanly returns 500.
      mockedValidateToken.mockRejectedValueOnce(new Error('boom'));

      const res = await request(app)
        .post('/api/magic-auth/validate')
        .send({ token: 'any.non.empty.token' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.action).toBe('request_new');
    });

    it('end-to-end: generate token -> validate token -> get user info', async () => {
      // Generate token via service
      const token = await generateToken(testUser, testPrompt);

      // Validate via API
      const res = await request(app)
        .post('/api/magic-auth/validate')
        .send({ token });

      // Verify full response
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.user.name).toBe('Magic Test User');
      expect(res.body.prompt_id).toBe(testPrompt.id);

      // Verify analytics were recorded
      await new Promise(resolve => setTimeout(resolve, 100));
      const analytics = await TokenAnalytics.findAll();
      expect(analytics.length).toBeGreaterThan(0);
    });
  });

  describe('POST /api/magic-auth/request-new', () => {
    it('returns 501 not implemented (placeholder)', async () => {
      const res = await request(app)
        .post('/api/magic-auth/request-new')
        .send({ email: 'test@example.com' });

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('This feature will be available soon.');
    });
  });
});
