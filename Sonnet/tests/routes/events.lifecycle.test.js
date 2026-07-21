// tests/routes/events.lifecycle.test.js
// Lifecycle invariants for event update / delete (Phase 61, MAIL-04 + MAIL-05).
//
// Encodes:
//  - Cancellation emails fire only when now < event.start_date + 15 min
//  - Update emails fire only when now < event.start_date (OLD start, no grace)
//  - Hard delete after start is silent (no email) but still writes audit log
//  - EventAuditLog row written on EVERY delete with correct timing flags
//  - Event-related templates render 12h with timezone label (MAIL-04)
//
// Pattern follows tests/routes/twilioWebhook.test.js: mock all models +
// services, inject a fake auth middleware, then drive routes via supertest.

process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

// ---- Model mocks ----
const mockEventFindByPk = jest.fn();
const mockEventRsvpFindAll = jest.fn();
const mockEventRsvpDestroy = jest.fn();
const mockEventParticipationDestroy = jest.fn();
const mockEventAuditLogCreate = jest.fn();
const mockGameFindByPk = jest.fn();
const mockGroupFindByPk = jest.fn();
const mockUserFindOne = jest.fn();

jest.mock('../../models', () => ({
  Event: { findByPk: (...args) => mockEventFindByPk(...args) },
  Game: { findByPk: (...args) => mockGameFindByPk(...args) },
  // 87.5 Req 9: the delete handler now resolves the caller's Users.id UUID via
  // User.findOne to record it as the audit actor (was the Auth0 sub). Mock it so
  // the resolve returns a UUID-shaped id.
  User: { findOne: (...args) => mockUserFindOne(...args) },
  Group: { findByPk: (...args) => mockGroupFindByPk(...args) },
  EventParticipation: { destroy: (...args) => mockEventParticipationDestroy(...args) },
  UserGroup: {},
  EventRsvp: {
    findAll: (...args) => mockEventRsvpFindAll(...args),
    destroy: (...args) => mockEventRsvpDestroy(...args),
  },
  EventBallotOption: {},
  EventAuditLog: { create: (...args) => mockEventAuditLogCreate(...args) },
}));

// ---- Service mocks ----
const mockSendToMany = jest.fn(() => Promise.resolve([]));
jest.mock('../../services/notificationService', () => ({
  sendToMany: (...args) => mockSendToMany(...args),
}));

const mockSend = jest.fn(() => Promise.resolve({ success: true }));
jest.mock('../../services/emailService', () => {
  // Re-require the real module so we can also unit-test the templates,
  // but stub send() so we don't hit Resend.
  const real = jest.requireActual('../../services/emailService');
  real.send = mockSend;
  return real;
});

jest.mock('../../services/auth0Service', () => ({}));
jest.mock('../../services/googleCalendarService', () => ({}));

// Owner-or-admin always passes; we want to exercise the lifecycle gates,
// not authorization (which has its own tests).
jest.mock('../../services/authorizationService', () => ({
  isOwnerOrAdmin: jest.fn(() => Promise.resolve(true)),
  isActiveMember: jest.fn(() => Promise.resolve(true)),
  isMemberOrHigher: jest.fn(() => Promise.resolve(true)),
}));

// Pass-through validators so we can drive the routes with raw bodies.
// Use a Proxy because routes/rsvp.js (required transitively) imports several
// validators by name; a flat mock would need every export listed.
jest.mock('../../middleware/validators', () => {
  const passthrough = (req, res, next) => next();
  const factory = () => passthrough;
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'validateUUID') return factory; // factory returns middleware
      if (prop === 'validate') return passthrough;
      return passthrough;
    },
  });
});

// rsvp.js also requires verifyAuth0Token from middleware/auth0
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

// rateLimiter middleware (used by rsvp.js)
jest.mock('../../middleware/rateLimiter', () => new Proxy({}, {
  get: () => (req, _res, next) => next(),
}));

// ---- App setup ----
const eventsRoutes = require('../../routes/events');
const app = express();
app.use(express.json());
// Inject fake auth user so routes' `req.user.user_id` resolves.
app.use((req, _res, next) => {
  req.user = { user_id: 'auth0|tester' };
  next();
});
app.use('/api/events', eventsRoutes);

