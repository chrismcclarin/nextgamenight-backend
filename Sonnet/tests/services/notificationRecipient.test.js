// tests/services/notificationRecipient.test.js
//
// BSEC-01 / D-03 — RESEARCH Pitfall 4 hardening (the binding pre-ship gate's
// non-empty-recipient-email assertion).
//
// The 83-06 change set User.defaultScope to STRIP email/phone from every
// default read, and made the ~18 legitimate notification readers opt back in
// via `User.scope('withContactInfo')` / `.unscoped()`. A green test suite alone
// does NOT prove that the opt-in actually restores the contact info — a wrong
// scope name, a typo, or a defaultScope that also leaked into the scoped read
// would silently produce recipients with an EMPTY email, and staging emails
// would go out blank (Pitfall 4: "tests pass but staging emails go out empty").
//
// This test resolves a recipient through the SAME scope readers the real
// notification paths use (services/promptLifecycleService.js,
// workers/promptWorker.js, routes/events.js, etc. all use
// `User.scope('withContactInfo').findByPk/findOne`) and asserts the resolved
// recipient's email is a NON-EMPTY string — and that the fail-closed default
// genuinely strips it when the scope is NOT applied.
const { User, sequelize } = require('../../models');

describe('Notification recipient resolution — non-empty email (D-03 / Pitfall 4)', () => {
  const RECIPIENT = {
    user_id: 'auth0|notif-recipient-pitfall4',
    username: 'Pitfall Four Recipient',
    email: 'recipient.pitfall4@example.com',
    phone: '+15555550123',
  };

  // Schema built once by tests/globalSetup.js; the global beforeEach TRUNCATEs
  // all tables, so the RECIPIENT user must be seeded per-test (the three tests
  // below all read it back). No sequelize.close() here — the connection
  // lifecycle is owned by tests/globalTeardown.js (BTEST-02).
  beforeEach(async () => {
    await User.create(RECIPIENT);
  });

  // The core Pitfall-4 assertion: the real reader path returns a non-empty
  // email. This is `User.scope('withContactInfo').findByPk(...)` — the exact
  // reader used by promptLifecycleService.resolveRecipient and the workers.
  it('resolves a non-empty email through .scope(withContactInfo).findByPk', async () => {
    const created = await User.findOne({ where: { user_id: RECIPIENT.user_id } });
    expect(created).not.toBeNull();

    const recipient = await User.scope('withContactInfo').findByPk(created.id);

    expect(recipient).not.toBeNull();
    expect(typeof recipient.email).toBe('string');
    expect(recipient.email.length).toBeGreaterThan(0);
    expect(recipient.email).toBe(RECIPIENT.email);
  });

  // The phone reader path (smsService recipients) must likewise be non-empty.
  it('resolves a non-empty phone through .scope(withContactInfo).findOne', async () => {
    const recipient = await User.scope('withContactInfo').findOne({
      where: { user_id: RECIPIENT.user_id },
    });

    expect(recipient).not.toBeNull();
    expect(typeof recipient.phone).toBe('string');
    expect(recipient.phone.length).toBeGreaterThan(0);
    expect(recipient.phone).toBe(RECIPIENT.phone);
  });

  // Fail-closed default proof: WITHOUT the scope, email/phone are stripped.
  // This guards against a regression where the defaultScope is dropped and PII
  // leaks into every default read (the inverse of Pitfall 4).
  it('strips email/phone on the default (unscoped) read — fail-closed default', async () => {
    const defaultRead = await User.findOne({ where: { user_id: RECIPIENT.user_id } });

    expect(defaultRead).not.toBeNull();
    expect(defaultRead.email).toBeUndefined();
    expect(defaultRead.phone).toBeUndefined();
  });
});
