// tests/services/accountDeletionService.test.js
// Phase 87.2 / Plan 04 — fault-injection unit tests for the deleteAccount
// orchestration pipeline (SPEC Req 4/5/6/8 + the slow-externals wall-clock budget).
//
// Strategy (mold on tests/services/gcalCleanupService.test.js): every boundary is
// mocked — models (incl. sequelize.transaction/query), googleCalendarService,
// auth0Service, emailService, and the auth0CleanupQueue — so the pipeline runs with no
// Postgres, no Google/Auth0/Resend, no Redis. We assert:
//   REQ-4  Google cleanup + revoke happen BEFORE the DB txn; a Google 5xx still completes.
//   REQ-5  auth0Service.deleteUser is called AFTER the txn commits.
//   REQ-6  in-request Auth0 success marks the PendingAuth0Deletion marker completed
//          (completed_at update, NEVER destroy); a DB-txn failure deletes nothing and
//          never calls Auth0; the FIRST Auth0 failure enqueues auth0-cleanup-<sub> with a
//          sub-only payload (no tokens), deleteUser attempted exactly once; an enqueue
//          failure (Redis down) after commit still resolves { status:'deleted' }.
//   REQ-6c a missing user resolves { status:'not_found' } (repeat-delete safe).
//   REQ-8  emailService is called with the EXACT captured email; a Resend throw OR a
//          hung send does not change { status:'deleted' }.
//   BUDGET every external lane (Google, Auth0, email) hanging past its budget still
//          resolves { status:'deleted' } (skipped Google deletes logged).
//
// NOTE: the User model is MOCKED here, so these tests cannot by themselves catch a
// missing `withContactInfo` scope — that is why the withContactInfo grep gate in the
// plan AND the exact-recipient email assertion both exist as independent guards.

// ---------------------------------------------------------------------------
// Mock handles (all `mock*`-prefixed so jest.mock factories may close over them).
// ---------------------------------------------------------------------------
const mockUserFindOne = jest.fn();
const mockUserScope = jest.fn(() => ({ findOne: (...a) => mockUserFindOne(...a) }));
const mockEPFindAll = jest.fn();
const mockUGFindAll = jest.fn();
const mockUGCount = jest.fn();
const mockGroupFindByPk = jest.fn();
const mockSequelizeQuery = jest.fn();
const mockSequelizeTransaction = jest.fn();
const mockMarkerFindOne = jest.fn();
const mockMarkerCreate = jest.fn();

const mockDeleteCalEvent = jest.fn();
const mockDeleteHolds = jest.fn();
const mockRevoke = jest.fn();
const mockDeleteUser = jest.fn();
const mockEmailSend = jest.fn();
const mockQueueAdd = jest.fn();

// Shared ordering log so tests can assert Google-before-txn / Auth0-after-commit.
const callLog = [];

jest.mock('../../models', () => ({
  User: { scope: (...a) => mockUserScope(...a) },
  Group: { findByPk: (...a) => mockGroupFindByPk(...a) },
  Event: { findAll: jest.fn().mockResolvedValue([]), destroy: jest.fn().mockResolvedValue(0) },
  EventParticipation: {
    findAll: (...a) => mockEPFindAll(...a),
    destroy: jest.fn().mockResolvedValue(0),
  },
  UserGroup: {
    findAll: (...a) => mockUGFindAll(...a),
    count: (...a) => mockUGCount(...a),
    destroy: jest.fn().mockResolvedValue(0),
  },
  GroupInvite: { destroy: jest.fn().mockResolvedValue(0) },
  GameReview: { destroy: jest.fn().mockResolvedValue(0) },
  UserGame: { destroy: jest.fn().mockResolvedValue(0) },
  MagicToken: { destroy: jest.fn().mockResolvedValue(0) },
  SingleUseToken: { destroy: jest.fn().mockResolvedValue(0) },
  Feedback: { update: jest.fn().mockResolvedValue([0]) },
  EventBallotOption: { update: jest.fn().mockResolvedValue([0]) },
  AvailabilitySuggestion: { findAll: jest.fn().mockResolvedValue([]) },
  PendingAuth0Deletion: {
    findOne: (...a) => mockMarkerFindOne(...a),
    create: (...a) => mockMarkerCreate(...a),
  },
  sequelize: {
    transaction: (...a) => mockSequelizeTransaction(...a),
    query: (...a) => mockSequelizeQuery(...a),
    QueryTypes: { SELECT: 'SELECT' },
  },
}));

