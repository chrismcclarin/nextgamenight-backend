// services/auth0Service.js
// Service for interacting with Auth0 Management API
const axios = require('axios');

// Sentry SDK is initialized in server.js when SENTRY_DSN is set. Unconditional
// try-require (the routes/users.js:19-25 idiom, NOT the DSN-gated variant): in a
// dev/test env with no DSN the SDK's capture calls are harmless no-ops, and if the
// package is absent entirely every capture below is guarded on Sentry being non-null.
let Sentry = null;
try {
  Sentry = require('@sentry/node');
} catch (_e) {
  Sentry = null;
}

/**
 * Report a failed Auth0 Management API call to Sentry.
 *
 * Captures a FRESH Error, never the raw AxiosError. An AxiosError carries `config`
 * (including `config.data`, which for the token POST is the body holding
 * `client_secret`), `params` and request headers including the bearer token
 * (T-88.8-03). Today's Sentry.init has no extraErrorDataIntegration and no
 * sendDefaultPii, so the raw error would not serialise those fields right now — but
 * one common integration line added later would silently turn every one of these
 * events into a credential leak. Pinning the wrapped error closes that regardless.
 * `error.response.data` continues to go to stdout only, which is where it already went.
 *
 * @param {Error} error - the caught error (usually an AxiosError).
 * @param {{ service: string, op: string }} tags - Sentry tags; `status` is added here.
 */
function captureManagementFailure(error, tags) {
  if (!Sentry || typeof Sentry.captureException !== 'function') return;
  const wrapped = new Error(`Auth0 Management ${tags.op} failed: ${error.message}`);
  Sentry.captureException(wrapped, {
    tags: { ...tags, status: String(error.response?.status ?? 'none') },
  });
}

class Auth0Service {
  constructor() {
    this.domain = process.env.AUTH0_DOMAIN;
    // DECISION Phase 88.8 D-04/D-05: the Management API audience and every Management
    // request URL are built from AUTH0_TENANT_DOMAIN, chosen OVER continuing to derive
    // them from AUTH0_DOMAIN.
    //
    // Root cause (.planning/.../88.8-CONFIG-FINDING.md): Auth0 requires the Management
    // API **audience** to be the CANONICAL tenant domain (`*.auth0.com`) even when users
    // log in through a custom domain. This app's AUTH0_DOMAIN holds the CUSTOM domain
    // `auth.nextgamenight.app` because JWT issuer validation needs it
    // (middleware/auth0.js:109, :200 and the jwksUri at :14). Deriving the Management
    // audience from that same variable produced `https://auth.nextgamenight.app/api/v2/`
    // — an API identifier that does not exist — so every token exchange has 403'd since
    // 2026-04, and every account provisioned since then got a synthetic @auth0.local
    // address instead of a real one.
    //
    // The issuer and the JWKS URI STAY on AUTH0_DOMAIN. Moving them to the tenant domain
    // would be a bug, not a cleanup: tokens minted through the custom login domain carry
    // the custom-domain issuer, and validating them against the tenant domain would
    // reject every real login.
    //
    // The `|| AUTH0_DOMAIN` fallback reproduces today's URLs byte-for-byte, which is what
    // makes the rollout order-independent (D-03) — the code can deploy before or after
    // the owner sets the variable, in either order, without a broken window.
    this.mgmtDomain = process.env.AUTH0_TENANT_DOMAIN || process.env.AUTH0_DOMAIN;
    this.clientId = process.env.AUTH0_MANAGEMENT_CLIENT_ID;
    this.clientSecret = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET;
    this.audience = `https://${this.mgmtDomain}/api/v2/`;
    this.accessToken = null;
    this.tokenExpiry = null;

    // A silent fallback in production is exactly the failure mode that hid the 403 for
    // five months, so say it out loud ONCE, at construction. NEVER throw here: this
    // module is required at boot, railway.json runs preDeployCommand and then health-
    // checks /health with a 120s timeout, and a constructor throw before /health can
    // answer fails the deploy outright — the 2026-09-02 incident class.
    if (!process.env.AUTH0_TENANT_DOMAIN && process.env.NODE_ENV === 'production') {
      console.warn(
        '⚠️  AUTH0_TENANT_DOMAIN is not set — the Auth0 Management API audience is falling ' +
        'back to AUTH0_DOMAIN. If AUTH0_DOMAIN is a CUSTOM login domain, every Management ' +
        'API call will 403. Set AUTH0_TENANT_DOMAIN to the canonical *.auth0.com tenant domain.'
      );
      if (Sentry && typeof Sentry.captureMessage === 'function') {
        Sentry.captureMessage(
          'AUTH0_TENANT_DOMAIN unset — Auth0 Management audience falling back to AUTH0_DOMAIN',
          { level: 'warning', tags: { service: 'auth0-management', op: 'token' } }
        );
      }
    }
  }