// ---- Helpers ----
const TEST_EVENT_ID = '11111111-1111-1111-1111-111111111111';
const TEST_GROUP_ID = '22222222-2222-2222-2222-222222222222';
const TEST_GAME_ID = '33333333-3333-3333-3333-333333333333';
// The caller's Auth0 sub is 'auth0|tester' (injected below); their resolved
// Users.id is this UUID. 87.5 Req 9: the audit actor must be the UUID, not the sub.
const TEST_CALLER_UUID = '44444444-4444-4444-4444-444444444444';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildEvent({ startOffsetMs }) {
  const startDate = new Date(Date.now() + startOffsetMs);
  return {
    id: TEST_EVENT_ID,
    group_id: TEST_GROUP_ID,
    game_id: TEST_GAME_ID,
    start_date: startDate,
    duration_minutes: 60,
    location: null,
    comments: null,
    update: jest.fn().mockResolvedValue({}),
    destroy: jest.fn().mockResolvedValue(true),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default group/game lookups return minimal fixtures
  mockGroupFindByPk.mockResolvedValue({ id: TEST_GROUP_ID, name: 'Test Group' });
  mockGameFindByPk.mockResolvedValue({ name: 'Catan' });
  mockEventRsvpFindAll.mockResolvedValue([
    {
      User: {
        id: 'user-1',
        user_id: 'auth0|attendee',
        username: 'Attendee',
        email: 'attendee@example.com',
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: null,
        phone_verified: false,
        notification_preferences: null,
        timezone: 'America/Denver',
        dataValues: {
          id: 'user-1',
          user_id: 'auth0|attendee',
          username: 'Attendee',
          email: 'attendee@example.com',
          timezone: 'America/Denver',
        },
      },
    },
  ]);
  mockEventRsvpDestroy.mockResolvedValue(1);
  mockEventParticipationDestroy.mockResolvedValue(1);
  mockEventAuditLogCreate.mockResolvedValue({});
  // 87.5 Req 9: caller's own sub ('auth0|tester') resolves to their Users.id UUID.
  mockUserFindOne.mockResolvedValue({ id: TEST_CALLER_UUID });
});

// ---- Tests ----
describe('Event lifecycle: cancellation cutoff', () => {
  // Test 1: Cancellation BEFORE start
  it('fires cancellation emails and writes audit log when event is in the future', async () => {
    const event = buildEvent({ startOffsetMs: 60 * 60 * 1000 }); // +1h
    mockEventFindByPk.mockResolvedValue(event);

    const res = await request(app).delete(`/api/events/${TEST_EVENT_ID}`);

    expect(res.status).toBe(200);
    // notificationService called with 'event_cancelled'
    expect(mockSendToMany).toHaveBeenCalledTimes(1);
    expect(mockSendToMany.mock.calls[0][1]).toBe('event_cancelled');
    // Audit log row with correct timing flags
    expect(mockEventAuditLogCreate).toHaveBeenCalledTimes(1);
    const auditRow = mockEventAuditLogCreate.mock.calls[0][0];
    expect(auditRow.action).toBe('delete');
    expect(auditRow.was_after_start).toBe(false);
    expect(auditRow.was_within_15min_grace).toBe(false);
    expect(auditRow.suppressed_email).toBe(false);
    // 87.5 Req 9: the audit actor is the caller's Users.id UUID, NOT the Auth0 sub.
    expect(auditRow.actor_user_id).toBe(TEST_CALLER_UUID);
    expect(auditRow.actor_user_id).toMatch(UUID_RE);
    expect(auditRow.actor_user_id).not.toBe('auth0|tester');
    expect(auditRow.event_snapshot.id).toBe(TEST_EVENT_ID);
    expect(event.destroy).toHaveBeenCalled();
  });

  // Test 2: Cancellation within 15-min grace AFTER start
  it('still fires cancellation emails when start is 5 min ago (within 15-min grace)', async () => {
    const event = buildEvent({ startOffsetMs: -5 * 60 * 1000 }); // -5min
    mockEventFindByPk.mockResolvedValue(event);

    const res = await request(app).delete(`/api/events/${TEST_EVENT_ID}`);

    expect(res.status).toBe(200);
    expect(mockSendToMany).toHaveBeenCalledTimes(1);
    expect(mockSendToMany.mock.calls[0][1]).toBe('event_cancelled');
    const auditRow = mockEventAuditLogCreate.mock.calls[0][0];
    expect(auditRow.was_after_start).toBe(true);
    expect(auditRow.was_within_15min_grace).toBe(true);
    expect(auditRow.suppressed_email).toBe(false);
  });

  // Test 3: Silent cancellation after 15-min grace
  it('SUPPRESSES cancellation emails when start is 30 min ago (past grace), still writes audit log', async () => {
    const event = buildEvent({ startOffsetMs: -30 * 60 * 1000 }); // -30min
    mockEventFindByPk.mockResolvedValue(event);

    const res = await request(app).delete(`/api/events/${TEST_EVENT_ID}`);

    expect(res.status).toBe(200);
    // No cancellation email fan-out
    expect(mockSendToMany).not.toHaveBeenCalled();
    // But audit log STILL written (the whole point)
    expect(mockEventAuditLogCreate).toHaveBeenCalledTimes(1);
    const auditRow = mockEventAuditLogCreate.mock.calls[0][0];
    expect(auditRow.was_after_start).toBe(true);
    expect(auditRow.was_within_15min_grace).toBe(false);
    expect(auditRow.suppressed_email).toBe(true);
    expect(event.destroy).toHaveBeenCalled();
  });
});

