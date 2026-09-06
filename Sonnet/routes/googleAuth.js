// routes/googleAuth.js
// Google OAuth 2.0 routes for Calendar integration
const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { User, SingleUseToken, PendingAuth0Deletion } = require('../models');
const { sendError, AppError } = require('../utils/errors');
const { resolveAllowedFrontendUrl, normalizeOrigin } = require('../config/allowedOrigins');
// Phase 88.8 plan 06 (SPEC A1 / D-13): the single home of the provisioning policy.
const provisioningService = require('../services/provisioningService');
const { matchesSelf } = require('../middleware/objectAuth');
const router = express.Router();

// OAuth state nonce lifetime: the consent round-trip is short; 30 min is generous.
const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Phase 88.8 plan 06 Task 3 — SPEC R9 as amended by SPEC Amendment A5, CONTEXT D-22.
//
// Where a deleted account is sent when it comes back through the PUBLIC Google OAuth
// callback. The path and the reason are ONE frozen literal because the frontend
// allowlist compares it with `===`:
// periodictabletop/src/app/api/auth/[auth0]/route.js matches exactly '/goodbye' and
// exactly '/goodbye?reason=account_deleted'. Deriving either side from the other is
// impossible across two repos, so both are written out; the backend test asserts the
// whole emitted string so a drift fails loudly rather than degrading silently.
//
// The PATH is copied from the shipped logout-goodbye constant
// (periodictabletop/src/app/components/DangerZoneDeleteAccount.tsx:61) but NOT the
// value: that constant's returnTo is unencoded because it has no query string of its
// own. Ours does.
// ---------------------------------------------------------------------------
const GOODBYE_RETURN_TO = '/goodbye?reason=account_deleted';
const FRONTEND_LOGOUT_PATH = '/api/auth/logout';

/**
 * Build the browser-facing refusal for an app-deleted account arriving at the OAuth
 * callback: log the still-live frontend session out through Auth0, then land on the
 * goodbye page with the account-deleted explanation.
 *
 * WHY A REDIRECT THROUGH LOGOUT rather than straight to /goodbye: mid-OAuth the
 * frontend session is still ALIVE. Sending the browser to /goodbye directly would leave
 * a logged-in session belonging to an account that no longer exists. Routing through
 * logout is the shipped idiom for exactly this.
 *
 * TWO FACTS, written here so nobody re-opens them:
 *  1. Auth0's logout documentation states that query-string and hash information in a
 *     `returnTo` value is NOT taken into account when validating against Allowed Logout
 *     URLs, so the already-allow-listed goodbye URL covers the reason variant and NO
 *     Auth0 dashboard change is required (owner confirmed the goodbye URL is on that
 *     list, 2026-09-02). 88.8-RESEARCH.md, Vendor Answers V3.
 *  2. The installed @auth0/nextjs-auth0 short-circuits to the return URL for a
 *     sessionless caller, so the branch is robust whether or not the session survived.
 *     88.8-RESEARCH.md, Code Examples E4.
 *
 * THE ENCODING IS LOAD-BEARING and is the single most likely thing to ship broken.
 * Unencoded, the reason's `?` starts a SECOND query parameter on the logout route; the
 * frontend's `searchParams.get('returnTo')` then returns the bare '/goodbye', its
 * exact-literal allowlist matches the OLD literal, and the reason variant silently
 * never renders — a bug that presents as a frontend copy bug and gets debugged in the
 * wrong repo. Pinned by an exact-string assertion plus a one-question-mark assertion.
 *
 * @param {{ frontend_url?: string|null }|null} consumedToken - the consumed oauth_state row.
 * @returns {string} an absolute URL on an ALLOW-LISTED origin.
 */
