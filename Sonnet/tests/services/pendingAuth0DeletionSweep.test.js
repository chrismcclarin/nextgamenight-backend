// tests/services/pendingAuth0DeletionSweep.test.js
// Phase 87.2 / Plan 05 Task 3 (REQ-6, D-08): behavioral tests for the
// PendingAuth0Deletion reconciliation sweep.
//
// Strategy: mock the models, the queues (manual __mocks__ with the getJob stub),
// and auth0Service; drive runPendingAuth0DeletionSweep() directly. No DB, no
// Redis, no cron. The LOAD-BEARING case: a pending marker whose queue job exists
// in state 'failed' (attempts exhausted, retained by removeOnFail:false) MUST be
// re-fired — treating it as live would permanently defeat the backstop after
// exactly the ~17h outage it exists for.

// ---- Model mocks ----
const mockPadFindAll = jest.fn();
const mockPadUpdate = jest.fn();
const mockPadDestroy = jest.fn();
const mockUserFindOne = jest.fn();
const mockMagicTokenDestroy = jest.fn();
const mockSingleUseTokenDestroy = jest.fn();

jest.mock('../../models', () => ({
  PendingAuth0Deletion: {
    findAll: (...a) => mockPadFindAll(...a),
    update: (...a) => mockPadUpdate(...a),
    destroy: (...a) => mockPadDestroy(...a),
  },
  User: { findOne: (...a) => mockUserFindOne(...a) },
  MagicToken: { destroy: (...a) => mockMagicTokenDestroy(...a) },
  SingleUseToken: { destroy: (...a) => mockSingleUseTokenDestroy(...a) },
}));

// ---- Queue mock (manual __mocks__ — includes the getJob stub) ----
jest.mock('../../queues');
const { auth0CleanupQueue } = require('../../queues');

// ---- auth0Service mock (direct-resolve path) ----
const mockDeleteUser = jest.fn();
jest.mock('../../services/auth0Service', () => ({
  deleteUser: (...a) => mockDeleteUser(...a),
}));

const { runPendingAuth0DeletionSweep } = require('../../services/pendingAuth0DeletionSweep');

// Helper: a marker row instance double (older than the 5-min staleness window).
function makeMarker(sub, overrides = {}) {
  return {
    auth0_sub: sub,
    email: `${sub}@example.com`,
    attempts: 1,
    last_attempt_at: null,
    completed_at: null,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
    update: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no stale pending rows, no tombstones, nothing to purge.
  mockPadFindAll.mockResolvedValue([]);
  mockPadUpdate.mockResolvedValue([0]);
  mockPadDestroy.mockResolvedValue(0);
  mockUserFindOne.mockResolvedValue(null);
  mockMagicTokenDestroy.mockResolvedValue(0);
  mockSingleUseTokenDestroy.mockResolvedValue(0);
  auth0CleanupQueue.getJob.mockResolvedValue(null);
  auth0CleanupQueue.add.mockResolvedValue({ id: 'mock-job' });
});

