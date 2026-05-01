// tests/services/icsService.test.js
const {
  buildEventIcs,
  buildGoogleCalendarUrl,
  _internals: { escapeIcsText, formatIcsDate },
} = require('../../services/icsService');

describe('icsService', () => {
  describe('buildEventIcs', () => {
    const baseParams = {
      eventId: 'abc-123',
      gameName: 'Catan, Cities & Knights',
      groupName: 'Saturday Crew',
      startUtc: new Date('2026-06-01T18:00:00.000Z'),
      durationMinutes: 120,
      location: "Alex's house",
      description: 'Game night.',
      hostName: 'Alex',
      organizerEmail: 'schedule@nextgamenight.app',
    };

    it('returns a string with required VCALENDAR/VEVENT structure', () => {
      const ics = buildEventIcs(baseParams);
      expect(ics).toContain('BEGIN:VCALENDAR');
      expect(ics).toContain('VERSION:2.0');
      expect(ics).toContain('PRODID:-//NextGameNight//EN');
      expect(ics).toContain('METHOD:PUBLISH');
      expect(ics).toContain('BEGIN:VEVENT');
      expect(ics).toContain('UID:event-abc-123@nextgamenight.app');
      expect(ics).toContain('END:VEVENT');
      expect(ics).toContain('END:VCALENDAR');
      // CRLF line endings per RFC 5545
      expect(ics).toMatch(/\r\n/);
    });

    it('emits correct DTSTART and DTEND in YYYYMMDDTHHMMSSZ format', () => {
      const ics = buildEventIcs(baseParams);
      // 2026-06-01T18:00:00Z + 120min → 2026-06-01T20:00:00Z
      expect(ics).toContain('DTSTART:20260601T180000Z');
      expect(ics).toContain('DTEND:20260601T200000Z');
    });

    it('escapes commas in SUMMARY', () => {
      const ics = buildEventIcs(baseParams);
      // Comma in "Catan, Cities & Knights" must be escaped as \,
      expect(ics).toContain('SUMMARY:Catan\\, Cities & Knights — Saturday Crew');
    });

    it('omits LOCATION line when location is null/empty', () => {
      const ics = buildEventIcs({ ...baseParams, location: null });
      expect(ics).not.toMatch(/^LOCATION:/m);

      const ics2 = buildEventIcs({ ...baseParams, location: '' });
      expect(ics2).not.toMatch(/^LOCATION:/m);

      const ics3 = buildEventIcs({ ...baseParams, location: '   ' });
      expect(ics3).not.toMatch(/^LOCATION:/m);
    });

    it('emits LOCATION line when location is provided', () => {
      const ics = buildEventIcs(baseParams);
      expect(ics).toContain("LOCATION:Alex's house");
    });

    it('emits ORGANIZER with CN and mailto', () => {
      const ics = buildEventIcs(baseParams);
      expect(ics).toContain('ORGANIZER;CN=Alex:mailto:schedule@nextgamenight.app');
    });

    it('falls back to default description when not provided', () => {
      const ics = buildEventIcs({ ...baseParams, description: undefined });
      expect(ics).toContain(
        'DESCRIPTION:Game night with Saturday Crew on Nextgamenight.'
      );
    });
  });

  describe('buildGoogleCalendarUrl', () => {
    it('returns a properly formatted Google Calendar template URL', () => {
      const url = buildGoogleCalendarUrl({
        gameName: 'Catan',
        groupName: 'Saturday Crew',
        startUtc: new Date('2026-06-01T18:00:00.000Z'),
        durationMinutes: 120,
        location: "Alex's house",
        description: 'Game night.',
      });

      expect(url).toMatch(/^https:\/\/calendar\.google\.com\/calendar\/render\?/);
      expect(url).toContain('action=TEMPLATE');
      // dates encoded as start/end UTC stamps
      expect(url).toContain('dates=20260601T180000Z%2F20260601T200000Z');
      // text properly URL-encoded
      const parsed = new URL(url);
      expect(parsed.searchParams.get('text')).toBe('Catan — Saturday Crew');
      expect(parsed.searchParams.get('location')).toBe("Alex's house");
      expect(parsed.searchParams.get('details')).toBe('Game night.');
    });

    it('omits optional details/location when not provided', () => {
      const url = buildGoogleCalendarUrl({
        gameName: 'Catan',
        groupName: 'Crew',
        startUtc: new Date('2026-06-01T18:00:00.000Z'),
        durationMinutes: 60,
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.has('location')).toBe(false);
      expect(parsed.searchParams.has('details')).toBe(false);
    });
  });

  describe('escapeIcsText', () => {
    it('escapes backslash, comma, semicolon, and newlines per RFC 5545', () => {
      expect(escapeIcsText('a\\b')).toBe('a\\\\b');
      expect(escapeIcsText('a,b')).toBe('a\\,b');
      expect(escapeIcsText('a;b')).toBe('a\\;b');
      expect(escapeIcsText('a\nb')).toBe('a\\nb');
      expect(escapeIcsText('a\r\nb')).toBe('a\\nb');
      expect(escapeIcsText('a\rb')).toBe('a\\nb');
    });

    it('handles null/undefined gracefully', () => {
      expect(escapeIcsText(null)).toBe('');
      expect(escapeIcsText(undefined)).toBe('');
    });

    it('escapes backslash first (so subsequent escapes are not double-escaped)', () => {
      // "a;b" → "a\;b" (3 chars become 4)
      // "a\b" → "a\\b" (3 chars become 4)
      // Combined "a;\b" → "a\;\\b"
      expect(escapeIcsText('a;\\b')).toBe('a\\\\\\;b'.replace('\\\\\\;', '\\;\\\\'));
      // simpler explicit check:
      expect(escapeIcsText('\\,')).toBe('\\\\\\,');
    });
  });

  describe('formatIcsDate', () => {
    it('converts JS Date to YYYYMMDDTHHMMSSZ', () => {
      expect(formatIcsDate(new Date('2026-06-01T18:30:45.123Z'))).toBe(
        '20260601T183045Z'
      );
      expect(formatIcsDate(new Date('2026-12-31T23:59:59.999Z'))).toBe(
        '20261231T235959Z'
      );
    });
  });
});
