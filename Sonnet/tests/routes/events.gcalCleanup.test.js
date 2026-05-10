// tests/routes/events.gcalCleanup.test.js
// Phase 75 / Plan 03: dispatcher integration tests for DELETE /api/events/:id.
//
// Verifies:
//   - Test 8: DELETE enqueues cleanup jobs through gcalCleanupService.
//   - Test 9: When gcalCleanupService throws (Redis down), the DELETE handler
//             still returns 200 and proceeds with the destroy chain.
//   - Test 10: enqueueCleanupJobsForEvent is invoked BEFORE
//              EventParticipation.destroy (otherwise we lose the gcal id).
//
// Pattern follows tests/routes/events.lifecycle.test.js: mock all models +
// services, inject a fake auth middleware, drive the route via supertest.

process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

// ---- Tracking arrays for ordering assertion (Test 10) ----
const callOrder = [];

// ---- Model mocks ----
const mockEventFindByPk = jest.fn();
const mockEventRsvpFindAll = jest.fn();
const mockEventRsvpDestroy = jest.fn();
const mockEventParticipationDestroy = jest.fn();
const mockEventAuditLogCreate = jest.fn();
const mockGameFindByPk = jest.fn();
const mockGroupFindByPk = jest.fn();

jest.mock('../../models', () => ({
  Event: { findByPk: (...args) => mockEventFindByPk(...args) },
  Game: { findByPk: (...args) => mockGameFindByPk(...args) },
  User: {},
  Group: { findByPk: (...args) => mockGroupFindByPk(...args) },
  EventParticipation: {
    destroy: (...args) => {
      callOrder.push('EventParticipation.destroy');
      return mockEventParticipationDestroy(...args);
    },
  },
  UserGroup: {},
  EventRsvp: {
    findAll: (...args) => mockEventRsvpFindAll(...args),
    destroy: (...args) => mockEventRsvpDestroy(...args),
  },
  EventBallotOption: {},
  EventAuditLog: { create: (...args) => mockEventAuditLogCreate(...args) },
}));

// ---- gcalCleanupService mock — central to this test file ----
const mockEnqueueCleanupJobsForEvent = jest.fn();
jest.mock('../../services/gcalCleanupService', () => ({
  enqueueCleanupJobsForEvent: (...args) => {
    callOrder.push('enqueueCleanupJobsForEvent');
    return mockEnqueueCleanupJobsForEvent(...args);
  },
  enqueueCleanupJobForAttendee: jest.fn(),
}));

// ---- Other service mocks (silence transitive deps) ----
jest.mock('../../services/notificationService', () => ({
  sendToMany: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../services/emailService', () => {
  const real = jest.requireActual('../../services/emailService');
  real.send = jest.fn(() => Promise.resolve({ success: true }));
  return real;
});
jest.mock('../../services/auth0Service', () => ({}));
jest.mock('../../services/googleCalendarService', () => ({}));
jest.mock('../../services/authorizationService', () => ({
  isOwnerOrAdmin: jest.fn(() => Promise.resolve(true)),
  isActiveMember: jest.fn(() => Promise.resolve(true)),
  isMemberOrHigher: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../../middleware/validators', () => {
  const passthrough = (req, res, next) => next();
  const factory = () => passthrough;
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'validateUUID') return factory;
      if (prop === 'validate') return passthrough;
      return passthrough;
    },
  });
});

jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => new Proxy({}, {
  get: () => (req, _res, next) => next(),
}));

const eventsRoutes = require('../../routes/events');
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { user_id: 'auth0|tester' };
  next();
});
app.use('/api/events', eventsRoutes);

const TEST_EVENT_ID = '11111111-1111-1111-1111-111111111111';
const TEST_GROUP_ID = '22222222-2222-2222-2222-222222222222';
const TEST_GAME_ID = '33333333-3333-3333-3333-333333333333';

function buildEvent({ startOffsetMs }) {
  return {
    id: TEST_EVENT_ID,
    group_id: TEST_GROUP_ID,
    game_id: TEST_GAME_ID,
    start_date: new Date(Date.now() + startOffsetMs),
    duration_minutes: 60,
    location: null,
    comments: null,
    update: jest.fn().mockResolvedValue({}),
    destroy: jest.fn().mockResolvedValue(true),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  callOrder.length = 0;
  mockGroupFindByPk.mockResolvedValue({ id: TEST_GROUP_ID, name: 'Test Group' });
  mockGameFindByPk.mockResolvedValue({ name: 'Catan' });
  mockEventRsvpFindAll.mockResolvedValue([]);
  mockEventRsvpDestroy.mockResolvedValue(1);
  mockEventParticipationDestroy.mockResolvedValue(1);
  mockEventAuditLogCreate.mockResolvedValue({});
});

describe('DELETE /api/events/:id — Phase 75 / Plan 03 GCal cleanup dispatch', () => {
  test('Test 8: enqueues cleanup jobs through gcalCleanupService and returns 200', async () => {
    mockEventFindByPk.mockResolvedValueOnce(buildEvent({ startOffsetMs: 24 * 3600 * 1000 }));
    mockEnqueueCleanupJobsForEvent.mockResolvedValueOnce({ enqueued: 1, skipped: 1, errors: 0 });

    const res = await request(app).delete(`/api/events/${TEST_EVENT_ID}`);

    expect(res.status).toBe(200);
    expect(mockEnqueueCleanupJobsForEvent).toHaveBeenCalledWith({ eventId: TEST_EVENT_ID });
  });

  test('Test 9: gcalCleanupService throws (Redis down) — DELETE still returns 200', async () => {
    mockEventFindByPk.mockResolvedValueOnce(buildEvent({ startOffsetMs: 24 * 3600 * 1000 }));
    mockEnqueueCleanupJobsForEvent.mockRejectedValueOnce(new Error('Redis is down'));

    const res = await request(app).delete(`/api/events/${TEST_EVENT_ID}`);

    expect(res.status).toBe(200);
    expect(mockEnqueueCleanupJobsForEvent).toHaveBeenCalled();
    // Destroy chain still ran.
    expect(mockEventParticipationDestroy).toHaveBeenCalled();
  });

  test('Test 10: enqueueCleanupJobsForEvent is called BEFORE EventParticipation.destroy', async () => {
    mockEventFindByPk.mockResolvedValueOnce(buildEvent({ startOffsetMs: 24 * 3600 * 1000 }));
    mockEnqueueCleanupJobsForEvent.mockResolvedValueOnce({ enqueued: 0, skipped: 0, errors: 0 });

    await request(app).delete(`/api/events/${TEST_EVENT_ID}`);

    const enqueueIdx = callOrder.indexOf('enqueueCleanupJobsForEvent');
    const destroyIdx = callOrder.indexOf('EventParticipation.destroy');
    expect(enqueueIdx).toBeGreaterThanOrEqual(0);
    expect(destroyIdx).toBeGreaterThanOrEqual(0);
    expect(enqueueIdx).toBeLessThan(destroyIdx);
  });
});
