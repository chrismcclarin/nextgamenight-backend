// tests/workers/gcalSyncWorker.test.js
// Phase 75 / Plan 03: tests for the gcal-sync worker handler in isolation.
//
// Strategy: the worker file exports the pure handler function as
// `processGcalSyncJob` so we can invoke it directly with mocked deps —
// no Redis, no BullMQ runtime, no Google API. The tests assert:
//   - load user / handle missing user
//   - skip when user has no GCal token
//   - call deleteCalendarEventForUser with the right args
//   - on disconnect, return skip + Sentry breadcrumb (no throw)
//   - on transient/permanent errors, re-throw so BullMQ retries / exhausts
//   - persist refreshed access token if delete returned _new_access_token

// ---------------------------------------------------------------------------
// Mocks BEFORE requiring the worker
// ---------------------------------------------------------------------------
const mockDeleteCalendarEventForUser = jest.fn();
jest.mock('../../services/googleCalendarService', () => ({
  deleteCalendarEventForUser: (...args) => mockDeleteCalendarEventForUser(...args),
}));

const mockUserFindByPk = jest.fn();
const mockUserUpdateInstance = jest.fn();
jest.mock('../../models', () => ({
  User: { findByPk: (...args) => mockUserFindByPk(...args) },
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

// Mock @sentry/node for breadcrumb + capture assertions.
const mockAddBreadcrumb = jest.fn();
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  addBreadcrumb: (...args) => mockAddBreadcrumb(...args),
  captureException: (...args) => mockCaptureException(...args),
}), { virtual: true });

// Force the worker file to require @sentry/node (otherwise it gates on SENTRY_DSN).
process.env.SENTRY_DSN = 'https://fake@sentry.io/123';

const { processGcalSyncJob, handleJobFailed } = require('../../workers/gcalSyncWorker');

// Helper: build a fake job
function makeJob(data, opts = { attempts: 3 }) {
  return {
    id: 'job-1',
    data,
    opts,
    attemptsMade: 1,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUserUpdateInstance.mockResolvedValue([1]);
});

