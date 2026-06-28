// tests/middleware/auth0.test.js
// DB-FREE unit test for verifyAuth0Token's 401 -> unauthorized envelope.
//
// Calls verifyAuth0Token directly with a mock req/res/next (status()/json()
// spies, gcalSyncWorker.test.js style). jsonwebtoken is mocked so the
// invalid-token branch never touches the network/JWKS. Does NOT require
// ../../models or open a DB connection.
//
// Asserts all three 401 reject paths collapse to ONE generic 'unauthorized'
// message at status 401 (ASVS V2 no-enumeration, T-85-08) with the legacy
// error (= message) alias.

// Mock jsonwebtoken so the invalid-token path is driven without network/JWKS.
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
const jwt = require('jsonwebtoken');
const { verifyAuth0Token } = require('../../middleware/auth0');

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
}

describe('verifyAuth0Token -> unauthorized envelope (401)', () => {
  let consoleErrorSpy;
  beforeAll(() => {
    process.env.AUTH0_AUDIENCE = 'test-audience';
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => consoleErrorSpy.mockRestore());
  beforeEach(() => jwt.verify.mockReset());

  it('missing Authorization header -> 401 unauthorized', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    verifyAuth0Token(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body.error).toBe(res.body.message);
    expect(next).not.toHaveBeenCalled();
  });

  it('malformed Bearer header -> 401 unauthorized', () => {
    const req = { headers: { authorization: 'Token abc.def' } };
    const res = mockRes();
    const next = jest.fn();

    verifyAuth0Token(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body.error).toBe(res.body.message);
    expect(next).not.toHaveBeenCalled();
  });

  it('invalid/expired token (jwt.verify error) -> 401 unauthorized', () => {
    jwt.verify.mockImplementation((token, getKey, opts, cb) => cb(new Error('jwt expired'), null));
    const req = { headers: { authorization: 'Bearer aaa.bbb.ccc' } };
    const res = mockRes();
    const next = jest.fn();

    verifyAuth0Token(req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('unauthorized');
    expect(res.body.error).toBe(res.body.message);
    expect(next).not.toHaveBeenCalled();
  });

  it('uses ONE generic message across all three 401 rejects (no enumeration)', () => {
    const r1 = mockRes();
    verifyAuth0Token({ headers: {} }, r1, jest.fn());
    const r2 = mockRes();
    verifyAuth0Token({ headers: { authorization: 'Token x' } }, r2, jest.fn());
    jwt.verify.mockImplementation((t, k, o, cb) => cb(new Error('bad'), null));
    const r3 = mockRes();
    verifyAuth0Token({ headers: { authorization: 'Bearer a.b.c' } }, r3, jest.fn());

    expect(r1.body.message).toBe(r2.body.message);
    expect(r2.body.message).toBe(r3.body.message);
  });
});