function buildDeletedAccountRedirect(consumedToken) {
  // T-88.8-27: RE-RESOLVE the stored value through the allow-list AT CALLBACK TIME,
  // never reflect it. SPEC R9's original text said the sibling branches already do
  // this; SPEC Amendment A5 corrected that — they do NOT. Allow-listing happens at
  // MINT time (see the resolveAllowedFrontendUrl block in generateGoogleAuthUrl), which
  // is why the siblings trust `consumedToken.frontend_url` directly. Do NOT "simplify"
  // this branch to match them: re-resolving here is what makes the open-redirect test
  // real rather than vacuous, and it is the only defence if a stored row is ever
  // tampered with or was written by an older, laxer mint.
  const resolved =
    resolveAllowedFrontendUrl(consumedToken && consumedToken.frontend_url) ||
    resolveAllowedFrontendUrl(process.env.FRONTEND_URL) ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000';

  // resolveAllowedFrontendUrl allow-lists by ORIGIN but returns the caller's value,
  // which may carry a path. The logout route is mounted at the site ROOT, so normalise
  // to the bare origin — `${resolved}/api/auth/logout` on a path-carrying stored value
  // would 404. normalizeOrigin returns null for an unparseable value; fall back rather
  // than emit nothing.
  const origin = normalizeOrigin(resolved) || resolved;

  return `${origin}${FRONTEND_LOGOUT_PATH}?returnTo=${encodeURIComponent(GOODBYE_RETURN_TO)}`;
}

