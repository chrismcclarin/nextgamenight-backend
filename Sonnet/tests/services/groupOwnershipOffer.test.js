// tests/services/groupOwnershipOffer.test.js
//
// Phase 88.2 / SPEC-REQ-8 + D-03 — the ownership-offer fanout.
//
// Pure unit suite: no database. The service is deliberately model-free (its
// signature takes primitives plus a pre-materialized roster precisely so it
// CANNOT re-query a paranoid-hidden group), so a real DB would prove nothing
// here. What must be pinned instead is the counting and the degradation
// behavior, and both are only observable through mocks.
//
// emailService is a class INSTANCE — override send/isConfigured on it and keep
// the real template method, so every assertion about the rendered html is made
// against the copy that actually ships.

jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  actual.isConfigured = jest.fn().mockReturnValue(true);
  return actual;
});

jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn(),
  extractUserDetails: jest.fn(),
}));

const emailService = require('../../services/emailService');
const auth0Service = require('../../services/auth0Service');
const { sendGroupOwnershipOffers } = require('../../services/groupOwnershipOfferService');

const GROUP_NAME = 'Tuesday Knights';
const RESTORE_URL = 'https://app.test/groups/restore/abc123nonce';
// Noon UTC on the 24th: still the 23rd in Los Angeles, which makes the
// per-recipient timezone formatting observable rather than cosmetic.
const PURGE_AFTER = new Date('2026-08-24T02:00:00Z');

const OWNER_EMAIL = 'owner@example.com';

function member(overrides = {}) {
  return {
    email: 'member@example.com',
    username: 'Member',
    timezone: 'UTC',
    user_id: 'auth0|member',
    ...overrides,
  };
}

function offer(recipients) {
  return sendGroupOwnershipOffers({
    groupName: GROUP_NAME,
    purgeAfter: PURGE_AFTER,
    restoreUrl: RESTORE_URL,
    recipients,
  });
}

function sentAddresses() {
  return emailService.send.mock.calls.map((c) => c[0].to);
}

