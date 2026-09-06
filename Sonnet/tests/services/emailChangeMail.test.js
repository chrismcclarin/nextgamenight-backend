// tests/services/emailChangeMail.test.js
// Phase 88.8 / plan 10 Task 1 (SPEC A9, SPEC A13 / DR-E, CONTEXT D-09 amended, D-43).
//
// The two email-change mail primitives, asserted on their RENDERED BODY rather
// than on their template source. That distinction is the whole point of this
// suite: "we did not put a link in the verification mail" is exactly the kind of
// claim a reviewer's memory gets wrong six months later, and A9's entire security
// mechanism is that the code mail has nothing for a corporate link scanner
// (Safe Links / Proofpoint / Mimecast) to fetch, render or auto-submit.
//
// MAIL SAFETY: every test stubs `emailService.send`, so no provider call is ever
// made. The one "unconfigured" test restores the real `send` but first forces
// `apiKey`/`resend` to undefined on the singleton, so it exercises the
// short-circuit at services/emailService.js:44-48 and CANNOT reach Resend even
// if a key were present in the environment.

const emailService = require('../../services/emailService');

// A representative 8-symbol Crockford-base32 code (A9 / D-09 amended).
const CODE = 'K7M2XQ9T';
const FORMATTED_CODE = 'K7M2-XQ9T';

// Anything that looks like a URL or an anchor. Asserted against the rendered
// html AND text of both mails.
const URL_SCHEME = /https?:\/\//i;
const ANCHOR_TAG = /<a[\s>]/i;

// A real (unmasked) address shape. The code mail must contain none at all; the
// notice mail must contain only the MASKED form, which cannot match this
// because of the asterisks.
const BARE_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// An 8-symbol code-shaped token, hyphenated or not. The notice mail must never
// carry a capability.
const CODE_SHAPED = /\b[0-9A-Z]{4}-?[0-9A-Z]{4}\b/;

let sendSpy;

beforeEach(() => {
  sendSpy = jest
    .spyOn(emailService, 'send')
    .mockResolvedValue({ success: true, id: 'stub-id' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Pull the single object the stubbed `send` received. */
function sentPayload() {
  expect(sendSpy).toHaveBeenCalledTimes(1);
  return sendSpy.mock.calls[0][0];
}

/** Both rendered bodies concatenated, for "must not contain" assertions. */
function renderedBody(payload) {
  return `${payload.html || ''}\n${payload.text || ''}`;
}

// ---------------------------------------------------------------------------
// maskEmail
// ---------------------------------------------------------------------------
describe('emailService.maskEmail (display mask for mail copy)', () => {
  it('reduces the local part to its first character', () => {
    expect(emailService.maskEmail('gregory@chris.com')).toBe('g***@chris.com');
  });

  it('never leaks a single-character local part verbatim', () => {
    expect(emailService.maskEmail('a@chris.com')).toBe('*@chris.com');
  });

  it('splits on the LAST @ so a quoted local part cannot smuggle a domain', () => {
    expect(emailService.maskEmail('we@ird@chris.com')).toBe('w***@chris.com');
  });

  it('returns a fixed placeholder rather than throwing on a value with no @', () => {
    expect(emailService.maskEmail('not-an-address')).toBe('an address we could not display');
  });

  it('returns the fixed placeholder for null/undefined/non-strings', () => {
    expect(emailService.maskEmail(null)).toBe('an address we could not display');
    expect(emailService.maskEmail(undefined)).toBe('an address we could not display');
    expect(emailService.maskEmail(42)).toBe('an address we could not display');
    expect(emailService.maskEmail({})).toBe('an address we could not display');
  });

  it('returns the placeholder for an empty domain', () => {
    expect(emailService.maskEmail('gregory@')).toBe('an address we could not display');
  });
});

// ---------------------------------------------------------------------------
// sendEmailChangeCode — SPEC A9
// ---------------------------------------------------------------------------
describe('emailService.sendEmailChangeCode (SPEC A9 — a code, never a link)', () => {
  it('sends to the given address and returns the send result unchanged', async () => {
    const result = await emailService.sendEmailChangeCode('new@example.com', CODE);
    expect(result).toEqual({ success: true, id: 'stub-id' });
    expect(sentPayload().to).toBe('new@example.com');
  });

  it('renders the code formatted XXXX-XXXX in both html and text', async () => {
    await emailService.sendEmailChangeCode('new@example.com', CODE);
    const payload = sentPayload();
    expect(payload.html).toContain(FORMATTED_CODE);
    expect(payload.text).toContain(FORMATTED_CODE);
  });

  it('rendered body contains NO url scheme and NO anchor tag (A9 / T-88.8-72)', async () => {
    await emailService.sendEmailChangeCode('new@example.com', CODE);
    const body = renderedBody(sentPayload());
    expect(body).not.toMatch(URL_SCHEME);
    expect(body).not.toMatch(ANCHOR_TAG);
    expect(body).not.toContain('href');
  });

  it('rendered body reveals nothing about the account — no address of any kind (T-88.8-73)', async () => {
    await emailService.sendEmailChangeCode('gregory@example.com', CODE);
    const body = renderedBody(sentPayload());
    // Not even the recipient's own address: this mail can land in an inbox the
    // account holder does not control, so it names no person, no address and no
    // group.
    expect(body).not.toMatch(BARE_EMAIL);
    expect(body).not.toContain('gregory');
  });

  it('carries the expiry sentence and the ignore-this sentence', async () => {
    await emailService.sendEmailChangeCode('new@example.com', CODE);
    const body = renderedBody(sentPayload());
    expect(body).toMatch(/expires in 30 minutes/i);
    expect(body).toMatch(/ignore this email/i);
  });

  it('subject is single-line (stripCrlf applied) and names no address', async () => {
    await emailService.sendEmailChangeCode('gregory@example.com', CODE);
    const { subject } = sentPayload();
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).not.toMatch(BARE_EMAIL);
  });

  it('HTML-escapes the interpolated code', async () => {
    await emailService.sendEmailChangeCode('new@example.com', '<script>alert(1)</script>');
    const { html } = sentPayload();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
// sendEmailChangeNotice — SPEC A13 / DR-E
// ---------------------------------------------------------------------------
describe('emailService.sendEmailChangeNotice (SPEC A13 / DR-E — a warning, never a capability)', () => {
  it('sends to the given (prior) address and returns the send result unchanged', async () => {
    const result = await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    expect(result).toEqual({ success: true, id: 'stub-id' });
    expect(sentPayload().to).toBe('prior@example.com');
  });

  it('shows the new address MASKED and never in full (T-88.8-74)', async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    const body = renderedBody(sentPayload());
    expect(body).toContain('g***@chris.com');
    expect(body).not.toContain('gregory@chris.com');
    expect(body).not.toMatch(BARE_EMAIL);
  });

  it("names the 'changed' action in fixed copy", async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    const body = renderedBody(sentPayload());
    expect(body).toMatch(/changed/i);
    expect(body).not.toMatch(/reverted/i);
  });

  it("names the 'reverted' action in fixed copy", async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'reverted',
      newAddress: 'gregory@chris.com',
    });
    const body = renderedBody(sentPayload());
    expect(body).toMatch(/reverted|changed back/i);
  });

  it('interpolates no caller-supplied prose — an unknown action does not reach the body', async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: '<b>pwned by the caller</b>',
      newAddress: 'gregory@chris.com',
    });
    const body = renderedBody(sentPayload());
    expect(body).not.toContain('pwned by the caller');
    expect(body).not.toContain('<b>pwned');
  });

  it('rendered body contains NO code, NO url scheme and NO anchor tag', async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    const body = renderedBody(sentPayload());
    expect(body).not.toMatch(URL_SCHEME);
    expect(body).not.toMatch(ANCHOR_TAG);
    expect(body).not.toContain('href');
    expect(body).not.toMatch(CODE_SHAPED);
  });

  it('tells the reader how to recover control', async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    const body = renderedBody(sentPayload());
    expect(body).toMatch(/wasn't you|was not you/i);
    // Round 4 #7: the copy names only steps the app actually supports.
    expect(body).toMatch(/change your sign-in password/i);
    expect(body).not.toMatch(/sign out everywhere/i);
  });

  it('subject is single-line (stripCrlf applied)', async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    expect(sentPayload().subject).not.toMatch(/[\r\n]/);
  });

  it('HTML-escapes the masked address before interpolation', async () => {
    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: '<script>x@evil<b>.com',
    });
    const { html } = sentPayload();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
  });

  it('does not throw when newAddress is missing — a template must never 500 a request', async () => {
    await expect(
      emailService.sendEmailChangeNotice('prior@example.com', { action: 'changed' })
    ).resolves.toEqual({ success: true, id: 'stub-id' });
    expect(renderedBody(sentPayload())).toContain('an address we could not display');
  });
});

