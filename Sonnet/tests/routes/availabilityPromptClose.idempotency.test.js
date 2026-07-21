// tests/routes/availabilityPromptClose.idempotency.test.js
// Phase 87 / Plan 05 (BINT-01, T-87-11): REAL-DB concurrent manual PATCH-close
// idempotency.
//
// The manual close route (PATCH /api/availability-prompts/:id/close) shares the
// guarded close-notification dispatch (handlePromptClosed) with the consensus
// and deadline paths, so it is the same double-close vector. Two concurrent
// close requests both pass the in-handler status check; only the request whose
// atomic conditional UPDATE flips exactly one row may dispatch the email — the
// loser gets 409 and does NOT re-send.
//
// Real-DB (sequelize.sync) with the tests/routes/* pattern: verifyAuth0Token is
// stubbed to inject req.user, emailService.send is counted, and
// heatmapService.aggregateResponses is a no-op so the seeded top slot survives.
// This FAILS against the prior naive check-then-update close (both requests
// would send) and PASSES against the atomic claim.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Passthrough auth — req.user is injected by an app-level middleware below
// (the jest.mock factory may not close over out-of-scope vars, so we keep the
// stub trivial and set the actor ahead of the router, mirroring rsvp.test.js).
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (_req, _res, next) => next(),
}));

// Count close-notification sends; keep the real template.
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  return actual;
});

// Stub aggregation so the seeded AvailabilitySuggestion survives the close.
jest.mock('../../services/heatmapService', () => ({
  aggregateResponses: jest.fn().mockResolvedValue(undefined),
}));

const request = require('supertest');
const express = require('express');
const promptRoutes = require('../../routes/availabilityPrompt');
const emailService = require('../../services/emailService');
const {
  AvailabilityPrompt,
  AvailabilityResponse,
  AvailabilitySuggestion,
  UserGroup,
  Group,
  User,
} = require('../../models');

const ACTOR = 'auth0|patch-close-idem-owner';

let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api', promptRoutes);

async function seedClosablePrompt() {
  const owner = await User.create({
    user_id: ACTOR,
    username: 'Close Owner',
    email: 'patch-close-idem@test.com',
    email_notifications_enabled: true,
  });
  const group = await Group.create({ name: 'PATCH Close Group', group_id: 'patch-close-group-001' });
  // Phase 87.1 seed cutover: DUAL-WRITE user_uuid (Users.id) so the re-keyed PATCH
  // close admin gate (user_uuid) resolves — not just the isCreator fallback.
  await UserGroup.create({
    user_id: ACTOR,
    user_uuid: owner.id,
    group_id: group.id,
    role: 'owner',
    status: 'active',
  });
  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    created_by_user_id: owner.id,
    status: 'active',
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
    week_identifier: '2026-W27',
  });
  await AvailabilityResponse.create({
    prompt_id: prompt.id,
    user_uuid: owner.id, // Phase 87.5 (D-04): table re-keyed onto user_uuid
    time_slots: [{ start: '2026-07-10T18:00:00Z', end: '2026-07-10T21:00:00Z', preference: 'preferred' }],
    user_timezone: 'UTC',
    submitted_at: new Date(),
  });
  await AvailabilitySuggestion.create({
    prompt_id: prompt.id,
    suggested_start: new Date('2026-07-10T18:00:00Z'),
    suggested_end: new Date('2026-07-10T21:00:00Z'),
    participant_count: 1,
    participant_user_ids: [owner.id], // Users.id UUIDs (87.4 D-05)
    preferred_count: 1,
    meets_minimum: true,
    score: 5,
  });
  return prompt;
}

describe('manual PATCH-close idempotency (BINT-01 / T-87-11, real DB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentActor = ACTOR;
    emailService.send.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    currentActor = null;
  });

  it('two concurrent PATCH closes → exactly ONE close email, one 200 + one 409', async () => {
    const prompt = await seedClosablePrompt();

    const [r1, r2] = await Promise.all([
      request(app).patch(`/api/availability-prompts/${prompt.id}/close`).send({}),
      request(app).patch(`/api/availability-prompts/${prompt.id}/close`).send({}),
    ]);

    // Exactly one close-notification email fired across both requests.
    expect(emailService.send).toHaveBeenCalledTimes(1);

    // Exactly one winner (200) and one loser (409) — never two 200s, never 500.
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const row = await AvailabilityPrompt.findByPk(prompt.id);
    expect(row.status).toBe('closed');
  });

  it('a second sequential PATCH close returns 409 and does not re-send', async () => {
    const prompt = await seedClosablePrompt();

    const first = await request(app).patch(`/api/availability-prompts/${prompt.id}/close`).send({});
    expect(first.status).toBe(200);

    const second = await request(app).patch(`/api/availability-prompts/${prompt.id}/close`).send({});
    expect(second.status).toBe(409);

    // Still exactly one email overall.
    expect(emailService.send).toHaveBeenCalledTimes(1);
  });
});
