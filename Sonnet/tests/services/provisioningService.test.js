// tests/services/provisioningService.test.js
// Phase 88.8 plan 04 (BOPS-05 / SPEC R2, R3, R4, R11) — the provisioning policy suite.
//
// Runs against the suite's REAL Postgres (D-16): tests/globalSetup.js force-syncs the
// schema once and tests/setup.js truncates before every test, so a genuine unique
// violation is reachable here (which is what plan 05 needs).
//
// Two module boundaries are mocked, both with the mock-prefixed idiom Jest's
// hoist-safety rule requires (pattern: tests/routes/users.timezone-backfill.test.js:15-35):
//   - @sentry/node          -> so the R4 reporting can be asserted without a DSN
//   - services/auth0Service -> so each branch can pin the EXACT getUserById call count
//
// The Task 1 helper assertions (utils/provisioningReport.js) live in this file
// deliberately: a separate registry-visible test file for one 30-line util is surface
// for no benefit, and the helper's behaviour only matters where it is consumed.

const mockSentryCaptureException = jest.fn();
const mockSentryAddBreadcrumb = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockSentryCaptureException(...args),
  addBreadcrumb: (...args) => mockSentryAddBreadcrumb(...args),
}));

const { emailDomain, reportProvisioning, PROVISIONING_REASONS } =
  require('../../utils/provisioningReport');

describe('utils/provisioningReport — emailDomain (SPEC R4 PII rule, mechanical half)', () => {
  beforeEach(() => {
    mockSentryCaptureException.mockClear();
  });

  it('returns only the lowercased domain for a mixed-case, plus-tagged address', () => {
    const out = emailDomain('  Alice.Smith+GameNight@Example.CO.UK  ');
    expect(out).toBe('example.co.uk');
    // The two halves that must never survive: the local part and the plus tag.
    expect(out).not.toContain('alice');
    expect(out).not.toContain('Alice');
    expect(out).not.toContain('+');
    expect(out).not.toContain('gamenight');
  });

  it('returns auth0.local for a synthetic address', () => {
    expect(emailDomain('auth0-1234567890@auth0.local')).toBe('auth0.local');
  });

  it('returns null for null, empty string, whitespace, a non-string and a value with no at-sign', () => {
    expect(emailDomain(null)).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
    expect(emailDomain('')).toBeNull();
    expect(emailDomain('   ')).toBeNull();
    expect(emailDomain(42)).toBeNull();
    expect(emailDomain({})).toBeNull();
    expect(emailDomain('not-an-address')).toBeNull();
    expect(emailDomain('trailing-at@')).toBeNull();
  });

  it('splits on the LAST at-sign so a quoted local part cannot leak a fake domain', () => {
    expect(emailDomain('"weird@local"@example.com')).toBe('example.com');
  });
});

describe('utils/provisioningReport — reportProvisioning (SPEC R4)', () => {
  beforeEach(() => {
    mockSentryCaptureException.mockClear();
  });

  it('captures exactly once with the provisioning feature tag and the caller reason', () => {
    reportProvisioning({
      sub: 'auth0|report-1',
      reason: PROVISIONING_REASONS.MGMT_API_FAILED,
      email: 'alice@example.com',
    });

    expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
    const [, options] = mockSentryCaptureException.mock.calls[0];
    expect(options.tags.feature).toBe('provisioning');
    expect(options.tags.reason).toBe('mgmt_api_failed');
  });

  it('the whole captured payload carries the domain but no local part and no http substring', () => {
    reportProvisioning({
      sub: 'auth0|report-2',
      reason: PROVISIONING_REASONS.EMAIL_UNVERIFIED,
      email: 'SecretLocalPart@example.com',
      err: new Error('management lookup rejected'),
    });

    expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
    const [err, options] = mockSentryCaptureException.mock.calls[0];
    // Errors do not survive JSON.stringify, so stringify the message explicitly
    // alongside the structured half — otherwise this assertion is vacuous.
    const payload = JSON.stringify({
      message: err && err.message,
      stackHead: String((err && err.stack) || '').split('\n')[0],
      options,
    });

    expect(payload).toContain('example.com');
    expect(payload.toLowerCase()).not.toContain('secretlocalpart');
    expect(payload).not.toContain('http');
  });

  it('synthesises an error when none is supplied, so a fallback is always a real event', () => {
    reportProvisioning({ sub: 'auth0|report-3', reason: PROVISIONING_REASONS.CLAIMS_MISSING });
    const [err] = mockSentryCaptureException.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('claims_missing');
  });

  it('falls back to a generic reason rather than throwing on an unrecognised one', () => {
    expect(() =>
      reportProvisioning({ sub: 'auth0|report-4', reason: 'not-a-real-reason' })
    ).not.toThrow();
    const [, options] = mockSentryCaptureException.mock.calls[0];
    expect(Object.values(PROVISIONING_REASONS)).not.toContain(options.tags.reason);
    expect(typeof options.tags.reason).toBe('string');
    expect(options.tags.reason.length).toBeGreaterThan(0);
  });

  it('is a no-op, never a throw, when captureException is unavailable (DSN-less dev/test)', () => {
    const sentry = require('@sentry/node');
    const saved = sentry.captureException;
    // Simulate a resolved module that does not expose captureException.
    sentry.captureException = undefined;
    try {
      expect(() =>
        reportProvisioning({ sub: 'auth0|report-5', reason: PROVISIONING_REASONS.CLAIMS_MISSING })
      ).not.toThrow();
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
    } finally {
      sentry.captureException = saved;
    }
  });

  it('exposes the frozen SPEC R4 reason vocabulary', () => {
    expect(Object.isFrozen(PROVISIONING_REASONS)).toBe(true);
    expect(Object.values(PROVISIONING_REASONS).sort()).toEqual([
      'claims_missing',
      'email_unverified',
      'genuine_conflict',
      'mgmt_api_failed',
      'orphan_released',
      'unique_email_collision',
    ]);
  });
});

// ===========================================================================
// services/provisioningService.js — the policy suite (SPEC R2, R3, R4, R11)
// ===========================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn(),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  // Faithful stand-in for the shipped contract at services/auth0Service.js:322-328.
  extractUserDetails: jest.fn((u) => ({
    user_id: (u && u.user_id) || null,
    email: (u && u.email) || null,
    username: (u && u.username) || null,
    email_verified: Boolean(u && u.email_verified),
    picture: (u && u.picture) || null,
  })),
}));

