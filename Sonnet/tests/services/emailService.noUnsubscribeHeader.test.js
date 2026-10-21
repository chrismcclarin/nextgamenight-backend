// tests/services/emailService.noUnsubscribeHeader.test.js
// Quick task 261020-u4u (owner ruling 2026-10-20): every email this service sends is a
// notification to a known account, never marketing (the typed emailTypes plus the
// untyped sends that default to the 'notification' tag — census in the review), and the
// `unsubscribe@nextgamenight.app` mailbox the old List-Unsubscribe header pointed at
// does not exist. Google's sender guidelines require one-click unsubscribe only for
// marketing / subscribed mail from 5,000+ messages-per-day senders; on transactional
// mail the header is a bulk-mail signal (Gmail filed the owner's check-ins under
// Promotions) that advertised a dead address. This pins that `send()` hands Resend
// NO List-Unsubscribe headers — and no `headers` key at all, so nothing else can
// quietly reintroduce one.
//
// MAIL SAFETY: the Resend client is replaced with a stub on the singleton for the
// duration of each test and restored afterwards; no provider call is ever made.

const emailService = require('../../services/emailService');

let originalApiKey;
let originalResend;
let resendSend;

beforeEach(() => {
  originalApiKey = emailService.apiKey;
  originalResend = emailService.resend;
  resendSend = jest.fn().mockResolvedValue({ data: { id: 'stub-id' }, error: null });
  emailService.apiKey = 'test-key';
  emailService.resend = { emails: { send: resendSend } };
});

afterEach(() => {
  emailService.apiKey = originalApiKey;
  emailService.resend = originalResend;
  jest.restoreAllMocks();
});

async function sendOne(extra = {}) {
  const result = await emailService.send({
    to: 'member@example.com',
    subject: 'Game night check-in',
    html: '<p>Can you make it?</p>',
    text: 'Can you make it?',
    emailType: 'availability_prompt',
    ...extra
  });
  expect(result.success).toBe(true);
  expect(resendSend).toHaveBeenCalledTimes(1);
  return resendSend.mock.calls[0][0];
}

describe('emailService.send — no List-Unsubscribe on transactional mail (261020-u4u)', () => {
  it('passes no List-Unsubscribe / List-Unsubscribe-Post header to Resend', async () => {
    const payload = await sendOne();
    const headerNames = Object.keys(payload.headers || {}).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain('list-unsubscribe');
    expect(headerNames).not.toContain('list-unsubscribe-post');
  });

  it('passes no `headers` key at all, so a header cannot be reintroduced by accident', async () => {
    const payload = await sendOne();
    expect(payload).not.toHaveProperty('headers');
  });

  it('still sends the rest of the message unchanged (from, to, subject, bodies, tags)', async () => {
    const payload = await sendOne({ groupName: 'Tuesday Crew', promptId: 42 });
    expect(payload.from).toMatch(/^Tuesday Crew via NextGameNight </);
    expect(payload.to).toEqual(['member@example.com']);
    expect(payload.subject).toBe('Game night check-in');
    expect(payload.html).toBe('<p>Can you make it?</p>');
    expect(payload.text).toBe('Can you make it?');
    expect(payload.tags).toEqual([
      { name: 'category', value: 'availability_prompt' },
      { name: 'prompt_id', value: '42' }
    ]);
  });

  it('the batch path (sendBatch) goes through send(), so it carries no unsubscribe header either', async () => {
    const result = await emailService.sendBatch(['a@example.com', { email: 'b@example.com' }], {
      subject: 'Game night check-in',
      html: '<p>Can you make it?</p>',
      text: 'Can you make it?'
    });
    expect(result.successful).toBe(2);
    expect(resendSend).toHaveBeenCalledTimes(2);
    for (const call of resendSend.mock.calls) {
      expect(call[0]).not.toHaveProperty('headers');
    }
  });
});
