// tests/routes/twilioWebhook.test.js
// Integration tests for the Twilio inbound SMS webhook handler

process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

// ---- Mocks ----

// Mock twilio so twilio.webhook() returns a pass-through middleware
jest.mock('twilio', () => {
  const MessagingResponse = class {
    constructor() { this.messages = []; }
    message(text) { this.messages.push(text); }
    toString() {
      return `<?xml version="1.0" encoding="UTF-8"?><Response>${this.messages.map(m => `<Message>${m}</Message>`).join('')}</Response>`;
    }
  };

  const twilioFn = () => ({});
  twilioFn.webhook = () => (req, res, next) => next();
  twilioFn.twiml = { MessagingResponse };
  return twilioFn;
});

// Mock rate limiter to pass through
jest.mock('../../middleware/rateLimiter', () => ({
  smsInboundLimiter: (req, res, next) => next(),
}));

// Mock models
const mockUserFindOne = jest.fn();
const mockSentNotificationFindOne = jest.fn();
const mockEventRsvpFindOne = jest.fn();
const mockEventRsvpCreate = jest.fn();

jest.mock('../../models', () => ({
  User: { findOne: (...args) => mockUserFindOne(...args) },
  Event: {},
  EventRsvp: {
    findOne: (...args) => mockEventRsvpFindOne(...args),
    create: (...args) => mockEventRsvpCreate(...args),
  },
  SentNotification: { findOne: (...args) => mockSentNotificationFindOne(...args) },
  Game: {},
  EmailMetrics: {},
}));

// Mock smsReplyParser
const mockParseReply = jest.fn();
jest.mock('../../services/smsReplyParser', () => ({
  parseReply: (...args) => mockParseReply(...args),
}));

// ---- App setup ----
const webhooksRoutes = require('../../routes/webhooks');
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/api/webhooks', webhooksRoutes);

// ---- Helpers ----
const postSms = (body) =>
  request(app)
    .post('/api/webhooks/twilio/sms')
    .type('form')
    .send(body);

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago

const mockUser = {
  id: 'user-uuid-123', // Users.id (UUID) — EventRsvp is keyed on user_uuid (Phase 87.1)
  user_id: 'auth0|test-user-123',
  phone: '+15551234567',
  sms_enabled: true,
  save: jest.fn(),
};

const mockEvent = {
  id: 'event-uuid-1',
  group_id: 'group-uuid-1',
  start_date: futureDate,
  status: 'scheduled',
  Game: { name: 'Catan' },
};

const mockNotification = {
  Event: mockEvent,
};

