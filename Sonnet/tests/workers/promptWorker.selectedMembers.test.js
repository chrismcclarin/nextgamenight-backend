// tests/workers/promptWorker.selectedMembers.test.js
// Phase 87.1 / Plan 08 (BINT-02, A1, Pitfall 4): REAL-DB proof that the
// promptWorker's selected_member_ids subset still emails EXACTLY those members
// after the UserGroup re-key.
//
// A1 (VERIFIED): schedule.selected_member_ids stores Auth0 user_id STRINGS. The
// old worker keyed `UserGroup.user_id = selectedMemberIds`. Once UserGroup is
// re-keyed onto the user_uuid UUID FK (Plan 03) that string filter silently
// matches NOBODY — a selected-subset schedule would prompt zero members with NO
// loud error. The fix scopes the subset through the User include's Auth0-string
// user_id while the UserGroup->User join runs on user_uuid.
//
// This suite runs against the sync'd Postgres test DB with REAL models — only
// bullmq/ioredis (so requiring the worker never boots Redis), reminderService
// (Redis-backed job scheduling), emailService.send, and magicTokenService are
// mocked. The UserGroup->User include join is therefore exercised for real; a
// mock could not catch the silent-nobody regression.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Don't boot Redis / the BullMQ Worker when requiring the worker module.
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(function () {
    this.on = jest.fn();
    this.close = jest.fn().mockResolvedValue();
  }),
}));
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  disconnect: jest.fn(),
})));

// reminderService schedules Redis-backed jobs post-send — no-op it here.
jest.mock('../../services/reminderService', () => ({
  scheduleReminders: jest.fn().mockResolvedValue({ scheduled: false }),
  scheduleDeadlineJob: jest.fn().mockResolvedValue({ scheduled: false }),
}));

// emailService is a class instance — override send on the instance, keep the
// rest real (the HTML builder is inert here since we only assert recipients).
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  return actual;
});

// Avoid MAGIC_TOKEN_SECRET requirement + a MagicToken DB write.
jest.mock('../../services/magicTokenService', () => ({
  generateToken: jest.fn().mockResolvedValue('fake-magic-token'),
}));

const { processPromptJob } = require('../../workers/promptWorker');
const emailService = require('../../services/emailService');
const { GroupPromptSettings, AvailabilityPrompt } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');
// PR-2: the fanout contracts to a UUID-shape-filtered `id [Op.in]` clause using this
// same isUuid predicate — a sub-shaped selected_member_ids entry fails isUuid and is
// dropped before the query (never compared against the UUID id column).
const { isUuid } = require('../../utils/resolveTargetUser');

function sentToAddresses() {
  return emailService.send.mock.calls.map((call) => call[0].to).sort();
}

// pickSubset(m1, m2, m3) -> array of Auth0 user_id STRINGS (or null/[] for "all").
async function seedGroupWithSchedule(pickSubset) {
  const group = await makeGroup();
  // Three active members. addToGroup DUAL-WRITES user_uuid so the include join
  // (UserGroup -> User on user_uuid) resolves each member's User row.
  const m1 = await makeUser();
  const m2 = await makeUser();
  const m3 = await makeUser();
  await addToGroup(m1, group, 'member');
  await addToGroup(m2, group, 'member');
  await addToGroup(m3, group, 'member');

  const selectedMemberIds = pickSubset ? pickSubset(m1, m2, m3) : undefined;
  const scheduleId = `sched-${group.id}`;
  const settings = await GroupPromptSettings.create({
    group_id: group.id,
    schedule_timezone: 'UTC',
    template_config: {
      schedules: [{
        id: scheduleId,
        is_active: true,
        game_id: null,
        // selected_member_ids stores Auth0 user_id STRINGS (A1).
        selected_member_ids: selectedMemberIds,
      }],
    },
  });

  return { group, m1, m2, m3, settings, scheduleId };
}

function makeJob({ group, settings, scheduleId }) {
  return {
    id: `job-${group.id}`,
    data: {
      groupId: group.id,
      settingsId: settings.id,
      scheduleId,
      deadlineMinutes: 60,
    },
  };
}

