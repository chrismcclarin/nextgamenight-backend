// tests/services/notificationService.test.js
// Unit tests for notificationService getPreference and send routing

// Mock emailService and smsService before requiring notificationService
jest.mock('../../services/emailService', () => ({
  send: jest.fn()
}));

jest.mock('../../services/smsService', () => ({
  send: jest.fn()
}));

// Phase 85 / Plan 06 (BAPI-02): mock @sentry/node and force SENTRY_DSN BEFORE
// requiring notificationService so its DSN-gated Sentry require resolves to this
// mock — lets the additive-capture describe assert captureException fired.
// (virtual: @sentry/node need not be installed for the unit-config run.)
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCaptureException(...args),
}), { virtual: true });
process.env.SENTRY_DSN = 'https://fake@sentry.io/85';

const notificationService = require('../../services/notificationService');
const emailService = require('../../services/emailService');
const smsService = require('../../services/smsService');

describe('notificationService', () => {

  // =============================================
  // getPreference tests
  // =============================================
  describe('getPreference', () => {

    // --- Email channel tests ---

    it('returns true for email with null preferences (default)', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: null,
        notification_preferences: null
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'email')).toBe(true);
    });

    it('returns false for email when email_notifications_enabled is false', () => {
      const user = {
        email_notifications_enabled: false,
        sms_enabled: false,
        phone: null,
        notification_preferences: null
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'email')).toBe(false);
    });

    it('returns true for email when explicit preference is true', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: null,
        notification_preferences: {
          event_confirmation: { email: true }
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'email')).toBe(true);
    });

    it('returns false for email when explicit preference is false', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: null,
        notification_preferences: {
          event_confirmation: { email: false }
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'email')).toBe(false);
    });

    it('returns true for email when type not in preferences (falls to default)', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: null,
        notification_preferences: {
          reminder: { email: false }  // different type
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'email')).toBe(true);
    });

    // --- SMS channel tests (double-gate) ---

    it('returns false for sms with null preferences (default = false)', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: true,
        phone: '+14155551234',
        phone_verified: true,
        notification_preferences: null
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'sms')).toBe(false);
    });

    it('returns false for sms when sms_enabled is false even with explicit true preference', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: '+14155551234',
        phone_verified: true,
        notification_preferences: {
          event_confirmation: { sms: true }
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'sms')).toBe(false);
    });

    it('returns false for sms when phone is null even with sms_enabled=true and explicit preference', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: true,
        phone: null,
        notification_preferences: {
          event_confirmation: { sms: true }
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'sms')).toBe(false);
    });

    it('returns false for sms when phone is empty string even with sms_enabled=true', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: true,
        phone: '',
        phone_verified: true,
        notification_preferences: {
          event_confirmation: { sms: true }
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'sms')).toBe(false);
    });

    it('returns true for sms ONLY when sms_enabled=true AND phone exists AND phone_verified AND explicit preference is true', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: true,
        phone: '+14155551234',
        phone_verified: true,
        notification_preferences: {
          event_confirmation: { sms: true }
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'sms')).toBe(true);
    });

    it('returns false for sms when sms_enabled=true AND phone exists AND phone_verified but no explicit preference (default=false)', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: true,
        phone: '+14155551234',
        phone_verified: true,
        notification_preferences: null
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'sms')).toBe(false);
    });

    it('returns false for sms when phone_verified is false even with sms_enabled=true AND phone AND explicit preference', () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: true,
        phone: '+14155551234',
        phone_verified: false,
        notification_preferences: {
          event_confirmation: { sms: true }
        }
      };
      expect(notificationService.getPreference(user, 'event_confirmation', 'sms')).toBe(false);
    });
  });

  // =============================================
  // send tests
  // =============================================
  describe('send', () => {

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('dispatches to email only for default user (null prefs)', async () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: null,
        notification_preferences: null
      };

      emailService.send.mockResolvedValue({ success: true, id: 'msg_123' });

      const payload = {
        emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
        data: { gameName: 'Catan', date: 'Friday' }
      };

      const results = await notificationService.send(user, 'event_confirmation', payload);

      expect(emailService.send).toHaveBeenCalledWith(payload.emailParams);
      expect(smsService.send).not.toHaveBeenCalled();
      expect(results.email).toEqual({ success: true, id: 'msg_123' });
      expect(results.sms).toBeNull();
    });

    it('dispatches to both when user has explicit sms preference and sms_enabled+phone+phone_verified', async () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: true,
        phone: '+14155551234',
        phone_verified: true,
        notification_preferences: {
          event_confirmation: { email: true, sms: true }
        }
      };

      emailService.send.mockResolvedValue({ success: true, id: 'msg_456' });
      smsService.send.mockResolvedValue({ success: true, sid: 'SM_789' });

      const payload = {
        emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
        data: { gameName: 'Catan', date: 'Friday' }
      };

      const results = await notificationService.send(user, 'event_confirmation', payload);

      expect(emailService.send).toHaveBeenCalledWith(payload.emailParams);
      expect(smsService.send).toHaveBeenCalledWith({
        to: '+14155551234',
        type: 'event_confirmation',
        data: payload.data
      });
      expect(results.email).toEqual({ success: true, id: 'msg_456' });
      expect(results.sms).toEqual({ success: true, sid: 'SM_789' });
    });

    it('dispatches to neither when email disabled and no sms preference', async () => {
      const user = {
        email_notifications_enabled: false,
        sms_enabled: false,
        phone: null,
        notification_preferences: null
      };

      const payload = {
        emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
        data: { gameName: 'Catan', date: 'Friday' }
      };

      const results = await notificationService.send(user, 'event_confirmation', payload);

      expect(emailService.send).not.toHaveBeenCalled();
      expect(smsService.send).not.toHaveBeenCalled();
      expect(results.email).toBeNull();
      expect(results.sms).toBeNull();
    });

    it('handles emailService error gracefully (does not throw, returns error in results)', async () => {
      const user = {
        email_notifications_enabled: true,
        sms_enabled: false,
        phone: null,
        notification_preferences: null
      };

      emailService.send.mockRejectedValue(new Error('Resend timeout'));

      const payload = {
        emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
        data: {}
      };

      const results = await notificationService.send(user, 'event_confirmation', payload);

      expect(results.email).toEqual({ success: false, error: 'Resend timeout' });
      expect(results.sms).toBeNull();
    });

    it('handles smsService error gracefully', async () => {
      const user = {
        email_notifications_enabled: false,
        sms_enabled: true,
        phone: '+14155551234',
        phone_verified: true,
        notification_preferences: {
          reminder: { sms: true }
        }
      };

      smsService.send.mockRejectedValue(new Error('Twilio rate limit'));

      const payload = {
        emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
        data: { gameName: 'Catan', date: 'Friday' }
      };

      const results = await notificationService.send(user, 'reminder', payload);

      expect(emailService.send).not.toHaveBeenCalled();
      expect(results.email).toBeNull();
      expect(results.sms).toEqual({ success: false, error: 'Twilio rate limit' });
    });
  });

  // =============================================
  // sendToMany tests (Phase 50)
  // =============================================
  describe('sendToMany', () => {

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('dispatches to all users and returns per-user results', async () => {
      const users = [
        {
          user_id: 'user-1',
          email_notifications_enabled: true,
          sms_enabled: false,
          phone: null,
          phone_verified: false,
          notification_preferences: { event_created: { email: true } }
        },
        {
          user_id: 'user-2',
          email_notifications_enabled: false,
          sms_enabled: true,
          phone: '+14155551111',
          phone_verified: true,
          notification_preferences: { event_created: { sms: true } }
        },
        {
          user_id: 'user-3',
          email_notifications_enabled: true,
          sms_enabled: true,
          phone: '+14155552222',
          phone_verified: true,
          notification_preferences: { event_created: { email: true, sms: true } }
        }
      ];

      emailService.send.mockResolvedValue({ success: true, id: 'msg_100' });
      smsService.send.mockResolvedValue({ success: true, sid: 'SM_200' });

      const payloadBuilder = (user) => ({
        emailParams: { to: `${user.user_id}@test.com`, subject: 'Event', html: '<p>hi</p>' },
        data: { eventName: 'Game Night', groupName: 'Gamers', dateTime: 'Friday' }
      });

      const results = await notificationService.sendToMany(users, 'event_created', payloadBuilder);

      expect(results).toHaveLength(3);
      expect(results.find(r => r.userId === 'user-1')).toBeDefined();
      expect(results.find(r => r.userId === 'user-2')).toBeDefined();
      expect(results.find(r => r.userId === 'user-3')).toBeDefined();
    });

    it('handles partial failures gracefully', async () => {
      const users = [
        {
          user_id: 'user-ok',
          email_notifications_enabled: true,
          sms_enabled: true,
          phone: '+14155551111',
          phone_verified: true,
          notification_preferences: { event_created: { sms: true } }
        },
        {
          user_id: 'user-fail',
          email_notifications_enabled: true,
          sms_enabled: true,
          phone: '+14155552222',
          phone_verified: true,
          notification_preferences: { event_created: { sms: true } }
        }
      ];

      emailService.send.mockResolvedValue({ success: true, id: 'msg_ok' });
      // smsService.send succeeds for first call, fails for second
      smsService.send
        .mockResolvedValueOnce({ success: true, sid: 'SM_OK' })
        .mockRejectedValueOnce(new Error('Twilio timeout'));

      const payloadBuilder = (user) => ({
        emailParams: { to: `${user.user_id}@test.com`, subject: 'Event', html: '<p>hi</p>' },
        data: { eventName: 'Game Night', groupName: 'Gamers', dateTime: 'Friday' }
      });

      // Should not throw
      const results = await notificationService.sendToMany(users, 'event_created', payloadBuilder);

      expect(results).toHaveLength(2);
      const okResult = results.find(r => r.userId === 'user-ok');
      const failResult = results.find(r => r.userId === 'user-fail');
      expect(okResult).toBeDefined();
      expect(failResult).toBeDefined();
      // The fail user's sms result should show the error (caught by send())
      expect(failResult.sms).toEqual({ success: false, error: 'Twilio timeout' });
    });

    it('works with empty users array', async () => {
      const results = await notificationService.sendToMany([], 'event_created', () => ({}));
      expect(results).toEqual([]);
    });
  });
});