jest.mock('../../services/googleCalendarService', () => ({
  deleteCalendarEventForUser: (...a) => mockDeleteCalEvent(...a),
  deleteTentativeHolds: (...a) => mockDeleteHolds(...a),
  revokeGoogleAccess: (...a) => mockRevoke(...a),
}));
jest.mock('../../services/auth0Service', () => ({
  deleteUser: (...a) => mockDeleteUser(...a),
}));
jest.mock('../../services/emailService', () => ({
  send: (...a) => mockEmailSend(...a),
}));
jest.mock('../../queues', () => ({
  auth0CleanupQueue: { add: (...a) => mockQueueAdd(...a) },
}));

const { deleteAccount } = require('../../services/accountDeletionService');

const SUB = 'google-oauth2|1075';
const EMAIL = 'player@example.com';
const UUID = '11111111-1111-1111-1111-111111111111';

function makeUser(overrides = {}) {
  return {
    id: UUID,
    user_id: SUB,
    email: EMAIL,
    google_calendar_token: null,
    google_calendar_refresh_token: null,
    destroy: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// A promise that never settles — used to hang an external lane past its budget.
const NEVER = () => new Promise(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  callLog.length = 0;

  // Happy-path defaults: user present, no blockers, no gcal tokens, txn commits.
  mockUserFindOne.mockResolvedValue(makeUser());
  mockUGFindAll.mockResolvedValue([]); // no owned groups -> no blockers, no auto-delete
  mockUGCount.mockResolvedValue(0);
  mockGroupFindByPk.mockResolvedValue({ id: 'g1', name: 'Group One' });
  mockEPFindAll.mockResolvedValue([]);
  mockSequelizeQuery.mockResolvedValue([]);
  mockMarkerFindOne.mockResolvedValue({ update: jest.fn().mockResolvedValue(undefined) });
  mockMarkerCreate.mockResolvedValue({ id: 'marker-1' });

  mockDeleteCalEvent.mockResolvedValue({ deleted: true });
  mockDeleteHolds.mockResolvedValue({ deleted: 0, failed: 0 });
  mockRevoke.mockResolvedValue({ revoked: true });
  mockDeleteUser.mockResolvedValue({ deleted: true });
  mockEmailSend.mockResolvedValue({ success: true });
  mockQueueAdd.mockResolvedValue({ id: 'job-1' });

  // Transaction: run the callback with a fake `t`, logging start/commit around it.
  mockSequelizeTransaction.mockImplementation(async (cb) => {
    callLog.push('txn:start');
    const result = await cb({ LOCK: { UPDATE: 'UPDATE' } });
    callLog.push('txn:commit');
    return result;
  });

  // Tag external boundaries into the ordering log.
  mockRevoke.mockImplementation(async () => { callLog.push('google:revoke'); return { revoked: true }; });
  mockDeleteUser.mockImplementation(async () => { callLog.push('auth0:delete'); return { deleted: true }; });
});

describe('deleteAccount — Step 0 / repeat-delete (REQ-6c)', () => {
  test('missing user resolves { status: "not_found" } without touching externals', async () => {
    mockUserFindOne.mockResolvedValue(null);
    const res = await deleteAccount({ userId: SUB });
    expect(res).toEqual({ status: 'not_found' });
    expect(mockSequelizeTransaction).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('loads the user via the withContactInfo scope (PII opt-in)', async () => {
    await deleteAccount({ userId: SUB });
    expect(mockUserScope).toHaveBeenCalledWith('withContactInfo');
    expect(mockUserFindOne).toHaveBeenCalledWith({ where: { user_id: SUB } });
  });
});

describe('deleteAccount — owner gate (REQ-2)', () => {
  test('blockers resolve { status: "blocked", groups } and delete nothing', async () => {
    // One owned group with an "other" member -> blocker.
    mockUGFindAll.mockResolvedValue([{ group_id: 'g1' }]);
    mockUGCount.mockResolvedValueOnce(1); // other-count for the fast-fail check
    mockUGCount.mockResolvedValueOnce(3); // total member count
    const res = await deleteAccount({ userId: SUB });
    expect(res.status).toBe('blocked');
    expect(res.groups).toEqual([{ id: 'g1', name: 'Group One', memberCount: 3 }]);
    expect(mockSequelizeTransaction).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});

describe('deleteAccount — blocked-at-recheck Google side-effect surfacing (WR-02)', () => {
  test('IN-TXN blocked result carries google_access_revoked: true when a Google grant existed', async () => {
    const user = makeUser({ google_calendar_token: 'at', google_calendar_refresh_token: 'rt' });
    mockUserFindOne.mockResolvedValue(user);
    // Step 1 fast-fail gate passes (no owned groups yet)...
    mockUGFindAll.mockResolvedValueOnce([]);
    // ...but the IN-TXN re-check finds an owned group (a member joined during
    // the Google-cleanup window).
    mockUGFindAll.mockResolvedValueOnce([{ group_id: 'g1' }]);
    // The in-txn re-check derives counts from the locked (FOR UPDATE) membership
    // row set: owner + one other member -> blocker, memberCount 2.
    mockSequelizeQuery.mockImplementation(async (sql) => {
      if (typeof sql === 'string' && sql.includes('"UserGroups"') && sql.includes('FOR UPDATE')) {
        return [{ user_uuid: UUID }, { user_uuid: '22222222-2222-2222-2222-222222222222' }];
      }
      return [];
    });

    const res = await deleteAccount({ userId: SUB });

    expect(res.status).toBe('blocked');
    expect(res.groups).toEqual([{ id: 'g1', name: 'Group One', memberCount: 2 }]);
    // Pinned FE contract key — Step 2 (Google cleanup + revoke) already ran.
    expect(res.google_access_revoked).toBe(true);
    expect(mockRevoke).toHaveBeenCalled();
    // Nothing was deleted; Auth0 untouched.
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('pre-flight (Step 1) blocked result does NOT carry google_access_revoked', async () => {
    const user = makeUser({ google_calendar_token: 'at', google_calendar_refresh_token: 'rt' });
    mockUserFindOne.mockResolvedValue(user);
    mockUGFindAll.mockResolvedValue([{ group_id: 'g1' }]);
    mockUGCount.mockResolvedValueOnce(1); // other-count -> blocker
    mockUGCount.mockResolvedValueOnce(3); // total member count

    const res = await deleteAccount({ userId: SUB });

    expect(res.status).toBe('blocked');
    expect(res.google_access_revoked).toBeUndefined();
    expect('google_access_revoked' in res).toBe(false);
    // Nothing ran: the fast-fail gate fired BEFORE Google cleanup.
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockSequelizeTransaction).not.toHaveBeenCalled();
  });
});

describe('deleteAccount — Google cleanup ordering + resilience (REQ-4)', () => {
  test('Google cleanup + revoke run BEFORE the DB transaction', async () => {
    const user = makeUser({ google_calendar_token: 'at', google_calendar_refresh_token: 'rt' });
    mockUserFindOne.mockResolvedValue(user);
    mockEPFindAll.mockResolvedValue([{ id: 'ep1', google_calendar_event_id: 'gcal-1' }]);

    await deleteAccount({ userId: SUB });

    expect(mockDeleteCalEvent).toHaveBeenCalledWith('gcal-1', 'at', 'rt');
    expect(mockRevoke).toHaveBeenCalled();
    // Ordering: revoke (google) strictly before txn:start.
    expect(callLog.indexOf('google:revoke')).toBeGreaterThanOrEqual(0);
    expect(callLog.indexOf('google:revoke')).toBeLessThan(callLog.indexOf('txn:start'));
  });

  test('a Google 5xx still completes the deletion', async () => {
    const user = makeUser({ google_calendar_token: 'at', google_calendar_refresh_token: 'rt' });
    mockUserFindOne.mockResolvedValue(user);
    mockEPFindAll.mockResolvedValue([{ id: 'ep1', google_calendar_event_id: 'gcal-1' }]);
    mockDeleteCalEvent.mockRejectedValue(new Error('mock GCal 500'));

    const res = await deleteAccount({ userId: SUB });
    expect(res).toEqual({ status: 'deleted' });
    expect(mockDeleteUser).toHaveBeenCalledTimes(1);
  });

  test('skips Google entirely when the user has no tokens', async () => {
    await deleteAccount({ userId: SUB }); // default user has null tokens
    expect(mockDeleteCalEvent).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});

describe('deleteAccount — Auth0 lane (REQ-5 / REQ-6)', () => {
  test('deleteUser is called AFTER the txn commits', async () => {
    await deleteAccount({ userId: SUB });
    expect(callLog.indexOf('auth0:delete')).toBeGreaterThan(callLog.indexOf('txn:commit'));
  });

  test('in-request Auth0 success marks the marker completed (never destroys it)', async () => {
    const markerUpdate = jest.fn().mockResolvedValue(undefined);
    const marker = { update: markerUpdate, destroy: jest.fn() };
    mockMarkerFindOne.mockResolvedValue(marker);

    const res = await deleteAccount({ userId: SUB });
    expect(res).toEqual({ status: 'deleted' });
    expect(markerUpdate).toHaveBeenCalledTimes(1);
    expect(markerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ completed_at: expect.any(Date), email: null })
    );
    expect(marker.destroy).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('a DB-txn failure deletes nothing and never calls Auth0', async () => {
    mockSequelizeTransaction.mockImplementation(async () => {
      throw new Error('DB write failed');
    });
    await expect(deleteAccount({ userId: SUB })).rejects.toThrow('DB write failed');
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  test('first Auth0 failure enqueues auth0-cleanup-<sub> with a sub-only payload, deleteUser attempted once', async () => {
    mockDeleteUser.mockReset();
    mockDeleteUser.mockRejectedValue(new Error('Auth0 503'));

    const res = await deleteAccount({ userId: SUB });
    expect(res).toEqual({ status: 'deleted' });
    expect(mockDeleteUser).toHaveBeenCalledTimes(1); // single attempt, no in-request retries
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, payload, opts] = mockQueueAdd.mock.calls[0];
    expect(payload).toEqual({ sub: SUB }); // ONLY the sub — no tokens
    expect(opts).toEqual(expect.objectContaining({ jobId: `auth0-cleanup-${SUB}` }));
    // The marker is left PENDING for the sweep — not marked completed.
  });

  test('enqueue failure (Redis down) after a committed deletion still resolves deleted', async () => {
    mockDeleteUser.mockReset();
    mockDeleteUser.mockRejectedValue(new Error('Auth0 503'));
    mockQueueAdd.mockRejectedValue(new Error('Redis down'));

    const res = await deleteAccount({ userId: SUB });
    expect(res).toEqual({ status: 'deleted' });
  });
});

describe('deleteAccount — notice email (REQ-8)', () => {
  test('emailService.send is called with the EXACT captured email address', async () => {
    await deleteAccount({ userId: SUB });
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
    const arg = mockEmailSend.mock.calls[0][0];
    expect(arg.to).toBe(EMAIL);
  });

  test('a Resend throw does not change { status: "deleted" }', async () => {
    mockEmailSend.mockRejectedValue(new Error('Resend down'));
    const res = await deleteAccount({ userId: SUB });
    expect(res).toEqual({ status: 'deleted' });
  });
});

describe('deleteAccount — slow-externals wall-clock budget (T-87.2-14)', () => {
  test('every external lane hanging past its budget still resolves deleted', async () => {
    const user = makeUser({ google_calendar_token: 'at', google_calendar_refresh_token: 'rt' });
    mockUserFindOne.mockResolvedValue(user);
    mockEPFindAll.mockResolvedValue([{ id: 'ep1', google_calendar_event_id: 'gcal-1' }]);

    // Hang EVERY external call forever.
    mockDeleteCalEvent.mockImplementation(NEVER);
    mockDeleteHolds.mockImplementation(NEVER);
    mockRevoke.mockImplementation(NEVER);
    mockDeleteUser.mockReset();
    mockDeleteUser.mockImplementation(NEVER);
    mockEmailSend.mockImplementation(NEVER);

    const started = Date.now();
    // Tiny injected budgets so the test is fast + deterministic; production defaults
    // (10s/5s/5s) are exercised by the route wiring in plan 87.2-05.
    const res = await deleteAccount(
      { userId: SUB },
      { budgets: { googleMs: 40, auth0Ms: 40, emailMs: 40 } }
    );
    const elapsed = Date.now() - started;

    expect(res).toEqual({ status: 'deleted' });
    // Well under the 30s BFF ceiling — the point of the budgets.
    expect(elapsed).toBeLessThan(2000);
    // Auth0 hung -> single attempt -> enqueue fallback fired.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});
