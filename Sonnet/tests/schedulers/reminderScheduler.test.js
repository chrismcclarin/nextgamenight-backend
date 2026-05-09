// tests/schedulers/reminderScheduler.test.js
// Unit tests for reminderScheduler with mocked models and smsService

// Mock models before requiring the scheduler
const mockEventFindAll = jest.fn();
const mockRsvpUpdate = jest.fn();

jest.mock('../../models', () => ({
  Event: { findAll: mockEventFindAll },
  EventRsvp: {},
  User: {},
  Game: {},
  Group: {},
  Op: require('sequelize').Op
}));

const mockSmsServiceSend = jest.fn();
const mockSmsServiceIsConfigured = jest.fn();

jest.mock('../../services/smsService', () => ({
  send: mockSmsServiceSend,
  isConfigured: mockSmsServiceIsConfigured
}));

// Mock node-cron so it doesn't actually schedule anything
jest.mock('node-cron', () => ({
  schedule: jest.fn((interval, callback, options) => ({
    start: jest.fn(),
    stop: jest.fn(),
    _callback: callback
  }))
}));

const { processUpcomingReminders, formatTimeUntil } = require('../../schedulers/reminderScheduler');

describe('reminderScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSmsServiceIsConfigured.mockReturnValue(true);
    mockSmsServiceSend.mockResolvedValue({ success: true, sid: 'SM_TEST_123' });
    process.env.FRONTEND_URL = 'https://example.com';
  });

  afterEach(() => {
    delete process.env.FRONTEND_URL;
  });

  // Helper: create a mock event with RSVPs
  function createMockEvent({
    startDate,
    gameName = 'Catan',
    groupName = 'Board Gamers',
    groupId = 'group-uuid-1',
    rsvps = []
  }) {
    return {
      id: 'event-uuid-1',
      start_date: startDate,
      Game: gameName ? { name: gameName } : null,
      Group: groupName ? { id: groupId, name: groupName } : null,
      EventRsvps: rsvps.map(rsvp => ({
        id: rsvp.id || 'rsvp-uuid-1',
        status: rsvp.status || 'yes',
        reminder_sent_at: rsvp.reminder_sent_at || null,
        User: rsvp.user || {
          user_id: 'auth0|user1',
          phone: '+15551234567',
          sms_enabled: true,
          phone_verified: true,
          notification_preferences: { reminder: { sms: true } }
        },
        update: mockRsvpUpdate
      }))
    };
  }

  describe('processUpcomingReminders', () => {
    test('sends SMS to RSVP\'d users within reminder window', async () => {
      const thirtyMinFromNow = new Date(Date.now() + 30 * 60000);

      mockEventFindAll.mockResolvedValue([
        createMockEvent({
          startDate: thirtyMinFromNow,
          rsvps: [{
            user: {
              user_id: 'auth0|user1',
              phone: '+15551234567',
              sms_enabled: true,
              phone_verified: true,
              notification_preferences: { reminder: { sms: true } }
            }
          }]
        })
      ]);

      await processUpcomingReminders();

      expect(mockSmsServiceSend).toHaveBeenCalledTimes(1);
      expect(mockSmsServiceSend).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '+15551234567',
          type: 'reminder',
          data: expect.objectContaining({
            eventName: 'Catan',
            groupName: 'Board Gamers',
            rsvpPrompt: true,
            eventUrl: expect.stringContaining('https://example.com')
          })
        })
      );

      expect(mockRsvpUpdate).toHaveBeenCalledTimes(1);
      expect(mockRsvpUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          reminder_sent_at: expect.any(Date)
        })
      );
    });

    test('skips users outside their reminder window', async () => {
      // Event starting in 12 hours, user with default 1hr window
      const twelveHoursFromNow = new Date(Date.now() + 12 * 3600000);

      mockEventFindAll.mockResolvedValue([
        createMockEvent({
          startDate: twelveHoursFromNow,
          rsvps: [{
            user: {
              user_id: 'auth0|user1',
              phone: '+15551234567',
              sms_enabled: true,
              phone_verified: true,
              notification_preferences: { reminder: { sms: true } } // defaults to 1 hour window
            }
          }]
        })
      ]);

      await processUpcomingReminders();

      expect(mockSmsServiceSend).not.toHaveBeenCalled();
      expect(mockRsvpUpdate).not.toHaveBeenCalled();
    });

    test('skips already-reminded RSVPs (handled by query WHERE clause)', async () => {
      // This test verifies the query returns no events when all RSVPs are already reminded
      // The WHERE clause filters reminder_sent_at: null, so the query returns empty
      mockEventFindAll.mockResolvedValue([]);

      await processUpcomingReminders();

      expect(mockSmsServiceSend).not.toHaveBeenCalled();
    });

    test('respects user\'s custom reminder window', async () => {
      // User has a 3-hour window, event starting in 2 hours
      const twoHoursFromNow = new Date(Date.now() + 2 * 3600000);

      mockEventFindAll.mockResolvedValue([
        createMockEvent({
          startDate: twoHoursFromNow,
          rsvps: [{
            user: {
              user_id: 'auth0|user1',
              phone: '+15551234567',
              sms_enabled: true,
              phone_verified: true,
              notification_preferences: {
                reminder: { window_hours: 3, sms: true }
              }
            }
          }]
        })
      ]);

      await processUpcomingReminders();

      expect(mockSmsServiceSend).toHaveBeenCalledTimes(1);
      expect(mockRsvpUpdate).toHaveBeenCalledTimes(1);
    });

    test('handles smsService failures gracefully (result.success === false)', async () => {
      const thirtyMinFromNow = new Date(Date.now() + 30 * 60000);

      mockSmsServiceSend.mockResolvedValue({ success: false, error: 'Invalid phone number' });

      mockEventFindAll.mockResolvedValue([
        createMockEvent({
          startDate: thirtyMinFromNow,
          rsvps: [{
            user: {
              user_id: 'auth0|user1',
              phone: '+15551234567',
              sms_enabled: true,
              phone_verified: true,
              notification_preferences: { reminder: { sms: true } }
            }
          }]
        })
      ]);

      // Should not throw
      await expect(processUpcomingReminders()).resolves.not.toThrow();

      expect(mockSmsServiceSend).toHaveBeenCalledTimes(1);
      // reminder_sent_at should NOT be updated so it retries next run
      expect(mockRsvpUpdate).not.toHaveBeenCalled();
    });

    test('handles smsService thrown errors gracefully', async () => {
      const thirtyMinFromNow = new Date(Date.now() + 30 * 60000);

      mockSmsServiceSend.mockRejectedValue(new Error('Network timeout'));

      mockEventFindAll.mockResolvedValue([
        createMockEvent({
          startDate: thirtyMinFromNow,
          rsvps: [{
            user: {
              user_id: 'auth0|user1',
              phone: '+15551234567',
              sms_enabled: true,
              phone_verified: true,
              notification_preferences: { reminder: { sms: true } }
            }
          }]
        })
      ]);

      // Should not throw
      await expect(processUpcomingReminders()).resolves.not.toThrow();

      expect(mockSmsServiceSend).toHaveBeenCalledTimes(1);
      // reminder_sent_at should NOT be updated so it retries next run
      expect(mockRsvpUpdate).not.toHaveBeenCalled();
    });

    test('sends to multiple RSVPs across multiple events', async () => {
      const fortyMinFromNow = new Date(Date.now() + 40 * 60000);
      const fiftyMinFromNow = new Date(Date.now() + 50 * 60000);

      const mockUpdate1 = jest.fn();
      const mockUpdate2 = jest.fn();
      const mockUpdate3 = jest.fn();

      mockEventFindAll.mockResolvedValue([
        {
          id: 'event-1',
          start_date: fortyMinFromNow,
          Game: { name: 'Catan' },
          Group: { id: 'g1', name: 'Group A' },
          EventRsvps: [
            {
              id: 'rsvp-1',
              status: 'yes',
              reminder_sent_at: null,
              User: { user_id: 'auth0|u1', phone: '+15551111111', sms_enabled: true, phone_verified: true, notification_preferences: { reminder: { sms: true } } },
              update: mockUpdate1
            },
            {
              id: 'rsvp-2',
              status: 'maybe',
              reminder_sent_at: null,
              User: { user_id: 'auth0|u2', phone: '+15552222222', sms_enabled: true, phone_verified: true, notification_preferences: { reminder: { sms: true } } },
              update: mockUpdate2
            }
          ]
        },
        {
          id: 'event-2',
          start_date: fiftyMinFromNow,
          Game: { name: 'Wingspan' },
          Group: { id: 'g2', name: 'Group B' },
          EventRsvps: [
            {
              id: 'rsvp-3',
              status: 'yes',
              reminder_sent_at: null,
              User: { user_id: 'auth0|u3', phone: '+15553333333', sms_enabled: true, phone_verified: true, notification_preferences: { reminder: { sms: true } } },
              update: mockUpdate3
            }
          ]
        }
      ]);

      await processUpcomingReminders();

      expect(mockSmsServiceSend).toHaveBeenCalledTimes(3);
      expect(mockUpdate1).toHaveBeenCalledTimes(1);
      expect(mockUpdate2).toHaveBeenCalledTimes(1);
      expect(mockUpdate3).toHaveBeenCalledTimes(1);
    });

    test('skips sending when smsService is not configured', async () => {
      const thirtyMinFromNow = new Date(Date.now() + 30 * 60000);

      mockSmsServiceIsConfigured.mockReturnValue(false);

      mockEventFindAll.mockResolvedValue([
        createMockEvent({
          startDate: thirtyMinFromNow,
          rsvps: [{
            user: {
              user_id: 'auth0|user1',
              phone: '+15551234567',
              sms_enabled: true,
              phone_verified: true,
              notification_preferences: { reminder: { sms: true } }
            }
          }]
        })
      ]);

      await processUpcomingReminders();

      expect(mockSmsServiceSend).not.toHaveBeenCalled();
      expect(mockRsvpUpdate).not.toHaveBeenCalled();
    });

    test('uses "Game Night" fallback when event has no Game', async () => {
      const thirtyMinFromNow = new Date(Date.now() + 30 * 60000);

      mockEventFindAll.mockResolvedValue([
        createMockEvent({
          startDate: thirtyMinFromNow,
          gameName: null,
          rsvps: [{
            user: {
              user_id: 'auth0|user1',
              phone: '+15551234567',
              sms_enabled: true,
              phone_verified: true,
              notification_preferences: { reminder: { sms: true } }
            }
          }]
        })
      ]);

      await processUpcomingReminders();

      expect(mockSmsServiceSend).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventName: 'Game Night'
          })
        })
      );
    });
  });

  describe('formatTimeUntil', () => {
    test('formats time less than 60 minutes', () => {
      const now = new Date('2026-03-29T12:00:00Z');
      const event = new Date('2026-03-29T12:30:00Z');
      expect(formatTimeUntil(event, now)).toBe('in about 30 minutes');
    });

    test('formats time around 1 hour', () => {
      const now = new Date('2026-03-29T12:00:00Z');
      const event = new Date('2026-03-29T13:10:00Z');
      expect(formatTimeUntil(event, now)).toBe('in about 1 hour');
    });

    test('formats 2-6 hours', () => {
      const now = new Date('2026-03-29T12:00:00Z');
      const event = new Date('2026-03-29T15:00:00Z');
      expect(formatTimeUntil(event, now)).toBe('in 3 hours');
    });

    test('formats same-day events beyond 6 hours', () => {
      const now = new Date('2026-03-29T08:00:00Z');
      const event = new Date('2026-03-29T19:00:00Z');
      expect(formatTimeUntil(event, now)).toBe('today at 7 PM');
    });

    test('formats next-day events', () => {
      const now = new Date('2026-03-29T22:00:00Z');
      const event = new Date('2026-03-30T07:30:00Z');
      expect(formatTimeUntil(event, now)).toBe('tomorrow at 7:30 AM');
    });
  });
});