// ---------------------------------------------------------------------------
// The two mails are provably DIFFERENT (plan 10 must_haves)
// ---------------------------------------------------------------------------
describe('the code mail and the notice mail are distinguishable by body, not by name', () => {
  it('the code mail carries the code and the notice mail does not', async () => {
    await emailService.sendEmailChangeCode('new@example.com', CODE);
    const codeBody = renderedBody(sentPayload());
    sendSpy.mockClear();

    await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    const noticeBody = renderedBody(sentPayload());

    expect(codeBody).toContain(FORMATTED_CODE);
    expect(noticeBody).not.toContain(FORMATTED_CODE);
    expect(noticeBody).not.toContain(CODE);
  });
});

// ---------------------------------------------------------------------------
// Unconfigured provider — the shipped short-circuit at emailService.js:44-48
// ---------------------------------------------------------------------------
describe('with no provider key configured', () => {
  let savedKey;
  let savedResend;

  beforeEach(() => {
    // Drop the `send` stub so the REAL send runs — then guarantee it can never
    // reach Resend by clearing the credentials on the singleton. This is both
    // the behaviour under test and the mail-safety guard.
    sendSpy.mockRestore();
    savedKey = emailService.apiKey;
    savedResend = emailService.resend;
    emailService.apiKey = undefined;
    emailService.resend = undefined;
  });

  afterEach(() => {
    emailService.apiKey = savedKey;
    emailService.resend = savedResend;
  });

  it('sendEmailChangeCode resolves { success: false } and does not throw', async () => {
    const result = await emailService.sendEmailChangeCode('new@example.com', CODE);
    expect(result.success).toBe(false);
  });

  it('sendEmailChangeNotice resolves { success: false } and does not throw', async () => {
    const result = await emailService.sendEmailChangeNotice('prior@example.com', {
      action: 'changed',
      newAddress: 'gregory@chris.com',
    });
    expect(result.success).toBe(false);
  });
});