// =============================================
// Phase 85 / Plan 06 (BAPI-02): additive Sentry capture on send failures
// =============================================
// DB-FREE — run in isolation via:
//   npx jest --config jest.unit.config.js \
//     --testMatch '**/tests/services/notificationService.test.js' \
//     -t 'additive Sentry capture' --forceExit
// (the -t filter excludes the DB-backed BSEC-01 block below, which needs Postgres.)
// Asserts the swallowed email/SMS send failures now escalate to Sentry WITHOUT
// changing the existing console.error + swallow (no throw; error still in results).
describe('additive Sentry capture (Phase 85/06 BAPI-02)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('email send failure: captures to Sentry (channel:email tag) AND still swallows (no throw)', async () => {
    const user = {
      email_notifications_enabled: true,
      sms_enabled: false,
      phone: null,
      notification_preferences: null,
    };
    const err = new Error('Resend 500');
    emailService.send.mockRejectedValue(err);

    const payload = {
      emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
      data: {},
    };

    // Must NOT throw (swallow preserved)
    const results = await notificationService.send(user, 'event_confirmation', payload);

    // Additive capture fired with the documented tags
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(err, {
      tags: { service: 'notification', channel: 'email', type: 'event_confirmation' },
    });
    // Existing behavior unchanged: error surfaced in results, sms untouched
    expect(results.email).toEqual({ success: false, error: 'Resend 500' });
    expect(results.sms).toBeNull();
  });

  it('SMS send failure: captures to Sentry (channel:sms tag) AND still swallows (no throw)', async () => {
    const user = {
      email_notifications_enabled: false,
      sms_enabled: true,
      phone: '+14155551234',
      phone_verified: true,
      notification_preferences: { reminder: { sms: true } },
    };
    const err = new Error('Twilio 429');
    smsService.send.mockRejectedValue(err);

    const payload = {
      emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
      data: { gameName: 'Catan' },
    };

    const results = await notificationService.send(user, 'reminder', payload);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(err, {
      tags: { service: 'notification', channel: 'sms', type: 'reminder' },
    });
    expect(results.sms).toEqual({ success: false, error: 'Twilio 429' });
    expect(results.email).toBeNull();
  });

  it('successful send does NOT call captureException (capture is failure-only)', async () => {
    const user = {
      email_notifications_enabled: true,
      sms_enabled: false,
      phone: null,
      notification_preferences: null,
    };
    emailService.send.mockResolvedValue({ success: true, id: 'msg_ok' });

    const payload = {
      emailParams: { to: 'user@test.com', subject: 'Test', html: '<p>hi</p>' },
      data: {},
    };

    const results = await notificationService.send(user, 'event_confirmation', payload);

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(results.email).toEqual({ success: true, id: 'msg_ok' });
  });
});