describe('Pass 1 — stale pending markers (job-STATE gating)', () => {
  test('EXHAUSTED failed job (retained by removeOnFail:false) is RE-FIRED — never skipped as live', async () => {
    const marker = makeMarker('auth0|exhausted');
    // Pass 1 findAll -> [marker]; Pass 2 findAll -> tombstone list.
    mockPadFindAll
      .mockResolvedValueOnce([marker])
      .mockResolvedValueOnce([{ auth0_sub: 'auth0|exhausted' }]);

    const failedJob = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
    };
    auth0CleanupQueue.getJob.mockResolvedValueOnce(failedJob);

    const counters = await runPendingAuth0DeletionSweep();

    expect(auth0CleanupQueue.getJob).toHaveBeenCalledWith('auth0-cleanup-auth0|exhausted');
    expect(failedJob.retry).toHaveBeenCalled(); // re-fired, NOT treated as live
    expect(marker.update).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 2, last_attempt_at: expect.any(Date) })
    );
    expect(counters.refired).toBe(1);
    expect(counters.skipped_live).toBe(0);
  });

  test('LIVE job (waiting/delayed/active) is skipped — no retry, no re-enqueue', async () => {
    const marker = makeMarker('auth0|inflight');
    mockPadFindAll
      .mockResolvedValueOnce([marker])
      .mockResolvedValueOnce([{ auth0_sub: 'auth0|inflight' }]);

    const liveJob = {
      getState: jest.fn().mockResolvedValue('delayed'),
      retry: jest.fn(),
    };
    auth0CleanupQueue.getJob.mockResolvedValueOnce(liveJob);

    const counters = await runPendingAuth0DeletionSweep();

    expect(liveJob.retry).not.toHaveBeenCalled();
    expect(auth0CleanupQueue.add).not.toHaveBeenCalled();
    expect(marker.update).not.toHaveBeenCalled();
    expect(counters.skipped_live).toBe(1);
  });

  test('NO job at all (Redis was down at enqueue) → re-enqueued with the deterministic jobId, sub only', async () => {
    const marker = makeMarker('auth0|orphan');
    mockPadFindAll
      .mockResolvedValueOnce([marker])
      .mockResolvedValueOnce([{ auth0_sub: 'auth0|orphan' }]);
    // default getJob -> null

    const counters = await runPendingAuth0DeletionSweep();

    expect(auth0CleanupQueue.add).toHaveBeenCalledWith(
      'cleanup',
      { sub: 'auth0|orphan' }, // sub ONLY — no tokens ever enter Redis
      { jobId: 'auth0-cleanup-auth0|orphan' }
    );
    expect(marker.update).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 2, last_attempt_at: expect.any(Date) })
    );
    expect(counters.reenqueued).toBe(1);
  });

  test('COMPLETED job with a still-pending marker → direct-resolve (deleteUser + mark completed, NEVER destroy)', async () => {
    const marker = makeMarker('auth0|lostupdate');
    mockPadFindAll
      .mockResolvedValueOnce([marker])
      .mockResolvedValueOnce([{ auth0_sub: 'auth0|lostupdate' }]);

    const completedJob = {
      getState: jest.fn().mockResolvedValue('completed'),
      retry: jest.fn(),
    };
    auth0CleanupQueue.getJob.mockResolvedValueOnce(completedJob);
    mockDeleteUser.mockResolvedValueOnce({ deleted: true, alreadyGone: true });

    const counters = await runPendingAuth0DeletionSweep();

    expect(mockDeleteUser).toHaveBeenCalledWith('auth0|lostupdate');
    expect(marker.update).toHaveBeenCalledWith(
      expect.objectContaining({ completed_at: expect.any(Date), email: null })
    );
    expect(counters.direct_resolved).toBe(1);
  });

  test('exhaustion-horizon PII hygiene: emails on pending rows older than ~17h are nulled (pending rows only)', async () => {
    mockPadUpdate.mockResolvedValueOnce([2]);

    const counters = await runPendingAuth0DeletionSweep();

    expect(mockPadUpdate).toHaveBeenCalledWith(
      { email: null },
      expect.objectContaining({
        where: expect.objectContaining({ completed_at: null }),
      })
    );
    expect(counters.emails_nulled).toBe(2);
  });
});

describe('Pass 2 — ghost-row destroy (REQ-6 backstop)', () => {
  test('a Users row matching a tombstoned sub is destroyed, plus sub-keyed MagicToken/SingleUseToken rows', async () => {
    mockPadFindAll
      .mockResolvedValueOnce([]) // pass 1: no stale pending
      .mockResolvedValueOnce([{ auth0_sub: 'auth0|ghosted' }]); // pass 2 tombstones

    const ghost = { destroy: jest.fn().mockResolvedValue(undefined) };
    mockUserFindOne.mockResolvedValueOnce(ghost);

    const counters = await runPendingAuth0DeletionSweep();

    expect(mockUserFindOne).toHaveBeenCalledWith({ where: { user_id: 'auth0|ghosted' } });
    expect(ghost.destroy).toHaveBeenCalled();
    expect(mockMagicTokenDestroy).toHaveBeenCalledWith({ where: { user_id: 'auth0|ghosted' } });
    expect(mockSingleUseTokenDestroy).toHaveBeenCalledWith({ where: { user_id: 'auth0|ghosted' } });
    expect(counters.ghosts_destroyed).toBe(1);
  });
});

describe('Pass 3 — retention purge', () => {
  test('purges ONLY tombstones with completed_at set and older than 24h — never pending rows', async () => {
    const { Op } = require('sequelize');
    mockPadDestroy.mockResolvedValueOnce(3);

    const counters = await runPendingAuth0DeletionSweep();

    expect(mockPadDestroy).toHaveBeenCalledTimes(1);
    const where = mockPadDestroy.mock.calls[0][0].where;
    // Explicit non-NULL guard + 24h cutoff.
    expect(where.completed_at[Op.ne]).toBeNull();
    expect(where.completed_at[Op.lt]).toBeInstanceOf(Date);
    const cutoff = where.completed_at[Op.lt].getTime();
    const expected = Date.now() - 24 * 60 * 60 * 1000;
    expect(Math.abs(cutoff - expected)).toBeLessThan(60 * 1000);
    expect(counters.purged).toBe(3);
  });
});

describe('resilience', () => {
  test('a per-marker remediation failure never crashes the sweep (other passes still run)', async () => {
    const badMarker = makeMarker('auth0|bad');
    mockPadFindAll
      .mockResolvedValueOnce([badMarker])
      .mockResolvedValueOnce([]);
    auth0CleanupQueue.getJob.mockRejectedValueOnce(new Error('redis exploded'));

    await expect(runPendingAuth0DeletionSweep()).resolves.toBeDefined();
    // Pass 3 still ran.
    expect(mockPadDestroy).toHaveBeenCalled();
  });
});
