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

const { handleJobFailed } = require('../../workers/promptWorker');

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