// =============================================
// BSEC-01 / D-03: User PII defaultScope + stripMemberPII allow-list
// =============================================
// These assert the durable fail-closed behavior added in 83-06:
//   1) a default User read has NO email/phone
//   2) a .scope('withContactInfo')/.unscoped() read HAS email/phone (so the
//      notification path still gets contact info and emails/SMS still send)
//   3) stripMemberPII returns ONLY allow-listed fields (new fields default to
//      stripped — incl. is_platform_admin)
// 1 & 2 are DB-backed (they exercise the Sequelize model scope). The global
// tests/setup.js beforeAll requires a test DB, so these run in CI; locally
// without Postgres the whole file is skipped by that gate.
describe('BSEC-01 User PII defaultScope', () => {
  const { User } = require('../../models');
  const { stripMemberPII } = require('../../services/authorizationService');

  const TEST_USER_ID = 'auth0|bsec01-pii-scope-test';
  const TEST_EMAIL = 'bsec01-scope-test@example.com';
  const TEST_PHONE = '+14155550199';

  // beforeEach (not beforeAll): the global tests/setup.js beforeEach TRUNCATEs
  // every table before each test. A beforeAll seed would be wiped before Test 1,
  // so the BSEC-01 User must be re-created per-test. Jest runs the global
  // setup.js beforeEach BEFORE this block-local one, so this seed lands on the
  // freshly truncated, schema-intact DB — exactly what we want. (This orphaned
  // DB suite was owned by no sibling plan; plan 05 takes it.)
  beforeEach(async () => {
    await User.destroy({ where: { user_id: TEST_USER_ID } });
    await User.create({
      user_id: TEST_USER_ID,
      username: 'bsec01-scope-test',
      email: TEST_EMAIL,
      phone: TEST_PHONE,
      phone_verified: true,
    });
  });

  // Redundant under the per-test TRUNCATE (each test starts empty) but kept as
  // harmless belt-and-suspenders cleanup.
  afterAll(async () => {
    await User.destroy({ where: { user_id: TEST_USER_ID } });
  });

  it('Test 1: a default User read has NO email/phone', async () => {
    const row = await User.findOne({ where: { user_id: TEST_USER_ID } });
    expect(row).not.toBeNull();
    const json = row.toJSON();
    expect(json).not.toHaveProperty('email');
    expect(json).not.toHaveProperty('phone');
    // identity fields still present
    expect(json.user_id).toBe(TEST_USER_ID);
    expect(json.username).toBe('bsec01-scope-test');
  });

  it('Test 2a: .scope("withContactInfo") restores email/phone', async () => {
    const row = await User.scope('withContactInfo').findOne({ where: { user_id: TEST_USER_ID } });
    expect(row.email).toBe(TEST_EMAIL);
    expect(row.phone).toBe(TEST_PHONE);
  });

  it('Test 2b: .unscoped() also restores email/phone', async () => {
    const row = await User.unscoped().findOne({ where: { user_id: TEST_USER_ID } });
    expect(row.email).toBe(TEST_EMAIL);
    expect(row.phone).toBe(TEST_PHONE);
  });

  it('Test 3: stripMemberPII returns ONLY allow-listed fields (new fields default to stripped)', () => {
    const input = {
      id: 'uuid-x',
      user_id: 'auth0|x',
      username: 'x',
      display_name: 'X',
      profile_picture_url: 'https://example.com/a.png',
      avatar_url: 'https://example.com/b.png',
      UserGroup: { role: 'member', joined_at: '2026-01-01T00:00:00Z' },
      // PII + a brand-new field that must default to STRIPPED:
      email: 'x@example.com',
      phone: '+14155550000',
      notification_preferences: { reminder: true },
      is_platform_admin: true, // future field — must be stripped by the allow-list
      some_future_secret: 'leak-me-if-omit-list',
    };

    const result = stripMemberPII(input);

    // allow-listed fields preserved
    expect(result.id).toBe('uuid-x');
    expect(result.user_id).toBe('auth0|x');
    expect(result.username).toBe('x');
    expect(result.display_name).toBe('X');
    expect(result.profile_picture_url).toBe('https://example.com/a.png');
    expect(result.avatar_url).toBe('https://example.com/b.png');
    expect(result.UserGroup).toEqual({ role: 'member', joined_at: '2026-01-01T00:00:00Z' });

    // everything else stripped — INCLUDING fields not previously in the omit-list
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('phone');
    expect(result).not.toHaveProperty('notification_preferences');
    expect(result).not.toHaveProperty('is_platform_admin');
    expect(result).not.toHaveProperty('some_future_secret');
  });

  it('Test 3b: stripMemberPII preserves UserGroup even when explicitly null (game-only signal)', () => {
    const result = stripMemberPII({
      id: 'uuid-caller',
      user_id: 'auth0|caller',
      username: 'caller',
      email: 'caller@example.com',
      UserGroup: null,
    });
    expect(result).toHaveProperty('UserGroup');
    expect(result.UserGroup).toBeNull();
    expect(result).not.toHaveProperty('email');
  });
});
