// tests/services/auth0Service.sentry.test.js
// Phase 88.8 / SPEC R4 + Amendment A2 (DR-2, owner ruled `apply` 2026-09-03):
// EVERY Auth0 Management API failure reports to Sentry, once, per method.
//
// Mock axios AND @sentry/node BEFORE requiring the service, so the singleton picks up
// both — the harness shape of tests/services/auth0Service.deleteUser.test.js:11-36.
//
// What this file pins:
//   (a) a token failure is reported exactly ONCE, tagged op:'token', even though it
//       surfaces through getUserById's try (the !error.sentryReported guard)
//   (b) a non-404 method failure is reported once with its own op + status tag, and the
//       captured argument is NOT the axios rejection object (T-88.8-03: an AxiosError
//       carries config.data, which for the token POST holds client_secret)
//   (c) a 404 from getUserById is a defined outcome -> null, ZERO captures
//   (d) a 403 from deleteUser is reported once, tagged op:'deleteUser'
//   (e) a 404 from deleteUser is idempotent success -> ZERO captures

const mockAxiosDelete = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();

jest.mock('axios', () => ({
  delete: (...args) => mockAxiosDelete(...args),
  post: (...args) => mockAxiosPost(...args),
  get: (...args) => mockAxiosGet(...args),
}));

const mockCaptureException = jest.fn();
const mockCaptureMessage = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCaptureException(...args),
  captureMessage: (...args) => mockCaptureMessage(...args),
}));

const auth0Service = require('../../services/auth0Service');

const SUB = 'auth0|sentry-abc';

function axiosError(status) {
  // Deliberately shaped like a real AxiosError: the `config` carries the token POST
  // body. If anything ever captures THIS object instead of a fresh Error, case (b)'s
  // credential assertion fails.
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { error: 'access_denied' } };
  err.config = {
    url: 'https://tenant.us.auth0.com/oauth/token',
    data: JSON.stringify({ client_id: 'cid', client_secret: 'SUPER-SECRET', grant_type: 'client_credentials' }),
    headers: { Authorization: 'Bearer leaked-token' },
  };
  return err;
}

describe('auth0Service — Sentry reporting on Management API failures (R4 / A2)', () => {
  let consoleErrorSpy;

  beforeAll(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterAll(() => consoleErrorSpy.mockRestore());

  beforeEach(() => {
    jest.clearAllMocks();
    // The service is a singleton with a cached token; reset it so each case exercises a
    // fresh token exchange. Credentials must be non-empty or getManagementToken throws
    // the not-configured error before any axios call.
    auth0Service.accessToken = null;
    auth0Service.tokenExpiry = null;
    // Round 3 #26: the token-failure memo is per process; each case starts fresh.
    auth0Service.tokenFailureUntil = 0;
    auth0Service.tokenFailureMessage = null;
    auth0Service.clientId = 'test-client-id';
    auth0Service.clientSecret = 'test-client-secret';
    auth0Service.mgmtDomain = 'tenant.us.auth0.com';
    auth0Service.audience = 'https://tenant.us.auth0.com/api/v2/';
  });

  it('(a) a token failure is captured ONCE with op:token, and getUserById rejects with the wrapped token message', async () => {
    mockAxiosPost.mockRejectedValue(axiosError(403));

    await expect(auth0Service.getUserById(SUB)).rejects.toThrow(
      /Failed to get Auth0 Management API token/
    );

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, options] = mockCaptureException.mock.calls[0];
    expect(options.tags.op).toBe('token');
    expect(options.tags.service).toBe('auth0-management');
    // No axios GET was ever attempted, so there is nothing for op:'getUserById' to report.
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('(b) a 500 from getUserById is captured once with op + status, and never as the raw axios error', async () => {
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'mgmt-token-xyz' } });
    const rejection = axiosError(500);
    mockAxiosGet.mockRejectedValue(rejection);

    await expect(auth0Service.getUserById(SUB)).rejects.toThrow(/Failed to fetch Auth0 user/);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [captured, options] = mockCaptureException.mock.calls[0];
    expect(options.tags.op).toBe('getUserById');
    expect(options.tags.status).toBe('500');
    expect(captured).not.toBe(rejection);
    expect(captured.response).toBeUndefined();
    expect(captured.config).toBeUndefined();

    // T-88.8-03: no captured argument may carry the token POST body.
    const serialized = JSON.stringify(mockCaptureException.mock.calls[0]);
    expect(serialized).not.toContain('client_secret');
    expect(serialized).not.toContain('grant_type');
    expect(serialized).not.toContain('SUPER-SECRET');
  });

  it('(c) a 404 from getUserById resolves null with ZERO captures', async () => {
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'mgmt-token-xyz' } });
    mockAxiosGet.mockRejectedValue(axiosError(404));

    await expect(auth0Service.getUserById(SUB)).resolves.toBeNull();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('(d) a 403 from deleteUser rejects and is captured once with op:deleteUser', async () => {
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'mgmt-token-xyz' } });
    mockAxiosDelete.mockRejectedValue(axiosError(403));

    await expect(auth0Service.deleteUser(SUB)).rejects.toThrow(/Failed to delete Auth0 user/);

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, options] = mockCaptureException.mock.calls[0];
    expect(options.tags.op).toBe('deleteUser');
    expect(options.tags.status).toBe('403');
  });

  it('(e) a 404 from deleteUser is idempotent success with ZERO captures', async () => {
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'mgmt-token-xyz' } });
    mockAxiosDelete.mockRejectedValue(axiosError(404));

    await expect(auth0Service.deleteUser(SUB)).resolves.toEqual({
      deleted: true,
      alreadyGone: true,
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('searchUsersByEmail reports its own op tag on a non-404 failure', async () => {
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'mgmt-token-xyz' } });
    mockAxiosGet.mockRejectedValue(axiosError(429));

    await expect(auth0Service.searchUsersByEmail('a@example.com')).rejects.toThrow(
      /Failed to search Auth0 users/
    );

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [, options] = mockCaptureException.mock.calls[0];
    expect(options.tags.op).toBe('searchUsersByEmail');
    expect(options.tags.status).toBe('429');
  });
});
