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
