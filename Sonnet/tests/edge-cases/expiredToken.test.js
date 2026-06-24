// tests/edge-cases/expiredToken.test.js
// Edge case tests for expired and revoked magic token handling
// NOTE: Do NOT use jest.useFakeTimers() here — the negative expiresIn trick handles
// token expiry without fake timers, which avoids Sequelize pool timeout pitfalls.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

const jwt = require('jsonwebtoken');
const { validateToken } = require('../../services/magicTokenService');
const { User, Group, AvailabilityPrompt, MagicToken, sequelize } = require('../../models');

describe('Expired magic token handling', () => {
  let testUser, testGroup, testPrompt;

  beforeEach(async () => {
    // Seed in beforeEach so the rows survive the global per-test TRUNCATE
    // (schema is built once by tests/globalSetup.js).
    testUser = await User.create({
      user_id: 'auth0|expired-token-test',
      username: 'Expired Token Test User',
      email: 'expired-token@test.com'
    });

    testGroup = await Group.create({
      name: 'Expired Token Test Group',
      group_id: 'expired-token-group-001'
    });

    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W10-expired-token'
    });
  });

  // Note: sequelize.close() is handled globally by tests/setup.js
  // Do NOT close here — closing in individual test files breaks subsequent files
  // when Jest runs multiple edge case tests in the same worker process.

  it('should reject a JWT past its expiry', async () => {
    // Sign a token with expiresIn: '-1h' — already expired by 1 hour
    const expiredToken = jwt.sign(
      {
        jti: 'expired-jti-test-001',
        sub: testUser.user_id,
        name: testUser.username,
        prompt_id: testPrompt.id,
        aud: 'availability-form',
        iss: 'nextgamenight.app'
      },
      process.env.MAGIC_TOKEN_SECRET,
      {
        expiresIn: '-1h',
        algorithm: 'HS256'
      }
    );

    const result = await validateToken(expiredToken);

    expect(result.valid).toBe(false);
  });

  it('should reject a DB-revoked token', async () => {
    const tokenId = 'revoked-jti-test-002';

    // Create a MagicToken row with status: 'revoked'
    await MagicToken.create({
      token_id: tokenId,
      user_id: testUser.user_id,
      prompt_id: testPrompt.id,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: 'revoked',
      usage_count: 0
    });

    // Sign a valid JWT (not expired) with the matching jti
    const revokedToken = jwt.sign(
      {
        jti: tokenId,
        sub: testUser.user_id,
        name: testUser.username,
        prompt_id: testPrompt.id,
        aud: 'availability-form',
        iss: 'nextgamenight.app'
      },
      process.env.MAGIC_TOKEN_SECRET,
      {
        expiresIn: '24h',
        algorithm: 'HS256'
      }
    );

    const result = await validateToken(revokedToken);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe('token_revoked');
  });
});
