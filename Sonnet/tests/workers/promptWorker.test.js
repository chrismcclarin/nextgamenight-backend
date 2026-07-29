// tests/workers/promptWorker.test.js
// Phase 85 / Plan 05 (BAPI-02): tests for promptWorker's exported
// handleJobFailed escalation handler in isolation.
//
// Strategy: the worker file exports handleJobFailed so we can invoke it
// directly with a mock job + error — no Redis, no BullMQ runtime, no DB.
// We mock bullmq + ioredis so requiring the worker never connects, mock
// @sentry/node to assert the tagged capture, and mock the worker's
// model/service requires so module load has no DB side effects.

// ---------------------------------------------------------------------------
// Mocks BEFORE requiring the worker
// ---------------------------------------------------------------------------

// Don't actually boot Redis / BullMQ Worker.
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

// Mock the worker's model/service requires so module load has no DB side effects.
jest.mock('../../models', () => ({
  AvailabilityPrompt: {},
  Group: {},
  GroupPromptSettings: {},
  UserGroup: {},
  User: { scope: jest.fn() },
  Game: {},
}));
jest.mock('../../services/magicTokenService', () => ({ generateToken: jest.fn() }));
jest.mock('../../services/emailService', () => ({ send: jest.fn() }));
jest.mock('../../services/reminderService', () => ({
  scheduleReminders: jest.fn(),
  scheduleDeadlineJob: jest.fn(),
}));

// Mock @sentry/node for capture assertions.
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCaptureException(...args),
  metrics: { count: jest.fn(), distribution: jest.fn() },
}), { virtual: true });

// Force the worker file to require @sentry/node (otherwise it gates on SENTRY_DSN).
process.env.SENTRY_DSN = 'https://fake@sentry.io/123';

const { handleJobFailed, processPromptJob } = require('../../workers/promptWorker');
const models = require('../../models');
const emailService = require('../../services/emailService');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('promptWorker.handleJobFailed (Phase 85 / Plan 05, BAPI-02)', () => {
  test('escalates a failed job to Sentry with worker:prompt + job_id tags', () => {
    const err = new Error('boom');
    const job = { id: 'job-1', data: { groupId: 'g-1' } };

    handleJobFailed(job, err);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ worker: 'prompt', job_id: 'job-1' }),
      })
    );
  });

  test('does not throw when job is undefined (still captures)', () => {
    const err = new Error('no-job-context');

    expect(() => handleJobFailed(undefined, err)).not.toThrow();
    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ worker: 'prompt' }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 88.2 plan 04 Task 3 (F-A3) — CALL-GRAIN half.
//
// This file mocks the entire model layer (see the jest.mock preamble above), so
// there is no Postgres and no row to read back. What it CAN prove — and what the
// pre-create placement of the guard is really about — is that
// AvailabilityPrompt.create is never REACHED when the group is gone. The real
// "zero rows at any status" readback lives in
// tests/workers/promptWorker.softDelete.test.js, which runs real models against
// the test database. Do not "upgrade" the assertions below into row reads; this
// file cannot support them.
// ---------------------------------------------------------------------------
describe('promptWorker.processPromptJob — F-A3 group liveness guard (88.2, call-grain)', () => {
  const scheduleId = 'sched-fa3-mocked';
  const groupId = 'group-fa3-mocked';

  beforeEach(() => {
    jest.clearAllMocks();

    models.GroupPromptSettings.findByPk = jest.fn().mockResolvedValue({
      id: 'settings-1',
      default_token_expiry_hours: 168,
      template_config: { schedules: [{ id: scheduleId, is_active: true, game_id: null }] },
    });
    models.AvailabilityPrompt.findOne = jest.fn().mockResolvedValue(null);
    models.AvailabilityPrompt.create = jest.fn();
    models.UserGroup.findAll = jest.fn().mockResolvedValue([]);
    models.Group.findByPk = jest.fn();
    models.User.scope = jest.fn().mockReturnValue({});
    emailService.send = jest.fn().mockResolvedValue({ success: true });
  });

  const job = () => ({ id: 'job-fa3', data: { groupId, settingsId: 'settings-1', scheduleId } });

  test('returns { skipped: true, reason: group_not_found } without throwing when Group.findByPk resolves null', async () => {
    models.Group.findByPk.mockResolvedValue(null);

    await expect(processPromptJob(job())).resolves.toEqual(
      expect.objectContaining({ skipped: true, reason: 'group_not_found' })
    );
  });

  test('never REACHES AvailabilityPrompt.create for a missing group — this is what makes the guard pre-create', async () => {
    models.Group.findByPk.mockResolvedValue(null);

    await processPromptJob(job());

    expect(models.AvailabilityPrompt.create).not.toHaveBeenCalled();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  test('the guard runs BEFORE the duplicate-week dedup lookup, so a dead group short-circuits earliest', async () => {
    models.Group.findByPk.mockResolvedValue(null);

    await processPromptJob(job());

    // Ordering pin: relocating the lookup back below the create (its pre-88.2
    // position) would make this dedup query run first and would let the create
    // through — the orphan-row path this guard exists to remove.
    expect(models.AvailabilityPrompt.findOne).not.toHaveBeenCalled();
  });
});
