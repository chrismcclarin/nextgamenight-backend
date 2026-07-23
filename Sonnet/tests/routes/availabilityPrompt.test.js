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
      user_uuid: target.id, // Phase 87.5 (D-04): table re-keyed onto user_uuid
      user_timezone: 'America/New_York', // NOT-NULL on the model
      submitted_at: new Date(),          // NOT-NULL on the model
      last_reminded_at: new Date(),
    });
  });

  it('returns the reminder_cooldown envelope at 429 with the 24-hour prose', async () => {
    // The remind endpoint is UUID-only — send the target's Users.id UUID. Phase
    // 87.5 (D-04): the cooldown find keys on the resolved target UUID, hitting the
    // AvailabilityResponse row seeded above with user_uuid: target.id.
    const res = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.id)}`)
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
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.id)}`)
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

// Phase 87.5 / Plan 03 (BINT-02, D-04): the respondents endpoint emits the
// member's Users.id UUID (member.User.id) as the serialized wire `user_id`,
// translated from the endpoint's EXISTING groupMembers include (no duplicate
// roster query). The AvailabilityResponse map + has_responded bridge now key on
// member.User.id (the UUID) because the response table is re-keyed onto user_uuid.
// This real-DB test pins BOTH facts: the wire carries the UUID, and the
// UUID-keyed bridge resolves has_responded correctly for each member.
describe('GET /api/prompts/:promptId/respondents — UUID wire field + UUID response bridge (87.5 D-04)', () => {
  let owner;
  let responder;
  let nonResponder;
  let group;
  let prompt;

  beforeEach(async () => {
    owner = await makeUser({ username: 'respondents-owner' });
    responder = await makeUser({ username: 'respondents-responder' });
    nonResponder = await makeUser({ username: 'respondents-nonresponder' });
    group = await makeGroup({ name: 'Respondents Wire Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(responder, group, 'member');
    await addToGroup(nonResponder, group, 'member');

    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W28',
    });

    // Only `responder` submits — AvailabilityResponse keyed on user_uuid (D-04).
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_uuid: responder.id,
      user_timezone: 'UTC',
      time_slots: [{ start: '2026-07-10T18:00:00Z', end: '2026-07-10T21:00:00Z', preference: 'preferred' }],
      submitted_at: new Date(),
    });
  });

  it('serializes each respondent with the Users.id UUID and bridges has_responded via the UUID-keyed map', async () => {
    const res = await request(makeApp(owner))
      .get(`/api/prompts/${prompt.id}/respondents`)
      .send();

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // Wire field now carries the Users.id UUID (NOT the Auth0 sub).
    const responderEntry = res.body.find((r) => r.user_id === responder.id);
    const nonResponderEntry = res.body.find((r) => r.user_id === nonResponder.id);

    // The flipped wire field is the member's Users.id UUID, never the sub.
    expect(responderEntry).toBeDefined();
    expect(responderEntry.user_id).toBe(responder.id);
    expect(res.body.some((r) => r.user_id === responder.user_id)).toBe(false);
    // Bridge into the UUID-keyed AvailabilityResponse map resolved correctly
    // (proves the internal responseMap keys on member.User.id, the UUID).
    expect(responderEntry.has_responded).toBe(true);

    // The non-responder bridges to has_responded=false; its wire id is also the UUID.
    expect(nonResponderEntry).toBeDefined();
    expect(nonResponderEntry.user_id).toBe(nonResponder.id);
    expect(nonResponderEntry.has_responded).toBe(false);

    // PR2-L3 (87.4-review): no serialized entry may carry an undefined user_id —
    // roster rows with a missing User include are dropped BEFORE serialization.
    // (A real missing-include row is unseedable here: UserGroup.user_uuid is a
    // NOT NULL CASCADE FK to Users.id — this pins the wire contract instead.)
    expect(res.body).toHaveLength(3); // owner + responder + nonResponder, none dropped
    for (const r of res.body) {
      expect(r.user_id).toBeDefined();
      expect(typeof r.user_id).toBe('string');
    }
  });
});

