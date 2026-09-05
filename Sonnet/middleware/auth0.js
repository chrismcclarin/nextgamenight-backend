// middleware/auth0.js
// Auth0 JWT verification middleware
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { sendError } = require('../utils/errors');
// DECISION Phase 88.8 D-02: runtime code loads a module whose body is ALSO pasted
// verbatim into the Auth0 dashboard as a post-login Action
// (auth0/actions/post-login-claims.js, re-exported through config/auth0Claims.js).
// That is surprising, and it is deliberate: the emitter of these claims and the reader
// of them share ONE table, so a claim-name change is impossible to make in only one
// half. Chosen OVER the obvious alternative — declaring the names a second time in a
// plain constants module and adding a key-set diff test — which only DETECTS drift
// after it happens. If the Actions editor ever refuses the extra exports (A1, unproven
// until the first owner paste), the fallback is mechanical: inline the table here in
// config/auth0Claims.js and keep the diff test. Changing this is a decision, not a cleanup.
const { CLAIMS } = require('../config/auth0Claims');

// Sentry is initialised in server.js when SENTRY_DSN is set; defensive require so
// dev/test without the DSN is a no-op (same idiom as routes/users.js).
let Sentry = null;
try {
  Sentry = require('@sentry/node');
} catch (_e) {
  Sentry = null;
}

/* Round 3 #3 (round 1 #12): the ONE runtime detector for "the post-login Action is not
   deployed". The whole verified-email posture — email adoption, the D-41/D-42 move gate,
   revert — reads namespaced claims that exist only once the Action is pasted into the
   Auth0 dashboard by hand (auth0/actions/README.md). Nothing in CI can see that, and
   without this every symptom (near-100% move skips, every revert refused, every repair
   deferred) looks like a bug in the gate rather than a missing deploy step. Throttled to
   one warning per process per hour, production only, and it never touches the request. */
const CLAIMS_ABSENT_REPORT_INTERVAL_MS = 60 * 60 * 1000;
let lastClaimsAbsentReportAt = 0;
function reportClaimsAbsentOnce(decoded) {
  if (process.env.NODE_ENV !== 'production') return;
  const now = Date.now();
  if (now - lastClaimsAbsentReportAt < CLAIMS_ABSENT_REPORT_INTERVAL_MS) return;
  lastClaimsAbsentReportAt = now;
  const line = '[auth0] post-login Action claims ABSENT from the access token — is the Action deployed and bound to the Login flow? (auth0/actions/README.md)';
  console.warn(line);
  if (Sentry && typeof Sentry.captureMessage === 'function') {
    Sentry.captureMessage(line, {
      level: 'warning',
      tags: { feature: 'auth0-claims', op: 'claims-absent' },
      extra: { hasBareEmail: typeof decoded.email === 'string' },
    });
  }
}

// Check for required environment variables
if (!process.env.AUTH0_DOMAIN) {
  console.warn('⚠️  WARNING: AUTH0_DOMAIN not set. JWT verification will fail.');
}