const auth0Service = require('../../services/auth0Service');
const provisioningService = require('../../services/provisioningService');
const { isEmailCollision, EMAIL_UNIQUE_CONSTRAINTS } = provisioningService;
const { User, Group, UserGroup } = require('../../models');

const SERVICE_PATH = path.join(__dirname, '..', '..', 'services', 'provisioningService.js');

// Every username this suite ever provisions, for the negative-space assertion at the
// bottom of the file. That one survives a refactor of the chain's SHAPE, which the
// per-position cases do not.
const provisionedUsernames = [];

async function provision(args, overrides) {
  const result = await provisioningService.provisionOrRepair(args, overrides);
  if (result && result.user && typeof result.user.username === 'string') {
    provisionedUsernames.push(result.user.username);
  }
  return result;
}

// UPDATE counter: a model hook is used rather than a prototype spy so it counts every
// path that issues an UPDATE, including one issued from inside the service.
let updateCount = 0;

function syntheticFor(sub) {
  return `${sub.replace(/[|:]/g, '-')}@auth0.local`;
}

describe('services/provisioningService — provisionOrRepair', () => {
  beforeAll(() => {
    User.addHook('beforeUpdate', 'countProvisioningUpdates', () => {
      updateCount += 1;
    });
  });

  afterAll(() => {
    User.removeHook('beforeUpdate', 'countProvisioningUpdates');
  });

  beforeEach(() => {
    updateCount = 0;
    jest.clearAllMocks();
    mockSentryCaptureException.mockClear();
    // Round 3 #25: the repair-path vendor-outage report is throttled per process; every
    // case that asserts a capture must start with the throttle open.
    provisioningService._resetRepairReportThrottle();
    auth0Service.getUserById.mockRejectedValue(
      new Error('Auth0 Management API credentials not configured')
    );
    auth0Service.extractUserDetails.mockImplementation((u) => ({
      user_id: (u && u.user_id) || null,
      email: (u && u.email) || null,
      username: (u && u.username) || null,
      email_verified: Boolean(u && u.email_verified),
      picture: (u && u.picture) || null,
    }));
  });

  // -----------------------------------------------------------------------
  // CREATE path — the three-way email rule (SPEC R2 / R3)
  // -----------------------------------------------------------------------
  describe('CREATE path — the three-way email rule', () => {
    it('ARM 1: a verified claim is adopted with ZERO Management calls, even while getUserById rejects', async () => {
      const sub = 'auth0|svc-arm1';
      const result = await provision({ sub, claims: { email: 'real@example.com', email_verified: true } });

      expect(result.status).toBe('provisioned');
      expect(result.created).toBe(true);
      expect(result.user.email).toBe('real@example.com');
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
      expect(result.reason).toBeNull();
    });

    it('ARM 2: a present-but-UNVERIFIED claim mints the synthetic address with ZERO Management calls and ONE Sentry event', async () => {
      const sub = 'auth0|svc-arm2';
      const result = await provision({ sub, claims: { email: 'unverified@example.com', email_verified: false } });

      expect(result.user.email).toBe(syntheticFor(sub));
      expect(result.user.email).not.toBe('unverified@example.com');
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('email_unverified');
    });

    it('ARM 2b: an ABSENT email_verified claim reads as unverified — synthetic, ZERO Management calls', async () => {
      const sub = 'auth0|svc-arm2b';
      const result = await provision({ sub, claims: { email: 'noflag@example.com' } });

      expect(result.user.email).toBe(syntheticFor(sub));
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
    });

    it('ARM 3: no claim email plus a REJECTING getUserById mints the synthetic address and reports mgmt_api_failed', async () => {
      const sub = 'auth0|svc-arm3-throw';
      const result = await provision({ sub, claims: { name: 'Claimless Person' } });

      expect(auth0Service.getUserById).toHaveBeenCalledTimes(1);
      expect(result.user.email).toBe(syntheticFor(sub));
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('mgmt_api_failed');
    });

    it('ARM 3: a Management user whose email_verified is false gets the synthetic address, reason email_unverified', async () => {
      const sub = 'auth0|svc-arm3-unverified';
      auth0Service.getUserById.mockResolvedValueOnce({
        user_id: sub, email: 'mgmt-unverified@example.com', email_verified: false, username: 'mgmtname',
      });

      const result = await provision({ sub, claims: {} });

      expect(result.user.email).toBe(syntheticFor(sub));
      expect(result.reason).toBe('email_unverified');
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('email_unverified');
    });

    it('ARM 3: a VERIFIED Management user has their email adopted', async () => {
      const sub = 'auth0|svc-arm3-verified';
      auth0Service.getUserById.mockResolvedValueOnce({
        user_id: sub, email: 'fallback-real@example.com', email_verified: true, username: 'fallbackuser',
      });

      const result = await provision({ sub, claims: {} });

      expect(result.user.email).toBe('fallback-real@example.com');
      expect(result.user.username).toBe('fallbackuser');
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
    });

    it('ARM 3: getUserById resolving NULL on the create path returns identity_gone and creates no row', async () => {
      const sub = 'auth0|svc-identity-gone';
      auth0Service.getUserById.mockResolvedValueOnce(null);

      const result = await provision({ sub, claims: {} });

      expect(result.status).toBe('identity_gone');
      expect(result.user).toBeNull();
      expect(await User.count({ where: { user_id: sub } })).toBe(0);
    });

    it('normalises the stored address with one trim-and-lowercase rule at persistence', async () => {
      const sub = 'auth0|svc-normalise';
      const result = await provision({
        sub,
        claims: { email: '  Mixed.Case@Example.COM  ', email_verified: true },
      });
      expect(result.user.email).toBe('mixed.case@example.com');
    });

    it('a >50-character name provisions successfully with a 50-character username', async () => {
      const sub = 'auth0|svc-long-name';
      const given = 'Bartholomew Maximilian Fitzgerald';
      const family = 'Wolfeschlegelsteinhausenbergerdorff';
      const result = await provision({
        sub,
        claims: { email: 'long@example.com', email_verified: true, given_name: given, family_name: family },
      });
      expect(result.user.username).toHaveLength(50);
      expect(result.user.username).toBe(`${given} ${family}`.slice(0, 50));
    });

    it('omits the timezone key when detectedTimezone is null so the model default applies', async () => {
      const sub = 'auth0|svc-no-tz';
      const result = await provision({ sub, claims: { email: 'tz@example.com', email_verified: true }, detectedTimezone: null });
      expect(result.user.timezone).toBeNull();
    });

    it('persists a supplied detectedTimezone on first creation', async () => {
      const sub = 'auth0|svc-tz';
      const result = await provision({
        sub, claims: { email: 'tz2@example.com', email_verified: true }, detectedTimezone: 'America/New_York',
      });
      expect(result.user.timezone).toBe('America/New_York');
    });
  });

  // -----------------------------------------------------------------------
  // The username filter — the leak claims-first would otherwise open
  // -----------------------------------------------------------------------
  describe('username chain — no candidate may be the claim email address', () => {
    it('THE CASE THE FILTER EXISTS FOR: claims.name === the claim email with email_verified FALSE', async () => {
      // email_verified:false is MANDATORY here. With `true` the resolved address and the
      // raw claim are the same string, so the test passes under a correct filter AND
      // under one wrongly bound to the resolved value — it would discriminate nothing.
      const sub = 'auth0|svc-leak-unverified';
      const result = await provision({
        sub,
        claims: { email: 'alice@example.com', email_verified: false, name: 'alice@example.com' },
      });

      expect(result.user.email).toBe(syntheticFor(sub));
      expect(result.user.username).not.toBe('alice@example.com');
      expect(result.user.username).not.toContain('@');
      // Falls through to the email LOCAL PART, which stays adopted by design.
      expect(result.user.username).toBe('alice');
    });

    it('the same case with email_verified TRUE also refuses the address', async () => {
      const sub = 'auth0|svc-leak-verified';
      const result = await provision({
        sub,
        claims: { email: 'bob@example.com', email_verified: true, name: 'bob@example.com' },
      });
      expect(result.user.email).toBe('bob@example.com');
      expect(result.user.username).not.toContain('@');
      expect(result.user.username).toBe('bob');
    });

    it.each([['username'], ['name'], ['nickname'], ['given_name']])(
      'EVERY POSITION is filtered, not just the first: claims.%s holding the claim email',
      async (position) => {
        const sub = `auth0|svc-leak-${position}`;
        const claims = { email: 'carol@example.com', email_verified: false };
        claims[position] = 'carol@example.com';

        const result = await provision({ sub, claims });

        expect(result.user.username).not.toContain('@');
        expect(result.user.username).toBe('carol');
      }
    );

    it('NORMALISATION, not identity: a padded, mixed-case copy of the claim email is rejected', async () => {
      // The shipped compare at services/auth0Service.js:176 is a strict unnormalised
      // !== and would let this through.
      const sub = 'auth0|svc-leak-normalised';
      const result = await provision({
        sub,
        claims: { email: 'alice@example.com', email_verified: false, name: '  ALICE@Example.COM  ' },
      });
      expect(result.user.username).not.toContain('@');
      expect(result.user.username).toBe('alice');
    });

    it('the email LOCAL PART candidate is still ADOPTED — deriving a display name is not adopting an address', async () => {
      const sub = 'auth0|svc-localpart';
      const result = await provision({ sub, claims: { email: 'alice@example.com', email_verified: true } });
      expect(result.user.username).toBe('alice');
    });

    it('a non-string candidate does not throw — the String(name ?? "") coercion survives the filter', async () => {
      const sub = 'auth0|svc-nonstring';
      const result = await provision({
        sub,
        claims: { email: 'dave@example.com', email_verified: true, name: 12345, nickname: { a: 1 } },
      });
      expect(result.status).toBe('provisioned');
      expect(typeof result.user.username).toBe('string');
      expect(result.user.username.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // REPAIR path (SPEC R3 upgrade + D-36)
  // -----------------------------------------------------------------------
  describe('REPAIR path — existing rows', () => {
    it('a synthetic-email row plus a now-verified claim is repaired to the real address', async () => {
      const sub = 'auth0|svc-repair-synth';
      await User.create({ user_id: sub, username: 'Someone', email: syntheticFor(sub) });

      const result = await provision({ sub, claims: { email: 'now-verified@example.com', email_verified: true } });

      expect(result.created).toBe(false);
      expect(result.changed).toBe(true);
      expect(result.user.email).toBe('now-verified@example.com');
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
    });

    it('D-36: a row with a non-null email_changed_at is NEVER email-repaired — no compare, no Management call, no UPDATE, no Sentry event', async () => {
      // THE case an executor omits, because it looks exactly like the row above.
      const sub = 'auth0|svc-d36-skip';
      await User.create({
        user_id: sub, username: 'Someone', email: syntheticFor(sub), email_changed_at: new Date(),
      });

      const result = await provision({ sub, claims: { email: 'auth0-claim@example.com', email_verified: true } });

      const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(row.email).toBe(syntheticFor(sub));
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
      expect(updateCount).toBe(0);
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
      expect(result.notes).toContain('email_repair_skipped_user_set');
    });

    it('D-36 is scoped to the EMAIL arm alone — username and picture_url repair still run for that row', async () => {
      const sub = 'auth0|svc-d36-scope';
      await User.create({
        user_id: sub, username: 'User', email: 'user-set@example.com', email_changed_at: new Date(),
      });

      const result = await provision({
        sub,
        claims: {
          email: 'auth0-claim@example.com',
          email_verified: true,
          name: 'Real Name',
          connection_strategy: 'google-oauth2',
          picture: 'https://lh3.googleusercontent.com/a/AAA',
        },
      });

      const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(row.email).toBe('user-set@example.com');
      expect(row.username).toBe('Real Name');
      expect(row.picture_url).toBe('https://lh3.googleusercontent.com/a/AAA');
      expect(result.changed).toBe(true);
    });

    // INVERTED 2026-09-05 (code review HIGH-1, owner ruling). This test previously
    // asserted the opposite — that a REAL stored address is rewritten to a differing
    // verified claim. That behaviour was ungated where the Management half of the same
    // arm is gated, was broader than SPEC R3's acceptance line ("repairs a SYNTHETIC
    // row"), and carried none of the invite/feedback/notice companion work that the
    // user-initiated change path does. The guard is now the assertion.
    it('a REAL-email row plus a verified claim for a DIFFERENT address is LEFT ALONE — the repair is synthetic-only', async () => {
      const sub = 'auth0|svc-repair-real';
      await User.create({ user_id: sub, username: 'Someone', email: 'old@example.com' });

      const result = await provision({ sub, claims: { email: 'new@example.com', email_verified: true } });

      const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(row.email).toBe('old@example.com');
      expect(result.user.email).toBe('old@example.com');
      expect(result.changed).toBe(false);
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
    });

    it('a real-email row plus an UNVERIFIED claim leaves the stored address alone', async () => {
      const sub = 'auth0|svc-repair-unverified';
      await User.create({ user_id: sub, username: 'Someone', email: 'keepme@example.com' });

      const result = await provision({ sub, claims: { email: 'attacker@example.com', email_verified: false } });

      const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(row.email).toBe('keepme@example.com');
      expect(result.changed).toBe(false);
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
    });

    it('a HEALTHY row with ABSENT claims makes ZERO Management calls, ZERO UPDATEs and emits nothing', async () => {
      const sub = 'auth0|svc-repair-healthy';
      await User.create({ user_id: sub, username: 'Someone', email: 'healthy@example.com' });

      const result = await provision({ sub, claims: {} });

      expect(auth0Service.getUserById).not.toHaveBeenCalled();
      expect(updateCount).toBe(0);
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
      expect(result.changed).toBe(false);
    });

    it('a SYNTHETIC row with ABSENT claims and getUserById resolving null keeps the row, status provisioned, NO Sentry event', async () => {
      const sub = 'auth0|svc-repair-gone';
      await User.create({ user_id: sub, username: 'Someone', email: syntheticFor(sub) });
      auth0Service.getUserById.mockResolvedValueOnce(null);

      const result = await provision({ sub, claims: {} });

      expect(result.status).toBe('provisioned');
      expect(result.user).not.toBeNull();
      expect(await User.count({ where: { user_id: sub } })).toBe(1);
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
      expect(result.notes).toContain('auth0_identity_gone');
    });

    it('a SYNTHETIC row with ABSENT claims adopts a VERIFIED Management address', async () => {
      const sub = 'auth0|svc-repair-mgmt';
      await User.create({ user_id: sub, username: 'User', email: syntheticFor(sub) });
      auth0Service.getUserById.mockResolvedValueOnce({
        user_id: sub, email: 'MgmtReal@Example.com', email_verified: true, username: 'mgmtuser',
      });

      const result = await provision({ sub, claims: {} });

      expect(result.user.email).toBe('mgmtreal@example.com');
      expect(result.user.username).toBe('mgmtuser');
    });

    it('a SYNTHETIC row with ABSENT claims does NOT adopt an UNVERIFIED Management address', async () => {
      const sub = 'auth0|svc-repair-mgmt-unverified';
      await User.create({ user_id: sub, username: 'Someone', email: syntheticFor(sub) });
      auth0Service.getUserById.mockResolvedValueOnce({
        user_id: sub, email: 'mgmt-unverified@example.com', email_verified: false, username: 'mgmtuser',
      });

      const result = await provision({ sub, claims: {} });

      const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(row.email).toBe(syntheticFor(sub));
      expect(result.changed).toBe(false);
    });

    it('a second fetch with the same mixed-case verified claim issues ZERO UPDATEs', async () => {
      const sub = 'auth0|svc-idempotent';
      await provision({ sub, claims: { email: 'Steady@Example.com', email_verified: true } });

      updateCount = 0;
      const result = await provision({ sub, claims: { email: 'STEADY@example.COM', email_verified: true } });

      expect(updateCount).toBe(0);
      expect(result.changed).toBe(false);
      expect(result.user.email).toBe('steady@example.com');
    });

    it('a second fetch for a permanently-unverified user emits NO further Sentry event', async () => {
      const sub = 'auth0|svc-perma-unverified';
      await provision({ sub, claims: { email: 'never@example.com', email_verified: false } });
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1); // the create-path fallback

      mockSentryCaptureException.mockClear();
      const result = await provision({ sub, claims: { email: 'never@example.com', email_verified: false } });

      expect(mockSentryCaptureException).not.toHaveBeenCalled();
      expect(result.changed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // picture_url (D-26 + D-27, SPEC R11 storage half)
  // -----------------------------------------------------------------------
  describe('picture_url', () => {
    const SOCIAL = 'google-oauth2';

    it('stores an https picture for a SOCIAL connection, refreshes it when it changes, and leaves it alone when the claim is absent', async () => {
      const sub = 'auth0|svc-pic';
      const base = { email: 'pic@example.com', email_verified: true, connection_strategy: SOCIAL };

      let result = await provision({ sub, claims: { ...base, picture: 'https://lh3.googleusercontent.com/a/AAA' } });
      expect(result.user.picture_url).toBe('https://lh3.googleusercontent.com/a/AAA');

      result = await provision({ sub, claims: { ...base, picture: 'https://lh3.googleusercontent.com/a/BBB' } });
      expect(result.user.picture_url).toBe('https://lh3.googleusercontent.com/a/BBB');
      expect(result.changed).toBe(true);

      // ABSENT claim -> leave alone. A Management-fallback login must never wipe an avatar.
      updateCount = 0;
      result = await provision({ sub, claims: { ...base } });
      expect(result.user.picture_url).toBe('https://lh3.googleusercontent.com/a/BBB');
      expect(updateCount).toBe(0);
    });

    it.each([
      ['an empty string', ''],
      ['a non-https URL', 'http://lh3.googleusercontent.com/a/AAA'],
      // Round 3 #11: HOST allow-list, not protocol alone — the value is rendered by every
      // co-member's browser, so a profile owner must not be able to point it anywhere.
      ['an https URL on a foreign host', 'https://attacker.example/pixel.png'],
      ['an https URL on a look-alike host (suffix without the dot)', 'https://evil-googleusercontent.com/a/AAA'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['an unparseable value', 'not-a-url'],
      ['a value longer than the varchar(255) column', `https://example.com/${'a'.repeat(260)}`],
    ])('stores null for %s', async (_label, picture) => {
      const sub = `auth0|svc-pic-bad-${_label.replace(/[^a-z]/gi, '')}`;
      const result = await provision({
        sub,
        claims: { email: 'picbad@example.com', email_verified: true, connection_strategy: SOCIAL, picture },
      });
      expect(result.user.picture_url).toBeNull();
    });

    // Phase 88.8 post-merge (round-5 #12/#28): the round-4 note shipped untested —
    // `grep -rn "PICTURE_URL_REJECTED_HOST" tests/` returned nothing at the merge
    // commit — and commit d2b26a7 had already had to repair a regression in exactly
    // this note's threading, with nothing to stop the next one. The note is the whole
    // point of the D-27 amendment: a rejected host must be DISTINGUISHABLE in telemetry
    // from "this user has no avatar", both of which store null.
    it('a rejected HOST is nameable in telemetry — the note rides BOTH the create and the repair path', async () => {
      const sub = 'auth0|svc-pic-note';
      const base = { email: 'picnote@example.com', email_verified: true, connection_strategy: SOCIAL };

      // CREATE path: first login, parseable https URL on a non-allow-listed host.
      const created = await provision({
        sub,
        claims: { ...base, picture: 'https://attacker.example/pixel.png' },
      });
      expect(created.user.picture_url).toBeNull();
      expect(created.notes).toContain('picture_url_rejected_host');

      // REPAIR path: the row exists now; a later login on a look-alike host must still
      // say WHY it stored nothing.
      const repaired = await provision({
        sub,
        claims: { ...base, picture: 'https://evil-googleusercontent.com/a/AAA' },
      });
      expect(repaired.user.picture_url).toBeNull();
      expect(repaired.notes).toContain('picture_url_rejected_host');

      // An ALLOW-LISTED host stores the value and emits no rejection note — the note
      // must mean something, not fire on every social login.
      const accepted = await provision({
        sub,
        claims: { ...base, picture: 'https://lh3.googleusercontent.com/a/AAA' },
      });
      expect(accepted.user.picture_url).toBe('https://lh3.googleusercontent.com/a/AAA');
      expect(accepted.notes).not.toContain('picture_url_rejected_host');
    });

    it('stores nothing for a DATABASE connection even when the picture is a valid https URL', async () => {
      const sub = 'auth0|svc-pic-db';
      const result = await provision({
        sub,
        claims: {
          email: 'picdb@example.com', email_verified: true,
          connection_strategy: 'auth0', picture: 'https://lh3.googleusercontent.com/a/AAA',
        },
      });
      expect(result.user.picture_url).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Email UNIQUE collision — the PLACEHOLDER tail plan 05 replaces
  //
  // These two cases exist because plan 04 deliberately went one step beyond its own
  // "collision handling is NOT in this task" instruction, and an addition with no test
  // is decorative. See the SUMMARY's deviation note. Both cases drive a CASE-VARIANT
  // collision on purpose: that fires ONLY `users_email_lower_unique` (the LOWER(email)
  // index plan 02 added), whose error carries `err.fields` keyed `lower(email::text)` —
  // so `err.fields.email` is undefined and the `parent.constraint` arm of the predicate
  // is the only thing that can recognise it. A predicate written against CONTEXT D-15's
  // original one-name spelling fails BOTH cases.
  // -----------------------------------------------------------------------
  describe('email unique collision — the predicate (plan 04) and the four branches (plan 05)', () => {
    it('THE SHAPE MATRIX, measured not assumed: the predicate recognises a collision from findOrCreate, create AND instance.update, on BOTH constraints', async () => {
      // This is the assertion that stops plan 05 from being written against an
      // incomplete shape. CONTEXT D-15 (as amended) and plan 05's plan text both say
      // `parent.constraint` is the primary discriminator and the ONLY arm carrying the
      // lower index. That holds for create/update and FAILS for findOrCreate, which is
      // the call every provisioning writer uses: findOrCreate sets options.exception,
      // wrapping the INSERT in a PL/pgSQL block, so the rebuilt parent has code + detail
      // and NO constraint. Plan 02 measured a bare create, which is why the recorded
      // shape is incomplete rather than wrong.
      await User.create({ user_id: 'auth0|matrix-case', username: 'mc', email: 'Case@Example.com' });
      await User.create({ user_id: 'auth0|matrix-exact', username: 'me', email: 'exact@example.com' });
      const victim = await User.create({ user_id: 'auth0|matrix-victim', username: 'mv', email: 'victim@example.com' });

      const capture = async (fn) => {
        try {
          await fn();
          return null;
        } catch (e) {
          return e;
        }
      };

      const shapes = {
        'findOrCreate / lower(email) index': await capture(() =>
          User.findOrCreate({
            where: { user_id: 'auth0|matrix-n1' },
            defaults: { user_id: 'auth0|matrix-n1', username: 'n1', email: 'case@example.com' },
          })),
        'findOrCreate / case-sensitive constraint': await capture(() =>
          User.findOrCreate({
            where: { user_id: 'auth0|matrix-n2' },
            defaults: { user_id: 'auth0|matrix-n2', username: 'n2', email: 'exact@example.com' },
          })),
        'create / lower(email) index': await capture(() =>
          User.create({ user_id: 'auth0|matrix-n3', username: 'n3', email: 'case@example.com' })),
      };
      shapes['instance.update / lower(email) index'] = await capture(() => victim.update({ email: 'case@example.com' }));
      await victim.reload();
      shapes['instance.update / case-sensitive constraint'] = await capture(() => victim.update({ email: 'exact@example.com' }));
      await victim.reload();

      // Jest's expect() takes no message argument, so the label rides in the VALUE:
      // a failure names the exact call form that broke rather than just "false".
      const raised = {};
      const recognised = {};
      for (const [label, err] of Object.entries(shapes)) {
        raised[label] = err !== null;
        recognised[label] = isEmailCollision(err);
      }
      const allTrue = Object.fromEntries(Object.keys(shapes).map((k) => [k, true]));
      expect(raised).toEqual(allTrue);
      expect(recognised).toEqual(allTrue);

      // The two facts that make BOTH arms load-bearing, asserted rather than described.
      expect(shapes['findOrCreate / lower(email) index'].parent.constraint).toBeUndefined();
      expect(Object.keys(shapes['findOrCreate / lower(email) index'].fields)).toEqual(['lower(email::text)']);
      expect(shapes['instance.update / lower(email) index'].parent.constraint).toBe('users_email_lower_unique');
      expect(shapes['instance.update / lower(email) index'].fields.email).toBeUndefined();
      expect(EMAIL_UNIQUE_CONSTRAINTS).toEqual(['Users_email_key', 'users_email_lower_unique']);
    });

    it('rejects a non-email unique violation and a plain Error', async () => {
      await User.create({ user_id: 'auth0|matrix-sub', username: 'ms', email: 'subdupe@example.com' });
      let subErr = null;
      try {
        await User.create({ user_id: 'auth0|matrix-sub', username: 'ms2', email: 'other@example.com' });
      } catch (e) {
        subErr = e;
      }
      expect(subErr.name).toBe('SequelizeUniqueConstraintError');
      expect(isEmailCollision(subErr)).toBe(false);
      expect(isEmailCollision(new Error('nope'))).toBe(false);
      expect(isEmailCollision(null)).toBe(false);
    });

    it('CREATE: a first-time user whose verified address is already taken provisions with the synthetic address instead of 500ing', async () => {
      // Seeded MIXED CASE and directly, bypassing the service normaliser, so the
      // collision is case-variant and can only be seen through parent.constraint.
      await User.create({ user_id: 'auth0|occupant', username: 'Occupant', email: 'Taken@Example.com' });

      const sub = 'auth0|svc-collide-create';
      // getUserById rejects by default (the beforeEach), so this is branch (d) —
      // Management unavailable, fail SAFE, the occupant's address is never released.
      const result = await provision({ sub, claims: { email: 'taken@example.com', email_verified: true } });

      expect(result.status).toBe('provisioned');
      expect(result.created).toBe(true);
      expect(result.user.email).toBe(syntheticFor(sub));
      expect(result.reason).toBe('mgmt_api_failed');
      expect(result.notes).toContain('email_repair_collided');
      expect(result.notes).toContain('collision_management_unavailable');
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('mgmt_api_failed');
      // The occupant is untouched — an unconfirmable identity is never released.
      const occupant = await User.scope('withContactInfo').findOne({ where: { user_id: 'auth0|occupant' } });
      expect(occupant.email).toBe('Taken@Example.com');
      expect(occupant.orphaned_at).toBeNull();
    });

    it('REPAIR: a collision on the repair UPDATE leaves the row intact and REPORTS rather than swallowing', async () => {
      await User.create({ user_id: 'auth0|occupant2', username: 'Occupant', email: 'Held@Example.com' });
      const sub = 'auth0|svc-collide-repair';
      await User.create({ user_id: sub, username: 'Someone', email: syntheticFor(sub) });

      // Branch (d) again — getUserById rejects, so the occupant cannot be confirmed dead.
      const result = await provision({ sub, claims: { email: 'held@example.com', email_verified: true } });

      expect(result.status).toBe('provisioned');
      expect(result.changed).toBe(false);
      expect(result.reason).toBe('mgmt_api_failed');
      expect(result.notes).toContain('email_repair_collided');
      expect(result.notes).toContain('collision_management_unavailable');
      // Reloaded, so the caller never sees the rejected in-memory value.
      expect(result.user.email).toBe(syntheticFor(sub));
      const row = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(row.email).toBe(syntheticFor(sub));
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('mgmt_api_failed');
    });
  });

  // -----------------------------------------------------------------------
  // SPEC R5 — the four collision branches (plan 05)
  //
  // Every case here drives a REAL 23505 through the call shape production uses
  // (findOrCreate on the create path, instance.update on the repair path) against the
  // suite's real Postgres. Nothing constructs an error object: a hand-built one encodes
  // the assumption under test, which is how the shape defect survived two rounds.
  // -----------------------------------------------------------------------
  describe('SPEC R5 — the four collision branches', () => {
    const ORPHAN_SUB = 'auth0|r5-dead-identity';
    const SHARED = 'shared@example.com';

    // getUserById answers PER SUB. A blanket mockResolvedValue(null) would classify
    // every occupant as identity-gone, including the ones branches (a)/(c) need alive.
    function mockIdentities(map) {
      auth0Service.getUserById.mockImplementation(async (id) => {
        if (!(id in map)) {
          throw new Error(`unexpected getUserById(${id})`);
        }
        const answer = map[id];
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      });
    }

    // The occupant, plus one group membership. The membership is the SPEC prohibition's
    // subject: releasing an address must not touch a single one of these rows.
    async function seedOccupantWithGroup({ sub = ORPHAN_SUB, email = SHARED, emailChangedAt = null } = {}) {
      const occupant = await User.create({
        user_id: sub,
        username: 'Occupant',
        email,
        email_changed_at: emailChangedAt,
      });
      const group = await Group.create({ name: 'Orphan Group', group_id: `orphan-grp-${Date.now()}` });
      await UserGroup.create({
        user_uuid: occupant.id,
        group_id: group.id,
        role: 'owner',
        status: 'active',
      });
      return occupant;
    }

    it('branch (a): the occupying row IS the caller — same_sub, no vendor call, no write, no Sentry', async () => {
      // WHY THIS ARM IS TESTED THROUGH resolveRepairCollision AND NOT END-TO-END, said
      // plainly rather than papered over: under the one-row-per-sub invariant
      // (Users.user_id is unique) a repair UPDATE cannot collide with the caller's OWN
      // row — Postgres does not raise 23505 when a row keeps or re-takes its own key.
      // Branch (a) is therefore a DEFENSIVE outcome of the occupant lookup, reachable
      // only if the database moves under us. The honest test is the real classifier
      // against real rows; fabricating a 23505 to reach the arm end-to-end would encode
      // exactly the assumption the shape matrix exists to stop us encoding.
      const sub = 'auth0|r5-same-sub';
      const row = await User.scope('withContactInfo').create({
        user_id: sub, username: 'Self', email: 'self@example.com',
      });
      const before = row.toJSON();

      const notes = [];
      const outcome = await provisioningService.resolveRepairCollision({
        row, sub, changes: { email: 'Self@Example.com' }, auth0: auth0Service, notes,
      });

      expect(outcome).toEqual({ reason: null, changed: false });
      expect(notes).toContain('collision_same_sub');
      // No Auth0 call: we never ask the vendor about our own identity.
      expect(auth0Service.getUserById).not.toHaveBeenCalled();
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
      expect(updateCount).toBe(0);
      const after = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(after.toJSON()).toEqual(before);
    });

    it('branch (b) REPAIR: a dead occupant releases the address, keeps its groups, and the real user is repaired', async () => {
      const occupant = await seedOccupantWithGroup();
      const sub = 'auth0|r5-real-user';
      await User.create({ user_id: sub, username: 'User', email: syntheticFor(sub) });
      mockIdentities({ [ORPHAN_SUB]: null });

      const result = await provision({ sub, claims: { email: SHARED, email_verified: true } });

      // The real user now holds the address.
      expect(result.status).toBe('provisioned');
      expect(result.changed).toBe(true);
      expect(result.user.email).toBe(SHARED);
      expect(result.reason).toBe('orphan_released');
      expect(result.notes).toContain('collision_orphan_released');

      // The occupant released the address, is stamped, and its user-set marker is cleared.
      const released = await User.scope('withContactInfo').findOne({ where: { user_id: ORPHAN_SUB } });
      expect(released.email).toBe(syntheticFor(ORPHAN_SUB));
      expect(released.orphaned_at).toBeInstanceOf(Date);
      expect(released.email_changed_at).toBeNull();

      // THE SPEC PROHIBITION, asserted rather than implied: keep the data.
      expect(await UserGroup.count({ where: { user_uuid: occupant.id } })).toBe(1);
      expect(await User.count({ where: { user_id: ORPHAN_SUB } })).toBe(1);

      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('orphan_released');
    });

    it('branch (b) with a NON-NULL email_changed_at on the occupant behaves identically and leaves it NULL (D-36 seam)', async () => {
      // The case an executor would not think to seed: after SPEC A12 the occupant's
      // stored address may be one the USER set (plan 09), so its D-36 marker is set.
      // Leaving it set would assert "the user chose this" about a synthetic value and
      // would make plan 04's repair guard refuse that row forever.
      const occupant = await seedOccupantWithGroup({ emailChangedAt: new Date('2026-08-01T00:00:00Z') });
      const sub = 'auth0|r5-real-user-2';
      await User.create({ user_id: sub, username: 'User', email: syntheticFor(sub) });
      mockIdentities({ [ORPHAN_SUB]: null });

      const result = await provision({ sub, claims: { email: SHARED, email_verified: true } });

      expect(result.user.email).toBe(SHARED);
      expect(result.reason).toBe('orphan_released');
      const released = await User.scope('withContactInfo').findOne({ where: { user_id: ORPHAN_SUB } });
      expect(released.email).toBe(syntheticFor(ORPHAN_SUB));
      expect(released.orphaned_at).toBeInstanceOf(Date);
      expect(released.email_changed_at).toBeNull();
      expect(await UserGroup.count({ where: { user_uuid: occupant.id } })).toBe(1);
    });

    it('branch (b) then a SECOND fetch: the real address is returned and NO further Sentry event fires', async () => {
      await seedOccupantWithGroup();
      const sub = 'auth0|r5-second-fetch';
      await User.create({ user_id: sub, username: 'User', email: syntheticFor(sub) });
      mockIdentities({ [ORPHAN_SUB]: null });

      await provision({ sub, claims: { email: SHARED, email_verified: true } });
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);

      mockSentryCaptureException.mockClear();
      const second = await provision({ sub, claims: { email: SHARED, email_verified: true } });
      expect(second.user.email).toBe(SHARED);
      expect(second.changed).toBe(false);
      expect(second.reason).toBeNull();
      expect(mockSentryCaptureException).not.toHaveBeenCalled();
    });

    it('branch (c) REPAIR: the occupying identity EXISTS — neither row changes, genuine_conflict is reported', async () => {
      const occupant = await seedOccupantWithGroup();
      const sub = 'auth0|r5-conflict';
      await User.create({ user_id: sub, username: 'User', email: syntheticFor(sub) });
      mockIdentities({ [ORPHAN_SUB]: { user_id: ORPHAN_SUB, email: SHARED, email_verified: true } });

      const result = await provision({ sub, claims: { email: SHARED, email_verified: true } });

      // Round 3 #4 AMENDED this pin: "neither row changes" was about the ADDRESS. The
      // EMAIL arm still cannot land (the occupant holds it; nothing is released on a
      // conflict) — but the username arm no longer dies with it: the generic 'User' is
      // repaired from the claim in the same call, so `changed` is true and the user is not
      // stuck nameless forever behind somebody else's address.
      expect(result.user.email).toBe(syntheticFor(sub));
      expect(result.user.username).not.toBe('User');
      expect(result.changed).toBe(true);
      expect(result.reason).toBe('genuine_conflict');
      expect(result.notes).toContain('collision_genuine_conflict');

      const untouched = await User.scope('withContactInfo').findOne({ where: { id: occupant.id } });
      expect(untouched.email).toBe(SHARED);
      expect(untouched.orphaned_at).toBeNull();
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('genuine_conflict');
    });

    it('branch (d) REPAIR: the Management API is unavailable — fail SAFE, treated as (c), reported mgmt_api_failed', async () => {
      const occupant = await seedOccupantWithGroup();
      const sub = 'auth0|r5-unavailable';
      await User.create({ user_id: sub, username: 'User', email: syntheticFor(sub) });
      mockIdentities({ [ORPHAN_SUB]: new Error('Failed to fetch Auth0 user: 503') });

      const result = await provision({ sub, claims: { email: SHARED, email_verified: true } });

      // Round 3 #4 (see branch (c)): the address is NOT adopted, the username IS repaired.
      expect(result.user.email).toBe(syntheticFor(sub));
      expect(result.user.username).not.toBe('User');
      expect(result.changed).toBe(true);
      expect(result.reason).toBe('mgmt_api_failed');
      expect(result.notes).toContain('collision_management_unavailable');
      // An address is NEVER released on a guess.
      const untouched = await User.scope('withContactInfo').findOne({ where: { id: occupant.id } });
      expect(untouched.email).toBe(SHARED);
      expect(untouched.orphaned_at).toBeNull();
      expect(mockSentryCaptureException).toHaveBeenCalledTimes(1);
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('mgmt_api_failed');
    });

    it('branch (b) CREATE: a first-time user takes the address a dead identity was holding', async () => {
      const occupant = await seedOccupantWithGroup();
      const sub = 'auth0|r5-create-orphan';
      mockIdentities({ [ORPHAN_SUB]: null });

      const result = await provision({ sub, claims: { email: SHARED, email_verified: true } });

      expect(result.created).toBe(true);
      expect(result.user.email).toBe(SHARED);
      expect(result.outcome).toBe('created_after_orphan_release');
      expect(result.reason).toBe('orphan_released');
      const released = await User.scope('withContactInfo').findOne({ where: { id: occupant.id } });
      expect(released.email).toBe(syntheticFor(ORPHAN_SUB));
      expect(released.orphaned_at).toBeInstanceOf(Date);
      expect(await UserGroup.count({ where: { user_uuid: occupant.id } })).toBe(1);
      expect(mockSentryCaptureException.mock.calls[0][1].tags.reason).toBe('orphan_released');
    });

    it('branch (c) CREATE: a live occupying identity leaves the caller on the synthetic address', async () => {
      const occupant = await seedOccupantWithGroup();
      const sub = 'auth0|r5-create-conflict';
      mockIdentities({ [ORPHAN_SUB]: { user_id: ORPHAN_SUB, email: SHARED, email_verified: true } });

      const result = await provision({ sub, claims: { email: SHARED, email_verified: true } });

      expect(result.created).toBe(true);
      expect(result.user.email).toBe(syntheticFor(sub));
      expect(result.reason).toBe('genuine_conflict');
      const untouched = await User.scope('withContactInfo').findOne({ where: { id: occupant.id } });
      expect(untouched.email).toBe(SHARED);
      expect(untouched.orphaned_at).toBeNull();
    });

    it('CONCURRENCY: two overlapping repairs for one caller release the dead occupant exactly ONCE', async () => {
      const occupant = await seedOccupantWithGroup();
      const sub = 'auth0|r5-concurrent';
      await User.create({ user_id: sub, username: 'User', email: syntheticFor(sub) });
      mockIdentities({ [ORPHAN_SUB]: null });
      const claims = { email: SHARED, email_verified: true };

      const [a, b] = await Promise.all([
        provisioningService.provisionOrRepair({ sub, claims }),
        provisioningService.provisionOrRepair({ sub, claims }),
      ]);

      // Neither call is a server error.
      expect(a.status).toBe('provisioned');
      expect(b.status).toBe('provisioned');

      const caller = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
      expect(caller.email).toBe(SHARED);

      const released = await User.scope('withContactInfo').findOne({ where: { id: occupant.id } });
      expect(released.email).toBe(syntheticFor(ORPHAN_SUB));
      expect(await UserGroup.count({ where: { user_uuid: occupant.id } })).toBe(1);

      // Released exactly once: one orphan_released event, and the loser says so.
      const orphanEvents = mockSentryCaptureException.mock.calls.filter(
        ([, opts]) => opts && opts.tags && opts.tags.reason === 'orphan_released'
      );
      expect(orphanEvents).toHaveLength(1);
      const outcomes = [a, b].map((r) => r.reason).sort();
      expect(outcomes).toEqual([null, 'orphan_released']);
      expect([...a.notes, ...b.notes]).toContain('collision_already_released');
    });

    it('SOURCE SCAN: the service can only ever release an ADDRESS — it holds no path to any other table', () => {
      // T-88.8-23. The prohibition is "no group, event, membership, participation or
      // friendship row is deleted, archived or reassigned"; the strongest mechanical
      // form of that is that the service does not reference those models at all.
      const source = fs.readFileSync(SERVICE_PATH, 'utf8');
      const codeOnly = source
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(codeOnly.length).toBeGreaterThan(2000); // anti-vacuity
      for (const forbidden of ['destroy(', 'UserGroup', 'EventParticipation', 'Friendship', 'AvailabilityResponse']) {
        expect(codeOnly).not.toContain(forbidden);
      }
      // orphaned_at is written, and in exactly one place.
      expect(codeOnly.split('orphaned_at').length - 1).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // SPEC concurrency / R2 backstop
  // -----------------------------------------------------------------------
  describe('concurrency backstop (SPEC Edge Coverage: concurrency / R2)', () => {
    it('two overlapping first fetches for one sub produce exactly one row and both resolve', async () => {
      const sub = 'auth0|svc-concurrent';
      const claims = { email: 'concurrent@example.com', email_verified: true };

      const [a, b] = await Promise.all([
        provisioningService.provisionOrRepair({ sub, claims }),
        provisioningService.provisionOrRepair({ sub, claims }),
      ]);

      expect(a.status).toBe('provisioned');
      expect(b.status).toBe('provisioned');
      expect(await User.count({ where: { user_id: sub } })).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // SPEC R4 source scan — a grep in <verify> evaporates; an assertion does not
  // -----------------------------------------------------------------------
  describe('SPEC R4 source scan of services/provisioningService.js', () => {
    const source = fs.readFileSync(SERVICE_PATH, 'utf8');
    const codeOnly = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

    it('reads a non-empty service file (anti-vacuity guard for every assertion below)', () => {
      expect(source.length).toBeGreaterThan(2000);
      expect(codeOnly).toContain('provisionOrRepair');
    });

    it('contains no console.warn( outside comments — every fallback is a Sentry event', () => {
      expect(codeOnly.split('console.warn(').length - 1).toBe(0);
    });

    it('no console call interpolates or passes a VALUE-bearing identifier (completes 88-34 r3 triage #7)', () => {
      const calls = codeOnly.match(/console\.\w+\([^\n]*/g) || [];
      expect(calls.length).toBeGreaterThan(0);

      // A provisioning log line may carry a row id, a frozen literal, or a pre-computed
      // list of changed FIELD NAMES. Never a field VALUE.
      const ALLOWED_INTERPOLATIONS = [
        'row.id',
        'user.id',
        "Object.keys(changes).sort().join(',')",
        // Round 3 #4: the non-email retry logs its own FIELD-NAME list, same rule.
        "Object.keys(nonEmail).sort().join(',')",
      ];
      const BANNED_ARGUMENT = /,\s*(changes|updateData|userDetails|claims|claimBag|defaults|row|user|result)\s*\)/;

      for (const call of calls) {
        for (const match of call.matchAll(/\$\{([^}]*)\}/g)) {
          expect(ALLOWED_INTERPOLATIONS).toContain(match[1].trim());
        }
        expect(call).not.toMatch(BANNED_ARGUMENT);
      }
    });

    it('carries the moved 88-34 clamp DECISION block and at least two DECISION Phase 88.8 markers', () => {
      expect(source).toContain('Phase 88-34');
      expect((source.match(/DECISION Phase 88\.8/g) || []).length).toBeGreaterThanOrEqual(2);
      expect(source).toContain('DECISION Phase 88.8 D-36');
    });

    it('uses the scoped findOrCreate and never a bare User.findOrCreate', () => {
      expect(codeOnly).toContain("User.scope('withContactInfo').findOrCreate");
      expect(codeOnly).not.toMatch(/(?<!scope\('withContactInfo'\)\.)\bUser\.findOrCreate\b/);
    });

    it('imports SOCIAL_CONNECTION_STRATEGIES rather than inlining a strategy literal', () => {
      expect(codeOnly).toContain('SOCIAL_CONNECTION_STRATEGIES');
      expect(codeOnly).not.toContain("'google-oauth2'");
    });
  });

  // -----------------------------------------------------------------------
  // NEGATIVE SPACE — survives a refactor of the chain's shape
  // -----------------------------------------------------------------------
  describe('negative space', () => {
    it('no username provisioned anywhere in this suite contains an at-sign', () => {
      expect(provisionedUsernames.length).toBeGreaterThan(20);
      const leaked = provisionedUsernames.filter((u) => u.includes('@'));
      expect(leaked).toEqual([]);
    });
  });
});
