// tests/services/magicTokenService.test.js
// TDD tests for magic token generation and validation service

// Set up test environment
require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Set a test secret if not already set
if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

const jwt = require('jsonwebtoken');
const { generateToken, validateToken } = require('../../services/magicTokenService');
const { MagicToken, User, AvailabilityPrompt, Group, sequelize } = require('../../models');

describe('magicTokenService', () => {
  let testUser, testGroup, testPrompt;

  // Schema built once by tests/globalSetup.js; the global beforeEach TRUNCATEs
  // all tables, so the user/group/prompt fixtures must be seeded per-test.
  // (NOTE: the {consume:true} assertion fix is owned by plan 05; this plan only
  // removes the force-sync + close and converts the seed to beforeEach.)
  beforeEach(async () => {
    // Create test user
    // Note: User model has 'username' not 'name'. Service uses 'name || username' for display.
    testUser = await User.create({
      user_id: 'auth0|test123',
      username: 'Test User',  // This is what gets stored and used for display
      email: 'test@example.com'
    });

    // Create test group
    testGroup = await Group.create({
      name: 'Test Group',
      group_id: 'test-group-001'
    });

    // Create test prompt
    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W05'
    });
  });

  describe('generateToken', () => {
    it('returns a JWT string with 3 parts', async () => {
      const token = await generateToken(testUser, testPrompt);
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts: header.payload.signature
    });

    it('creates MagicToken record in database', async () => {
      const token = await generateToken(testUser, testPrompt);
      const decoded = jwt.decode(token);

      const record = await MagicToken.findOne({ where: { token_id: decoded.jti } });
      expect(record).not.toBeNull();
      expect(record.user_id).toBe(testUser.user_id);
      expect(record.prompt_id).toBe(testPrompt.id);
      expect(record.status).toBe('active');
    });

    it('includes user name in token claims', async () => {
      const token = await generateToken(testUser, testPrompt);
      const decoded = jwt.decode(token);

      expect(decoded.name).toBe('Test User');
      expect(decoded.sub).toBe('auth0|test123');
      expect(decoded.prompt_id).toBe(testPrompt.id);
    });

    it('includes required claims (aud, iss)', async () => {
      const token = await generateToken(testUser, testPrompt);
      const decoded = jwt.decode(token);

      expect(decoded.aud).toBe('availability-form');
      expect(decoded.iss).toBe('nextgamenight.app');
      expect(decoded.jti).toBeDefined();
      expect(decoded.exp).toBeDefined();
    });

    it('sets expiry to 24 hours from now', async () => {
      const beforeGeneration = Math.floor(Date.now() / 1000);
      const token = await generateToken(testUser, testPrompt);
      const afterGeneration = Math.floor(Date.now() / 1000);
      const decoded = jwt.decode(token);

      const expectedExpiry = beforeGeneration + (24 * 60 * 60);
      // Allow 5 second tolerance for test execution time
      expect(decoded.exp).toBeGreaterThanOrEqual(expectedExpiry - 5);
      expect(decoded.exp).toBeLessThanOrEqual(afterGeneration + (24 * 60 * 60) + 5);
    });
  });

  describe('validateToken', () => {
    it('returns valid for active non-expired token', async () => {
      const token = await generateToken(testUser, testPrompt);
      const result = await validateToken(token);

      expect(result.valid).toBe(true);
      expect(result.decoded.name).toBe('Test User');
      expect(result.tokenRecord.status).toBe('active');
    });

    it('returns user name in decoded claims for UI confirmation', async () => {
      const token = await generateToken(testUser, testPrompt);
      const result = await validateToken(token);

      expect(result.valid).toBe(true);
      expect(result.decoded.name).toBe('Test User');
      expect(result.decoded.sub).toBe('auth0|test123');
    });

    it('returns invalid for malformed token', async () => {
      const result = await validateToken('not.a.valid.token');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_token');
    });

    it('returns invalid for completely invalid string', async () => {
      const result = await validateToken('garbage');

      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_token');
    });

    it('returns invalid for token not in database', async () => {
      // Create a valid JWT that isn't in the database
      const fakeToken = jwt.sign(
        {
          jti: 'nonexistent-token-id',
          sub: 'auth0|fakeuser',
          name: 'Fake User',
          prompt_id: testPrompt.id,
          aud: 'availability-form',
          iss: 'nextgamenight.app'
        },
        process.env.MAGIC_TOKEN_SECRET,
        { expiresIn: '24h', algorithm: 'HS256' }
      );

      const result = await validateToken(fakeToken);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_not_found');
    });

    it('returns invalid for revoked token', async () => {
      const token = await generateToken(testUser, testPrompt);
      const decoded = jwt.decode(token);

      // Revoke the token
      await MagicToken.update(
        { status: 'revoked' },
        { where: { token_id: decoded.jti } }
      );

      const result = await validateToken(token);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('token_revoked');
    });

    it('returns invalid for token with wrong audience', async () => {
      const wrongAudienceToken = jwt.sign(
        {
          jti: 'wrong-audience-token',
          sub: 'auth0|test123',
          aud: 'wrong-audience',
          iss: 'nextgamenight.app'
        },
        process.env.MAGIC_TOKEN_SECRET,
        { expiresIn: '24h', algorithm: 'HS256' }
      );

      const result = await validateToken(wrongAudienceToken);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_token');
    });

    it('returns invalid for token with wrong issuer', async () => {
      const wrongIssuerToken = jwt.sign(
        {
          jti: 'wrong-issuer-token',
          sub: 'auth0|test123',
          aud: 'availability-form',
          iss: 'wrong-issuer'
        },
        process.env.MAGIC_TOKEN_SECRET,
        { expiresIn: '24h', algorithm: 'HS256' }
      );

      const result = await validateToken(wrongIssuerToken);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_token');
    });

    it('updates usage tracking on successful validation', async () => {
      const token = await generateToken(testUser, testPrompt);
      const decoded = jwt.decode(token);

      // Get initial record
      const beforeRecord = await MagicToken.findOne({ where: { token_id: decoded.jti } });
      expect(beforeRecord.usage_count).toBe(0);
      expect(beforeRecord.last_used_at).toBeNull();

      // usage_count only increments when the caller opts into consumption.
      // validateToken(token, formLoadedAt, { consume }) — magicTokenService.js:81/107.
      // The increment-on-consume design is intentional (Open Q2 RESOLVED), so the
      // test must pass { consume: true } rather than expecting a bare validate to
      // mutate usage_count.
      await validateToken(token, null, { consume: true });

      // Check updated record
      const afterRecord = await MagicToken.findOne({ where: { token_id: decoded.jti } });
      expect(afterRecord.usage_count).toBe(1);
      expect(afterRecord.last_used_at).not.toBeNull();
    });

    describe('grace period', () => {
      it('returns invalid for expired token without grace period context', async () => {
        // Create a token that expired 6 minutes ago (beyond 5-min grace and 30-sec clock tolerance)
        const expiresAt = new Date(Date.now() - 6 * 60 * 1000); // 6 min ago
        const tokenId = 'expired-token-no-grace';

        const expiredToken = jwt.sign(
          {
            jti: tokenId,
            sub: testUser.user_id,
            name: testUser.username,
            prompt_id: testPrompt.id,
            aud: 'availability-form',
            iss: 'nextgamenight.app',
            exp: Math.floor(expiresAt.getTime() / 1000)
          },
          process.env.MAGIC_TOKEN_SECRET,
          { algorithm: 'HS256' }
        );

        // Create database record with past expiry
        await MagicToken.create({
          token_id: tokenId,
          user_id: testUser.user_id,
          prompt_id: testPrompt.id,
          expires_at: expiresAt,
          status: 'active',
          usage_count: 0
        });

        const result = await validateToken(expiredToken);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('token_expired');
      });

      it('returns valid with grace period when form loaded before expiry', async () => {
        // Create a token that expired 2 minutes ago (within 5-min grace period)
        const expiresAt = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago
        const tokenId = 'grace-period-test-token';

        const expiredToken = jwt.sign(
          {
            jti: tokenId,
            sub: testUser.user_id,
            name: testUser.username,
            prompt_id: testPrompt.id,
            aud: 'availability-form',
            iss: 'nextgamenight.app',
            exp: Math.floor(expiresAt.getTime() / 1000)
          },
          process.env.MAGIC_TOKEN_SECRET,
          { algorithm: 'HS256' }
        );

        // Create database record
        await MagicToken.create({
          token_id: tokenId,
          user_id: testUser.user_id,
          prompt_id: testPrompt.id,
          expires_at: expiresAt,
          status: 'active',
          usage_count: 0
        });

        // Form was loaded 10 minutes ago (before expiry since expiry was 2 min ago)
        const formLoadedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();

        const result = await validateToken(expiredToken, formLoadedAt);
        expect(result.valid).toBe(true);
        expect(result.graceUsed).toBe(true);
      });

      it('returns invalid when grace period exceeded (> 5 minutes after expiry)', async () => {
        // Create a token that expired 10 minutes ago (beyond 5 min grace)
        const expiresAt = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
        const tokenId = 'grace-period-exceeded-token';

        const expiredTokenWithPastExp = jwt.sign(
          {
            jti: tokenId,
            sub: testUser.user_id,
            name: testUser.username,
            prompt_id: testPrompt.id,
            aud: 'availability-form',
            iss: 'nextgamenight.app',
            exp: Math.floor(expiresAt.getTime() / 1000)
          },
          process.env.MAGIC_TOKEN_SECRET,
          { algorithm: 'HS256' }
        );

        // Create database record
        await MagicToken.create({
          token_id: tokenId,
          user_id: testUser.user_id,
          prompt_id: testPrompt.id,
          expires_at: expiresAt,
          status: 'active',
          usage_count: 0
        });

        // Form was loaded 15 minutes ago (before expiry)
        const formLoadedAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();

        const result = await validateToken(expiredTokenWithPastExp, formLoadedAt);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('token_expired');
      });

      it('returns invalid when form loaded after token expired', async () => {
        // Create a token that expired 2 minutes ago
        const expiresAt = new Date(Date.now() - 2 * 60 * 1000); // 2 min ago
        const tokenId = 'form-loaded-after-expiry-token';

        const expiredTokenWithPastExp = jwt.sign(
          {
            jti: tokenId,
            sub: testUser.user_id,
            name: testUser.username,
            prompt_id: testPrompt.id,
            aud: 'availability-form',
            iss: 'nextgamenight.app',
            exp: Math.floor(expiresAt.getTime() / 1000)
          },
          process.env.MAGIC_TOKEN_SECRET,
          { algorithm: 'HS256' }
        );

        // Create database record
        await MagicToken.create({
          token_id: tokenId,
          user_id: testUser.user_id,
          prompt_id: testPrompt.id,
          expires_at: expiresAt,
          status: 'active',
          usage_count: 0
        });

        // Form was loaded 1 minute ago (after token already expired)
        const formLoadedAt = new Date(Date.now() - 1 * 60 * 1000).toISOString();

        const result = await validateToken(expiredTokenWithPastExp, formLoadedAt);
        expect(result.valid).toBe(false);
        expect(result.reason).toBe('token_expired');
      });
    });
  });
});