describe('sendGroupOwnershipOffers (Phase 88.2, SPEC-REQ-8 / D-03)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
    emailService.isConfigured.mockReturnValue(true);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('counts (SPEC-REQ-8)', () => {
    it('dispatches exactly one email per remaining member', async () => {
      const recipients = [
        member({ email: 'a@example.com', user_id: 'auth0|a' }),
        member({ email: 'b@example.com', user_id: 'auth0|b' }),
        member({ email: 'c@example.com', user_id: 'auth0|c' }),
      ];

      const result = await offer(recipients);

      expect(emailService.send).toHaveBeenCalledTimes(3);
      expect(result).toEqual({ sent: 3, failed: 0, unreachable: 0 });
      expect(sentAddresses().sort()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    });

    it('sends nothing to the deleting owner, who is simply absent from the roster', async () => {
      // The exclusion is structural: the caller (plan 06) builds the roster
      // without the owner. This asserts the service invents no extra recipient.
      const recipients = [
        member({ email: 'a@example.com', user_id: 'auth0|a' }),
        member({ email: 'b@example.com', user_id: 'auth0|b' }),
      ];

      const result = await offer(recipients);

      expect(result.sent).toBe(2);
      expect(sentAddresses()).not.toContain(OWNER_EMAIL);
      sentAddresses().forEach((to) => expect(to).not.toBe(OWNER_EMAIL));
    });

    it('a group with no other members dispatches zero', async () => {
      const result = await offer([]);
      expect(emailService.send).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 0, unreachable: 0 });
    });

    it('a non-array roster is treated as empty rather than throwing', async () => {
      await expect(offer(undefined)).resolves.toEqual({ sent: 0, failed: 0, unreachable: 0 });
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('is a no-op when the email service is not configured', async () => {
      emailService.isConfigured.mockReturnValue(false);
      const result = await offer([member(), member({ email: 'b@example.com' })]);
      expect(emailService.send).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 0, unreachable: 0 });
    });
  });

  describe('D-03: the offer is transactional and ignores the email preference', () => {
    it('still emails a member who has muted game-night email', async () => {
      // The flag is carried on the recipient object precisely so this test can
      // prove the service IGNORES it. Every sibling dispatcher
      // (promptInvitationService.js:144, notificationService.js:50) would skip.
      const muted = member({
        email: 'muted@example.com',
        user_id: 'auth0|muted',
        email_notifications_enabled: false,
      });

      const result = await offer([muted]);

      expect(emailService.send).toHaveBeenCalledTimes(1);
      expect(sentAddresses()).toEqual(['muted@example.com']);
      expect(result.sent).toBe(1);
    });
  });

  describe('MED-AUTH0: synthetic @auth0.local addresses get a Management API backfill', () => {
    const synthetic = () => member({
      email: 'auth0-abc123@auth0.local',
      user_id: 'auth0|abc123',
      username: 'Placeholder Person',
    });

    it('sends to the recovered address when Auth0 reports it VERIFIED', async () => {
      auth0Service.getUserById.mockResolvedValue({ email: 'real@example.com', email_verified: true });
      auth0Service.extractUserDetails.mockReturnValue({ email: 'real@example.com', emailVerified: true });

      const result = await offer([synthetic()]);

      expect(auth0Service.getUserById).toHaveBeenCalledWith('auth0|abc123');
      expect(emailService.send).toHaveBeenCalledTimes(1);
      // The recovered address, NOT the synthetic placeholder.
      expect(emailService.send.mock.calls[0][0].to).toBe('real@example.com');
      expect(result).toEqual({ sent: 1, failed: 0, unreachable: 0 });
    });

    it('skips and counts unreachable when Auth0 reports the address UNVERIFIED', async () => {
      auth0Service.getUserById.mockResolvedValue({ email: 'maybe@example.com', email_verified: false });
      auth0Service.extractUserDetails.mockReturnValue({ email: 'maybe@example.com', emailVerified: false });

      const result = await offer([synthetic()]);

      expect(emailService.send).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 0, unreachable: 1 });
    });

    it('skips and counts unreachable when the Management API lookup REJECTS', async () => {
      auth0Service.getUserById.mockRejectedValue(new Error('Failed to fetch Auth0 user: 429'));

      await expect(offer([synthetic()])).resolves.toEqual({ sent: 0, failed: 0, unreachable: 1 });
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('skips and counts unreachable when the Management API RESOLVES null (its real 404 behavior)', async () => {
      // getUserById returns null on 404 rather than rejecting. A try/catch-only
      // implementation sails past this and then throws a TypeError inside
      // extractUserDetails(null) — this case is what makes the explicit null
      // check load-bearing.
      auth0Service.getUserById.mockResolvedValue(null);
      // Reproduce the REAL extractUserDetails, which dereferences its argument
      // unguarded (auth0Service.js:157) and therefore throws a TypeError on null.
      // A bare jest.fn() would silently return undefined and hide the defect.
      auth0Service.extractUserDetails.mockImplementation((u) => ({
        email: u.email,
        emailVerified: u.email_verified || false,
      }));

      await expect(offer([synthetic()])).resolves.toEqual({ sent: 0, failed: 0, unreachable: 1 });
      // The load-bearing assertion: the explicit null check must short-circuit
      // BEFORE the dereference. Removing it reds this line.
      expect(auth0Service.extractUserDetails).not.toHaveBeenCalled();
      expect(emailService.send).not.toHaveBeenCalled();
    });

    it('counts a member with no stored address at all as unreachable', async () => {
      const result = await offer([member({ email: null, user_id: 'auth0|noaddr' })]);
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, failed: 0, unreachable: 1 });
    });

    it('an entirely unreachable roster reports the residual rather than a silent zero', async () => {
      auth0Service.getUserById.mockResolvedValue(null);
      const recipients = [
        member({ email: 'a@auth0.local', user_id: 'auth0|a' }),
        member({ email: 'b@auth0.local', user_id: 'auth0|b' }),
        member({ email: 'c@auth0.local', user_id: 'auth0|c' }),
      ];

      const result = await offer(recipients);

      // NOT { sent: 0, failed: 0, unreachable: 0 } — the residual is counted.
      expect(result).toEqual({ sent: 0, failed: 0, unreachable: 3 });
      expect(emailService.send).not.toHaveBeenCalled();
      // The summary fires so the residual is recorded, not silently ignored (D-03).
      const warned = console.warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('could not be offered ownership');
      expect(warned).toContain('3 of 3');
    });

    it('one unreachable member does not stop the rest of the fanout', async () => {
      auth0Service.getUserById.mockResolvedValue(null);
      const recipients = [
        member({ email: 'a@example.com', user_id: 'auth0|a' }),
        member({ email: 'b@auth0.local', user_id: 'auth0|b' }),
        member({ email: 'c@example.com', user_id: 'auth0|c' }),
      ];

      const result = await offer(recipients);

      expect(result).toEqual({ sent: 2, failed: 0, unreachable: 1 });
      expect(sentAddresses().sort()).toEqual(['a@example.com', 'c@example.com']);
    });
  });

  describe('failure isolation (T-88.2-21) and failure COUNTING (MED #18)', () => {
    it('counts a REJECTING send as failed and keeps going', async () => {
      emailService.send
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error('socket hang up'))
        .mockResolvedValueOnce({ success: true });

      const result = await offer([
        member({ email: 'a@example.com', user_id: 'auth0|a' }),
        member({ email: 'b@example.com', user_id: 'auth0|b' }),
        member({ email: 'c@example.com', user_id: 'auth0|c' }),
      ]);

      expect(result).toEqual({ sent: 2, failed: 1, unreachable: 0 });
    });

    it('counts a RESOLVED { success: false } as failed — the production failure path', async () => {
      // emailService.send NEVER throws on a Resend error; it resolves
      // { success: false, error }. Counting failures only in the catch would
      // make a genuinely failed dispatch increment neither counter.
      emailService.send
        .mockResolvedValueOnce({ success: true })
        .mockResolvedValueOnce({ success: false, error: 'resend down' })
        .mockResolvedValueOnce({ success: true });

      const result = await offer([
        member({ email: 'a@example.com', user_id: 'auth0|a' }),
        member({ email: 'b@example.com', user_id: 'auth0|b' }),
        member({ email: 'c@example.com', user_id: 'auth0|c' }),
      ]);

      expect(result).toEqual({ sent: 2, failed: 1, unreachable: 0 });
    });

    it('an all-resolved-failure batch reports failed === n, never { sent: 0, failed: 0 }', async () => {
      emailService.send.mockResolvedValue({ success: false, error: 'resend down' });
      const recipients = [
        member({ email: 'a@example.com', user_id: 'auth0|a' }),
        member({ email: 'b@example.com', user_id: 'auth0|b' }),
        member({ email: 'c@example.com', user_id: 'auth0|c' }),
      ];

      const result = await offer(recipients);

      expect(result).toEqual({ sent: 0, failed: recipients.length, unreachable: 0 });
      expect(result.failed).not.toBe(0);
    });

    it('never rejects, so an email failure can never fail the committed delete', async () => {
      emailService.send.mockRejectedValue(new Error('everything is broken'));
      await expect(offer([member(), member({ email: 'b@example.com' })])).resolves.toEqual({
        sent: 0, failed: 2, unreachable: 0,
      });
    });

    it('does not log a raw recipient address in per-item error output (V7 / T-88.2-22)', async () => {
      emailService.send.mockResolvedValue({ success: false, error: 'resend down' });
      await offer([member({ email: 'private.person@example.com', user_id: 'auth0|p' })]);

      const logged = console.error.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('private.person@example.com');
      expect(logged).toContain('@example.com'); // domain-only survives
    });
  });

  describe('content of every dispatched email (SPEC-REQ-8)', () => {
    it('carries the group name, the deadline date and the restore link', async () => {
      await offer([
        member({ email: 'a@example.com', user_id: 'auth0|a' }),
        member({ email: 'b@example.com', user_id: 'auth0|b' }),
      ]);

      expect(emailService.send).toHaveBeenCalledTimes(2);
      emailService.send.mock.calls.forEach(([args]) => {
        expect(args.html).toContain(GROUP_NAME);
        expect(args.html).toContain('Aug 24, 2026');
        expect(args.html).toContain(RESTORE_URL);
        expect(args.text).toContain(RESTORE_URL);
        expect(args.subject).toBeTruthy();
        expect(args.emailType).toBe('group_ownership_offer');
        expect(args.groupName).toBe(GROUP_NAME);
      });
    });

    it('formats the deadline in each recipient own timezone', async () => {
      // PURGE_AFTER is 02:00 UTC on the 24th, which is still the 23rd in LA.
      // A single shared pre-formatted date would give both members the same
      // calendar day and quietly mis-state one member's deadline.
      await offer([
        member({ email: 'utc@example.com', user_id: 'auth0|u', timezone: 'UTC' }),
        member({ email: 'la@example.com', user_id: 'auth0|l', timezone: 'America/Los_Angeles' }),
      ]);

      const byAddress = Object.fromEntries(emailService.send.mock.calls.map(([a]) => [a.to, a.html]));
      expect(byAddress['utc@example.com']).toContain('Aug 24, 2026');
      expect(byAddress['la@example.com']).toContain('Aug 23, 2026');
    });

    it('falls back rather than throwing when a member timezone is unusable', async () => {
      // An unrecognized IANA zone makes Intl throw a RangeError. That must not
      // cost a member their one notice.
      const result = await offer([member({ email: 'bad@example.com', timezone: 'Not/AZone' })]);
      expect(result).toEqual({ sent: 1, failed: 0, unreachable: 0 });
      expect(emailService.send.mock.calls[0][0].html).toContain('Aug 24, 2026');
    });

    it('makes no permanence claim in any dispatched email (SPEC-REQ-7)', async () => {
      await offer([member()]);
      const [args] = emailService.send.mock.calls[0];
      const forbidden = /cannot be undone|permanently remove|permanently delete/i;
      expect(args.html).not.toMatch(forbidden);
      expect(args.text).not.toMatch(forbidden);
      expect(args.subject).not.toMatch(forbidden);
    });
  });
});
