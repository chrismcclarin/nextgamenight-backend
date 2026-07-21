// tests/integration/participantUserIds.roundtrip.test.js
// Phase 87.4 / Plan 03 (D-05) — UUID round-trip proof for the
// AvailabilitySuggestion.participant_user_ids keyspace flip (Auth0 sub -> Users.id).
//
// REAL-POSTGRES integration test. It mocks ONLY the external boundaries (Google
// Calendar client, emailService) and the Auth0 middleware (for the heatmap route
// reader); every model + service + the sweep migration run for real against Postgres.
//
// Coverage:
//   1. WRITE -> READ -> CONVERT: heatmapService stores Users.id UUIDs; every stored
//      element isUuid; eventCreationService.convert resolves the seeded Users by id.
//   2. SWEEP (legacy rows): the migration remaps a sub-shaped row to UUIDs with a
//      consistent participant_count, and is idempotent on re-run.
//   3. SWEEP (all-orphan): an all-orphan sub row COALESCEs to [] (NOT NULL) with count 0.
//   4. BACKSTOP: a participant present in participant_user_ids but ABSENT from the
//      sub-keyed tentative_calendar_event_ids map still gets their hold reaped, proving
//      the backstop bridges UUID -> sub and recomputes the deterministic (sub-based) id.
//   5. DEPLOY-WINDOW RESIDUE: a mixed UUID + sub-shaped array does not throw a 22P02 in
//      any of the three flipped readers; UUID entries resolve, sub-shaped entry is dropped.
//
// RUN ALONE (shared test-DB force-sync gotcha):
//   npm test -- tests/integration/participantUserIds.roundtrip.test.js --forceExit --testTimeout=70000
// Runs under the DEFAULT jest config (globalSetup schema build + per-test TRUNCATE).

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// ---------------------------------------------------------------------------
// External-boundary mocks (models stay REAL). Declared before requiring the
// services so their top-level requires resolve to these doubles.
// ---------------------------------------------------------------------------
const mockCreateHold = jest.fn().mockResolvedValue({ id: 'gcal-created' });
const mockDeleteHold = jest.fn().mockResolvedValue(true);
jest.mock('../../services/googleCalendarService', () => ({
  createTentativeHold: (...a) => mockCreateHold(...a),
  deleteTentativeHold: (...a) => mockDeleteHold(...a),
}));
const mockEmailSend = jest.fn().mockResolvedValue({ success: true });
jest.mock('../../services/emailService', () => ({
  isConfigured: () => false, // convert skips confirmation emails
  send: (...a) => mockEmailSend(...a),
}));
// Mock Auth0 so verifyAuth0Token injects the requester as req.user (heatmap reader).
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => {
    req.user = req.__actor || { user_id: 'auth0|roundtrip-actor' };
    next();
  },
}));

const request = require('supertest');
const express = require('express');

const {
  sequelize,
  User,
  Game,
  Event,
  EventParticipation,
  AvailabilityPrompt,
  AvailabilityResponse,
  AvailabilitySuggestion,
} = require('../../models');

const { makeUser, makeGroup, addToGroup } = require('../factories');
const { isUuid } = require('../../utils/resolveTargetUser');
const heatmapService = require('../../services/heatmapService');
const eventCreationService = require('../../services/eventCreationService');
const tentativeHoldService = require('../../services/tentativeHoldService');
const { deterministicHoldId } = tentativeHoldService;
const availabilityPromptRoutes = require('../../routes/availabilityPrompt');
const sweepMigration = require('../../migrations/20260716000001-sweep-participant-user-ids-uuid.js');