// Phase 87.1 / Plan 07 (T-87.1-19): the remind target-membership check (step 7)
// must gate on the TARGET's membership, not the caller's. Keyed on the caller it
// would fail GREEN (the caller already passed the step-2 admin gate), letting an
// admin remind ANY user platform-wide and seed placeholder AvailabilityResponse
// rows for non-members. This negative test proves the boundary is live: an admin
// reminding a NON-member target gets 400, no email, no placeholder row.
describe('POST /api/prompts/:promptId/remind/:userId — non-member target rejected (87.1 T-87.1-19)', () => {
  let owner;
  let outsider;
  let group;
  let prompt;

  beforeEach(async () => {
    owner = await makeUser({ username: 'remind-authz-owner' });
    // `outsider` is a real User but is NOT added to the group.
    outsider = await makeUser({ username: 'remind-authz-outsider' });
    group = await makeGroup({ name: 'Remind Authz Group' });
    await addToGroup(owner, group, 'owner');

    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W29',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('an admin reminding a non-member target → 400, no reminder email, no AvailabilityResponse row', async () => {
    const sendSpy = jest.spyOn(emailService, 'send').mockResolvedValue({ success: true });

    // Phase 87.4 Plan 09: UUID-only endpoint — send the outsider's Users.id UUID
    // (a real user, resolvable), so the request reaches the TARGET membership check
    // and is rejected there (400), NOT short-circuited by the UUID-shape guard.
    const res = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(outsider.id)}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a member of this group/i);

    // The check sits BEFORE the email + placeholder-create steps.
    expect(sendSpy).not.toHaveBeenCalled();
    const rowCount = await AvailabilityResponse.count({
      where: { prompt_id: prompt.id, user_uuid: outsider.id },
    });
    expect(rowCount).toBe(0);
  });
});

// Phase 87.5 / Plan 03 (BINT-02, D-04): the remind endpoint is UUID-only and
// resolves the target BEFORE any AvailabilityResponse query, keying the
// cooldown / already-responded / placeholder-create / race lookups on the
// RESOLVED target's Users.id UUID (targetUser.id) against the re-keyed
// AvailabilityResponse table (user_uuid). These tests pin the three coupled facts:
//   (1) a sub-form :userId is rejected as not-found (T-874-09-VALID);
//   (2) a UUID :userId reminds successfully AND the email is sent to the target's
//       REAL, DEFINED address — proving the contact-info-lifted re-fetch by the
//       resolved PK ran (targetUser.email not undefined);
//   (3) the 24h cooldown HOLDS for a UUID target — a first remind succeeds, a
//       second within the window is rejected with the cooldown envelope (proving
//       the cooldown query keyed the RESOLVED UUID against the user_uuid column,
//       so the row is found and an admin cannot spam reminders —
//       T-874-09-COOLDOWN).
describe('POST /api/prompts/:promptId/remind/:userId — UUID-only contract (87.4 D-03)', () => {
  let owner;
  let target;
  let group;
  let prompt;

  beforeEach(async () => {
    owner = await makeUser({ username: 'uuid-remind-owner' });
    target = await makeUser({ username: 'uuid-remind-target' });
    group = await makeGroup({ name: 'UUID Remind Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(target, group, 'member');

    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W30',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a sub-form :userId as not-found (UUID-only resolve returns null)', async () => {
    const sendSpy = jest.spyOn(emailService, 'send').mockResolvedValue({ success: true });

    // The still-PR-1-shaped Auth0 sub is no longer an accepted target shape.
    const res = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.user_id)}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/user not found/i);
    expect(sendSpy).not.toHaveBeenCalled();
    // No placeholder row created for a rejected target.
    const rowCount = await AvailabilityResponse.count({
      where: { prompt_id: prompt.id, user_uuid: target.id },
    });
    expect(rowCount).toBe(0);
  });

  it('reminds a UUID target and emails the target REAL (defined) address', async () => {
    const sendSpy = jest.spyOn(emailService, 'send').mockResolvedValue({ success: true });

    const res = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.id)}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // The contact-info-lifted re-fetch by the resolved PK ran: `to` is the target's
    // seeded email, DEFINED (not undefined — which is what a default-scope resolve
    // would leave it, defeating the send).
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sendArgs = sendSpy.mock.calls[0][0];
    expect(sendArgs.to).toBeDefined();
    expect(sendArgs.to).toBe(target.email);

    // The placeholder response row was created keyed on the RESOLVED UUID.
    const row = await AvailabilityResponse.findOne({
      where: { prompt_id: prompt.id, user_uuid: target.id },
    });
    expect(row).not.toBeNull();
    expect(row.last_reminded_at).not.toBeNull();
  });

  it('holds the 24h cooldown for a UUID target (second remind within window rejected)', async () => {
    jest.spyOn(emailService, 'send').mockResolvedValue({ success: true });

    // First remind — succeeds and stamps last_reminded_at on the user_uuid-keyed row.
    const first = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.id)}`)
      .send({});
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);

    // Second remind within 24h — the cooldown query keys the RESOLVED UUID against
    // the user_uuid column, finds the just-stamped row, and rejects. (A sub-keyed
    // query would miss it and wrongly succeed — the regression this test guards.)
    const second = await request(makeApp(owner))
      .post(`/api/prompts/${prompt.id}/remind/${encodeURIComponent(target.id)}`)
      .send({});
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('reminder_cooldown');
    expect(second.body.message).toContain('24 hours');
  });
});