describe('gcalSyncWorker.processGcalSyncJob (Phase 75 / Plan 03)', () => {
  test('Test 1: success path — loads user, calls deleteCalendarEventForUser, returns ok', async () => {
    mockUserFindByPk.mockResolvedValueOnce({
      id: 'u-1',
      google_calendar_token: 'access-token',
      google_calendar_refresh_token: 'refresh-token',
      update: mockUserUpdateInstance,
    });
    mockDeleteCalendarEventForUser.mockResolvedValueOnce({ deleted: true });

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-1',
      googleCalendarEventId: 'gcal-1',
    });

    const result = await processGcalSyncJob(job);

    expect(mockUserFindByPk).toHaveBeenCalledWith('u-1');
    expect(mockDeleteCalendarEventForUser).toHaveBeenCalledWith(
      'gcal-1',
      'access-token',
      'refresh-token'
    );
    expect(result).toMatchObject({ ok: true, eventParticipationId: 'ep-1' });
  });

  test('Test 2: user not found — returns skipped:user_not_found, no throw, no Sentry alert', async () => {
    mockUserFindByPk.mockResolvedValueOnce(null);

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-gone',
      googleCalendarEventId: 'gcal-1',
    });

    const result = await processGcalSyncJob(job);

    expect(result).toMatchObject({ skipped: true, reason: 'user_not_found' });
    expect(mockDeleteCalendarEventForUser).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('Test 3: user has no GCal token — returns skipped_due_to_disconnect + Sentry breadcrumb (no alert)', async () => {
    mockUserFindByPk.mockResolvedValueOnce({
      id: 'u-1',
      google_calendar_token: null,
      google_calendar_refresh_token: null,
      update: mockUserUpdateInstance,
    });

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-1',
      googleCalendarEventId: 'gcal-1',
    });

    const result = await processGcalSyncJob(job);

    expect(result).toMatchObject({ skipped: true, reason: 'skipped_due_to_disconnect' });
    expect(mockDeleteCalendarEventForUser).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'gcal-sync',
        message: 'skipped_due_to_disconnect',
        level: 'info',
        data: expect.objectContaining({
          eventId: 'evt-1',
          eventParticipationId: 'ep-1',
          userId: 'u-1',
        }),
      })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('Test 4: GCAL_DISCONNECTED from helper — returns skip + breadcrumb, no throw, no retry', async () => {
    mockUserFindByPk.mockResolvedValueOnce({
      id: 'u-1',
      google_calendar_token: 'access-token',
      google_calendar_refresh_token: null,
      update: mockUserUpdateInstance,
    });
    const disconnectErr = Object.assign(new Error('disconnected'), { code: 'GCAL_DISCONNECTED' });
    mockDeleteCalendarEventForUser.mockRejectedValueOnce(disconnectErr);

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-1',
      googleCalendarEventId: 'gcal-1',
    });

    const result = await processGcalSyncJob(job);

    expect(result).toMatchObject({ skipped: true, reason: 'skipped_due_to_disconnect' });
    expect(mockAddBreadcrumb).toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('Test 5a: GCAL_RATE_LIMITED — re-throws so BullMQ retries', async () => {
    mockUserFindByPk.mockResolvedValueOnce({
      id: 'u-1',
      google_calendar_token: 'access-token',
      google_calendar_refresh_token: null,
      update: mockUserUpdateInstance,
    });
    const rateLimitErr = Object.assign(new Error('rate limited'), { code: 'GCAL_RATE_LIMITED' });
    mockDeleteCalendarEventForUser.mockRejectedValueOnce(rateLimitErr);

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-1',
      googleCalendarEventId: 'gcal-1',
    });

    await expect(processGcalSyncJob(job)).rejects.toBe(rateLimitErr);
  });

  test('Test 5b: 5xx (no code) — re-throws', async () => {
    mockUserFindByPk.mockResolvedValueOnce({
      id: 'u-1',
      google_calendar_token: 'access-token',
      google_calendar_refresh_token: 'refresh-token',
      update: mockUserUpdateInstance,
    });
    const transientErr = Object.assign(new Error('boom'), { code: 503 });
    mockDeleteCalendarEventForUser.mockRejectedValueOnce(transientErr);

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-1',
      googleCalendarEventId: 'gcal-1',
    });

    await expect(processGcalSyncJob(job)).rejects.toBe(transientErr);
  });

  test('Test 6: GCAL_PERMANENT — re-throws AND failed-event hook with attempts exhausted -> Sentry alert', async () => {
    mockUserFindByPk.mockResolvedValueOnce({
      id: 'u-1',
      google_calendar_token: 'access-token',
      google_calendar_refresh_token: null,
      update: mockUserUpdateInstance,
    });
    const permanentErr = Object.assign(new Error('forbidden'), { code: 'GCAL_PERMANENT' });
    mockDeleteCalendarEventForUser.mockRejectedValueOnce(permanentErr);

    const job = makeJob(
      {
        eventId: 'evt-1',
        eventParticipationId: 'ep-1',
        userId: 'u-1',
        googleCalendarEventId: 'gcal-1',
      },
      { attempts: 3 }
    );

    await expect(processGcalSyncJob(job)).rejects.toBe(permanentErr);

    // Now simulate BullMQ's `failed` hook firing with attempts exhausted.
    const exhaustedJob = { ...job, attemptsMade: 3 };
    handleJobFailed(exhaustedJob, permanentErr);

    expect(mockCaptureException).toHaveBeenCalledWith(
      permanentErr,
      expect.objectContaining({
        tags: expect.objectContaining({ worker: 'gcal-sync', exhausted: 'true' }),
        extra: expect.objectContaining({
          eventId: 'evt-1',
          eventParticipationId: 'ep-1',
          userId: 'u-1',
          errorCode: 'GCAL_PERMANENT',
          attemptsMade: 3,
        }),
      })
    );
  });

  test('Test 6b: failed hook on non-final attempt does NOT call Sentry.captureException', async () => {
    const transientErr = Object.assign(new Error('boom'), { code: 'GCAL_RATE_LIMITED' });
    const partialJob = {
      id: 'job-2',
      data: { eventId: 'evt-1', eventParticipationId: 'ep-1', userId: 'u-1' },
      opts: { attempts: 3 },
      attemptsMade: 1, // not exhausted yet
    };

    handleJobFailed(partialJob, transientErr);

    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('Test 7: helper returned _new_access_token — worker persists it on User', async () => {
    const userInstance = {
      id: 'u-1',
      google_calendar_token: 'old-token',
      google_calendar_refresh_token: 'refresh-token',
      update: mockUserUpdateInstance,
    };
    mockUserFindByPk.mockResolvedValueOnce(userInstance);
    mockDeleteCalendarEventForUser.mockResolvedValueOnce({
      deleted: true,
      _new_access_token: 'newly-refreshed-token',
    });

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-1',
      googleCalendarEventId: 'gcal-1',
    });

    const result = await processGcalSyncJob(job);

    expect(mockUserUpdateInstance).toHaveBeenCalledWith({
      google_calendar_token: 'newly-refreshed-token',
    });
    expect(result).toMatchObject({ ok: true });
  });

  test('alreadyGone: returns ok with alreadyGone:true', async () => {
    mockUserFindByPk.mockResolvedValueOnce({
      id: 'u-1',
      google_calendar_token: 'access-token',
      google_calendar_refresh_token: null,
      update: mockUserUpdateInstance,
    });
    mockDeleteCalendarEventForUser.mockResolvedValueOnce({ deleted: true, alreadyGone: true });

    const job = makeJob({
      eventId: 'evt-1',
      eventParticipationId: 'ep-1',
      userId: 'u-1',
      googleCalendarEventId: 'gcal-1',
    });

    const result = await processGcalSyncJob(job);
    expect(result).toMatchObject({ ok: true, alreadyGone: true });
  });
});
