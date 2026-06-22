// tests/services/smsService.test.js
// Unit tests for smsService with mocked Twilio SDK

const mockCreate = jest.fn().mockResolvedValue({ sid: 'SM_TEST_123' });
jest.mock('twilio', () => {
  return jest.fn(() => ({
    messages: {
      create: mockCreate
    }
  }));
});

describe('smsService', () => {

  let smsService;

  beforeAll(() => {
    // Reset module registry to get a fresh instance with mocked twilio
    jest.resetModules();

    // Set env vars before requiring the service
    process.env.TWILIO_ACCOUNT_SID = 'AC_TEST_SID';
    process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
    process.env.TWILIO_PHONE_NUMBER = '+15005550006';

    // Re-mock twilio after resetModules
    jest.mock('twilio', () => {
      return jest.fn(() => ({
        messages: {
          create: mockCreate
        }
      }));
    });

    smsService = require('../../services/smsService');
  });

  afterAll(() => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
  });

  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({ sid: 'SM_TEST_123' });
  });

  // =============================================
  // buildMessage tests
  // =============================================
  describe('buildMessage', () => {

    it('renders event_confirmation template with game name and date', () => {
      const msg = smsService.buildMessage('event_confirmation', {
        gameName: 'Catan',
        date: 'Friday April 4th'
      });
      expect(msg).toContain('Catan');
      expect(msg).toContain('Friday April 4th');
      expect(msg).toContain('NextGameNight');
    });

    it('renders all notification types without error', () => {
      const types = [
        'event_confirmation',
        'reminder',
        'availability_prompt',
        'no_consensus',
        'group_invite',
        'rsvp_magic_link',
        'friend_request',
        'event_created',
        'event_updated',
        'event_cancelled'
      ];

      const testData = {
        gameName: 'Catan',
        date: 'Friday',
        groupName: 'Board Gamers',
        inviterName: 'Alice',
        requesterName: 'Bob',
        actionUrl: 'https://app.test/action',
        // Phase 50 event template fields
        eventName: 'Catan',
        dateTime: 'Friday',
        eventUrl: 'https://app.test/events/123',
        timeUntil: 'tomorrow'
      };

      types.forEach((type) => {
        const msg = smsService.buildMessage(type, testData);
        expect(typeof msg).toBe('string');
        expect(msg.length).toBeGreaterThan(0);
        expect(msg.length).toBeLessThanOrEqual(306);
      });
    });

    it('truncates messages over 306 characters', () => {
      const msg = smsService.buildMessage('event_confirmation', {
        gameName: 'A Very Long Game Name That Goes On And On And On And Takes Up Lots Of Characters And Even More Characters To Really Push It Over The Limit Of Three Hundred And Six Characters Which Is Two GSM Seven Segments Worth Of Text Content In A Single Message Body Field',
        date: 'Saturday March 29th 2026 at 7:00 PM Eastern Standard Time',
        actionUrl: 'https://nextgamenight.app/events/some-really-long-uuid-here-with-extra-path-segments/additional'
      });
      expect(msg.length).toBeLessThanOrEqual(306);
      expect(msg).toMatch(/\.\.\.$/);
    });

    it('returns fallback for unknown type', () => {
      const msg = smsService.buildMessage('unknown_type', { actionUrl: 'https://app.test' });
      expect(msg).toContain('NextGameNight');
      expect(msg).toContain('notification');
    });
  });

  // =============================================
  // BSEC-04 / B8: legacy (Phase 49) templates sanitize user content
  // The legacy templates must route user-supplied fields through
  // sanitizeForSms, mirroring the Phase 50 event templates. We prove this
  // by feeding emoji / smart-quote payloads and asserting they are stripped
  // (the GSM-7-unsafe chars are removed exactly as sanitizeForSms does).
  // =============================================
  describe('legacy templates sanitize user content (BSEC-04)', () => {

    it('event_confirmation sanitizes gameName', () => {
      const msg = smsService.buildMessage('event_confirmation', {
        gameName: 'Catan 🎲', // "Catan 🎲"
        date: 'Friday',
        actionUrl: 'https://app.test/a'
      });
      expect(msg).toContain('Catan');
      expect(msg).not.toMatch(/[\uD800-\uDFFF]/); // no surrogate-pair emoji survive
    });

    it('availability_prompt sanitizes groupName', () => {
      const msg = smsService.buildMessage('availability_prompt', {
        groupName: 'Gamers 🎲',
        actionUrl: 'https://app.test/a'
      });
      expect(msg).toContain('Gamers');
      expect(msg).not.toMatch(/[\uD800-\uDFFF]/);
    });

    it('no_consensus sanitizes groupName', () => {
      const msg = smsService.buildMessage('no_consensus', {
        groupName: 'Gamers 🎲',
        actionUrl: 'https://app.test/a'
      });
      expect(msg).toContain('Gamers');
      expect(msg).not.toMatch(/[\uD800-\uDFFF]/);
    });

    it('group_invite sanitizes inviterName and groupName', () => {
      const msg = smsService.buildMessage('group_invite', {
        inviterName: 'Alice 🎲',
        groupName: 'Gamers 🎲',
        actionUrl: 'https://app.test/a'
      });
      expect(msg).toContain('Alice');
      expect(msg).toContain('Gamers');
      expect(msg).not.toMatch(/[\uD800-\uDFFF]/);
    });

    it('rsvp_magic_link sanitizes gameName', () => {
      const msg = smsService.buildMessage('rsvp_magic_link', {
        gameName: 'Catan 🎲',
        date: 'Friday',
        actionUrl: 'https://app.test/a'
      });
      expect(msg).toContain('Catan');
      expect(msg).not.toMatch(/[\uD800-\uDFFF]/);
    });

    it('friend_request sanitizes requesterName', () => {
      const msg = smsService.buildMessage('friend_request', {
        requesterName: 'Bob 🎲',
        actionUrl: 'https://app.test/a'
      });
      expect(msg).toContain('Bob');
      expect(msg).not.toMatch(/[\uD800-\uDFFF]/);
    });
  });

  // =============================================
  // send tests (with mocked Twilio)
  // =============================================
  describe('send', () => {

    it('calls twilio messages.create with correct params when configured', async () => {
      const result = await smsService.send({
        to: '+14155551234',
        type: 'event_confirmation',
        data: { gameName: 'Catan', date: 'Friday' }
      });

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith({
        body: expect.stringContaining('Catan'),
        to: '+14155551234',
        from: '+15005550006'
      });
      expect(result).toEqual({ success: true, sid: 'SM_TEST_123' });
    });

    it('returns success false when not configured (no env vars)', () => {
      // Create a fresh instance without credentials
      jest.resetModules();

      // Clear env
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_PHONE_NUMBER;

      jest.mock('twilio', () => {
        return jest.fn(() => ({
          messages: { create: mockCreate }
        }));
      });

      const unconfiguredService = require('../../services/smsService');
      expect(unconfiguredService.isConfigured()).toBe(false);

      // Restore for other tests
      process.env.TWILIO_ACCOUNT_SID = 'AC_TEST_SID';
      process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
      process.env.TWILIO_PHONE_NUMBER = '+15005550006';
    });
  });

  // =============================================
  // Event notification template tests (Phase 50)
  // =============================================
  describe('event notification templates', () => {

    const baseData = {
      eventName: 'Board Game Night',
      groupName: 'Friday Gamers',
      dateTime: 'Fri Apr 10 at 7pm',
      eventUrl: 'https://nextgamenight.app/events/abc123',
      rsvpPrompt: true,
      timeUntil: 'tomorrow'
    };

    // --- event_created ---
    describe('event_created', () => {

      it('includes event name, group name, date/time, and event URL', () => {
        const msg = smsService.buildMessage('event_created', baseData);
        expect(msg).toContain('Board Game Night');
        expect(msg).toContain('Friday Gamers');
        expect(msg).toContain('Fri Apr 10 at 7pm');
        expect(msg).toContain('https://nextgamenight.app/events/abc123');
      });

      it('includes RSVP prompt when rsvpPrompt is true', () => {
        const msg = smsService.buildMessage('event_created', { ...baseData, rsvpPrompt: true });
        expect(msg).toContain('Reply 1=Yes, 2=No, 3=Maybe');
      });

      it('omits RSVP prompt when rsvpPrompt is false', () => {
        const msg = smsService.buildMessage('event_created', { ...baseData, rsvpPrompt: false });
        expect(msg).not.toContain('Reply 1=Yes, 2=No, 3=Maybe');
      });

      it('uses casual tone (starts with "Hey!")', () => {
        const msg = smsService.buildMessage('event_created', baseData);
        expect(msg).toMatch(/^Hey!/);
      });

      it('stays within 306 characters', () => {
        const msg = smsService.buildMessage('event_created', baseData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });
    });

    // --- event_updated ---
    describe('event_updated', () => {

      it('includes event name, group name, date/time, and event URL', () => {
        const msg = smsService.buildMessage('event_updated', baseData);
        expect(msg).toContain('Board Game Night');
        expect(msg).toContain('Friday Gamers');
        expect(msg).toContain('Fri Apr 10 at 7pm');
        expect(msg).toContain('https://nextgamenight.app/events/abc123');
      });

      it('does NOT include RSVP prompt', () => {
        const msg = smsService.buildMessage('event_updated', { ...baseData, rsvpPrompt: true });
        expect(msg).not.toContain('Reply 1=Yes, 2=No, 3=Maybe');
      });

      it('uses casual tone (starts with "Heads up")', () => {
        const msg = smsService.buildMessage('event_updated', baseData);
        expect(msg).toMatch(/^Heads up/);
      });

      it('stays within 306 characters', () => {
        const msg = smsService.buildMessage('event_updated', baseData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });
    });

    // --- event_cancelled ---
    describe('event_cancelled', () => {

      it('includes event name, group name, and date/time', () => {
        const msg = smsService.buildMessage('event_cancelled', baseData);
        expect(msg).toContain('Board Game Night');
        expect(msg).toContain('Friday Gamers');
        expect(msg).toContain('Fri Apr 10 at 7pm');
      });

      it('does NOT include event URL or RSVP prompt', () => {
        const msg = smsService.buildMessage('event_cancelled', { ...baseData, rsvpPrompt: true });
        expect(msg).not.toContain('https://nextgamenight.app/events/abc123');
        expect(msg).not.toContain('Reply 1=Yes, 2=No, 3=Maybe');
      });

      it('uses casual tone (starts with "Bummer")', () => {
        const msg = smsService.buildMessage('event_cancelled', baseData);
        expect(msg).toMatch(/^Bummer/);
      });

      it('stays within 306 characters', () => {
        const msg = smsService.buildMessage('event_cancelled', baseData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });
    });

    // --- reminder (Phase 50 version with group name) ---
    describe('reminder (event notification)', () => {

      it('includes event name, group name, timeUntil, and event URL', () => {
        const msg = smsService.buildMessage('reminder', baseData);
        expect(msg).toContain('Board Game Night');
        expect(msg).toContain('Friday Gamers');
        expect(msg).toContain('tomorrow');
        expect(msg).toContain('https://nextgamenight.app/events/abc123');
      });

      it('includes RSVP prompt when rsvpPrompt is true', () => {
        const msg = smsService.buildMessage('reminder', { ...baseData, rsvpPrompt: true });
        expect(msg).toContain('Reply 1=Yes, 2=No, 3=Maybe');
      });

      it('omits RSVP prompt when rsvpPrompt is false', () => {
        const msg = smsService.buildMessage('reminder', { ...baseData, rsvpPrompt: false });
        expect(msg).not.toContain('Reply 1=Yes, 2=No, 3=Maybe');
      });

      it('uses casual tone (starts with "Reminder:")', () => {
        const msg = smsService.buildMessage('reminder', baseData);
        expect(msg).toMatch(/^Reminder:/);
      });

      it('stays within 306 characters', () => {
        const msg = smsService.buildMessage('reminder', baseData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });
    });

    // --- Character budget with long realistic data ---
    describe('character budget (long data)', () => {

      const longData = {
        eventName: 'Twilight Imperium Fourth Edition',
        groupName: 'Portland Board Game Enthusiasts',
        dateTime: 'Saturday March 29th at 7:00 PM',
        eventUrl: 'https://nextgamenight.app/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        rsvpPrompt: true,
        timeUntil: 'in 2 hours'
      };

      it('event_created with long data stays within 306 chars', () => {
        const msg = smsService.buildMessage('event_created', longData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });

      it('event_updated with long data stays within 306 chars', () => {
        const msg = smsService.buildMessage('event_updated', longData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });

      it('event_cancelled with long data stays within 306 chars', () => {
        const msg = smsService.buildMessage('event_cancelled', longData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });

      it('reminder with long data stays within 306 chars', () => {
        const msg = smsService.buildMessage('reminder', longData);
        expect(msg.length).toBeLessThanOrEqual(306);
      });
    });
  });

  // =============================================
  // sanitizeForSms tests (Phase 50)
  // =============================================
  describe('sanitizeForSms', () => {

    let sanitizeForSms;

    beforeAll(() => {
      sanitizeForSms = require('../../utils/smsUtils').sanitizeForSms;
    });

    it('strips emoji from strings', () => {
      expect(sanitizeForSms('Game Night 🎲')).toBe('Game Night');
    });

    it('replaces smart double quotes with straight quotes', () => {
      expect(sanitizeForSms('\u201CHello\u201D')).toBe('"Hello"');
    });

    it('replaces smart single quotes with straight apostrophes', () => {
      expect(sanitizeForSms('\u2018don\u2019t')).toBe("'don't");
    });

    it('replaces em dashes with hyphens', () => {
      expect(sanitizeForSms('Game\u2014Night')).toBe('Game-Night');
    });

    it('replaces en dashes with hyphens', () => {
      expect(sanitizeForSms('Game\u2013Night')).toBe('Game-Night');
    });

    it('passes through plain ASCII unchanged', () => {
      expect(sanitizeForSms('Board Game Night 2026')).toBe('Board Game Night 2026');
    });

    it('handles null input gracefully', () => {
      expect(sanitizeForSms(null)).toBe('');
    });

    it('handles undefined input gracefully', () => {
      expect(sanitizeForSms(undefined)).toBe('');
    });

    it('handles empty string input', () => {
      expect(sanitizeForSms('')).toBe('');
    });

    it('trims whitespace', () => {
      expect(sanitizeForSms('  hello  ')).toBe('hello');
    });
  });

  // =============================================
  // isConfigured tests
  // =============================================
  describe('isConfigured', () => {

    it('returns false when client is not initialized', () => {
      jest.resetModules();

      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_PHONE_NUMBER;

      jest.mock('twilio', () => {
        return jest.fn(() => ({
          messages: { create: mockCreate }
        }));
      });

      const unconfiguredService = require('../../services/smsService');
      expect(unconfiguredService.isConfigured()).toBe(false);

      // Restore env
      process.env.TWILIO_ACCOUNT_SID = 'AC_TEST_SID';
      process.env.TWILIO_AUTH_TOKEN = 'test_auth_token';
      process.env.TWILIO_PHONE_NUMBER = '+15005550006';
    });
  });
});
