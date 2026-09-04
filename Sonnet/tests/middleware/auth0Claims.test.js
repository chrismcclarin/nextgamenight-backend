// tests/middleware/auth0Claims.test.js
// Phase 88.8 / BOPS-05 (R1): the claim-mapping contract for BOTH auth middlewares.
//
// DB-FREE and network-free, in the style of tests/middleware/auth0.test.js:
// jsonwebtoken is mocked so the verify callback is driven with a decoded payload of our
// choosing, and ../../models is mocked so verifyAuth0Token's tombstone choke never opens
// a Postgres connection.
//
// What this file pins:
//   * the seven namespaced claims land on req.user, on verifyAuth0Token AND optionalAuth
//   * optionalAuth carries `username` and `connection_strategy`, which it did not before
//   * a claim-less token leaves req.user.email undefined and still proceeds
//   * the SUPERSEDED placeholder namespace `https://your-api-identifier/email` is dead —
//     a token whose only email lives there yields NO email (prohibition, plan 01)
//   * the namespaced claim BEATS the bare OIDC claim when both are present
//   * the drift pin: the real Action file emits exactly Object.values(CLAIMS)

jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
// Keep the tombstone choke off the database. count() === 0 is the steady state, which
// short-circuits before any per-caller lookup.
jest.mock('../../models', () => ({
  PendingAuth0Deletion: {
    count: jest.fn().mockResolvedValue(0),
    isTombstoned: jest.fn().mockResolvedValue(false),
  },
}));

const jwt = require('jsonwebtoken');
const { verifyAuth0Token, optionalAuth } = require('../../middleware/auth0');
const { CLAIMS } = require('../../config/auth0Claims');

const NS = 'https://nextgamenight.app';
const PLACEHOLDER_EMAIL_CLAIM = 'https://your-api-identifier/email';

const ALL_CLAIMS = {
  sub: 'auth0|claims-1',
  [`${NS}/email`]: 'claimed@example.com',
  [`${NS}/email_verified`]: true,
  [`${NS}/picture`]: 'https://cdn.example.com/a.png',
  [`${NS}/name`]: 'Claimed Person',
  [`${NS}/nickname`]: 'claimed',
  [`${NS}/username`]: 'claimeduser',
  [`${NS}/connection`]: 'google-oauth2',
};

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

// verifyAuth0Token calls next() from inside a promise handler (the tombstone choke), so
// the assertion has to wait for it.
function runVerify(decoded) {
  jwt.verify.mockImplementation((token, getKey, opts, cb) => cb(null, decoded));
  const req = { headers: { authorization: 'Bearer a.b.c' } };
  const res = mockRes();
  return new Promise((resolve, reject) => {
    const next = jest.fn(() => resolve(req));
    const timer = setTimeout(() => reject(new Error('next() was never called')), 5000);
    timer.unref?.();
    verifyAuth0Token(req, res, () => { clearTimeout(timer); next(); });
  });
}

function runOptional(decoded) {
  jwt.verify.mockImplementation((token, getKey, opts, cb) => cb(null, decoded));
  const req = { headers: { authorization: 'Bearer a.b.c' } };
  const next = jest.fn();
  optionalAuth(req, mockRes(), next);
  expect(next).toHaveBeenCalledTimes(1);
  return req;
}

describe('namespaced claim mapping (Phase 88.8 R1)', () => {
  beforeAll(() => { process.env.AUTH0_AUDIENCE = 'test-audience'; });
  beforeEach(() => { jwt.verify.mockReset(); });

  it('verifyAuth0Token maps all seven namespaced claims onto req.user', async () => {
    const req = await runVerify(ALL_CLAIMS);

    expect(req.user).toMatchObject({
      user_id: 'auth0|claims-1',
      email: 'claimed@example.com',
      email_verified: true,
      picture: 'https://cdn.example.com/a.png',
      name: 'Claimed Person',
      nickname: 'claimed',
      username: 'claimeduser',
      connection_strategy: 'google-oauth2',
    });
  });

  it('optionalAuth maps the same seven, INCLUDING username and connection_strategy', () => {
    const req = runOptional(ALL_CLAIMS);

    expect(req.user).toMatchObject({
      user_id: 'auth0|claims-1',
      email: 'claimed@example.com',
      email_verified: true,
      picture: 'https://cdn.example.com/a.png',
      name: 'Claimed Person',
      nickname: 'claimed',
      username: 'claimeduser',
      connection_strategy: 'google-oauth2',
    });
  });

  it('a token with NO namespaced claims and no bare OIDC email leaves req.user.email undefined and proceeds', async () => {
    const req = await runVerify({ sub: 'auth0|bare-1' });

    expect(req.user.user_id).toBe('auth0|bare-1');
    expect(req.user.email).toBeUndefined();
    // An ABSENT verification claim must read as unverified, never as verified.
    expect(req.user.email_verified).toBe(false);
  });

  it('the SUPERSEDED placeholder namespace is no longer read by either middleware', async () => {
    const decoded = { sub: 'auth0|placeholder-1', [PLACEHOLDER_EMAIL_CLAIM]: 'ghost@example.com' };

    const verified = await runVerify(decoded);
    expect(verified.user.email).toBeUndefined();

    const optional = runOptional(decoded);
    expect(optional.user.email).toBeUndefined();
  });

  it('the namespaced claim WINS over the bare OIDC claim when both are present', async () => {
    const decoded = {
      sub: 'auth0|both-1',
      email: 'bare@example.com',
      email_verified: false,
      [CLAIMS.email]: 'namespaced@example.com',
      [CLAIMS.emailVerified]: true,
    };

    const verified = await runVerify(decoded);
    expect(verified.user.email).toBe('namespaced@example.com');
    expect(verified.user.email_verified).toBe(true);

    const optional = runOptional(decoded);
    expect(optional.user.email).toBe('namespaced@example.com');
    expect(optional.user.email_verified).toBe(true);
  });

  it('DRIFT PIN: the real post-login Action emits exactly the CLAIMS key set the middleware reads', async () => {
    const action = require('../../auth0/actions/post-login-claims');
    const emitted = [];
    const api = { accessToken: { setCustomClaim: (key, value) => emitted.push(key) } };

    await action.onExecutePostLogin(
      {
        user: {
          email: 'x@example.com',
          email_verified: true,
          picture: 'p',
          name: 'n',
          nickname: 'nn',
          username: 'u',
        },
        connection: { strategy: 'google-oauth2' },
      },
      api
    );

    expect(emitted.slice().sort()).toEqual(Object.values(CLAIMS).slice().sort());
    // And the module the middleware imports IS the module the Action defines.
    expect(action.CLAIMS).toBe(CLAIMS);
  });
});