// ---- local seeders -----------------------------------------------------------
async function makeGame(overrides = {}) {
  return Game.create({ name: `Game ${Date.now()}-${Math.random()}`, bgg_id: null, min_players: 2, ...overrides });
}
async function makePrompt(group, overrides = {}) {
  const n = Math.random().toString(36).slice(2);
  return AvailabilityPrompt.create({
    group_id: group.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 72 * 3600 * 1000),
    status: 'closed',
    week_identifier: `2026-W07-${n}`,
    ...overrides,
  });
}
async function makeResponse(prompt, user, timeSlots, overrides = {}) {
  return AvailabilityResponse.create({
    prompt_id: prompt.id,
    user_uuid: user.id, // Phase 87.5 (D-04): re-keyed onto Users.id (user_uuid)
    time_slots: timeSlots,
    user_timezone: 'UTC',
    submitted_at: new Date(),
    ...overrides,
  });
}

// Two half-hour slots making one full hour (heatmap intersects :00 and :30 halves).
const SLOT_START = '2026-02-15T18:00:00.000Z';
const SLOT_MID = '2026-02-15T18:30:00.000Z';
const SLOT_END = '2026-02-15T19:00:00.000Z';
function fullHourSlots(pref = 'preferred') {
  return [
    { start: SLOT_START, end: SLOT_MID, preference: pref },
    { start: SLOT_MID, end: SLOT_END, preference: pref },
  ];
}

function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor) req.__actor = { user_id: actor.user_id, email: actor.email };
    next();
  });
  app.use('/api', availabilityPromptRoutes);
  return app;
}