  /**
   * Get Management API access token
   * Tokens expire after 24 hours, so we cache and reuse them
   */
  async getManagementToken() {
    // Return cached token if still valid (with 5 minute buffer)
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry - 300000) {
      return this.accessToken;
    }

    if (!this.clientId || !this.clientSecret || !this.mgmtDomain) {
      throw new Error('Auth0 Management API credentials not configured. Set AUTH0_MANAGEMENT_CLIENT_ID, AUTH0_MANAGEMENT_CLIENT_SECRET, and AUTH0_TENANT_DOMAIN (preferred; falls back to AUTH0_DOMAIN) environment variables.');
    }

    try {
      const response = await axios.post(`https://${this.mgmtDomain}/oauth/token`, {
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: this.audience,
        grant_type: 'client_credentials'
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      this.accessToken = response.data.access_token;
      // Token expires in 24 hours (86400000 ms), cache for 23 hours to be safe
      this.tokenExpiry = Date.now() + (23 * 60 * 60 * 1000);

      return this.accessToken;
    } catch (error) {
      console.error('Error fetching Auth0 Management API token:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      // SPEC R4 / A2. The response body is already on stdout above — what was missing
      // for five months was the Sentry EVENT, not the logging, so do not add a second
      // body log here. The flag makes the token failure reported exactly ONCE even
      // though it surfaces through three different methods' try blocks.
      const wrapped = new Error(`Failed to get Auth0 Management API token: ${error.message}`);
      wrapped.sentryReported = true;
      if (Sentry && typeof Sentry.captureException === 'function') {
        Sentry.captureException(wrapped, { tags: { service: 'auth0-management', op: 'token' } });
      }
      throw wrapped;
    }
  }

  /**
   * Search for users by email in Auth0
   * Returns array of matching users
   */
  async searchUsersByEmail(email) {
    try {
      const token = await this.getManagementToken();
      
      const response = await axios.get(`https://${this.mgmtDomain}/api/v2/users`, {
        params: {
          q: `email:"${email}"`,
          search_engine: 'v3'
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      return response.data || [];
    } catch (error) {
      console.error('Error searching Auth0 users by email:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      // Guarded so a token failure surfacing through this method's try is reported once,
      // at the token catch, not twice.
      if (!error.sentryReported) {
        captureManagementFailure(error, { service: 'auth0-management', op: 'searchUsersByEmail' });
      }
      throw new Error(`Failed to search Auth0 users: ${error.message}`);
    }
  }

  /**
   * Get user by Auth0 user_id (sub)
   */
  async getUserById(userId) {
    try {
      const token = await this.getManagementToken();
      
      const response = await axios.get(`https://${this.mgmtDomain}/api/v2/users/${encodeURIComponent(userId)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      console.error('Error fetching Auth0 user by ID:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      // Placed AFTER the 404 early-return above: a 404 is a defined outcome
      // ("the Auth0 identity is gone"), never a report.
      if (!error.sentryReported) {
        captureManagementFailure(error, { service: 'auth0-management', op: 'getUserById' });
      }
      throw new Error(`Failed to fetch Auth0 user: ${error.message}`);
    }
  }

  /**
   * Delete an Auth0 login identity by user_id (sub).
   * Molded on getUserById: acquire the cached client-credentials Management token,
   * issue DELETE /api/v2/users/:encodedSub, treat 204 as success and 404 as
   * already-deleted (idempotent). Any other status throws so the caller's durable
   * retry lane (accountDeletionService / auth0CleanupWorker) engages — this method
   * NEVER swallows a 401/403/429/5xx.
   *
   * Requires the delete:users scope on the Management client (provisioned as a gated
   * human dashboard step in plan 87.2-09, not code-provisioned).
   */
  async deleteUser(userId) {
    const token = await this.getManagementToken();
    try {
      await axios.delete(`https://${this.mgmtDomain}/api/v2/users/${encodeURIComponent(userId)}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      return { deleted: true }; // 204 No Content on success
    } catch (error) {
      if (error.response?.status === 404) {
        return { deleted: true, alreadyGone: true }; // idempotent — already deleted
      }
      console.error('Error deleting Auth0 user:', error.message);
      if (error.response) {
        console.error('Auth0 response:', error.response.data);
      }
      // Placed AFTER the 404 early-return: 404 is idempotent success, never a report.
      // deleteUser acquires its token OUTSIDE this try (above), so a token failure
      // propagates already-reported by the token catch and never reaches here — the
      // !error.sentryReported guard is kept anyway so this catch cannot start
      // double-reporting if that shape ever changes.
      // Accepted collateral, recorded: the durable deletion retry lane
      // (accountDeletionService.js:640, pendingAuth0DeletionSweep.js:136,
      // auth0CleanupWorker.js:62) emits roughly one Sentry event per retry attempt.
      // They group under a single issue via the shared message shape. Deliberately NOT
      // rate-limited in this phase.
      if (!error.sentryReported) {
        captureManagementFailure(error, { service: 'auth0-management', op: 'deleteUser' });
      }
      // Rethrow (wrapped) so the enqueue/retry path fires on 401/403/429/5xx.
      throw new Error(`Failed to delete Auth0 user: ${error.message}`);
    }
  }

  /**
   * Extract user details from Auth0 user object
   * Handles both Google OAuth and email/password users
   * 
   * For email/password users: username field contains what they entered during signup
   * For Google OAuth users: name field contains their Google name
   */
  extractUserDetails(auth0User) {
    const email = auth0User.email;
    const emailVerified = auth0User.email_verified || false;
    
    // Priority order for username:
    // 1. username field (for email/password users - this is what they entered during signup!)
    //    Auth0 structure: name = email, email = email, username = what they entered during signup
    // 2. name field (for Google OAuth users, but skip if it's just the email)
    // 3. nickname (if different from email)
    // 4. given_name + family_name (for Google OAuth users)
    // 5. Extract from email as fallback
    let username;
    
    // Check username field FIRST and use it directly (for email/password users)
    // This is the username they entered during signup - use it regardless of whether it equals email
    // The name field is just the email, so we ignore that and use username instead
    if (auth0User.username && auth0User.username.trim().length > 0) {
      username = auth0User.username.trim();
    }
    // Then check name field (for Google OAuth users, but skip if it equals email)
    else if (auth0User.name && auth0User.name !== email && auth0User.name.trim().length > 0) {
      username = auth0User.name.trim();
    }
    // Then check nickname (if different from email)
    else if (auth0User.nickname && auth0User.nickname !== email && auth0User.nickname.trim().length > 0) {
      username = auth0User.nickname.trim();
    }
    // Then given_name + family_name (for Google OAuth)
    else if (auth0User.given_name || auth0User.family_name) {
      username = [auth0User.given_name, auth0User.family_name].filter(Boolean).join(' ').trim();
      if (username.length === 0) {
        username = null; // Reset if empty after trimming
      }
    }
    
    // Fallback: extract from email if no username found
    if (!username && email) {
      // Extract username from email (e.g., "oblivionfolder@hotmail.com" -> "oblivionfolder")
      username = email.split('@')[0];
    }
    
    // Last resort fallback
    if (!username) {
      username = 'User';
    }

    // Debug logging in development to help troubleshoot
    if (process.env.NODE_ENV === 'development') {
      console.log('Auth0 user extraction:', {
        user_id: auth0User.user_id,
        email: email,
        username_field: auth0User.username,
        name_field: auth0User.name,
        nickname: auth0User.nickname,
        extracted_username: username
      });
    }

    return {
      user_id: auth0User.user_id,
      email: email,
      username: username,
      email_verified: emailVerified,
      picture: auth0User.picture || null
    };
  }
}

module.exports = new Auth0Service();