// Initialize OAuth2 client
const getOAuth2Client = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  
  // Determine redirect URI - check env var, or construct from Railway domain, or use localhost default
  let redirectUri = process.env.GOOGLE_REDIRECT_URI;
  
  if (!redirectUri) {
    // Try to construct from Railway environment (Railway provides RAILWAY_PUBLIC_DOMAIN)
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/auth/google/callback`;
    } else if (process.env.NODE_ENV === 'production') {
      // In production without explicit redirect URI and no Railway domain, throw error
      throw new Error('GOOGLE_REDIRECT_URI environment variable is required in production. Set it to your production backend URL (e.g., https://your-backend.railway.app/api/auth/google/callback)');
    } else {
      // Development: use localhost default
      redirectUri = 'http://localhost:4000/api/auth/google/callback';
    }
  }
  
  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID environment variable is not set');
  }
  
  if (!clientSecret) {
    throw new Error('GOOGLE_CLIENT_SECRET environment variable is not set');
  }
  
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

// Helper function to generate Google OAuth URL.
//
// Phase 88.8 plan 06: takes the CLAIMS BAG (req.user) rather than pre-extracted
// email/username strings, because provisioning policy now reads the whole bag —
// plan 01 widened req.user with `email_verified` and `connection_strategy`, and both
// are load-bearing (SPEC R3 verified-email adoption, D-27 social-only avatars). One
// caller, below.
const generateGoogleAuthUrl = async (user_id, claims = {}, frontendUrl = null) => {
  // SPEC Req 6 (Phase 87.2 tombstone guard, self-keyed): both callers pass the
  // verified token sub. A still-valid token surviving account deletion must not
  // re-provision the Users row via the OAuth-URL mint. Throw the registered
  // AppError so the routes' catch blocks map it to the pinned 410 envelope.
  if (await PendingAuth0Deletion.isTombstoned(user_id)) {
    throw new AppError('account_deleted');
  }

  // -------------------------------------------------------------------------
  // Phase 88.8 plan 06 (SPEC Amendment A1; D-13). Provision through the single
  // home. This ALSO fixes a latent NOT NULL violation, which is why it is a fix
  // and not churn: the defaults this replaced passed `email: email || null` into
  // `Users.email`, declared `allowNull: false` (models/User.js). Any Google connect
  // whose token carried no email address 500'd on the INSERT; it has survived only
  // because Google sign-in almost always supplies one. The service can never produce
  // a null address — its last resort is the synthetic one.
  // -------------------------------------------------------------------------
  const provisioned = await provisioningService.provisionOrRepair({
    sub: user_id,
    claims,
  });

  if (provisioned.status === 'identity_gone') {
    // Phase 87.2 SPEC Req 6: the Auth0 identity was deleted from the dashboard.
    // Same refusal the tombstone guard above uses, so this handler answers a
    // deleted identity with ONE shape.
    throw new AppError('account_deleted');
  }

  const user = provisioned.user;
  const created = provisioned.created;

  // -------------------------------------------------------------------------
  // DECISION Phase 88.8 R3: this block keeps the USERNAME refresh and no longer
  // writes EMAIL. Chosen OVER deleting the block outright, and OVER leaving it as
  // shipped.
  //
  // The email half was a security defect, not a cleanup target. `email` was
  // `req.user?.email || req.query.email || null` and the branch did
  // `if (email) updateData.email = email` with NO `email_verified` check anywhere
  // in this file — so ANY authenticated caller could write an arbitrary,
  // QUERY-STRING-sourced address into their own UNIQUE identity column just by
  // hitting `GET /google/url?email=...`. That column is an AUTHORIZATION gate here,
  // not contact data: routes/invites.js:593/:664/:757 accept an invite only when the
  // addresses match. Email adoption now belongs solely to the service's
  // verified-only repair, and the `req.query.email` / `req.query.username`
  // fallbacks are deleted outright (the only frontend caller,
  // periodictabletop/src/app/api/auth/google-connect/route.js:41, sends
  // `frontend_url` alone).
  //
  // The username half is KEPT rather than dropped because
  // tests/routes/provisionedUsername.clamp.test.js:94-104 pins it: an existing
  // 'Old Name' row must become the clamped token name on the next mint. The
  // service repairs a username only when the stored one is GENERIC or blank, so
  // dropping this block would weaken that pin. This is a display-name refresh from
  // the live token, which is a different rule from the service's repair rule.
  //
  // NAMED TRADE-OFF, recorded rather than glossed: the candidate order here
  // (`name || nickname`) is NOT the service's chain
  // (`username || name || nickname || given_name || email-local`). The divergence
  // is narrow — it can only differ for an EXISTING row whose caller carries a
  // `username` claim differing from `name` — and it is left in place deliberately
  // because converging it would change a shipped behaviour this plan did not scope.
  // Converging it is a decision for a later phase, not a cleanup.
  //
  // DECISION Phase 88.8 code review round 2 HIGH-C (2026-09-05): the candidates run
  // through the SERVICE's per-candidate picker, not through `clampProvisionedUsername`
  // directly. The ORDER trade-off above is unchanged; what changed is the FILTER. For
  // an Auth0 database (username-password) connection the `name` claim defaults to the
  // user's EMAIL ADDRESS, and `Users.username` is PUBLIC (PUBLIC_USER_ATTRS, twelve
  // projections) — so the direct clamp published a user's address as their display
  // name on every Calendar connect. The service's `pick()` refuses any candidate that
  // normalises to one of the user's own addresses; this route now asks that same
  // question, against BOTH the address on the live token and the address stored on
  // the row (they differ after an in-app email change, and neither may become the
  // public name). Chosen over a second local copy of the compare (duplication is not
  // a peer option here) and over lifting the picker into utils/provisionedUsername.js
  // (that helper is pinned to "DISPLAY usernames only" — see rejected alternative (a)
  // on makeUsernamePicker). When every candidate is refused, the stored username is
  // left as it is — a refused refresh is not a blank name.
  // -------------------------------------------------------------------------
  if (!created) {
    const pick = provisioningService.makeUsernamePicker([claims.email, user.email]);
    const refreshedUsername = pick(claims.name) || pick(claims.nickname);
    if (refreshedUsername) {
      await user.update({ username: refreshedUsername });
    }
  }

  const oauth2Client = getOAuth2Client();

  // Generate authorization URL
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly'
  ];

  // D-04 / BSEC-03: server-stored crypto nonce instead of unsigned base64-JSON state.
  // The callback resolves user_id FROM the stored row (kills BE-001 login-CSRF) and
  // redirects to the allow-listed frontend_url stored alongside it (kills BE-024 open redirect).
  // Allow-list the requested frontend_url against the SAME allow-list CORS uses;
  // reject anything not on it by falling back to FRONTEND_URL (never reflect attacker input).
  const allowedFrontendUrl =
    resolveAllowedFrontendUrl(frontendUrl) ||
    resolveAllowedFrontendUrl(process.env.FRONTEND_URL) ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000';

  const nonce = crypto.randomBytes(32).toString('base64url');
  await SingleUseToken.create({
    nonce,
    user_id,
    purpose: 'oauth_state',
    frontend_url: allowedFrontendUrl,
    status: 'active',
    expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Required to get refresh token
    scope: scopes,
    prompt: 'consent', // Force consent screen to get refresh token
    state: nonce, // Opaque server-stored nonce — NOT client-controlled state
  });

  return authUrl;
};

// Get Google OAuth URL as JSON (for authenticated API calls)
router.get('/google/url', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get frontend URL from request origin, query param, or environment variable
    // This ensures the callback redirects to the correct frontend URL
    const frontendUrl = req.query.frontend_url ||
                       (req.headers.origin ? req.headers.origin.replace(/\/$/, '') : null) ||
                       process.env.FRONTEND_URL ||
                       'http://localhost:3000';

    // Pass req.user ITSELF as the claims bag — never re-extracted local strings, and
    // never anything from req.query (Phase 88.8 plan 06, the DECISION R3 marker above).
    const authUrl = await generateGoogleAuthUrl(userId, req.user || {}, frontendUrl);

    // Return URL as JSON
    res.json({ authUrl });
  } catch (error) {
    if (error instanceof AppError && error.code === 'account_deleted') {
      // Phase 87.2 tombstone refusal — pinned 410 envelope, never a raw 500.
      return sendError(res, 'account_deleted');
    }
    console.error('Error generating Google OAuth URL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Step 2: Handle OAuth callback from Google (PUBLIC - no auth required)
router.get('/google/callback', async (req, res) => {
  // D-04: the resolved nonce row is hoisted so BOTH the success path AND the
  // catch-block error redirect derive frontend_url from it — never from a
  // re-parse of req.query.state (the second open-redirect sink, now removed).
  let consumedToken = null;
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    if (!state) {
      return res.status(400).json({ error: 'State parameter is required' });
    }

    // D-04 / BSEC-03: atomically consume the server-stored single-use nonce.
    // Zero rows => forged / replayed / expired => 403. This resolves user_id
    // and frontend_url FROM the row (the client cannot influence either).
    consumedToken = await SingleUseToken.consumeByNonce(state);
    if (!consumedToken || consumedToken.purpose !== 'oauth_state') {
      console.error('OAuth callback rejected: invalid, expired, or already-used state nonce');
      const errUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${errUrl}/userProfile/?google_calendar=error&message=${encodeURIComponent('Invalid or expired authorization request')}`);
    }

    const user_id = consumedToken.user_id;
    // frontend_url was allow-listed at mint time; trust the stored value.
    const frontendUrl = consumedToken.frontend_url || process.env.FRONTEND_URL || 'http://localhost:3000';

    // SPEC Req 6 (Phase 87.2 tombstone guard, self-keyed): the sub was resolved from
    // the nonce minted by the same (now-deleted) user. Refuse before the writer below
    // can re-materialize the Users row mid-OAuth-flow.
    //
    // Phase 88.8 plan 06 (SPEC R9 as amended by A5, D-22, T-88.8-31): the refusal is a
    // REDIRECT now, not `sendError(res, 'account_deleted')`. This handler is reached by
    // a BROWSER NAVIGATION from Google, so the 410 API envelope rendered as raw JSON in
    // the user's window. The two raw-JSON 400s above for a missing code/state stay as
    // they are — the SPEC boundaries record them as accepted-forever, because Google
    // always sends both and turning them into redirects would hide a genuinely broken
    // integration rather than help anyone.
    if (await PendingAuth0Deletion.isTombstoned(user_id)) {
      return res.redirect(buildDeletedAccountRedirect(consumedToken));
    }

    // -----------------------------------------------------------------------
    // Phase 88.8 plan 06 (SPEC Amendment A1; D-13). Should exist from step 1, but
    // provision if needed — through the single home, like every other writer. The
    // defaults this replaced were the literal generic username and a NULL email into
    // a NOT NULL column.
    //
    // CLAIMS ARE DELIBERATELY EMPTY, and this is the whole reason the site needs a
    // comment. This handler is a PUBLIC browser navigation (see the route
    // registration above) with NO `req.user` — its subject comes from
    // `consumedToken.user_id`. There IS a Google-userinfo address available on this
    // flow, and passing it here would adopt an address the IDENTITY PROVIDER never
    // asserted: Google told us who authorised a CALENDAR scope, not that Auth0 has
    // verified that address for this Auth0 sub. Passing `undefined` is not the same
    // thing as `{}` at the call boundary either — `{}` is what makes the service read
    // the claims as ABSENT and take its Management-then-synthetic create rule.
    //
    // Cost check, because "absent claims" sounds expensive: on the REPAIR path (the
    // overwhelmingly common case here, since /google/url provisioned this row
    // moments ago) the service makes ZERO Management calls for a row that already
    // holds a real address and a non-generic username. Connecting a calendar costs
    // no vendor round-trip, exactly as before.
    // -----------------------------------------------------------------------
    const provisioned = await provisioningService.provisionOrRepair({
      sub: user_id,
      claims: {},
    });

    if (provisioned.status === 'identity_gone') {
      // Phase 87.2 SPEC Req 6. Same browser-facing refusal as the tombstone branch
      // above — a browser navigation must never be answered with an API envelope.
      return res.redirect(buildDeletedAccountRedirect(consumedToken));
    }

    const user = provisioned.user;

    const oauth2Client = getOAuth2Client();

    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      console.error('No access token received from Google');
      throw new Error('Failed to get access token from Google');
    }

    // Store tokens in database
    // Note: Refresh token might be null if user already granted permission (Google reuses existing consent)
    const updateData = {
      google_calendar_token: tokens.access_token,
      google_calendar_enabled: true,
    };

    // Only update refresh token if we received one (if null, keep existing refresh token)
    if (tokens.refresh_token) {
      updateData.google_calendar_refresh_token = tokens.refresh_token;
    }

    await user.update(updateData);

    // Redirect to frontend success page using the allow-listed frontend URL from the row
    res.redirect(`${frontendUrl}/userProfile/?google_calendar=connected`);
  } catch (error) {
    console.error('Error handling Google OAuth callback:', error.message);
    // D-04: derive the error-redirect target from the RESOLVED row's allow-listed
    // frontend_url (or the env default) — NEVER from re-parsing req.query.state.
    // An attacker-supplied state cannot influence the error redirect.
    const frontendUrl =
      (consumedToken && consumedToken.frontend_url) ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000';
    res.redirect(`${frontendUrl}/userProfile/?google_calendar=error&message=${encodeURIComponent(error.message)}`);
  }
});

// Disconnect Google Calendar
router.post('/google/disconnect', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Clear Google Calendar tokens
    await user.update({
      google_calendar_token: null,
      google_calendar_refresh_token: null,
      google_calendar_enabled: false,
    });

    res.json({ message: 'Google Calendar disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting Google Calendar:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get Google Calendar connection status
router.get('/google/status/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify that the requested user_id matches the authenticated user
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' calendar status' });
    }

    // Find user (don't auto-create, just return status). Reuse matchesSelf's
    // UUID-arm memoized row when present (default scope carries both calendar
    // fields — only email/phone are excluded); fall back on the sub arm. (ML-19)
    const user = req.selfUser ?? await User.findOne({
      where: { user_id: userId },
      attributes: ['google_calendar_enabled', 'google_calendar_token']
    });

    // If user doesn't exist, they're not connected
    if (!user) {
      return res.json({ connected: false });
    }

    // Check if calendar is enabled AND has a token (both required for "connected")
    const isConnected = !!(user.google_calendar_enabled && user.google_calendar_token);
    
    res.json({ 
      connected: isConnected
    });
  } catch (error) {
    console.error('Error getting Google Calendar status:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

