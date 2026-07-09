// tests/services/auth0Service.deleteUser.test.js
// Phase 87.2 / Plan 02 Task 2: unit tests for auth0Service.deleteUser(sub).
//
// deleteUser molds on getUserById (token-acquire + axios + 404-tolerance). It is the
// leaf the accountDeletionService (plan 04) / auth0CleanupWorker (plan 03) call to remove
// the Auth0 login identity. Its 404-idempotence and throw-on-retryable contract are what
// keep the durable retry lane honest — so this test is the only net for those semantics.
//
// Mock axios BEFORE requiring the service so the singleton picks up the mock.

const mockAxiosDelete = jest.fn();
const mockAxiosPost = jest.fn();
const mockAxiosGet = jest.fn();

jest.mock('axios', () => ({
  delete: (...args) => mockAxiosDelete(...args),
  post: (...args) => mockAxiosPost(...args),
  get: (...args) => mockAxiosGet(...args),
}));

const auth0Service = require('../../services/auth0Service');

describe('auth0Service.deleteUser', () => {
  const SUB = 'auth0|abc123';
  const ENCODED = encodeURIComponent(SUB);

  beforeEach(() => {
    jest.clearAllMocks();
    // Stub the token acquisition so no real Auth0 call is made and no new
    // scope-acquisition code is required — getManagementToken is reused as-is.
    jest.spyOn(auth0Service, 'getManagementToken').mockResolvedValue('mgmt-token-xyz');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves { deleted: true } on 204 and issues DELETE to the encoded-sub URL with Bearer + 10s timeout', async () => {
    mockAxiosDelete.mockResolvedValue({ status: 204 });

    const result = await auth0Service.deleteUser(SUB);

    expect(result).toEqual({ deleted: true });
    expect(auth0Service.getManagementToken).toHaveBeenCalledTimes(1);
    expect(mockAxiosDelete).toHaveBeenCalledTimes(1);

    const [url, config] = mockAxiosDelete.mock.calls[0];
    expect(url).toContain(`/api/v2/users/${ENCODED}`);
    expect(config.headers.Authorization).toBe('Bearer mgmt-token-xyz');
    expect(config.timeout).toBe(10000);
  });

  it('resolves { deleted: true, alreadyGone: true } on 404 (idempotent)', async () => {
    mockAxiosDelete.mockRejectedValue({ response: { status: 404 } });

    const result = await auth0Service.deleteUser(SUB);

    expect(result).toEqual({ deleted: true, alreadyGone: true });
  });

  it('throws on a 500 so the caller retry lane engages (does not swallow)', async () => {
    mockAxiosDelete.mockRejectedValue({ response: { status: 500 }, message: 'server error' });

    await expect(auth0Service.deleteUser(SUB)).rejects.toThrow();
  });

  it('encodes special characters in the sub', async () => {
    mockAxiosDelete.mockResolvedValue({ status: 204 });
    const weirdSub = 'google-oauth2|10#20';

    await auth0Service.deleteUser(weirdSub);

    const [url] = mockAxiosDelete.mock.calls[0];
    expect(url).toContain(encodeURIComponent(weirdSub));
    expect(url).not.toContain('#');
  });
});
