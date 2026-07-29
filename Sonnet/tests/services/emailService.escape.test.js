// tests/services/emailService.escape.test.js
// BSEC-04 / D-07 regression test: user-supplied content in email, feedback,
// and invitation templates must be HTML-escaped, and mail subjects must be
// CRLF-stripped (header-injection defense). Pure-wiring of the existing
// escapeHtml primitive — no new escaper is introduced.

const emailService = require('../../services/emailService');

// WR-02 (88.2 review): requiring workers/promptWorker instantiates its BullMQ
// Worker and Redis connection at module load — neutralize both so the builder
// can be exercised as a pure function (same mocks as promptWorker.softDelete.test.js).
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

const { buildPromptEmailHtml } = require('../../workers/promptWorker');
const { generateEventConfirmationEmailTemplate } = require('../../services/eventCreationService');

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

    // Phase 88.2 / T-88.2-19 + T-88.2-20 (SPEC-REQ-8 ownership offer).
    it('generateGroupOwnershipOfferEmailTemplate escapes groupName and recipientName', () => {
      const { html } = emailService.generateGroupOwnershipOfferEmailTemplate({
        recipientName: XSS,
        groupName: `${XSS} "quoted"`,
        deadlineDate: 'Aug 24, 2026',
        restoreUrl: 'https://app.test/groups/restore/abc123',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
      // The raw double quote must not survive into the body either — it is the
      // attribute-breakout character.
      expect(html).toContain('&quot;quoted&quot;');
      expect(html).not.toContain('"quoted"');
    });

    it('generateGroupOwnershipOfferEmailTemplate returns a CRLF-free subject', () => {
      const { subject } = emailService.generateGroupOwnershipOfferEmailTemplate({
        recipientName: 'Member',
        groupName: 'Tuesday Knights\r\nBcc: attacker@example.com',
        deadlineDate: 'Aug 24, 2026',
        restoreUrl: 'https://app.test/groups/restore/abc123',
      });
      // The security property: no CR/LF survives, so no second mail header can
      // be forged from a group name.
      expect(subject).not.toMatch(/[\r\n]/);
      expect(subject).toContain('Bcc: attacker@example.com'); // collapsed inline, harmless
    });

    it('generateGroupOwnershipOfferEmailTemplate never claims the delete is permanent (SPEC-REQ-7)', () => {
      const { html, text, subject } = emailService.generateGroupOwnershipOfferEmailTemplate({
        recipientName: 'Member',
        groupName: 'Tuesday Knights',
        deadlineDate: 'Aug 24, 2026',
        restoreUrl: 'https://app.test/groups/restore/abc123',
        memberCount: 4,
        eventCount: 12,
      });
      const forbidden = /cannot be undone|permanently remove|permanently delete/i;
      expect(html).not.toMatch(forbidden);
      expect(text).not.toMatch(forbidden);
      expect(subject).not.toMatch(forbidden);
      // The load-bearing facts SPEC-REQ-8 requires in every offer email.
      expect(html).toContain('Tuesday Knights');
      expect(html).toContain('Aug 24, 2026');
      expect(html).toContain('https://app.test/groups/restore/abc123');
      expect(text).toContain('https://app.test/groups/restore/abc123');
      expect(html).toContain('4 members and 12 events');
    });

    it('generateGroupOwnershipOfferEmailTemplate omits the count sentence when counts are absent', () => {
      const { html, text } = emailService.generateGroupOwnershipOfferEmailTemplate({
        recipientName: 'Member',
        groupName: 'Tuesday Knights',
        deadlineDate: 'Aug 24, 2026',
        restoreUrl: 'https://app.test/groups/restore/abc123',
      });
      expect(html).not.toContain('undefined');
      expect(text).not.toContain('undefined');
      expect(html).not.toContain('It has');
    });
  });

  // Phase 88.2 / MED #24: the From display name is built from the raw groupName
  // in emailService.send (`fromName`). A CR/LF-bearing group name there forges a
  // header for EVERY transactional email, not just the ownership offer, so the
  // strip is applied at that shared site rather than in one caller.
  describe('emailService.send strips CRLF from the From display name', () => {
    let savedApiKey;
    let savedResend;
    let captured;

    beforeEach(() => {
      savedApiKey = emailService.apiKey;
      savedResend = emailService.resend;
      captured = null;
      emailService.apiKey = 'test-key';
      emailService.resend = {
        emails: {
          send: jest.fn(async (msg) => {
            captured = msg;
            return { data: { id: 'test-id' }, error: null };
          }),
        },
      };
    });

    afterEach(() => {
      emailService.apiKey = savedApiKey;
      emailService.resend = savedResend;
    });

    it('produces a single-line from value for a CR/LF-bearing group name', async () => {
      const result = await emailService.send({
        to: 'member@example.com',
        subject: 'Subject',
        html: '<p>Body</p>',
        groupName: 'Tuesday Knights\r\nBcc: attacker@example.com',
      });
      expect(result.success).toBe(true);
      expect(captured).not.toBeNull();
      expect(captured.from).not.toMatch(/[\r\n]/);
      expect(captured.from).toContain('Tuesday Knights');
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

  // WR-02 (88.2 review): the three pre-existing builders that interpolated
  // user-controlled strings raw. One case per builder.
  describe('WR-02 — pre-existing email builders escape user-supplied content', () => {
    it('generateEventConfirmationEmailTemplate escapes groupName, gameName, comments and participants in the HTML part', () => {
      const { html, text } = generateEventConfirmationEmailTemplate({
        gameName: XSS,
        groupName: XSS,
        startDate: '2026-08-01T18:00:00Z',
        durationMinutes: 120,
        participants: [XSS, 'plain-player'],
        eventUrl: 'https://app.test/event/1',
        comments: XSS,
        timezone: 'UTC',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
      // The text part is text/plain — it must stay raw, not entity-encoded.
      expect(text).toContain(XSS);
    });

    it('buildPromptEmailHtml escapes recipientName, groupName and gameName', () => {
      const html = buildPromptEmailHtml({
        recipientName: XSS,
        groupName: XSS,
        gameName: XSS,
        weekDescription: 'this week',
        responseDeadline: 'Friday',
        formUrl: 'https://app.test/availability/tok',
      });
      expect(html).toContain(ESCAPED_XSS);
      expect(html).not.toContain('<script>alert(1)</script>');
    });

    it('availabilityPrompt remind builder relies on primitives that neutralize its payloads (template-level)', () => {
      // The reminder HTML/subject construction lives inline in
      // routes/availabilityPrompt.js (same precedent as the feedback route
      // above): assert the two primitives it now routes through.
      expect(emailService.escapeHtml(XSS)).toBe(ESCAPED_XSS);
      expect(emailService.stripCrlf(`Reminder: ${CRLF_SUBJECT} availability request`)).not.toMatch(/[\r\n]/);
    });
  });
});
