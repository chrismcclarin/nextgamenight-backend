// tests/workers/auth0CleanupWorker.test.js
// Phase 87.2 / Plan 03 (REQ-6, D-07): tests for the auth0-cleanup worker handler
// in isolation.
//
// Strategy: the worker file exports the pure handler `processAuth0CleanupJob` and
// the `handleJobFailed` exhaustion hook so we can invoke them directly with mocked
// deps — no Redis, no BullMQ runtime, no Auth0 Management API. The tests assert:
//   - success path: deleteUser(sub) then destroy the PendingAuth0Deletion marker
//   - failure path: deleteUser throws -> handler re-throws (BullMQ retries)
//   - exhausted (attemptsMade >= attempts=10) -> Sentry.captureException with the
//     exact D-07 tags { worker: 'auth0-cleanup', exhausted: 'true' }
//   - non-exhausted failure -> NO Sentry.captureException

// ---------------------------------------------------------------------------
// Mocks BEFORE requiring the worker
// ---------------------------------------------------------------------------
const mockDeleteUser = jest.fn();
jest.mock('../../services/auth0Service', () => ({
  deleteUser: (...args) => mockDeleteUser(...args),
}));

const mockPendingDestroy = jest.fn();
jest.mock('../../models', () => ({
  PendingAuth0Deletion: { destroy: (...args) => mockPendingDestroy(...args) },
}));

// Don't actually boot Redis / BullMQ Worker -- mock the bullmq Worker
// constructor to a no-op class. The handler is exported as a named export
// from the worker file, so we test it directly without invoking BullMQ.
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

// Mock @sentry/node for capture assertions.
const mockAddBreadcrumb = jest.fn();
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  addBreadcrumb: (...args) => mockAddBreadcrumb(...args),
  captureException: (...args) => mockCaptureException(...args),
}), { virtual: true });

// Force the worker file to require @sentry/node (otherwise it gates on SENTRY_DSN).
process.env.SENTRY_DSN = 'https://fake@sentry.io/123';

const { processAuth0CleanupJob, handleJobFailed } = require('../../workers/auth0CleanupWorker');

// Helper: build a fake job
function makeJob(data, opts = { attempts: 10 }, attemptsMade = 1) {
  return {
    id: 'job-1',
    data,
    opts,
    attemptsMade,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPendingDestroy.mockResolvedValue(1);
});

describe('auth0CleanupWorker.processAuth0CleanupJob (Phase 87.2 / Plan 03)', () => {
  test('success path — deletes Auth0 user then destroys the PendingAuth0Deletion marker', async () => {
    mockDeleteUser.mockResolvedValueOnce({ deleted: true });

    const job = makeJob({ sub: 'google-oauth2|123' });
    const result = await processAuth0CleanupJob(job);

    expect(mockDeleteUser).toHaveBeenCalledWith('google-oauth2|123');
    expect(mockPendingDestroy).toHaveBeenCalledWith({ where: { auth0_sub: 'google-oauth2|123' } });
    expect(result).toMatchObject({ ok: true, sub: 'google-oauth2|123' });
  });

  test('success path — idempotent alreadyGone still clears the marker', async () => {
    mockDeleteUser.mockResolvedValueOnce({ deleted: true, alreadyGone: true });

    const job = makeJob({ sub: 'auth0|abc' });
    const result = await processAuth0CleanupJob(job);

    expect(mockPendingDestroy).toHaveBeenCalledWith({ where: { auth0_sub: 'auth0|abc' } });
    expect(result).toMatchObject({ ok: true });
  });

  test('failure path — deleteUser throws -> handler re-throws, marker NOT cleared', async () => {
    const err = Object.assign(new Error('Failed to delete Auth0 user: 429'), { code: 429 });
    mockDeleteUser.mockRejectedValueOnce(err);

    const job = makeJob({ sub: 'google-oauth2|123' });

    await expect(processAuth0CleanupJob(job)).rejects.toBe(err);
    expect(mockPendingDestroy).not.toHaveBeenCalled();
  });
});

describe('auth0CleanupWorker.handleJobFailed (Phase 87.2 / Plan 03, D-07)', () => {
  test('exhausted (attemptsMade >= attempts) -> Sentry.captureException with auth0-cleanup tags', async () => {
    const err = new Error('forbidden');
    const exhaustedJob = makeJob({ sub: 'google-oauth2|123' }, { attempts: 10 }, 10);

    handleJobFailed(exhaustedJob, err);

    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ worker: 'auth0-cleanup', exhausted: 'true' }),
        extra: expect.objectContaining({
          sub: 'google-oauth2|123',
          attemptsMade: 10,
        }),
      })
    );
  });

  test('exhausted with no explicit opts.attempts defaults to 10 (D-06)', async () => {
    const err = new Error('forbidden');
    const job = { id: 'job-x', data: { sub: 'auth0|abc' }, opts: {}, attemptsMade: 10 };

    handleJobFailed(job, err);

    expect(mockCaptureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ worker: 'auth0-cleanup', exhausted: 'true' }),
      })
    );
  });

  test('non-exhausted failure -> does NOT call Sentry.captureException', async () => {
    const err = new Error('transient');
    const partialJob = makeJob({ sub: 'google-oauth2|123' }, { attempts: 10 }, 3);

    handleJobFailed(partialJob, err);

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('no job context -> logs, does NOT call Sentry.captureException', async () => {
    handleJobFailed(undefined, new Error('boom'));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
