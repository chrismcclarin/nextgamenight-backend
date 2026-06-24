// tests/edge-cases/concurrentSubmissions.test.js
// Edge case tests for concurrent duplicate availability response submissions
// Tests that the upsert pattern (unique constraint on prompt_id + user_id) resolves
// to exactly one DB record even when two requests arrive simultaneously.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const availabilityResponseRoutes = require('../../routes/availabilityResponse');
const {
  User,
  Group,
  AvailabilityPrompt,
  MagicToken,
  AvailabilityResponse,
  sequelize
} = require('../../models');

// Create minimal express app for testing the availability response route
// NOTE: magicTokenLimiter skips localhost in development/test mode
const app = express();
app.use(express.json());
app.use('/api/availability-responses', availabilityResponseRoutes);

describe('Concurrent availability response submissions', () => {
  let testUser, testGroup, testPrompt, validJwt, tokenId;

  beforeEach(async () => {
    // Seed in beforeEach so the rows survive the global per-test TRUNCATE
    // (schema is built once by tests/globalSetup.js).
    testUser = await User.create({
      user_id: 'auth0|concurrent-submit-user',
      username: 'Concurrent Submit User',
      email: 'concurrent-submit@test.com'
    });

    testGroup = await Group.create({
      name: 'Concurrent Submit Test Group',
      group_id: 'concurrent-submit-group-001'
    });

    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W13-concurrent-submit'
    });

    // Create a MagicToken in DB
    tokenId = 'concurrent-jti-test-001';
    await MagicToken.create({
      token_id: tokenId,
      user_id: testUser.user_id,
      prompt_id: testPrompt.id,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      status: 'active',
      usage_count: 0
    });

    // Sign a valid JWT with that tokenId
    validJwt = jwt.sign(
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
  });

  // Note: sequelize.close() is handled globally by tests/setup.js

  it('should produce exactly one DB record after two simultaneous POST requests', async () => {
    const payload = {
      magic_token: validJwt,
      time_slots: [
        {
          start: '2026-03-15T14:00:00.000Z',
          end: '2026-03-15T15:00:00.000Z',
          preference: 'preferred'
        }
      ],
      user_timezone: 'America/New_York'
    };

    // Fire two simultaneous POST requests using Promise.all
    const [res1, res2] = await Promise.all([
      request(app).post('/api/availability-responses').send(payload),
      request(app).post('/api/availability-responses').send(payload)
    ]);

    // Both responses should be 200 (one creates, one updates due to upsert pattern)
    // If single-use token, second request may return 400 — still assert 1 DB record
    const validStatusCodes = [200, 201, 400];
    expect(validStatusCodes).toContain(res1.status);
    expect(validStatusCodes).toContain(res2.status);

    // At least one request must have succeeded
    const successCount = [res1, res2].filter(r => r.status === 200 || r.status === 201).length;
    expect(successCount).toBeGreaterThanOrEqual(1);

    // Critical assertion: exactly one DB record for this user/prompt combination
    const dbCount = await AvailabilityResponse.count({
      where: {
        prompt_id: testPrompt.id,
        user_id: testUser.user_id
      }
    });

    expect(dbCount).toBe(1);
  });
});
