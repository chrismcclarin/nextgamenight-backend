// tests/unit/errorHandler.test.js
// Phase 85 / Plan 04: DB-FREE unit coverage for utils/errorHandler.sendSafeError
// (BAPI-01 envelope safety + BAPI-02 5xx escalation).
//
// Strategy: errorHandler is a pure module once @sentry/node is mocked. We set SENTRY_DSN
// BEFORE require (gcalSyncWorker precedent) so the DSN gate inside errorHandler loads the
// MOCK, then drive sendSafeError with a fake `res` whose `res.req` carries a PII-bearing
// route. MUST stay DB-free: no model-layer import, no destructive schema rebuild (Pitfall 4).

// ---------------------------------------------------------------------------
// Mock @sentry/node BEFORE requiring the module under test.
// ---------------------------------------------------------------------------
const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCaptureException(...args),
}), { virtual: true });

// Force the DSN gate in errorHandler to require the mocked @sentry/node.
process.env.SENTRY_DSN = 'https://fake@sentry.io/123';

const { sendSafeError } = require('../../utils/errorHandler');

// Fake res with status/json spies.
function makeRes(req) {
  const res = {
    statusCode: null,
    body: null,
    req,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
}

// PII-bearing request: originalUrl embeds a REAL email; route.path is the low-cardinality
// pattern we expect to be tagged instead (no path-param value, no query string).
const PII_REQ = {
  route: { path: '/search/email/:email' },
  baseUrl: '/api/users',
  originalUrl: '/api/users/search/email/john@example.com',
  method: 'GET',
};

describe('sendSafeError — envelope + 5xx escalation (BAPI-01/BAPI-02)', () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production'; // exercise the prod info-disclosure guard
  });
  afterAll(() => { process.env.NODE_ENV = ORIGINAL_NODE_ENV; });

  test('500 returns the internal envelope and never leaks err.message', () => {
    const res = makeRes(PII_REQ);
    sendSafeError(res, 500, new Error('secret db detail'));

    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('internal');
    expect(res.body.error).toBe(res.body.message); // legacy alias === message
    expect(JSON.stringify(res.body)).not.toContain('secret db detail');
  });

  test('5xx calls captureException exactly once, tagged with the route PATTERN (no path PII)', () => {
    const res = makeRes(PII_REQ);
    sendSafeError(res, 500, new Error('boom'));

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, opts] = mockCaptureException.mock.calls[0];
    expect(opts.tags.route).toBe('/api/users/search/email/:email'); // baseUrl + route.path
    expect(opts.tags.route).not.toContain('@');            // no path-param PII reaches Sentry
    expect(opts.tags.route).not.toBe(PII_REQ.originalUrl); // not the raw URL
    expect(opts.tags.method).toBe('GET');
  });

  test('4xx does NOT call captureException (no over-capture)', () => {
    const res = makeRes(PII_REQ);
    sendSafeError(res, 400, new Error('bad input'), 'Invalid request');

    expect(res.statusCode).toBe(400);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('4xx still emits an envelope shape (code + error alias)', () => {
    const res = makeRes(PII_REQ);
    sendSafeError(res, 400, new Error('bad input'), 'Invalid request');

    expect(res.body.code).toBeDefined();
    expect(res.body.error).toBe(res.body.message);
  });

  test('<500 routes through the registry — returns a REGISTERED code, never off-registry "error"', () => {
    const res = makeRes(PII_REQ);
    sendSafeError(res, 403, new Error('nope'), 'Forbidden');

    expect(res.statusCode).toBe(403);           // caller status preserved
    expect(res.body.code).toBe('forbidden');    // registered code, NOT the old ad-hoc 'error'
    expect(res.body.code).not.toBe('error');
    expect(res.body.error).toBe(res.body.message); // legacy alias intact
    expect(res.body.message).toBe('Forbidden');    // prod-safe message preserved via override
  });
});
