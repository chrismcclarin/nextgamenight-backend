// tests/workers/promptWorker.softDelete.test.js
// Phase 88.2 plan 04 Task 3 (F-A3): REAL-DB proof that a backlogged prompt job
// for a soft-deleted group is a CLEAN SKIP — it does not throw, sends no email,
// and leaves ZERO AvailabilityPrompt rows for that group at ANY status.
//
// Why this file exists rather than the tests living in promptWorker.test.js
// (which the plan named): that file `jest.mock('../../models')` wholesale — every
// model is a bare `{}` and there is no Postgres behind it, so the load-bearing
// assertion ("zero rows exist for that group at any status") is unwritable there.
// The call-grain half (the guard fires, AvailabilityPrompt.create is never
// reached) DOES live in promptWorker.test.js; this file carries the row readback.
// Same split plan 03 used for the F-02 paranoid readbacks.
//
// The guard is PRE-CREATE by design: all three sibling skip branches
// (schedule_deleted / schedule_inactive / duplicate_week) return before
// AvailabilityPrompt.create, so there is no orphan row to dispose of. That is
// exactly what "zero rows at any status" pins — a post-create guard would leave a
// `pending` row behind and fail this suite.
//
// Real models against the sync'd test Postgres; only bullmq/ioredis (so requiring
// the worker never boots Redis), reminderService, emailService.send and
// magicTokenService are mocked — mirroring promptWorker.selectedMembers.test.js.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

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

jest.mock('../../services/reminderService', () => ({
  scheduleReminders: jest.fn().mockResolvedValue({ scheduled: false }),
  scheduleDeadlineJob: jest.fn().mockResolvedValue({ scheduled: false }),
}));

jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  return actual;
});

jest.mock('../../services/magicTokenService', () => ({
  generateToken: jest.fn().mockResolvedValue('fake-magic-token'),
}));

const { processPromptJob } = require('../../workers/promptWorker');
const emailService = require('../../services/emailService');
const { GroupPromptSettings, AvailabilityPrompt, Group, UserGroup, Event } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

async function seedGroupWithSchedule() {
  const group = await makeGroup();
  const m1 = await makeUser();
  const m2 = await makeUser();
  await addToGroup(m1, group, 'owner');
  await addToGroup(m2, group, 'member');

  const scheduleId = `sched-fa3-${group.id}`;
  const settings = await GroupPromptSettings.create({
    group_id: group.id,
    schedule_timezone: 'UTC',
    template_config: {
      schedules: [{ id: scheduleId, is_active: true, game_id: null }],
    },
  });

  return { group, m1, m2, settings, scheduleId };
}

const makeJob = ({ group, settings, scheduleId }) => ({
  id: `job-fa3-${group.id}`,
  data: { groupId: group.id, settingsId: settings.id, scheduleId, deadlineMinutes: 60 },
});

// Stamp Group + UserGroup + Event with ONE shared timestamp — the phase-wide
// discipline that plan 07's stamp-matched restore depends on.
async function softDeleteGroup(group) {
  const deletedAt = new Date();
  await Group.update({ deletedAt }, { where: { id: group.id }, silent: true });
  await UserGroup.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
  await Event.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
  return deletedAt;
}

describe('promptWorker.processPromptJob — soft-deleted group (88.2 F-A3, real DB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
  });

  it('a backlogged job for a soft-deleted group does NOT throw and returns { skipped: true, reason: group_not_found }', async () => {
    const seed = await seedGroupWithSchedule();
    await softDeleteGroup(seed.group);

    // Without the guard this threw a TypeError per recipient (group.name on null).
    const result = await processPromptJob(makeJob(seed));

    expect(result).toEqual(expect.objectContaining({ skipped: true, reason: 'group_not_found' }));
  });

  it('sends ZERO emails for a soft-deleted group', async () => {
    const seed = await seedGroupWithSchedule();
    await softDeleteGroup(seed.group);

    await processPromptJob(makeJob(seed));

    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('leaves ZERO AvailabilityPrompt rows for that group at ANY status (the guard is pre-create, so no orphan is created)', async () => {
    const seed = await seedGroupWithSchedule();
    await softDeleteGroup(seed.group);

    await processPromptJob(makeJob(seed));

    // Deliberately unfiltered by status: a post-create guard would leave a
    // 'pending' row here, and an unguarded worker would leave an 'active' one
    // bound to a group that no longer exists.
    const all = await AvailabilityPrompt.findAll({ where: { group_id: seed.group.id } });
    expect(all).toHaveLength(0);

    for (const status of ['pending', 'active', 'closed']) {
      const n = await AvailabilityPrompt.count({ where: { group_id: seed.group.id, status } });
      expect(n).toBe(0);
    }
  });

  it('(non-regression) a LIVE group still creates its prompt and reaches the send loop — the relocated lookup did not break the happy path', async () => {
    const seed = await seedGroupWithSchedule();

    const result = await processPromptJob(makeJob(seed));

    expect(result.skipped).toBeUndefined();
    expect(result.promptId).toBeTruthy();
    expect(result.recipientCount).toBe(2);
    expect(emailService.send).toHaveBeenCalledTimes(2);

    const prompt = await AvailabilityPrompt.findByPk(result.promptId);
    expect(prompt).not.toBeNull();
    expect(prompt.status).toBe('active');
    expect(prompt.group_id).toBe(seed.group.id);
  });
});
