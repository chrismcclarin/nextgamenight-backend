// tests/services/eventCreationService.test.js
// Phase 88.2 plan 04 Task 6 (MED #6): convertSuggestionToEvent must REFUSE to
// convert a suggestion whose group has been soft-deleted.
//
// Neither AvailabilitySuggestion nor AvailabilityPrompt is paranoid (D-01 makes
// only Group / UserGroup / Event paranoid), so a group soft-delete leaves both
// rows untouched and a backlogged conversion still runs. Group IS paranoid, and
// the include is a LEFT JOIN, so the prompt returns with `Group === null`.
//
// Two harms this pins:
//   1. A contradictory confirmation email to members who were just told the group
//      was deleted, with the group name degraded to the literal 'Your Group'.
//   2. THE NON-OBVIOUS ONE — a LIVE, UNSTAMPED Event row on a hidden group. It
//      does not match plan 07's Event.restore({ where: { group_id, deletedAt:
//      stamp } }), so a restored group would gain an event that did not exist
//      before the delete, breaking SPEC-REQ-9's row-set equality. Task 3's wire
//      sweep cannot see it — Task 2's INNER JOINs make it invisible during the
//      window — so this suite is the only thing that catches it.
//
// Real models against the test Postgres; only emailService.send and the
// tentative-hold cleanup (post-commit, fire-and-forget) are mocked.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  actual.isConfigured = jest.fn().mockReturnValue(true);
  return actual;
});

jest.mock('../../services/tentativeHoldService', () => ({
  cleanupHoldsOnEventCreation: jest.fn().mockResolvedValue({ cleaned: 0 }),
}));

const eventCreationService = require('../../services/eventCreationService');
const emailService = require('../../services/emailService');
const {
  AvailabilityPrompt,
  AvailabilitySuggestion,
  Event,
  Group,
  UserGroup,
  Game,
} = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

async function seedConvertibleSuggestion() {
  const group = await makeGroup();
  const owner = await makeUser();
  const member = await makeUser();
  await addToGroup(owner, group, 'owner');
  await addToGroup(member, group, 'member');

  const game = await Game.create({ name: 'MED6 Game', is_custom: true });

  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    game_id: game.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 3600000),
    status: 'active',
    week_identifier: `med6-${group.id}`,
  });

  const start = new Date(Date.now() + 86400000);
  const end = new Date(start.getTime() + 7200000);
  const suggestion = await AvailabilitySuggestion.create({
    prompt_id: prompt.id,
    suggested_start: start,
    suggested_end: end,
    participant_user_ids: [owner.id, member.id],
    participant_count: 2,
    preferred_count: 2,
    meets_minimum: true,
    score: 1.0,
  });

  return { group, owner, member, game, prompt, suggestion };
}

// Stamp Group + UserGroup + Event with ONE shared timestamp — the phase-wide
// discipline plan 07's stamp-matched restore depends on.
async function softDeleteGroup(group) {
  const deletedAt = new Date();
  await Group.update({ deletedAt }, { where: { id: group.id }, silent: true });
  await UserGroup.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
  await Event.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
  return deletedAt;
}

describe('eventCreationService.convertSuggestionToEvent — soft-deleted group (88.2 MED-6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
  });

  it('returns { success: false, message: group_not_found } for a soft-deleted group', async () => {
    const seed = await seedConvertibleSuggestion();
    await softDeleteGroup(seed.group);

    const result = await eventCreationService.convertSuggestionToEvent(
      seed.suggestion.id,
      seed.owner.user_id
    );

    expect(result.success).toBe(false);
    expect(result.message).toBe('group_not_found');
    expect(result.event_id).toBeUndefined();
  });

  it('creates ZERO Event rows for the hidden group — read with { paranoid: false }, so an UNSTAMPED live row cannot hide from this assertion', async () => {
    const seed = await seedConvertibleSuggestion();
    await softDeleteGroup(seed.group);

    await eventCreationService.convertSuggestionToEvent(seed.suggestion.id, seed.owner.user_id);

    // paranoid: false is load-bearing here. The row this guard prevents would be
    // LIVE and UNSTAMPED — invisible to a default read only if it were stamped,
    // which is exactly what it would NOT be.
    const events = await Event.findAll({
      where: { group_id: seed.group.id },
      paranoid: false,
    });
    expect(events).toHaveLength(0);
  });

  it('attempts NO confirmation email for a soft-deleted group', async () => {
    const seed = await seedConvertibleSuggestion();
    await softDeleteGroup(seed.group);

    await eventCreationService.convertSuggestionToEvent(seed.suggestion.id, seed.owner.user_id);

    // Members were just told the group was deleted; a game-night confirmation
    // naming 'Your Group' would land inside the exact window SPEC-REQ-8 exists to
    // make clear.
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('leaves the suggestion UNCONVERTED and the prompt status untouched (the transaction rolled back)', async () => {
    const seed = await seedConvertibleSuggestion();
    await softDeleteGroup(seed.group);

    await eventCreationService.convertSuggestionToEvent(seed.suggestion.id, seed.owner.user_id);

    const s = await AvailabilitySuggestion.findByPk(seed.suggestion.id);
    expect(s.converted_to_event_id).toBeNull();
    const p = await AvailabilityPrompt.findByPk(seed.prompt.id);
    expect(p.status).not.toBe('converted');
  });

  it('(non-regression) a LIVE group still converts, creates its Event, and reaches the send path', async () => {
    const seed = await seedConvertibleSuggestion();

    const result = await eventCreationService.convertSuggestionToEvent(
      seed.suggestion.id,
      seed.owner.user_id
    );

    expect(result.success).toBe(true);
    expect(result.event_id).toBeTruthy();

    const events = await Event.findAll({ where: { group_id: seed.group.id } });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(result.event_id);

    const s = await AvailabilitySuggestion.findByPk(seed.suggestion.id);
    expect(s.converted_to_event_id).toBe(result.event_id);
  });
});