describe('participant_user_ids UUID round-trip (Phase 87.4 / Plan 03)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('1. writer stores Users.id UUIDs and convert resolves the seeded Users by id', async () => {
    const owner = await makeUser();
    const memberA = await makeUser();
    const memberB = await makeUser();
    const group = await makeGroup();
    await addToGroup(owner, group, 'owner');
    await addToGroup(memberA, group, 'member');
    await addToGroup(memberB, group, 'member');
    const game = await makeGame();
    const prompt = await makePrompt(group, { game_id: game.id });

    await makeResponse(prompt, memberA, fullHourSlots('preferred'));
    await makeResponse(prompt, memberB, fullHourSlots('if-need-be'));

    // WRITE
    const agg = await heatmapService.aggregateResponses(prompt.id);
    expect(agg.success).toBe(true);

    const suggestions = await AvailabilitySuggestion.findAll({ where: { prompt_id: prompt.id } });
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(Array.isArray(s.participant_user_ids)).toBe(true);
      for (const el of s.participant_user_ids) {
        expect(isUuid(el)).toBe(true); // every stored element is a UUID, no sub
        expect(el).not.toContain('|');
      }
    }
    // The full-hour slot holds BOTH members' UUIDs (not their subs).
    const withBoth = suggestions.find(s => s.participant_user_ids.length === 2);
    expect(withBoth).toBeDefined();
    expect([...withBoth.participant_user_ids].sort()).toEqual([memberA.id, memberB.id].sort());
    expect(withBoth.participant_user_ids).not.toContain(memberA.user_id);

    // CONVERT (read path) — suppress the fire-and-forget hold cleanup for this case.
    const cleanupSpy = jest
      .spyOn(tentativeHoldService, 'cleanupHoldsOnEventCreation')
      .mockResolvedValue({ deleted: 0, failed: 0 });

    const result = await eventCreationService.convertSuggestionToEvent(withBoth.id, owner.user_id);
    expect(result.success).toBe(true);
    expect(result.event.participant_count).toBe(2);

    const parts = await EventParticipation.findAll({ where: { event_id: result.event_id } });
    expect(parts.map(p => p.user_id).sort()).toEqual([memberA.id, memberB.id].sort());

    cleanupSpy.mockRestore();
  });

  test('2. sweep migration remaps a legacy sub-shaped row to UUIDs (idempotent, consistent count)', async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const group = await makeGroup();
    const prompt = await makePrompt(group); // no game -> min 2

    const sugg = await AvailabilitySuggestion.create({
      prompt_id: prompt.id,
      suggested_start: new Date(SLOT_START),
      suggested_end: new Date(SLOT_END),
      participant_count: 2,
      participant_user_ids: [userA.user_id, userB.user_id], // legacy subs
      preferred_count: 1,
      meets_minimum: false,
      score: 0,
    });

    await sweepMigration.up(sequelize.getQueryInterface());

    let after = await AvailabilitySuggestion.findByPk(sugg.id);
    expect(after.participant_user_ids.every(isUuid)).toBe(true);
    expect([...after.participant_user_ids].sort()).toEqual([userA.id, userB.id].sort());
    expect(after.participant_count).toBe(2);
    expect(after.meets_minimum).toBe(true); // 2 >= 2
    expect(after.score).toBe(2 * 1.0 + 1 * 0.5); // len*1 + preferred_count*0.5

    // Idempotent: re-running the sweep is a no-op on the now-UUID row.
    await sweepMigration.up(sequelize.getQueryInterface());
    const after2 = await AvailabilitySuggestion.findByPk(sugg.id);
    expect([...after2.participant_user_ids].sort()).toEqual([userA.id, userB.id].sort());
    expect(after2.participant_count).toBe(2);
  });

  test('3. sweep COALESCEs an all-orphan row to [] (not NULL) with participant_count 0', async () => {
    const group = await makeGroup();
    const prompt = await makePrompt(group);
    const orphanSub = `auth0|orphan-${Date.now()}`;

    const sugg = await AvailabilitySuggestion.create({
      prompt_id: prompt.id,
      suggested_start: new Date(SLOT_START),
      suggested_end: new Date(SLOT_END),
      participant_count: 1,
      participant_user_ids: [orphanSub], // no Users row -> orphan
      preferred_count: 0,
      meets_minimum: false,
      score: 1,
    });

    await sweepMigration.up(sequelize.getQueryInterface());

    const after = await AvailabilitySuggestion.findByPk(sugg.id);
    expect(after.participant_user_ids).toEqual([]); // [] not NULL
    expect(after.participant_user_ids).not.toBeNull();
    expect(after.participant_count).toBe(0);
    expect(after.meets_minimum).toBe(false);
  });

  test('4. cleanup backstop reaps a participant absent from the sub-keyed tentative map', async () => {
    const user = await makeUser({
      google_calendar_enabled: true,
      google_calendar_token: 'access-tok',
      google_calendar_refresh_token: 'refresh-tok',
    });
    const group = await makeGroup();
    const prompt = await makePrompt(group);

    // participant_user_ids is UUID-keyed; the sub-keyed tentative map is EMPTY (the
    // hold was created on GCal but never persisted — the crash-recovery scenario).
    const sugg = await AvailabilitySuggestion.create({
      prompt_id: prompt.id,
      suggested_start: new Date(SLOT_START),
      suggested_end: new Date(SLOT_END),
      participant_count: 1,
      participant_user_ids: [user.id], // UUID
      preferred_count: 0,
      meets_minimum: true,
      score: 1,
      tentative_calendar_event_ids: {}, // participant ABSENT from the stored map
    });

    const result = await tentativeHoldService.cleanupHoldsOnEventCreation(sugg.id, prompt.id);

    // The backstop bridged UUID -> sub and recomputed the deterministic (sub-based) id.
    const expectedHoldId = deterministicHoldId(sugg.id, user.user_id);
    expect(mockDeleteHold).toHaveBeenCalledWith(expectedHoldId, 'access-tok', 'refresh-tok');
    expect(result.deleted).toBe(1);
    expect(result.failed).toBe(0);
  });

  test('5a. deploy-window residue: mixed UUID + sub-shaped array does not throw in eventCreation + tentativeHold readers', async () => {
    const owner = await makeUser();
    const validUser = await makeUser({
      google_calendar_enabled: true,
      google_calendar_token: 'access-tok',
      google_calendar_refresh_token: 'refresh-tok',
    });
    const group = await makeGroup();
    await addToGroup(owner, group, 'owner');
    await addToGroup(validUser, group, 'member');
    const prompt = await makePrompt(group);
    const residueSub = `auth0|residue-${Date.now()}`;

    // Reader A — eventCreationService.convert (its own suggestion, converts it).
    const suggForConvert = await AvailabilitySuggestion.create({
      prompt_id: prompt.id,
      suggested_start: new Date(SLOT_START),
      suggested_end: new Date(SLOT_END),
      participant_count: 2,
      participant_user_ids: [validUser.id, residueSub], // mixed
      preferred_count: 0,
      meets_minimum: true,
      score: 2,
    });

    const cleanupSpy = jest
      .spyOn(tentativeHoldService, 'cleanupHoldsOnEventCreation')
      .mockResolvedValue({ deleted: 0, failed: 0 });

    let convertResult;
    await expect(
      (async () => { convertResult = await eventCreationService.convertSuggestionToEvent(suggForConvert.id, owner.user_id); })()
    ).resolves.not.toThrow();
    expect(convertResult.success).toBe(true);
    const parts = await EventParticipation.findAll({ where: { event_id: convertResult.event_id } });
    expect(parts.map(p => p.user_id)).toEqual([validUser.id]); // only the UUID resolved
    cleanupSpy.mockRestore();

    // Reader B — tentativeHoldService.createHoldsForTopSuggestions (separate suggestion).
    await AvailabilitySuggestion.create({
      prompt_id: prompt.id,
      suggested_start: new Date(SLOT_MID),
      suggested_end: new Date(SLOT_END),
      participant_count: 2,
      participant_user_ids: [validUser.id, residueSub], // mixed
      preferred_count: 0,
      meets_minimum: true,
      score: 2,
    });

    let holdResult;
    await expect(
      (async () => { holdResult = await tentativeHoldService.createHoldsForTopSuggestions(prompt.id); })()
    ).resolves.not.toThrow();
    // The residue sub was shape-filtered out; only the valid UUID user got a hold.
    expect(mockCreateHold).toHaveBeenCalledTimes(1);
  });

  test('5b. deploy-window residue: heatmap reader returns 200, counts the UUID user, excludes the sub', async () => {
    const actor = await makeUser();
    const validUser = await makeUser();
    const group = await makeGroup();
    await addToGroup(actor, group, 'member');
    await addToGroup(validUser, group, 'member');
    const prompt = await makePrompt(group);
    const residueSub = `auth0|residue-${Date.now()}`;

    // A submitted response so totalMembers > 0 (the heatmap counts distinct responders).
    await makeResponse(prompt, validUser, fullHourSlots());

    // Two half-hour suggestions for the same hour, both mixed UUID + residue sub.
    await AvailabilitySuggestion.create({
      prompt_id: prompt.id,
      suggested_start: new Date(SLOT_START), // minute 0 -> halfA
      suggested_end: new Date(SLOT_MID),
      participant_count: 2,
      participant_user_ids: [validUser.id, residueSub],
      preferred_count: 0,
      meets_minimum: true,
      score: 2,
    });
    await AvailabilitySuggestion.create({
      prompt_id: prompt.id,
      suggested_start: new Date(SLOT_MID), // minute 30 -> halfB
      suggested_end: new Date(SLOT_END),
      participant_count: 2,
      participant_user_ids: [validUser.id, residueSub],
      preferred_count: 0,
      meets_minimum: true,
      score: 2,
    });

    const res = await request(makeApp(actor)).get(`/api/prompts/${prompt.id}/heatmap`);
    expect(res.status).toBe(200); // no 22P02 / 500
    // The residue sub appears NOWHERE in the response.
    expect(JSON.stringify(res.body)).not.toContain(residueSub);

    // The valid UUID user is counted for the full hour and its username resolves.
    const hourSlot = (res.body.slots || []).find(s => s.availableCount === 1);
    expect(hourSlot).toBeDefined();
    expect(hourSlot.availableMembers.map(m => m.user_id)).toEqual([validUser.id]);
    expect(hourSlot.availableMembers[0].username).toBe(validUser.username);
  });
});
