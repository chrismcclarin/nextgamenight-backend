// tests/middleware/auth0.claims.test.js
// Phase 88.8 post-merge (round-5 #13 / #20, and the coverage gap #9/#12/#28 named):
// the post-login-Action claim DETECTOR in verifyAuth0Token.
//
// Why this file exists at all: at the 88.8 merge commit,
// `grep -rn "reportClaimsAbsentOnce\|claims-absent" tests/` returned ZERO hits. That
// predicate is the wave-8 deploy-state signal the whole Auth0 rollout is watched
// through — a wrong `Object.values(CLAIMS)` shape would silence it permanently while
// every suite stayed green.
//
// Two arms, deliberately distinct (see the DECISION marker at the call site):
//   op: 'claims-absent'  -> NO namespaced claim at all: the Action is not deployed.
//   op: 'claims-partial' -> some namespaced claims present but email / email_verified
//                           missing: the Action was edited and is now partially broken.
// Both are PRODUCTION-ONLY and throttled to one report per process per hour, on
// SEPARATE timestamps, so neither can starve the other. The throttle is module-level
// state, so every case loads the middleware through `jest.isolateModules` and gets a
// fresh one.
//
// DB-FREE: ../../models is mocked so callerIsTombstoned's lazy require never opens a
// connection, and jsonwebtoken is mocked so no JWKS fetch happens.

const mockCaptureMessage = jest.fn();
const mockJwtVerify = jest.fn();

