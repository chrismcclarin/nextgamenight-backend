// tests/services/promptLifecycleService.idempotency.test.js
// Phase 87 / Plan 05 (BINT-01, T-87-11): REAL-DB double-close idempotency.
//
// The double-close guard is the atomic conditional UPDATE
// (`AvailabilityPrompt.update({status:'closed'}, { where:{ status notIn
// [closed,converted] }, returning:true })`) — enforced by Postgres, NOT by JS.
// A mocked model proves nothing (a stale in-memory status check would pass
// vacuously), so this suite runs against the sync'd Postgres test DB with the
// tests/routes/* real-DB pattern: REAL models, ONLY emailService.send mocked
// (to count sends). heatmapService.aggregateResponses is stubbed to a no-op so
// the seeded top-slot survives (it otherwise destroys+recreates suggestions);
// the suggestion algorithm is not what's under test here — the atomic prompt
// claim is.
//
// This test FAILS against a naive check-then-update close (the second call would
// re-send because its in-memory status was read before the first close
// committed) and PASSES against the atomic claim.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Only emailService.send is mocked (count sends); generatePollClosedEmailTemplate
// stays real. emailService is a class instance — override send on the instance.
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  return actual;
});

// Stub the aggregation so the seeded AvailabilitySuggestion survives the close
// (aggregateResponses destroys+recreates suggestions from raw responses).
jest.mock('../../services/heatmapService', () => ({
  aggregateResponses: jest.fn().mockResolvedValue(undefined),
}));

const lifecycleService = require('../../services/promptLifecycleService');
const emailService = require('../../services/emailService');
const {
  AvailabilityPrompt,
  AvailabilityResponse,
  AvailabilitySuggestion,
  UserGroup,
  Group,
  User,
} = require('../../models');

const CREATOR_SUB = 'auth0|prompt-close-idem-creator';

async function seedConsensusPrompt() {
  const creator = await User.create({
    user_id: CREATOR_SUB,
    username: 'Close Creator',
    email: 'close-idem@test.com',
    email_notifications_enabled: true,
  });
  const group = await Group.create({ name: 'Close Idem Group', group_id: 'close-idem-group-001' });
  // Single active member so consensus = 1 responded >= 1 active.
  // Phase 87.1 seed cutover: DUAL-WRITE user_uuid (Users.id) alongside the old
  // Auth0-string user_id so the re-keyed UserGroup queries resolve post-Plan-09.
  await UserGroup.create({
    user_id: CREATOR_SUB,
    user_uuid: creator.id,
    group_id: group.id,
    role: 'owner',
    status: 'active',
  });
  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    created_by_user_id: creator.id, // manual poll → recipient = creator
    status: 'active',
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
    week_identifier: '2026-W27',
  });
  // A submitted response → respondedCount 1 (consensus reached).
  // Phase 87.5 rekey: AvailabilityResponse is keyed on user_uuid (NOT NULL as of
  // Plan 01; the legacy user_id attribute is dropped in Plan 07). Caught by PR-1
  // CI — this suite was outside the availability "run alone" list, so the seed
  // was never re-pointed with the others.
  await AvailabilityResponse.create({
    prompt_id: prompt.id,
    user_uuid: creator.id,
    time_slots: [{ start: '2026-07-10T18:00:00Z', end: '2026-07-10T21:00:00Z', preference: 'preferred' }],
    user_timezone: 'UTC',
    submitted_at: new Date(),
  });
  // A viable top slot so handlePromptClosed sends (it re-reads suggestions).
  await AvailabilitySuggestion.create({
    prompt_id: prompt.id,
    suggested_start: new Date('2026-07-10T18:00:00Z'),
    suggested_end: new Date('2026-07-10T21:00:00Z'),
    participant_count: 1,
    participant_user_ids: [CREATOR_SUB],
    preferred_count: 1,
    meets_minimum: true,
    score: 5,
  });
  return prompt;
}

describe('promptLifecycleService double-close idempotency (BINT-01 / T-87-11, real DB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
  });

  it('two checkConsensusAndClose invocations fire exactly ONE close email; 2nd claims 0 rows', async () => {
    const prompt = await seedConsensusPrompt();

    const first = await lifecycleService.checkConsensusAndClose(prompt.id);
    const second = await lifecycleService.checkConsensusAndClose(prompt.id);

    // Exactly one close-notification email across both invocations.
    expect(emailService.send).toHaveBeenCalledTimes(1);

    // First won the atomic claim and closed the prompt.
    expect(first.closed).toBe(true);

    // Second lost the claim (0 rows) — reported already_closed, no re-send.
    expect(second.closed).toBe(false);
    expect(second.reason).toBe('already_closed');

    // The row is closed in the DB (true state, not spied).
    const row = await AvailabilityPrompt.findByPk(prompt.id);
    expect(row.status).toBe('closed');
  });

  it('concurrent double-close (Promise.all) still fires exactly ONE email', async () => {
    // Both callers pass the consensus gate simultaneously; only the caller whose
    // UPDATE flips the row wins the claim and sends. This is the case a naive
    // check-then-update fails.
    const prompt = await seedConsensusPrompt();

    const [a, b] = await Promise.all([
      lifecycleService.checkConsensusAndClose(prompt.id),
      lifecycleService.checkConsensusAndClose(prompt.id),
    ]);

    expect(emailService.send).toHaveBeenCalledTimes(1);
    // Exactly one caller reports closed=true; the other already_closed.
    const closedFlags = [a.closed, b.closed];
    expect(closedFlags.filter(Boolean)).toHaveLength(1);

    const row = await AvailabilityPrompt.findByPk(prompt.id);
    expect(row.status).toBe('closed');
  });
});
