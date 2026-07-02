// tests/services/tentativeHoldService.test.js
// Phase 87 / BINT-01 (D-04) — NEW unit test (Wave-0 gap).
//
// Verifies the retry-safety guarantees of the tentative-hold service WITHOUT a
// live Google Calendar or the test DB: googleCalendarService and the Sequelize
// models are mocked. Three properties are covered:
//   (a) DETERMINISM       — deterministicHoldId is stable + uses GCal's base32hex charset.
//   (b) 409-AS-SUCCESS    — a _duplicate (409) create is counted as a hold, not a failure.
//   (c) INCREMENTAL PERSIST — each id is written to the DB as it is created, and
//                             cleanup can RECOMPUTE the id so nothing orphans on retry.

jest.mock('../../models', () => ({
  AvailabilitySuggestion: { findAll: jest.fn() },
  AvailabilityPrompt: { findByPk: jest.fn() },
  User: { findAll: jest.fn(), findOne: jest.fn(), update: jest.fn() },
  Group: {},
  Game: {},
}));

jest.mock('../../services/googleCalendarService', () => ({
  createTentativeHold: jest.fn(),
  deleteTentativeHold: jest.fn(),
}));

const service = require('../../services/tentativeHoldService');
const {
  AvailabilitySuggestion,
  AvailabilityPrompt,
  User,
} = require('../../models');
const googleCalendarService = require('../../services/googleCalendarService');

const { deterministicHoldId } = service;

// ---- fixtures ------------------------------------------------------------

function makeSuggestion(overrides = {}) {
  const s = {
    id: 'sug-1',
    participant_user_ids: ['user-1', 'user-2'],
    suggested_start: new Date('2026-02-15T18:00:00Z'),
    suggested_end: new Date('2026-02-15T20:00:00Z'),
    tentative_calendar_event_ids: null,
    ...overrides,
  };
  // Mimic a Sequelize instance: update() mutates in place (so the service's
  // incremental spread `...suggestion.tentative_calendar_event_ids` accumulates).
  s.update = jest.fn(async (patch) => {
    Object.assign(s, patch);
    return s;
  });
  return s;
}

function makePrompt() {
  return { id: 'prompt-1', Group: { name: 'Board Gamers' }, Game: { name: 'Catan' } };
}