// Initialize JWKS client
const client = jwksClient({
  jwksUri: `https://${process.env.AUTH0_DOMAIN || 'your-tenant.us.auth0.com'}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
  rateLimit: true,
  jwksRequestsPerMinute: 5
});

// Function to get signing key
function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

// ---------------------------------------------------------------------------
// Phase 87.2 (SPEC Req 6) — tombstone choke, DEFENSE-IN-DEPTH for SELF-keyed paths.
//
// Auth0 deletion does not revoke already-issued access tokens (~24h TTL). The
// per-create-site guards (routes/users.js / events.js / groups.js / googleAuth.js)
// are the primary defense; this choke additionally refuses a tombstoned CALLER at
// the authn layer so no self-keyed path is missed. It cannot substitute for the
// per-site guards — third-party-keyed creates (search-by-email) create a row for
// a sub that is not the caller's, which this choke never sees.
//
// Steady-state cost discipline: verifyAuth0Token is DB-free today (stateless JWT
// + cached JWKS); coupling every authenticated request to a Postgres lookup of an
// almost-always-empty table would also couple auth availability to DB
// availability. So the per-caller lookup is gated behind a short-TTL in-process
// any-tombstones count cache: when zero tombstones exist (the overwhelming norm)
// NO per-request query runs. Any DB error fails OPEN (auth proceeds) — the
// per-site guards and the reconciliation sweep remain the backstops.
//
// Refusal shape is PINNED: the 410 account_deleted envelope — never 401 (a
// central 401 would make repeat DELETE /users/me bounce inside the retention
// window) and never a raw 410 (the FE maps a raw 410 to 'unknown' and retries).
// ---------------------------------------------------------------------------
const TOMBSTONE_COUNT_CACHE_TTL_MS = 60 * 1000;
let _tombstoneCountCache = { count: 0, fetchedAt: 0 };

async function callerIsTombstoned(sub) {
  if (!sub) return false;
  try {
    // Lazy require — keeps this middleware import-time DB-free (test suites mock
    // ../models or never touch it).
    const { PendingAuth0Deletion } = require('../models');
    const now = Date.now();
    if (now - _tombstoneCountCache.fetchedAt > TOMBSTONE_COUNT_CACHE_TTL_MS) {
      _tombstoneCountCache = { count: await PendingAuth0Deletion.count(), fetchedAt: now };
    }
    if (_tombstoneCountCache.count === 0) return false; // steady state: zero per-request DB cost
    return await PendingAuth0Deletion.isTombstoned(sub);
  } catch (err) {
    // Fail OPEN — never couple auth availability to DB availability.
    return false;
  }
}

/**
 * Auth0 JWT verification middleware
 * Verifies the JWT token from Authorization header and extracts user info
 */
const verifyAuth0Token = (req, res, next) => {
  // Get token from Authorization header
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // Status STAYS 401 (Pitfall 2). One generic 'unauthorized' message across all
    // three reject paths — no header/format/token enumeration (ASVS V2, T-85-08).
    return sendError(res, 'unauthorized');
  }

  // Extract token (format: "Bearer <token>")
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return sendError(res, 'unauthorized');
  }

  const token = parts[1];

  // Verify token
  // Use AUTH0_AUDIENCE if available (recommended), otherwise fall back to AUTH0_CLIENT_ID
  const audience = process.env.AUTH0_AUDIENCE || process.env.AUTH0_CLIENT_ID;
  if (!audience) {
    return res.status(500).json({ error: 'AUTH0_AUDIENCE or AUTH0_CLIENT_ID must be set' });
  }
  
  jwt.verify(
    token,
    getKey,
    {
      audience: audience,
      issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      algorithms: ['RS256']
    },
    (err, decoded) => {
      if (err) {
        // Don't log specific error details in production (could leak info)
        if (process.env.NODE_ENV === 'development') {
          console.error('JWT verification error:', err.message);
        } else {
          console.error('JWT verification failed');
        }
        // Call-site emit (Pitfall 1: never a bare async/callback throw). Status
        // STAYS 401; generic 'unauthorized' prose — no token-state enumeration.
        return sendError(res, 'unauthorized');
      }

      // Attach user info to request object.
      //
      // Phase 88.8 / BOPS-05 (R1): the NAMESPACED claim written by the post-login
      // Action wins over the bare OIDC claim when both are present — the Action's
      // value comes from event.user at login time and is the one we can reason about.
      // `??` (not `||`) so a legitimately false/empty claim value is not silently
      // skipped over in favour of a bare claim. email_verified keeps its `false`
      // default: an ABSENT verification claim must read as unverified, never verified.
      //
      // For email/password users: username field contains what they entered during signup.
      // For Google OAuth users: name field contains their Google name.
      req.user = {
        user_id: decoded.sub, // Auth0 user ID (sub claim) - this proves they exist in Auth0
        email: decoded[CLAIMS.email] ?? decoded.email,
        email_verified: decoded[CLAIMS.emailVerified] ?? decoded.email_verified ?? false,
        username: decoded[CLAIMS.username] ?? decoded.username,
        name: decoded[CLAIMS.name] ?? (decoded.name || decoded.nickname || decoded.given_name || decoded.family_name),
        nickname: decoded[CLAIMS.nickname] ?? decoded.nickname,
        picture: decoded[CLAIMS.picture] ?? decoded.picture,
        connection_strategy: decoded[CLAIMS.connection],
        given_name: decoded.given_name,
        family_name: decoded.family_name,
        // Include any other claims you need
      };
      // Round 4 #18: fire only when NO namespaced claim is present. A deployed Action
      // omits the email claim for a user whose Auth0 profile has no email, but it ALWAYS
      // sets the connection claim — so "none present" is the deploy-state signal.
      if (!Object.values(CLAIMS).some((key) => decoded[key] !== undefined)) reportClaimsAbsentOnce(decoded);

      // Log available token claims in development for debugging
      if (process.env.NODE_ENV === 'development' && !req.user.email) {
        console.log('Available token claims:', Object.keys(decoded));
        console.log('Email not found in token. Available fields:', {
          email: decoded.email,
          email_verified: decoded.email_verified,
          name: decoded.name,
          nickname: decoded.nickname,
          given_name: decoded.given_name,
          family_name: decoded.family_name,
        });
      }

      // Phase 87.2 tombstone choke (see block comment above). Emits the pinned
      // 410 account_deleted envelope for a tombstoned caller — never 401. Any
      // rejection here is call-site handled (Pitfall 1: no bare callback throw).
      // Two-argument then (NOT .then().catch()): a trailing .catch would also
      // re-catch a downstream error thrown back through next()/sendError inside
      // the fulfillment handler and call next() a SECOND time (double dispatch).
      // The rejection handler fires ONLY on a callerIsTombstoned rejection.
      callerIsTombstoned(decoded.sub).then(
        (tombstoned) => (tombstoned ? sendError(res, 'account_deleted') : next()),
        () => next() // fail OPEN only on a callerIsTombstoned rejection — per-site guards + sweep are the backstops
      );
    }
  );
};

/**
 * Optional middleware - verifies token but doesn't require it
 * Useful for endpoints that work with or without authentication
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // No auth header, continue without user
    req.user = null;
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    // Invalid format, continue without user
    req.user = null;
    return next();
  }

  const token = parts[1];

    // Use AUTH0_AUDIENCE if available (recommended), otherwise fall back to AUTH0_CLIENT_ID
    const audience = process.env.AUTH0_AUDIENCE || process.env.AUTH0_CLIENT_ID;
    
    jwt.verify(
    token,
    getKey,
    {
      audience: audience,
      issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      algorithms: ['RS256']
    },
    (err, decoded) => {
      if (err) {
        // Invalid token, continue without user
        req.user = null;
        return next();
      }

      // Phase 88.8 / BOPS-05 (R1): kept field-for-field identical to the
      // verifyAuth0Token mapping above — these two blocks are copies and both must
      // change together. optionalAuth additionally gains `username` and
      // `connection_strategy`, which it did not carry before.
      req.user = {
        user_id: decoded.sub,
        email: decoded[CLAIMS.email] ?? decoded.email,
        email_verified: decoded[CLAIMS.emailVerified] ?? decoded.email_verified ?? false,
        username: decoded[CLAIMS.username] ?? decoded.username,
        name: decoded[CLAIMS.name] ?? (decoded.name || decoded.nickname || decoded.given_name || decoded.family_name),
        nickname: decoded[CLAIMS.nickname] ?? decoded.nickname,
        picture: decoded[CLAIMS.picture] ?? decoded.picture,
        connection_strategy: decoded[CLAIMS.connection],
        given_name: decoded.given_name,
        family_name: decoded.family_name,
      };

      next();
    }
  );
};

module.exports = {
  verifyAuth0Token,
  optionalAuth
};

