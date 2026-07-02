// tests/routes/availabilityPrompt.test.js
// Integration test for POST /api/prompts/:promptId/remind/:userId — the <24h
// reminder cooldown branch (Phase 85, BAPI-01 + fix C).
//
// Asserts the cooldown reject emits the canonical envelope:
//   - status 429
//   - code  reminder_cooldown
//   - details.next_reminder_available present (ISO string)
//   - error === message (legacy alias)
//   - message contains '24 hours' (fix C: the live FE special-cases
//     err.message.includes('24 hours') in ResponseDashboard.js:72; the prose is
//     preserved via messageOverride so that FE branch keeps working).
//
// This route is Auth0-protected, so verifyAuth0Token is mocked to inject req.user.
// Models hit the real test DB. Schema is built ONCE by tests/globalSetup.js; the
// global beforeEach (tests/setup.js) TRUNCATEs before each test. This suite NEVER
// force-syncs the schema itself.
//
// NOTE (this session): the DB-backed jest harness could not run locally
// (sequelize.authenticate() hangs — session socket degradation, not a code
// defect). The assertions below were proven via a bare-node supertest script that
// stubs the models in require.cache; this file stands for CI.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Mock Auth0 so verifyAuth0Token simply injects the requester as req.user.
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => {
    req.user = req.__actor || { user_id: 'auth0|reminder-requester' };
    next();
  },
}));

const request = require('supertest');
const express = require('express');

const availabilityPromptRoutes = require('../../routes/availabilityPrompt');
const { AvailabilityPrompt, AvailabilityResponse } = require('../../models');
const emailService = require('../../services/emailService');
const { makeUser, makeGroup, addToGroup } = require('../factories');

function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor) req.__actor = { user_id: actor.user_id, email: actor.email };
    next();
  });
  // Mounted at '/api' to mirror server.js:337 (the router declares /prompts/... paths).
  app.use('/api', availabilityPromptRoutes);
  return app;
}

describe('POST /api/prompts/:promptId/remind/:userId — <24h cooldown envelope', () => {
  let owner;
  let target;
  let group;
  let prompt;

  beforeEach(async () => {
    owner = await makeUser({ username: 'reminder-owner' });
    target = await makeUser({ username: 'reminder-target' });
    group = await makeGroup({ name: 'Reminder Cooldown Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(target, group, 'member');

    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W26',
    });

    // A response reminded just now => hoursSince < 24 => cooldown branch.
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_id: target.user_id,
      user_timezone: 'America/New_York', // NOT-NULL on the model
      submitted_at: new Date(),          // NOT-NULL on the model
      last_reminded_at: new Date(),
    });
  });

  it('returns the reminder_cooldown envelope at 429 with the 24-hour prose', async () => {
    const res = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.user_id)}`)
      .send({});

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('reminder_cooldown');
    expect(res.body.details).toBeDefined();
    expect(typeof res.body.details.next_reminder_available).toBe('string');
    expect(res.body.error).toBe(res.body.message); // legacy alias
    // fix C: the wire message must retain '24 hours' for the live FE branch.
    expect(res.body.message).toContain('24 hours');
  });
});

// Phase 87 (WR-04): a concurrent/duplicate admin remind that races the
// placeholder AvailabilityResponse.create must degrade to a success (re-find +
// update last_reminded_at), never a 500. A real DB race is not reproducible in a
// single-threaded test, so we force it: step 4's findOne sees no row (the create
// branch is taken), the create throws a SequelizeUniqueConstraintError (the
// concurrent create won the row), and the absorb's re-find returns the racing row.
describe('POST /api/prompts/:promptId/remind/:userId — concurrent-duplicate absorb (WR-04)', () => {
  let owner;
  let target;
  let group;
  let prompt;

  beforeEach(async () => {
    owner = await makeUser({ username: 'remind-absorb-owner' });
    target = await makeUser({ username: 'remind-absorb-target' });
    group = await makeGroup({ name: 'Remind Absorb Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(target, group, 'member');

    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W27',
    });

    // Email must succeed so the handler reaches step 9 (the write branch).
    jest.spyOn(emailService, 'send').mockResolvedValue({ success: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('degrades a duplicate placeholder create into a success (re-find + update)', async () => {
    // The racing row that the concurrent request already inserted.
    const raceRow = { update: jest.fn().mockResolvedValue(undefined) };

    // Step 4 sees no row (create branch); the absorb re-find returns the racer.
    const findOneSpy = jest
      .spyOn(AvailabilityResponse, 'findOne')
      .mockResolvedValueOnce(null)      // step 4 cooldown/submitted check
      .mockResolvedValueOnce(raceRow);  // absorb re-find

    // The placeholder create loses the race → unique-index violation.
    const uniqueErr = new Error('duplicate key value violates unique constraint');
    uniqueErr.name = 'SequelizeUniqueConstraintError';
    const createSpy = jest
      .spyOn(AvailabilityResponse, 'create')
      .mockRejectedValueOnce(uniqueErr);

    const res = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.user_id)}`)
      .send({});

    // Absorbed: success, not a 500.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The racing row was re-found and stamped with last_reminded_at (exactly one
    // row survives — the unique index guarantees the second insert never lands).
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(findOneSpy).toHaveBeenCalledTimes(2);
    expect(raceRow.update).toHaveBeenCalledTimes(1);
    expect(raceRow.update.mock.calls[0][0]).toHaveProperty('last_reminded_at');
  });
});
