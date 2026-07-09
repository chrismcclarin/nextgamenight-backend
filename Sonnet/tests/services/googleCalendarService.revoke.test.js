// tests/services/googleCalendarService.revoke.test.js
// Phase 87.2 / Plan 02 Task 3: unit tests for googleCalendarService.revokeGoogleAccess().
//
// Rationale (why this test is load-bearing): the deletion pipeline (plan 04) mocks this
// service wholesale and swallows its failures best-effort (D-03) — so a defective revoke
// degrades SILENTLY in production, leaving live Google grants, the exact gap SPEC Req 4
// closes. This unit test is the only net for the revoke semantics.
//
// Mock googleapis BEFORE requiring the service so the OAuth2 client is our spy.

const mockRevokeToken = jest.fn();
const mockOAuth2 = jest.fn().mockImplementation(() => ({
  setCredentials: jest.fn(),
  revokeToken: mockRevokeToken,
}));

jest.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: mockOAuth2 },
    calendar: jest.fn(() => ({ events: {} })),
  },
}));

// googleCalendarService touches models/User in OTHER methods; keep the mock minimal.
jest.mock('../../models', () => ({
  User: { update: jest.fn() },
}));

const googleCalendarService = require('../../services/googleCalendarService');

describe('googleCalendarService.revokeGoogleAccess', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prefers the refresh token over the access token (refresh kills the whole grant)', async () => {
    mockRevokeToken.mockResolvedValue({ status: 200 });

    const result = await googleCalendarService.revokeGoogleAccess('access-abc', 'refresh-xyz');

    expect(result).toEqual({ revoked: true });
    expect(mockRevokeToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeToken).toHaveBeenCalledWith('refresh-xyz');
  });

  it('falls back to the access token when no refresh token is given', async () => {
    mockRevokeToken.mockResolvedValue({ status: 200 });

    const result = await googleCalendarService.revokeGoogleAccess('access-only');

    expect(result).toEqual({ revoked: true });
    expect(mockRevokeToken).toHaveBeenCalledWith('access-only');
  });

  it('returns { revoked:false, skipped:true, reason:"no_token" } without calling revokeToken when no token', async () => {
    const result = await googleCalendarService.revokeGoogleAccess(null, null);

    expect(result).toEqual({ revoked: false, skipped: true, reason: 'no_token' });
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it('treats a NUMERIC 400 as already-revoked success', async () => {
    mockRevokeToken.mockRejectedValue({ code: 400 });

    const result = await googleCalendarService.revokeGoogleAccess('access-abc', 'refresh-xyz');

    expect(result).toEqual({ revoked: true, alreadyRevoked: true });
  });

  it('treats a STRING "400" GaxiosError code as already-revoked success (coercion)', async () => {
    // GaxiosError.code is frequently the STRING '400' — a strict === against the number
    // would silently rethrow an already-revoked token. The coercion guards that.
    mockRevokeToken.mockRejectedValue({ code: '400' });

    const result = await googleCalendarService.revokeGoogleAccess('access-abc', 'refresh-xyz');

    expect(result).toEqual({ revoked: true, alreadyRevoked: true });
  });

  it('treats a 400 carried on error.response.status as already-revoked success', async () => {
    mockRevokeToken.mockRejectedValue({ response: { status: 400 } });

    const result = await googleCalendarService.revokeGoogleAccess('access-abc', 'refresh-xyz');

    expect(result).toEqual({ revoked: true, alreadyRevoked: true });
  });

  it('rethrows any non-400 error so the caller can log it (best-effort, never blocks)', async () => {
    mockRevokeToken.mockRejectedValue({ code: 500, message: 'boom' });

    await expect(
      googleCalendarService.revokeGoogleAccess('access-abc', 'refresh-xyz')
    ).rejects.toBeDefined();
  });
});