describe('Event lifecycle: update cutoff', () => {
  // Test 4: Update before start fires emails
  it('fires update emails when event is 2h in the future and start_date changes', async () => {
    const oldStart = new Date(Date.now() + 2 * 60 * 60 * 1000); // +2h
    const newStart = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const event = {
      id: TEST_EVENT_ID,
      group_id: TEST_GROUP_ID,
      game_id: TEST_GAME_ID,
      start_date: oldStart,
      duration_minutes: 60,
      update: jest.fn().mockResolvedValue({}),
    };
    // First findByPk returns the event for permission check.
    // Second findByPk (after update) returns the updated event for response shape.
    mockEventFindByPk
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({
        ...event,
        EventParticipations: [],
        toJSON: () => ({ id: event.id, custom_participants: [] }),
      });

    const res = await request(app)
      .put(`/api/events/${TEST_EVENT_ID}`)
      .send({ start_date: newStart, duration_minutes: 60 });

    expect(res.status).toBe(200);
    expect(mockSendToMany).toHaveBeenCalledTimes(1);
    expect(mockSendToMany.mock.calls[0][1]).toBe('event_updated');
  });

  // Test 5: Silent update after start
  it('SUPPRESSES update emails when event already started 5 min ago', async () => {
    const oldStart = new Date(Date.now() - 5 * 60 * 1000); // -5min
    const newStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const event = {
      id: TEST_EVENT_ID,
      group_id: TEST_GROUP_ID,
      game_id: TEST_GAME_ID,
      start_date: oldStart,
      duration_minutes: 60,
      update: jest.fn().mockResolvedValue({}),
    };
    mockEventFindByPk
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({
        ...event,
        EventParticipations: [],
        toJSON: () => ({ id: event.id, custom_participants: [] }),
      });

    const res = await request(app)
      .put(`/api/events/${TEST_EVENT_ID}`)
      .send({ start_date: newStart, duration_minutes: 60 });

    expect(res.status).toBe(200);
    // No update email fan-out — old start is in the past
    expect(mockSendToMany).not.toHaveBeenCalled();
  });
});

describe('MAIL-04: 12h time format with timezone in event email templates', () => {
  // Test 6: Both templates render 12h time with timezone abbreviation.
  it('renders 7:30 PM MDT in generateGameSessionEmailTemplate and generateDateChangeEmailTemplate', () => {
    const emailService = require('../../services/emailService');

    const sessionResult = emailService.generateGameSessionEmailTemplate({
      gameName: 'Catan',
      groupName: 'Test Group',
      startDate: '2026-06-01T01:30:00Z', // UTC -> MDT 7:30 PM (May 31 evening Denver)
      durationMinutes: 60,
      location: null,
      comments: null,
      eventUrl: 'https://example.com/event',
      recipientName: 'Alice',
      rsvpUrls: null,
      ballotUrl: null,
      timezone: 'America/Denver',
    });
    // Verify HTML contains the 12h-with-tz string and NOT the 24h equivalent
    expect(sessionResult.html).toContain('7:30 PM MDT');
    expect(sessionResult.html).toContain('8:30 PM MDT');
    expect(sessionResult.html).not.toContain('19:30');
    expect(sessionResult.text).toContain('7:30 PM MDT');

    const dateChangeResult = emailService.generateDateChangeEmailTemplate({
      gameName: 'Catan',
      groupName: 'Test Group',
      newDate: '2026-06-01T01:30:00Z',
      durationMinutes: 60,
      eventUrl: 'https://example.com/event',
      recipientName: 'Alice',
      rsvpUrls: null,
      timezone: 'America/Denver',
    });
    expect(dateChangeResult.html).toContain('7:30 PM MDT');
    expect(dateChangeResult.html).toContain('8:30 PM MDT');
    expect(dateChangeResult.html).not.toContain('19:30');
    expect(dateChangeResult.text).toContain('7:30 PM MDT');
  });
});
