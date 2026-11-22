// tests/services/emailService.buttonInk.test.js
// quick-261121-inv (E1/E2): every button link in an email carries its text colour on the link
// itself. The owner read two emails in Gmail: "View Event Details" was Gmail's link blue on the
// indigo button ("invisible") and "View Invite" was blue on green, while the Yes / Maybe / No
// buttons of the SAME email, whose colour is written on the link, were white. A colour that
// lives only in the <style> block's .button rule loses to the mail app's own link colour.

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

const emailService = require('../../services/emailService');
const { generateEventConfirmationEmailTemplate } = require('../../services/eventCreationService');

const WHEN = new Date('2030-01-15T02:00:00Z');
const URL = 'https://app.test/somewhere';

function htmlOf(out) {
  return typeof out === 'string' ? out : out.html;
}

const TEMPLATES = [
  ['no consensus', () => emailService.generateNoConsensusEmailTemplate({ groupName: 'G', promptId: 'p1', dashboardUrl: URL })],
  ['group invite', () => emailService.generateGroupInviteEmailTemplate({ inviterName: 'A', groupName: 'G', memberCount: 3, inviteUrl: URL })],
  ['ownership offer', () => emailService.generateGroupOwnershipOfferEmailTemplate({ recipientName: 'A', groupName: 'G', deadlineDate: WHEN, restoreUrl: URL, memberCount: 3 })],
  ['new game night', () => emailService.generateGameSessionEmailTemplate({ gameName: 'Catan', groupName: 'G', startDate: WHEN, durationMinutes: 90, eventUrl: URL, recipientName: 'A', timezone: 'UTC' })],
  ['date change', () => emailService.generateDateChangeEmailTemplate({ gameName: 'Catan', groupName: 'G', newDate: WHEN, durationMinutes: 90, eventUrl: URL, recipientName: 'A', timezone: 'UTC' })],
  ['cancellation', () => emailService.generateCancellationEmailTemplate({ gameName: 'Catan', groupName: 'G', eventDate: WHEN, recipientName: 'A', groupUrl: URL, timezone: 'UTC' })],
  ['event confirmation', () => generateEventConfirmationEmailTemplate({ gameName: 'Catan', groupName: 'G', startDate: WHEN, durationMinutes: 90, eventUrl: URL, recipientName: 'A', participants: ['A', 'B'], timezone: 'UTC' })],
];

describe('email button links carry their own text colour (quick-261121-inv E1/E2)', () => {
  it.each(TEMPLATES)('%s', (_name, render) => {
    const html = htmlOf(render());
    const buttons = html.match(/<a\b[^>]*class="button"[^>]*>/g) || [];
    expect(buttons.length).toBeGreaterThan(0);
    for (const tag of buttons) {
      const style = (tag.match(/style="([^"]*)"/) || [])[1] || '';
      expect(style).toMatch(/(^|;)\s*color:\s*(white|#fff(fff)?)\b/i);
      // Review MED-1: the fill and the padding travel with the ink. A mail app that drops the
      // <style> block would otherwise show white words on no fill at all.
      expect(style).toMatch(/(^|;)\s*background-color:\s*#[0-9a-f]{6}\b/i);
      expect(style).toMatch(/(^|;)\s*padding:/i);
    }
  });
});
