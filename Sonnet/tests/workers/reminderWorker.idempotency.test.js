// tests/workers/reminderWorker.idempotency.test.js
// Phase 87 / Plan 05 (BINT-01, T-87-12): REAL-DB same-reminder double-send
// idempotency for the extracted processReminderJob handler.
//
// The guard under test is the expected-prior-value claim
// (`AvailabilityResponse.update({reminder_count: :expected}, { where:{
// reminder_count: :expected-1 }})`) performed BEFORE emailService.send — a
// Postgres-enforced atomic claim, NOT a JS check. A mocked model proves nothing
// (a cumulative `< MAX` increment would double-send 0→1→2 on a same-job retry
// and a mock can't catch that), so this suite runs against the sync'd Postgres
// test DB with REAL models. Only infra + non-DB helpers are mocked:
//   - bullmq.Worker / ioredis  → so requiring the worker never boots Redis
//   - emailService.send         → count sends
//   - magicTokenService.generateToken → avoid MAGIC_TOKEN_SECRET + a MagicToken write
// notificationService.getPreference is REAL (pure preference logic; seeded users
// have null prefs → reminder.email defaults true).
//
// Each test double-invokes processReminderJob for the SAME reminder (a same-job
// BullMQ retry) and asserts exactly ONE send + reminder_count never exceeds
// MAX(2). These FAIL against a cumulative `< MAX` increment and PASS against the
// expected-prior-value claim.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Do NOT boot Redis / BullMQ Worker on require.
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

// Count sends; do not reach Resend.
jest.mock('../../services/emailService', () => ({ send: jest.fn().mockResolvedValue({ success: true }) }));
// Avoid MAGIC_TOKEN_SECRET requirement + a MagicToken DB write.
jest.mock('../../services/magicTokenService', () => ({
  generateToken: jest.fn().mockResolvedValue('fake-magic-token'),
}));

const { processReminderJob } = require('../../workers/reminderWorker');
const emailService = require('../../services/emailService');
const {
  AvailabilityPrompt,
  AvailabilityResponse,
  UserGroup,
  Group,
  User,
} = require('../../models');

const USER_SUB = 'auth0|reminder-idem-user';

async function seedActivePromptAndMember() {
  const user = await User.create({
    user_id: USER_SUB,
    username: 'Reminder User',
    email: 'reminder-user@test.com',
    email_notifications_enabled: true,
  });
  const group = await Group.create({ name: 'Reminder Idem Group', group_id: 'reminder-idem-group-001' });
  await UserGroup.create({
    user_id: USER_SUB,
    group_id: group.id,
    role: 'member',
    status: 'active',
  });
  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    status: 'active',
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
    week_identifier: '2026-W27',
  });
  return { user, group, prompt };
}

function jobFor(promptId, reminderType, groupId) {
  return { id: `job-${reminderType}`, data: { promptId, reminderType, groupId } };
}

async function reminderRow(promptId) {
  return AvailabilityResponse.findOne({ where: { prompt_id: promptId, user_id: USER_SUB } });
}

describe('reminderWorker.processReminderJob same-reminder idempotency (BINT-01 / T-87-12, real DB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
  });

  it('50-percent, row at 0: two invocations → exactly ONE send, reminder_count → 1', async () => {
    const { group, prompt } = await seedActivePromptAndMember();
    // Seed a not-yet-submitted placeholder at reminder_count 0.
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_id: USER_SUB,
      time_slots: [],
      user_timezone: 'UTC',
      submitted_at: null,
      reminder_count: 0,
    });

    const job = jobFor(prompt.id, '50-percent', group.id);
    await processReminderJob(job);
    await processReminderJob(job); // same-job retry

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const row = await reminderRow(prompt.id);
    expect(row.reminder_count).toBe(1);
  });

  it('90-percent, row at 1: two invocations → exactly ONE send, reminder_count → 2 (<= MAX)', async () => {
    const { group, prompt } = await seedActivePromptAndMember();
    // Row already advanced past the 50% reminder.
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_id: USER_SUB,
      time_slots: [],
      user_timezone: 'UTC',
      submitted_at: null,
      reminder_count: 1,
    });

    const job = jobFor(prompt.id, '90-percent', group.id);
    await processReminderJob(job);
    await processReminderJob(job); // same-job retry

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const row = await reminderRow(prompt.id);
    expect(row.reminder_count).toBe(2);
    expect(row.reminder_count).toBeLessThanOrEqual(2);
  });

  it('90-percent, NO prior row: two invocations → exactly ONE send, placeholder lands at 2', async () => {
    const { group, prompt } = await seedActivePromptAndMember();
    // No AvailabilityResponse row exists — user first-eligible only at 90%.

    const job = jobFor(prompt.id, '90-percent', group.id);
    await processReminderJob(job);
    await processReminderJob(job); // same-job retry

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const row = await reminderRow(prompt.id);
    expect(row).not.toBeNull();
    // Placeholder created AT the 90% expected value (2), NOT 1 — so the retry
    // re-finds the row at MAX and never double-sends.
    expect(row.reminder_count).toBe(2);
  });

  // Phase 87 (adversarial review #2): a genuine non-responder can have a row
  // stuck at reminder_count 0 (the admin manual-remind endpoint seeds a
  // placeholder at the model default 0, and if the 50-percent job never
  // advanced that user, 90% is the first worker to reach it). The OLD
  // exact-prior-value claim (WHERE reminder_count = expected-1 = 1) matched 0
  // rows on a count-0 row → silently skipped the final reminder. The monotonic
  // `< expected` claim advances it 0→2 and sends exactly once, still MAX-safe.
  it('90-percent, row STUCK at 0: two invocations → exactly ONE send, reminder_count → 2', async () => {
    const { group, prompt } = await seedActivePromptAndMember();
    // Placeholder seeded at 0 (as the admin manual-remind route does) and never
    // advanced by the 50-percent job.
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_id: USER_SUB,
      time_slots: [],
      user_timezone: 'UTC',
      submitted_at: null,
      reminder_count: 0,
    });

    const job = jobFor(prompt.id, '90-percent', group.id);
    await processReminderJob(job);
    await processReminderJob(job); // same-job retry

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const row = await reminderRow(prompt.id);
    expect(row.reminder_count).toBe(2);
  });
});