jest.mock('@sentry/node', () => ({
  captureMessage: (...args) => mockCaptureMessage(...args),
  captureException: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock('jsonwebtoken', () => ({ verify: (...args) => mockJwtVerify(...args) }));
jest.mock('../../models', () => ({
  PendingAuth0Deletion: {
    count: jest.fn().mockResolvedValue(0),
    isTombstoned: jest.fn().mockResolvedValue(false),
  },
}));

const { CLAIMS } = require('../../config/auth0Claims');

/** Every claim the shipped Action sets (auth0/actions/post-login-claims.js:52-61). */
function fullClaimBag(overrides = {}) {
  return {
    sub: 'auth0|claims-test',
    [CLAIMS.email]: 'person@example.com',
    [CLAIMS.emailVerified]: true,
    [CLAIMS.picture]: 'https://lh3.googleusercontent.com/a/AAA',
    [CLAIMS.name]: 'A Person',
    [CLAIMS.nickname]: 'person',
    [CLAIMS.username]: 'person',
    [CLAIMS.connection]: 'google-oauth2',
    ...overrides,
  };
}

/** Drop a claim entirely — an Action that omits a line emits NO key, not undefined. */
function without(bag, ...keys) {
  const copy = { ...bag };
  for (const k of keys) delete copy[k];
  return copy;
}

/**
 * Load a FRESH copy of the middleware (fresh throttle timestamps) and return a caller
 * that drives one request through it with the given decoded token.
 */
function loadMiddleware() {
  let mod;
  jest.isolateModules(() => {
    mod = require('../../middleware/auth0');
  });
  return function call(decoded) {
    mockJwtVerify.mockImplementation((token, getKey, opts, cb) => cb(null, decoded));
    const res = {};
    res.status = jest.fn(() => res);
    res.json = jest.fn(() => res);
    const req = { headers: { authorization: 'Bearer a.b.c' } };
    mod.verifyAuth0Token(req, res, jest.fn());
    return req;
  };
}

/** The reports captured so far, by their `op` tag. */
function reportsWithOp(op) {
  return mockCaptureMessage.mock.calls.filter(
    ([, options]) => options && options.tags && options.tags.op === op
  );
}

describe('verifyAuth0Token — post-login Action claim detector', () => {
  let warnSpy;
  let priorEnv;

  beforeAll(() => {
    process.env.AUTH0_DOMAIN = process.env.AUTH0_DOMAIN || 'tenant.example.auth0.com';
    process.env.AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE || 'test-audience';
  });

  beforeEach(() => {
    mockCaptureMessage.mockClear();
    mockJwtVerify.mockReset();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The detector is production-only by design (it is a deploy-state alarm).
    priorEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = priorEnv;
    warnSpy.mockRestore();
  });

  it('a token with NO namespaced claim fires claims-absent, and only claims-absent', () => {
    const call = loadMiddleware();
    call({ sub: 'auth0|no-claims', email: 'bare@example.com' });

    expect(reportsWithOp('claims-absent')).toHaveLength(1);
    expect(reportsWithOp('claims-partial')).toHaveLength(0);

    const [line, options] = reportsWithOp('claims-absent')[0];
    expect(line).toMatch(/ABSENT/);
    expect(options.tags.feature).toBe('auth0-claims');
    // The bare OIDC claim is the discriminator this arm already collected.
    expect(options.extra).toEqual({ hasBareEmail: true });
  });

  it('a fully-populated token fires NOTHING', () => {
    const call = loadMiddleware();
    const req = call(fullClaimBag());

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    // ...and the namespaced claims still win over the bare ones (BOPS-05 / R1).
    expect(req.user.email).toBe('person@example.com');
    expect(req.user.email_verified).toBe(true);
  });

  it('an Action that drops email_verified while still emitting the rest fires claims-partial', () => {
    // THE case round 4's narrowing made silent. email_verified gates
    // revertClaimAddress and wasOldAddressProved, so losing it fails CLOSED: revert
    // refuses and the D-41 / D-42 moves all skip, with no diagnostic anywhere.
    const call = loadMiddleware();
    call(without(fullClaimBag(), CLAIMS.emailVerified));

    expect(reportsWithOp('claims-absent')).toHaveLength(0);
    expect(reportsWithOp('claims-partial')).toHaveLength(1);

    const [line, options] = reportsWithOp('claims-partial')[0];
    expect(line).toMatch(/PARTIAL/);
    expect(options.tags).toEqual({ feature: 'auth0-claims', op: 'claims-partial' });
    // The discriminators say WHICH half is missing, and carry no address or sub.
    expect(options.extra.hasNamespacedEmail).toBe(true);
    expect(options.extra.hasNamespacedEmailVerified).toBe(false);
    expect(options.extra.connection).toBe('google-oauth2');
    expect(JSON.stringify(options.extra)).not.toContain('person@example.com');
    expect(JSON.stringify(options.extra)).not.toContain('auth0|claims-test');
  });

  it('an Action that drops the email claim fires claims-partial too', () => {
    const call = loadMiddleware();
    call(without(fullClaimBag(), CLAIMS.email));

    expect(reportsWithOp('claims-partial')).toHaveLength(1);
    expect(reportsWithOp('claims-partial')[0][1].extra.hasNamespacedEmail).toBe(false);
    expect(reportsWithOp('claims-partial')[0][1].extra.hasNamespacedEmailVerified).toBe(true);
  });

  it('an email-less user reports as PARTIAL with both booleans false — the ACCEPTED overlap, identifiable on sight', () => {
    // A deployed Action omits BOTH email lines for a user whose Auth0 profile has no
    // address. That is indistinguishable from an Action edited to drop both, so this
    // arm fires for it. The overlap is deliberate (see the call-site DECISION marker);
    // what makes it survivable is that the event says so, and that it lands under its
    // own op tag rather than polluting the deploy-state alarm.
    const call = loadMiddleware();
    call(without(fullClaimBag(), CLAIMS.email, CLAIMS.emailVerified));

    expect(reportsWithOp('claims-absent')).toHaveLength(0);
    const [, options] = reportsWithOp('claims-partial')[0];
    expect(options.extra.hasNamespacedEmail).toBe(false);
    expect(options.extra.hasNamespacedEmailVerified).toBe(false);
    expect(options.extra.connection).toBe('google-oauth2');
  });

  it('each arm is throttled to one report per process, and the two throttles are independent', () => {
    const call = loadMiddleware();

    call(without(fullClaimBag(), CLAIMS.emailVerified));
    call(without(fullClaimBag(), CLAIMS.emailVerified));
    call(without(fullClaimBag(), CLAIMS.emailVerified));
    expect(reportsWithOp('claims-partial')).toHaveLength(1);

    // A spent partial throttle must not swallow the deploy-state alarm.
    call({ sub: 'auth0|no-claims' });
    call({ sub: 'auth0|no-claims' });
    expect(reportsWithOp('claims-absent')).toHaveLength(1);
  });

  it('reports NOTHING outside production, on either arm', () => {
    process.env.NODE_ENV = 'test';
    const call = loadMiddleware();

    call({ sub: 'auth0|no-claims' });
    call(without(fullClaimBag(), CLAIMS.emailVerified));

    expect(mockCaptureMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