// ---- Tests ----
describe('Twilio Inbound SMS Webhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mutable mock properties
    mockUser.sms_enabled = true;
    mockUser.save = jest.fn();
    mockEvent.start_date = futureDate;
    mockEvent.Game = { name: 'Catan' };
  });

  // Test 1: Unknown phone number
  it('returns empty TwiML for unknown phone number', async () => {
    mockUserFindOne.mockResolvedValue(null);

    const res = await postSms({ From: '+15559999999', Body: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toBe('<Response/>');
    expect(mockUserFindOne).toHaveBeenCalled();
  });

  // Test 2: Valid RSVP "1" (yes)
  it('records RSVP as Yes when user replies "1"', async () => {
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'yes' });
    mockSentNotificationFindOne.mockResolvedValue(mockNotification);
    mockEventRsvpFindOne.mockResolvedValue(null);
    mockEventRsvpCreate.mockResolvedValue({});

    const res = await postSms({ From: '+15551234567', Body: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain('RSVP recorded: Yes');
    expect(res.text).toContain('Catan');
    expect(mockEventRsvpCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'event-uuid-1',
        user_uuid: 'user-uuid-123', // Phase 87.1 (Plan 09): create payload keyed on user_uuid = user.id
        status: 'yes',
      })
    );
    // Plan 09: the old Auth0-string user_id column was removed — it must NOT be written.
    expect(mockEventRsvpCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ user_id: expect.anything() })
    );
  });

  // Test 3: Valid RSVP "2" (no)
  it('records RSVP as No when user replies "2"', async () => {
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'no' });
    mockSentNotificationFindOne.mockResolvedValue(mockNotification);
    mockEventRsvpFindOne.mockResolvedValue(null);
    mockEventRsvpCreate.mockResolvedValue({});

    const res = await postSms({ From: '+15551234567', Body: '2' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('RSVP recorded: No');
    expect(mockEventRsvpCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'no' })
    );
  });

  // Test 4: Valid RSVP "3" (maybe)
  it('records RSVP as Maybe when user replies "3"', async () => {
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'maybe' });
    mockSentNotificationFindOne.mockResolvedValue(mockNotification);
    mockEventRsvpFindOne.mockResolvedValue(null);
    mockEventRsvpCreate.mockResolvedValue({});

    const res = await postSms({ From: '+15551234567', Body: '3' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('RSVP recorded: Maybe');
    expect(mockEventRsvpCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'maybe' })
    );
  });

  // Test 5: RSVP updates existing record
  it('updates existing RSVP instead of creating new one', async () => {
    const existingRsvp = { update: jest.fn().mockResolvedValue({}) };
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'yes' });
    mockSentNotificationFindOne.mockResolvedValue(mockNotification);
    mockEventRsvpFindOne.mockResolvedValue(existingRsvp);

    const res = await postSms({ From: '+15551234567', Body: 'yes' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('RSVP recorded: Yes');
    expect(existingRsvp.update).toHaveBeenCalledWith({ status: 'yes' });
    expect(mockEventRsvpCreate).not.toHaveBeenCalled();
  });

  // Test 6: Unrecognized text
  it('returns help message for unrecognized text', async () => {
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'unknown' });

    const res = await postSms({ From: '+15551234567', Body: 'what is this' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toContain('Reply 1=Yes, 2=No, 3=Maybe');
    expect(res.text).toContain('STOP');
  });

  // Test 7: STOP opt-out
  it('disables SMS and confirms unsubscribe on STOP', async () => {
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'opt_out' });

    const res = await postSms({ From: '+15551234567', Body: 'STOP' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('unsubscribed');
    expect(mockUser.sms_enabled).toBe(false);
    expect(mockUser.save).toHaveBeenCalled();
  });

  // Test 8: No recent event notification
  it('returns no upcoming events message when no SentNotification found', async () => {
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'yes' });
    mockSentNotificationFindOne.mockResolvedValue(null);

    const res = await postSms({ From: '+15551234567', Body: '1' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('No upcoming events to RSVP for right now');
  });

  // Test 9: Stale event (past date)
  it('returns event-passed message for stale event reply', async () => {
    const pastNotification = {
      Event: { ...mockEvent, start_date: pastDate, Game: { name: 'Catan' }, group_id: 'group-uuid-1' },
    };
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'yes' });
    mockSentNotificationFindOne.mockResolvedValue(pastNotification);

    const res = await postSms({ From: '+15551234567', Body: '1' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('That event has already passed');
  });

  // Test 10: Error handling -- graceful failure
  it('returns empty TwiML when an error occurs', async () => {
    mockUserFindOne.mockRejectedValue(new Error('Database connection failed'));

    const res = await postSms({ From: '+15551234567', Body: '1' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.text).toBe('<Response/>');
  });

  // Test 11: Event with no Game association falls back to "Game Night"
  it('uses "Game Night" fallback when event has no Game association', async () => {
    const noGameNotification = {
      Event: { ...mockEvent, Game: null },
    };
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'yes' });
    mockSentNotificationFindOne.mockResolvedValue(noGameNotification);
    mockEventRsvpFindOne.mockResolvedValue(null);
    mockEventRsvpCreate.mockResolvedValue({});

    const res = await postSms({ From: '+15551234567', Body: '1' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Game Night');
    expect(res.text).toContain('RSVP recorded: Yes');
  });

  // Test 12: Confirmation does NOT include a URL.
  // The original SMS the user replied to already carries the event-detail link;
  // repeating a (broken) link in the confirmation just adds clutter and segments.
  it('does not include a URL in RSVP confirmation', async () => {
    mockUserFindOne.mockResolvedValue(mockUser);
    mockParseReply.mockReturnValue({ type: 'rsvp', status: 'yes' });
    mockSentNotificationFindOne.mockResolvedValue(mockNotification);
    mockEventRsvpFindOne.mockResolvedValue(null);
    mockEventRsvpCreate.mockResolvedValue({});

    const res = await postSms({ From: '+15551234567', Body: '1' });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('http');
    expect(res.text).not.toContain('groupHomePage');
  });
});
