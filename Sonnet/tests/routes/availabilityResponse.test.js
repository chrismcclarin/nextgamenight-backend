// tests/routes/availabilityResponse.test.js
// Integration tests for POST /api/availability-responses domain-error envelope codes (85-03, BAPI-01).
// Magic-token-authenticated (NOT Auth0); validateToken runs with { consume: false }.
//
// Asserts the SPEC-enumerated domain rejects emit their documented lowercase wire codes at
// their CURRENT (anchored) status — NO breaking status change:
//   - closed prompt        -> code prompt_closed            (status 400)
//   - past-deadline prompt -> code prompt_deadline_expired  (status 400)
// Schema is built ONCE by tests/globalSetup.js; the global beforeEach (tests/setup.js)
// TRUNCATEs all tables before each test. Per-test fixtures are seeded in a describe-local
// beforeEach so they survive the wipe. This suite NEVER force-syncs the schema itself.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

const request = require('supertest');
const express = require('express');

const availabilityResponseRoutes = require('../../routes/availabilityResponse');
const {
  User,
  Group,
  AvailabilityPrompt,
} = require('../../models');
const { generateToken } = require('../../services/magicTokenService');

const app = express();
app.use(express.json());
app.use('/api/availability-responses', availabilityResponseRoutes);

describe('POST /api/availability-responses — domain-error envelope codes (85-03)', () => {
  let respondent;
  let testGroup;

  beforeEach(async () => {
    respondent = await User.create({
      user_id: 'auth0|response-domain-codes',
      username: 'Response Tester',
      email: 'response-tester@test.com',
    });

    testGroup = await Group.create({
      name: 'Response Domain Group',
      group_id: 'response-domain-group-001',
    });
  });

  async function createPrompt(overrides = {}) {
    return AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W26',
      ...overrides,
    });
  }

  it('closed prompt returns code prompt_closed at status 400', async () => {
    const prompt = await createPrompt({ status: 'closed' });
    const token = await generateToken(respondent, prompt);

    const res = await request(app)
      .post('/api/availability-responses')
      .send({
        magic_token: token,
        user_timezone: 'America/New_York',
        is_unavailable: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('prompt_closed');
    // legacy `error` alias mirrors `message` during the 85->86 window
    expect(res.body.error).toBe(res.body.message);
  });

  it('past-deadline prompt returns code prompt_deadline_expired at status 400', async () => {
    // status must be 'active' so the deadline check is reached (closed is caught first).
    const prompt = await createPrompt({
      status: 'active',
      deadline: new Date(Date.now() - 60 * 60 * 1000), // 1h in the past
    });
    const token = await generateToken(respondent, prompt);

    const res = await request(app)
      .post('/api/availability-responses')
      .send({
        magic_token: token,
        user_timezone: 'America/New_York',
        is_unavailable: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('prompt_deadline_expired');
    expect(res.body.error).toBe(res.body.message);
  });
});
