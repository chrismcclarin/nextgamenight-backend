// tests/services/emailService.escape.test.js
// BSEC-04 / D-07 regression test: user-supplied content in email, feedback,
// and invitation templates must be HTML-escaped, and mail subjects must be
// CRLF-stripped (header-injection defense). Pure-wiring of the existing
// escapeHtml primitive — no new escaper is introduced.

const emailService = require('../../services/emailService');

// A representative XSS payload + a CRLF header-injection payload.
const XSS = '<script>alert(1)</script>';
const ESCAPED_XSS = '&lt;script&gt;alert(1)&lt;/script&gt;';
const CRLF_SUBJECT = 'Hello\r\nBcc: attacker@evil.com';

describe('BSEC-04 content escaping', () => {
  describe('emailService.escapeHtml', () => {
    it('escapes <script> tags so they render inert', () => {
      const out = emailService.escapeHtml(XSS);
      expect(out).toBe(ESCAPED_XSS);
      expect(out).not.toContain('<script>');
    });
  });

  describe('emailService.stripCrlf', () => {
    it('removes CR and LF so subjects cannot inject mail headers', () => {
      const out = emailService.stripCrlf(CRLF_SUBJECT);
      // The security property: no CR/LF survives, so no second header can be
      // forged. The injected text is harmlessly collapsed onto one line.
      expect(out).not.toMatch(/[\r\n]/);
      expect(out).toBe('Hello Bcc: attacker@evil.com');
    });

    it('returns empty string for null/undefined', () => {
      expect(emailService.stripCrlf(null)).toBe('');
      expect(emailService.stripCrlf(undefined)).toBe('');
    });
  });

  describe('HTML templates escape user-supplied content', () => {
    it('generateNoConsensusEmailTemplate escapes groupName', () => {
      const { html } = emailService.generateNoConsensusEmailTemplate({
        groupName: XSS,
        promptId: 'p1',
        dashboardUrl: 'https://app.test/dashboard',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('generateGroupInviteEmailTemplate escapes inviterName and groupName', () => {
      const { html } = emailService.generateGroupInviteEmailTemplate({
        inviterName: XSS,
        groupName: XSS,
        memberCount: 3,
        inviteUrl: 'https://app.test/invite',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('generateGameSessionEmailTemplate escapes gameName, groupName, location and comments', () => {
      const { html } = emailService.generateGameSessionEmailTemplate({
        gameName: XSS,
        groupName: XSS,
        startDate: new Date('2026-07-01T18:00:00Z'),
        durationMinutes: 120,
        location: XSS,
        comments: XSS,
        eventUrl: 'https://app.test/event',
        recipientName: XSS,
        timezone: 'UTC',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('generateDateChangeEmailTemplate escapes gameName and groupName', () => {
      const { html } = emailService.generateDateChangeEmailTemplate({
        gameName: XSS,
        groupName: XSS,
        newDate: new Date('2026-07-01T18:00:00Z'),
        durationMinutes: 90,
        eventUrl: 'https://app.test/event',
        recipientName: XSS,
        timezone: 'UTC',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('generateCancellationEmailTemplate escapes gameName and groupName', () => {
      const { html } = emailService.generateCancellationEmailTemplate({
        gameName: XSS,
        groupName: XSS,
        eventDate: new Date('2026-07-01T18:00:00Z'),
        recipientName: XSS,
        groupUrl: 'https://app.test/group',
        timezone: 'UTC',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('generateGameJoinConfirmationTemplate escapes gameName, groupName, host and location', () => {
      const { html, subject } = emailService.generateGameJoinConfirmationTemplate({
        gameName: XSS,
        groupName: XSS,
        eventDate: new Date('2026-07-01T18:00:00Z'),
        durationMinutes: 60,
        location: XSS,
        hostName: XSS,
        recipientName: XSS,
        eventUrl: 'https://app.test/event',
        googleCalendarUrl: 'https://calendar.test',
        timezone: 'UTC',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
      // Subject is a plain-text header; CRLF must never survive there.
      expect(subject).not.toMatch(/[\r\n]/);
    });
  });

  describe('feedback route renders escaped content (template-level)', () => {
    // The feedback HTML/subject construction lives inline in routes/feedback.js.
    // We assert the two primitives it relies on behave correctly here; the
    // route wiring is covered structurally by the grep verification in the plan.
    it('escapeHtml neutralizes a feedback description payload', () => {
      expect(emailService.escapeHtml(XSS)).toBe(ESCAPED_XSS);
    });

    it('stripCrlf neutralizes a feedback subject payload', () => {
      expect(emailService.stripCrlf(`[Feedback] bug: ${CRLF_SUBJECT}`)).not.toMatch(/[\r\n]/);
    });
  });

  describe('invitation template escapes customMessage', () => {
    // buildInvitationHtml is module-private in promptInvitationService; exercise
    // the escaper it now routes through to lock the behavior.
    it('escapeHtml neutralizes a customMessage payload', () => {
      expect(emailService.escapeHtml(XSS)).toBe(ESCAPED_XSS);
    });
  });
});