function makeUser(user_id) {
  return {
    user_id,
    google_calendar_token: `tok-${user_id}`,
    google_calendar_refresh_token: `ref-${user_id}`,
    timezone: 'UTC',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ---- (a) DETERMINISM -----------------------------------------------------

describe('deterministicHoldId', () => {
  test('is stable for the same (suggestion, user)', () => {
    const a = deterministicHoldId('sug-1', 'user-1');
    const b = deterministicHoldId('sug-1', 'user-1');
    expect(a).toBe(b);
  });

  test('differs across users and across suggestions', () => {
    expect(deterministicHoldId('sug-1', 'user-1')).not.toBe(deterministicHoldId('sug-1', 'user-2'));
    expect(deterministicHoldId('sug-1', 'user-1')).not.toBe(deterministicHoldId('sug-2', 'user-1'));
  });

  test('uses only GCal base32hex charset (0-9a-v) and satisfies GCal length rule', () => {
    const id = deterministicHoldId('sug-1', 'user-1');
    expect(id).toMatch(/^[0-9a-v]+$/);
    expect(id.length).toBeGreaterThanOrEqual(5);
    expect(id.length).toBeLessThanOrEqual(1024);
  });
});

// ---- (b) 409-AS-SUCCESS --------------------------------------------------

describe('createHoldsForTopSuggestions — 409 duplicate is success', () => {
  test('a _duplicate (409) result counts as a created hold, not a failure', async () => {
    const suggestion = makeSuggestion();
    AvailabilitySuggestion.findAll.mockResolvedValue([suggestion]);
    AvailabilityPrompt.findByPk.mockResolvedValue(makePrompt());
    User.findAll.mockResolvedValue([makeUser('user-1'), makeUser('user-2')]);

    // Simulate GCal returning the idempotent-success shape produced when a
    // duplicate client-supplied id triggers HTTP 409.
    googleCalendarService.createTentativeHold.mockImplementation(async (eventData) => ({
      id: eventData.id,
      _duplicate: true,
    }));

    const result = await service.createHoldsForTopSuggestions('prompt-1');

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(0);
    expect(result.suggestions[0].holdsCreated).toBe(2);
    expect(result.suggestions[0].holdsFailed).toBe(0);
  });

  test('a genuine (non-409) error still increments holdsFailed', async () => {
    const suggestion = makeSuggestion();
    AvailabilitySuggestion.findAll.mockResolvedValue([suggestion]);
    AvailabilityPrompt.findByPk.mockResolvedValue(makePrompt());
    User.findAll.mockResolvedValue([makeUser('user-1'), makeUser('user-2')]);

    googleCalendarService.createTentativeHold
      .mockResolvedValueOnce({ id: deterministicHoldId('sug-1', 'user-1') })
      .mockRejectedValueOnce(new Error('network down'));

    const result = await service.createHoldsForTopSuggestions('prompt-1');

    expect(result.suggestions[0].holdsCreated).toBe(1);
    expect(result.suggestions[0].holdsFailed).toBe(1);
  });
});

// ---- (c) INCREMENTAL PERSIST + no-orphan ---------------------------------

describe('createHoldsForTopSuggestions — incremental persist', () => {
  test('persists each deterministic id to the DB as it is created', async () => {
    const suggestion = makeSuggestion();
    AvailabilitySuggestion.findAll.mockResolvedValue([suggestion]);
    AvailabilityPrompt.findByPk.mockResolvedValue(makePrompt());
    User.findAll.mockResolvedValue([makeUser('user-1'), makeUser('user-2')]);

    googleCalendarService.createTentativeHold.mockImplementation(async (eventData) => ({
      id: eventData.id,
    }));

    await service.createHoldsForTopSuggestions('prompt-1');

    // One incremental update per hold (2 users) — persistence happens INSIDE the loop.
    expect(suggestion.update).toHaveBeenCalledTimes(2);

    const id1 = deterministicHoldId('sug-1', 'user-1');
    const id2 = deterministicHoldId('sug-1', 'user-2');

    // First write carries user-1's id...
    expect(suggestion.update.mock.calls[0][0]).toEqual({
      tentative_calendar_event_ids: { 'user-1': id1 },
    });
    // ...and the second write ACCUMULATES both (spread of the prior state).
    expect(suggestion.update.mock.calls[1][0]).toEqual({
      tentative_calendar_event_ids: { 'user-1': id1, 'user-2': id2 },
    });

    // Final persisted map holds both deterministic ids.
    expect(suggestion.tentative_calendar_event_ids).toEqual({ 'user-1': id1, 'user-2': id2 });
  });
});

describe('cleanupHoldsOnEventCreation — recompute backstop (no orphans)', () => {
  test('recomputes deterministic ids for participants missing from the stored map', async () => {
    // Simulate a crash BEFORE any id was persisted: stored map empty, but the
    // holds exist on GCal under their deterministic ids.
    const suggestion = makeSuggestion({ tentative_calendar_event_ids: null });
    AvailabilitySuggestion.findAll.mockResolvedValue([suggestion]);
    User.findOne.mockImplementation(async ({ where }) => makeUser(where.user_id));
    googleCalendarService.deleteTentativeHold.mockResolvedValue(true);

    const result = await service.cleanupHoldsOnEventCreation('sug-1', 'prompt-1');

    // Cleanup must attempt to reap BOTH participants using recomputed ids.
    const deletedIds = googleCalendarService.deleteTentativeHold.mock.calls.map((c) => c[0]);
    expect(deletedIds).toContain(deterministicHoldId('sug-1', 'user-1'));
    expect(deletedIds).toContain(deterministicHoldId('sug-1', 'user-2'));
    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(0);
  });
});