describe('promptWorker.processPromptJob — selected_member_ids subset (87.1 A1, Pitfall 4, real DB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
  });

  // Phase 87.4 Plan 04 (D-11 case 1) / PR-2: UUID-keyed selected_member_ids (the
  // post-backfill, post-contract shape) emails EXACTLY those members via the fanout's
  // UUID-shape-filtered `id [Op.in]` clause.
  it('D-11 case 1: a UUID-keyed selected_member_ids subset (Users.id) emails EXACTLY those members', async () => {
    // Subset = m1, m2 (NOT m3), keyed by their Users.id UUIDs (post-backfill shape).
    const { group, m1, m2, m3, settings, scheduleId } =
      await seedGroupWithSchedule((a, b) => [a.id, b.id]);
    // These entries are UUID-shaped, so the contract's isUuid filter keeps them.
    expect(isUuid(m1.id) && isUuid(m2.id)).toBe(true);

    const result = await processPromptJob(makeJob({ group, settings, scheduleId }));

    expect(result.recipientCount).toBe(2);
    expect(sentToAddresses()).toEqual([m1.email, m2.email].sort());
    expect(sentToAddresses()).not.toContain(m3.email);

    const prompt = await AvailabilityPrompt.findByPk(result.promptId);
    expect(prompt).not.toBeNull();
    expect(prompt.status).toBe('active');
  });

  // PR-2 contract (Plan 11): the fanout is now a UUID-shape-filtered `id [Op.in]`
  // clause — the dual-read window is CLOSED. A legacy sub-keyed selected_member_ids
  // row is filtered out by isUuid BEFORE the query runs, so those members are silently
  // EXCLUDED (no delivery), and the query never sees a sub-shaped value (no Postgres
  // 22P02, no thrown/caught error).
  //
  // HISTORICAL: 87.1/PR-1 proved a sub-keyed subset STILL delivered during the D-07
  // dual-read window (the `[Op.or]` `user_id IN (...)` arm). PR-2 contracted the fanout
  // to the UUID shape filter after the Plan 04 backfill converted real rows to UUID, so
  // a raw sub row is now stale and is dropped rather than crashing the query.
  //
  // This ALSO proves the whole-group guard reads the ORIGINAL unfiltered array: the
  // seeded array is entirely sub-shaped (non-empty original), so the job still takes the
  // selected-members branch and matches NOBODY — it does NOT fall back to the whole
  // group (which would wrongly email all 3).
  it('PR-2: a legacy all-sub selected_member_ids row is silently EXCLUDED (matches nobody, NOT the whole group)', async () => {
    // Subset = m1, m2 keyed by their (now-stale) Auth0 user_id STRINGS.
    const { group, m3, settings, scheduleId } =
      await seedGroupWithSchedule((a, b) => [a.user_id, b.user_id]);

    const result = await processPromptJob(makeJob({ group, settings, scheduleId }));

    // Nobody is emailed — the sub-shaped entries are filtered out before the query,
    // and the whole-group guard (original non-empty array) keeps us in the
    // selected-members branch, matching nobody rather than the whole group.
    expect(result.recipientCount).toBe(0);
    expect(sentToAddresses()).toEqual([]);
    expect(sentToAddresses()).not.toContain(m3.email);

    // Sanity: the prompt row still persisted and went active (the fanout completed
    // normally — no thrown error).
    const prompt = await AvailabilityPrompt.findByPk(result.promptId);
    expect(prompt).not.toBeNull();
    expect(prompt.status).toBe('active');
  });

  // PR-2 contract: a MIXED array (one UUID + one stale sub) delivers to ONLY the
  // UUID-shaped member — the sub entry is dropped by the shape filter, proving the
  // filter operates per-entry and the query completes without a 22P02.
  it('PR-2: a mixed UUID+sub selected_member_ids row delivers to ONLY the UUID member', async () => {
    // m1 keyed by UUID (valid), m2 keyed by stale sub (dropped).
    const { m1, m2, m3, group, settings, scheduleId } =
      await seedGroupWithSchedule((a, b) => [a.id, b.user_id]);

    const result = await processPromptJob(makeJob({ group, settings, scheduleId }));

    expect(result.recipientCount).toBe(1);
    expect(sentToAddresses()).toEqual([m1.email]);
    expect(sentToAddresses()).not.toContain(m2.email);
    expect(sentToAddresses()).not.toContain(m3.email);
  });

  // D-11 case 3: empty/null selected_member_ids preserves the whole-active-group default.
  it('D-11 case 3: no selected_member_ids (subset absent) emails the WHOLE active group', async () => {
    const { group, m1, m2, m3, settings, scheduleId } = await seedGroupWithSchedule(null);

    const result = await processPromptJob(makeJob({ group, settings, scheduleId }));

    expect(result.recipientCount).toBe(3);
    expect(sentToAddresses()).toEqual([m1.email, m2.email, m3.email].sort());
  });
});
