// routes/users.js
const express = require('express');
const { User, Group, UserGroup, PendingAuth0Deletion, sequelize } = require('../models');
const router = express.Router();
const { validateUserSearch } = require('../middleware/validators');
const { writeOperationLimiter } = require('../middleware/rateLimiter');
const { requireParamMatchesToken } = require('../middleware/objectAuth');
// Phase 87.4 Plan 02 (KEYMISS mitigation): resolve a UUID self-param to the
// sub-keyed Users row.
const { isUuid } = require('../utils/resolveTargetUser');
const auth0Service = require('../services/auth0Service');
const smsService = require('../services/smsService');
const accountDeletionService = require('../services/accountDeletionService');
const { sendError } = require('../utils/errors');

// Sentry SDK is initialized in server.js when SENTRY_DSN is set. Use a defensive
// require so dev / test envs without the DSN don't blow up — addBreadcrumb /
// captureException become no-ops there. Pattern mirrors workers/*.js.
let Sentry = null;
try {
  Sentry = require('@sentry/node');
} catch (_e) {
  Sentry = null;
}

// ============================================================================
// Phase 87.3 PR-C (plan 09, Req 1/Req 2 — the ALIAS lock): every User-row
// serialization in this file ALIASES the `user_id` field to the row's Users.id
// UUID — the field NAME stays (display refs/React keys keep working), the
// Auth0 sub VALUE never crosses the wire. Applies to the self-profile read
// (BE-10) and every self-write echo (POST /, PUT username, POST refresh,
// PATCH notification-preferences, DELETE phone) — all are res.json-reachable
// serializations the grep-derived inventory (Task 2b) put in scope. Verified:
// no FE consumer reads `.user_id` off these responses as a sub (the identity
// hook and providers read `.id`; the one server-arg consumer — BringGamePicker
// -> GET /user-games/user/:id — is covered by that route's self-gate accepting
// the caller's UUID shape, extended in this same PR).
// ============================================================================
const toSelfWire = (user) => {
  const json = user && user.toJSON ? user.toJSON() : { ...user };
  json.user_id = json.id;
  return json;
};

// Search user by email
// Searches both our database and Auth0
router.get('/search/email/:email', validateUserSearch, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);

    // First, search in our database.
    // BSEC-01 (D-03 / WR-01): this is a CROSS-USER email search (friend lookup),
    // NOT a self read. We use withContactInfo so the self-case below can return the
    // caller's own full profile, but the cross-user response is projected down to
    // identity fields only (see the projection before res.json) — never leak phone.
    let user = await User.scope('withContactInfo').findOne({
      where: { email: email }
    });
    
    // If not found in database, try to find in Auth0 Management API
    // SECURITY: We ONLY create users if they exist in Auth0 (verified by Management API search)
    // We never create users "from thin air" - they must exist in Auth0 first
    if (!user) {
      try {
        const auth0Users = await auth0Service.searchUsersByEmail(email);
        
        // Only create user if found in Auth0
        if (auth0Users && auth0Users.length > 0) {
          // Found in Auth0, safe to create user in our database
          const auth0User = auth0Users[0]; // Use first match
          const userDetails = auth0Service.extractUserDetails(auth0User);

          // SPEC Req 6 (tombstone guard): this is a THIRD-PARTY-triggered create keyed on
          // the SEARCHED user's sub. If that sub was deleted (tombstone present, pending or
          // completed, within the ~24h token-TTL retention window), a still-valid deletion
          // must not let a third party re-materialize the deleted user's PII. Skip creation
          // entirely and fall through to the normal DB-miss 404 below — leaking nothing.
          if (await PendingAuth0Deletion.isTombstoned(userDetails.user_id)) {
            // user stays null → returns the ordinary "User not found" 404.
          } else {
          // Create user in our database (they exist in Auth0, so this is safe)
          const [newUser, created] = await User.findOrCreate({
            where: { user_id: userDetails.user_id },
            defaults: {
              user_id: userDetails.user_id,
              email: userDetails.email,
              username: userDetails.username, // This includes the username they entered during signup
            }
          });
          
          // If user already existed but had wrong email, update it
          if (!created && newUser.email !== userDetails.email) {
            await newUser.update({
              email: userDetails.email,
              username: userDetails.username
            });
          }
          
          user = newUser;
          } // end tombstone-guard else
        }
        // If not found in Auth0, user doesn't exist - return 404 (don't create from thin air)
      } catch (auth0Error) {
        // If Auth0 Management API is not configured, log and continue
        // This allows the endpoint to work even without Management API (but won't find users who haven't logged in yet)
        console.warn('Auth0 Management API lookup failed (this is optional):', auth0Error.message);
        // Continue to return 404 below (user not found)
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // WR-01 (BSEC-01/D-03): only the caller's OWN row gets the full contact-info
    // profile. For any other user, return identity fields plus the searched email
    // (which the caller already supplied) — never phone or integration PII.
    // Phase 87.3 PR-C (BE-11): the non-self object DROPS the sub user_id — this
    // endpoint has ZERO FE consumers (the FE email-search flow calls
    // GET /friendships/search, BE-12); cleaned on its own merit. The self branch
    // rides the toSelfWire alias (user_id = UUID) like every self read.
    const isSelf = req.user?.user_id === user.user_id;
    const payload = isSelf
      ? toSelfWire(user)
      : {
          id: user.id,
          username: user.username,
          email: user.email,
        };
    res.json(payload);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Phase 87.2 (D-01) — self-serve account deletion HTTP surface.
//
// These two routes MUST be registered ABOVE the `/:user_id` param routes below
// (Pitfall 7 defensive ordering): a bare `GET /:user_id` would otherwise swallow
// a `/me` segment. Both handlers are THIN (D-01) — they resolve the caller from
// req.user.user_id ONLY (never a param/body/query) and delegate to
// accountDeletionService. No request shape can target another user (SPEC Req 1).
// ---------------------------------------------------------------------------

// Pre-flight: which owned groups (if any) block this caller's deletion?
// Returns a raw 200 { groups: [{ id, name, memberCount }] } — success bodies are
// plain JSON. The Phase 85 envelope is reserved for the DELETE error responses.
router.get('/me/deletion-blockers', async (req, res) => {
  try {
    const sub = req.user && req.user.user_id;
    if (!sub) {
      return sendError(res, 'unauthorized');
    }
    // Resolve the caller's Users.id (UUID) — getDeletionBlockers keys on the UUID
    // surrogate PK, not the Auth0 sub. A stale session whose row is already gone
    // (still inside the token-TTL window) must return the 410 account_deleted
    // envelope, NEVER a 500 from feeding a null row into getDeletionBlockers.
    const user = await User.findOne({ where: { user_id: sub } });
    if (!user) {
      return sendError(res, 'account_deleted');
    }
    const groups = await accountDeletionService.getDeletionBlockers(user.id);
    return res.json({ groups });
  } catch (error) {
    console.error('[users] deletion-blockers pre-flight failed:', error.message);
    return sendError(res, 'internal');
  }
});

// Authoritative self-delete. Behind writeOperationLimiter (per-route, matching the
// PATCH /:user_id/timezone idiom) — the most destructive endpoint must not ship
// unthrottled since every attempt drives shared Auth0 Management + Google quota.
router.delete('/me', writeOperationLimiter, async (req, res) => {
  try {
    const sub = req.user && req.user.user_id;
    if (!sub) {
      return sendError(res, 'unauthorized');
    }
    // Delegate — the service resolves the caller from the sub ONLY. No param/body
    // target is read here or there (SPEC Req 1 — cross-user delete is structurally
    // impossible).
    const result = await accountDeletionService.deleteAccount({ userId: sub });
    if (result.status === 'blocked') {
      // Owner gate rides the Phase 85 envelope @409 with details.groups (D-11) —
      // NOT the legacy raw-403 groups.js shape. When the block fired at the
      // IN-TXN re-check (after Google cleanup already ran), the service adds
      // google_access_revoked: true — a pinned FE contract key — so the user can
      // be told to reconnect Google Calendar. Absent on the pre-flight block.
      const details = { groups: result.groups };
      if (result.google_access_revoked) {
        details.google_access_revoked = true;
      }
      return sendError(res, 'owner_of_active_groups', details);
    }
    if (result.status === 'not_found') {
      // Repeat DELETE inside the retention window → HTTP 410 with code
      // account_deleted on the envelope. Never a bare 401 (a still-valid token must
      // not be bounced by a generic auth guard) and never a raw non-envelope 410
      // (the FE maps a raw 410 to 'unknown' and default-retries it).
      return sendError(res, 'account_deleted');
    }
    // status === 'deleted'
    return res.json({ message: 'Your account and associated data have been deleted.' });
  } catch (error) {
    console.error('[users] account deletion failed:', error.message);
    return sendError(res, 'internal');
  }
});

// Get user by user_id (auto-creates if doesn't exist and user is authenticated)
// SECURITY: We only create users if:
// 1. They have a valid Auth0 token (verified by the global /api authn layer)
// 2. The token's user_id matches the requested user_id
// This ensures the user MUST exist in Auth0 before we create them in our database
//
// BSEC-01 / BE-048 (Task 1 audit): the READ path was NOT self-gated — only the
// auto-create branch checked `req.user.user_id === req.params.user_id`, so any
// authenticated user could read ANY user's full profile (email/phone). Add the
// object-level self-gate: the actor must equal the :user_id param. The frontend
// only ever calls this for the logged-in user (usersAPI.getUser(sub)).
router.get('/:user_id', requireParamMatchesToken('user_id'), async (req, res) => {
  try {
    // Phase 78 / TZ-01: accept optional browser-detected timezone for auto-create
    // persistence and existing-user null backfill. Query param wins over body to
    // keep the call site (GET request from TimezoneProvider) simple. Empty string
    // is treated as absent (frontend's "omit on detection failure" contract).
    // Validation lives here in the route handler per CONTEXT D-Validation
    // (not in middleware, not in the Sequelize model layer).
    const rawTimezone =
      (typeof req.query.timezone === 'string' && req.query.timezone) ||
      (req.body && typeof req.body.timezone === 'string' && req.body.timezone) ||
      null;
    let detectedTimezone = null;
    if (rawTimezone && rawTimezone.trim().length > 0) {
      const candidate = rawTimezone.trim();
      try {
        // Reuse the exact IANA validation from PATCH /:user_id/timezone (~L504).
        Intl.DateTimeFormat(undefined, { timeZone: candidate });
        detectedTimezone = candidate;
      } catch {
        return res.status(400).json({ error: 'Invalid IANA timezone string' });
      }
    }
    // detectedTimezone is now either a validated IANA string OR null (absent/empty).

    // BSEC-01 (D-03): withContactInfo — self-gated own-profile read that
    // returns email and reconciles it against the Auth0 token.
    // Phase 87.4 Plan 02 (T-874-02-KEYMISS): the self-gated param may be the
    // caller's own Users.id UUID (post-PR-2) — resolve it to the PK rather than
    // querying the still-sub-keyed Users.user_id column (which would miss and
    // wrongly enter the auto-create branch / 404 the caller's own profile).
    let user = isUuid(req.params.user_id)
      ? await User.scope('withContactInfo').findByPk(req.params.user_id, {
          include: [{ model: Group }],
        })
      : await User.scope('withContactInfo').findOne({
          where: { user_id: req.params.user_id },
          include: [{ model: Group }],
        });
    
    // Only auto-create if:
    // 1. User doesn't exist in our database
    // 2. Request has authenticated user info (valid Auth0 token)
    // 3. The authenticated user_id matches the requested user_id
    // SECURITY: The verifyAuth0Token middleware ensures they exist in Auth0 (token is signed by Auth0)
    // A valid Auth0 token can ONLY be issued by Auth0, which means the user MUST exist in Auth0
    // Therefore, we can safely create them in our database
    if (!user && req.user && req.user.user_id === req.params.user_id) {
      // SPEC Req 6 (tombstone guard): a still-valid access token whose Auth0 identity
      // was deleted must NOT JIT re-create the Users row (Auth0 deletion does not revoke
      // issued tokens for up to ~24h). Refuse with the pinned 410 account_deleted envelope
      // — the SAME shape as repeat DELETE — and create nothing.
      if (await PendingAuth0Deletion.isTombstoned(req.params.user_id)) {
        return sendError(res, 'account_deleted');
      }

      // Start with username from token (for email/password users, this is what they entered during signup)
      let userName = req.user.username || req.user.name || req.user.nickname || req.user.given_name || req.user.email?.split('@')[0] || 'User';
      let userEmail = req.user.email;

      // ALWAYS try to fetch from Auth0 Management API if we have credentials
      // This ensures we get the username they entered during signup (for email/password users)
      // Even if email is in token, username might not be, so we need Management API
      try {
        const auth0User = await auth0Service.getUserById(req.params.user_id);
        if (auth0User === null) {
          // SPEC Req 6: getUserById returns null ONLY on a 404 — the Auth0 identity is
          // GONE (deleted). Refuse to re-provision from token claims; a deleted identity
          // must never re-materialize email/username as a fresh Users row. (Management-API
          // *errors* throw and are handled by the catch below as the optional-lookup path.)
          return sendError(res, 'account_deleted');
        }
        if (auth0User) {
          // User exists in Auth0 (verified), safe to use their details
          const userDetails = auth0Service.extractUserDetails(auth0User);
          
          // Always use email from Management API if available and valid
          if (userDetails.email && !userDetails.email.includes('@auth0.local') && !userDetails.email.includes('@auth0')) {
            userEmail = userDetails.email;
          }
          
          // Always use username from Management API if available and not generic
          // This is critical for email/password users who entered a username during signup
          if (userDetails.username && userDetails.username.trim().length > 0 && userDetails.username !== 'User') {
            userName = userDetails.username.trim();
          }
        }
      } catch (auth0Error) {
        // If Management API is not configured or fails, log and continue with token data
        // This allows the system to work without Management API (with reduced functionality)
        console.warn('Auth0 Management API lookup failed during user creation (this is optional):', auth0Error.message);
        if (process.env.NODE_ENV === 'development') {
          console.log('Falling back to token data. Make sure AUTH0_MANAGEMENT_CLIENT_ID and AUTH0_MANAGEMENT_CLIENT_SECRET are set for full functionality.');
        }
      }
      
      // Improve username extraction for email/password users
      if (!userEmail || userEmail.includes('@auth0.local') || userEmail.includes('@auth0')) {
        // Fallback: construct email from user_id if still missing
        userEmail = `${req.params.user_id.replace(/[|:]/g, '-')}@auth0.local`;
      }
      
      // If username is still generic, try to extract from email
      if (userName === 'User' && userEmail && !userEmail.includes('@auth0.local') && !userEmail.includes('@auth0')) {
        userName = userEmail.split('@')[0];
      }
      
      // Combine given_name and family_name if available
      if (req.user.given_name || req.user.family_name) {
        const fullName = [req.user.given_name, req.user.family_name].filter(Boolean).join(' ').trim();
        if (fullName) {
          userName = fullName;
        }
      }
      
      try {
        const [newUser, created] = await User.findOrCreate({
          where: { user_id: req.params.user_id },
          defaults: {
            user_id: req.params.user_id,
            email: userEmail,
            username: userName,
            // TZ-01: persist browser-detected timezone on first creation if supplied.
            // If detectedTimezone is null we DELIBERATELY omit the key so Sequelize
            // applies the model defaultValue (null per migration 78-01) — sending
            // `timezone: null` explicitly would risk a future model default of 'UTC'
            // sneaking back in undetected. Absence is the safest signal.
            ...(detectedTimezone ? { timezone: detectedTimezone } : {}),
          }
        });
        
        // If user already existed but has wrong email/username, update them
        if (!created) {
          const needsUpdate = 
            (newUser.email !== userEmail && !newUser.email.includes('@auth0.local') && !newUser.email.includes('@auth0')) ||
            (newUser.username === 'User' && userName !== 'User');
          
          if (needsUpdate) {
            await newUser.update({
              email: userEmail,
              username: userName
            });
            console.log(`Updated user ${newUser.user_id} with email: ${userEmail}, username: ${userName}`);
          }
        } else {
          console.log(`Auto-created user: ${newUser.user_id} (${newUser.username}) with email: ${newUser.email}`);
        }
        
        user = newUser;
      } catch (error) {
        // If creation fails (e.g., email already exists), try to find the user
        console.error('Error auto-creating user:', error.message);
        // BSEC-01 (D-03): withContactInfo — same self-profile read as above.
        user = await User.scope('withContactInfo').findOne({ where: { user_id: req.params.user_id } });
        if (!user) {
          throw error; // Re-throw if we still can't find/create the user
        }
      }
    }
    
    // If user exists but has incorrect email/username, try to fix it
    // This handles cases where users were created before we had proper email extraction
    if (user && req.user && req.user.user_id === req.params.user_id) {
      const hasIncorrectEmail = user.email && (user.email.includes('@auth0.local') || user.email.includes('@auth0'));
      const hasGenericUsername = user.username === 'User' || !user.username || user.username.trim().length === 0;
      
      if (hasIncorrectEmail || hasGenericUsername) {
        // ALWAYS try Auth0 Management API to get correct data
        // This is especially important for email/password users with username from signup
        try {
          const auth0User = await auth0Service.getUserById(req.params.user_id);
          if (auth0User) {
            const userDetails = auth0Service.extractUserDetails(auth0User);
            
            const updateData = {};
            
            // Update email if incorrect
            if (hasIncorrectEmail && userDetails.email && !userDetails.email.includes('@auth0.local') && !userDetails.email.includes('@auth0')) {
              updateData.email = userDetails.email;
            }
            
            // Update username if generic or missing
            if (hasGenericUsername && userDetails.username && userDetails.username.trim().length > 0 && userDetails.username !== 'User') {
              updateData.username = userDetails.username.trim();
            }
            
            if (Object.keys(updateData).length > 0) {
              await user.update(updateData);
              console.log(`Fixed user ${user.user_id} with Management API data:`, updateData);
              // Reload user to get updated data.
              // BSEC-01 (D-03): withContactInfo — own profile returned with email.
              user = await User.scope('withContactInfo').findOne({
                where: { user_id: req.params.user_id },
                include: [{ model: Group }]
              });
            }
          }
        } catch (auth0Error) {
          // If Management API fails, log but don't break
          console.warn('Auth0 Management API lookup failed during user update:', auth0Error.message);
          if (process.env.NODE_ENV === 'development') {
            console.log('Make sure AUTH0_MANAGEMENT_CLIENT_ID and AUTH0_MANAGEMENT_CLIENT_SECRET are set.');
          }
        }
      }
    }

    // TZ-01 (Phase 78): null-timezone safety-net backfill.
    // If a user predates the auto-detect flow OR signed up while detection failed,
    // their stored timezone is null. On any subsequent login, if the client sends
    // a valid detected timezone, write it. NEVER overwrite a non-null stored value
    // — user's explicit pick is sacrosanct (CONTEXT D-Backend). Strict `=== null`
    // guard is the only check: 'UTC' and every other string are treated as
    // legitimate explicit choices. Mismatch-on-login awareness is deferred.
    if (user && user.timezone === null && detectedTimezone) {
      try {
        await user.update({ timezone: detectedTimezone });
        if (Sentry && typeof Sentry.addBreadcrumb === 'function') {
          Sentry.addBreadcrumb({
            category: 'auth.timezone-backfill',
            message: 'Backfilled null timezone for existing user on login',
            level: 'info',
            data: {
              user_id: user.user_id,
              timezone: detectedTimezone,
            },
          });
        }
        console.log(`Backfilled timezone for existing user ${user.user_id}: ${detectedTimezone}`);
      } catch (err) {
        // Backfill is best-effort — don't fail the GET request if the update fails.
        console.error(`Failed to backfill timezone for ${user.user_id}:`, err.message);
        if (Sentry && typeof Sentry.captureException === 'function') {
          Sentry.captureException(err, { tags: { feature: 'timezone-backfill' } });
        }
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Phase 87.3 PR-C (BE-10, A3 + locked alias decision): the self-profile
    // response aliases user_id to the Users.id UUID — the identity hook and
    // providers read `.id`; no consumer needs the sub off this response.
    res.json(toSelfWire(user));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark tutorial as completed (with version tracking)
router.put('/:user_id/tutorial', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' tutorial status' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Accept version from body, default to 2 (current tutorial version)
    const version = req.body.version != null ? parseInt(req.body.version, 10) : 2;
    await user.update({ tutorial_version: version });
    res.json({ tutorial_version: version });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset tutorial for replay
router.delete('/:user_id/tutorial', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot reset other users\' tutorial status' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ tutorial_version: 0 });
    res.json({ tutorial_version: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create or update the AUTHENTICATED user's own row (BE-049).
// FOLLOW-UP: this duplicates POST /:user_id/refresh (which reconciles
// username/email authoritatively from Auth0); consider removing this route
// and the unused FE `createOrUpdateUser` client method in a later cleanup.
router.post('/', async (req, res) => {
  try {
    const { username, email } = req.body;

    // BE-049 (BSEC-01): derive the subject from the verified JWT, NEVER from the
    // request body. Previously `user_id` came from req.body, letting any
    // authenticated caller create/overwrite ANY user's username+email.
    const user_id = req.user?.user_id;
    if (!user_id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // SPEC Req 6 (tombstone guard, self-keyed): a still-valid token surviving the
    // Auth0 deletion must not re-create the Users row from token claims. Pinned
    // refusal shape: 410 account_deleted on the Phase 85 envelope.
    if (await PendingAuth0Deletion.isTombstoned(user_id)) {
      return sendError(res, 'account_deleted');
    }

    const [user, created] = await User.findOrCreate({
      where: { user_id },
      defaults: { username, email, user_id }
    });

    if (!created) {
      await user.update({ username, email });
    }

    res.json(toSelfWire(user)); // PR-C: user_id aliased to the UUID
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user's username
router.put('/:user_id/username', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Verify that the requested user_id matches the authenticated user
    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' usernames' });
    }
    
    const { username } = req.body;
    
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({ error: 'Username is required and must be a non-empty string' });
    }
    
    if (username.length > 50) {
      return res.status(400).json({ error: 'Username must be 50 characters or less' });
    }
    
    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await user.update({ username: username.trim() });

    res.json(toSelfWire(user)); // PR-C: user_id aliased to the UUID
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Refresh user info from Auth0 (updates email and username from Auth0)
router.post('/:user_id/refresh', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Verify that the requested user_id matches the authenticated user
    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot refresh other users\' info' });
    }

    // SPEC Req 6 (tombstone guard, self-keyed): during the pending window the Auth0
    // identity may not be deleted yet, so the Auth0-404 check below is not enough —
    // this route's User.create could re-materialize the deleted row. Pinned refusal
    // shape: 410 account_deleted envelope.
    if (await PendingAuth0Deletion.isTombstoned(userId)) {
      return sendError(res, 'account_deleted');
    }

    // BSEC-01 (D-03): withContactInfo — self-gated refresh that returns the
    // user's own profile (incl. email) reconciled with Auth0.
    let user = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    
    try {
      // Fetch latest info from Auth0 Management API
      const auth0User = await auth0Service.getUserById(userId);
      if (!auth0User) {
        return res.status(404).json({ error: 'User not found in Auth0' });
      }
      
      const userDetails = auth0Service.extractUserDetails(auth0User);
      
      if (!user) {
        // Create user if doesn't exist
        user = await User.create({
          user_id: userDetails.user_id,
          email: userDetails.email,
          username: userDetails.username,
        });
      } else {
        // Update existing user with correct info
        await user.update({
          email: userDetails.email,
          username: userDetails.username,
        });
      }
      
      res.json(toSelfWire(user)); // PR-C: user_id aliased to the UUID
    } catch (auth0Error) {
      if (!user) {
        return res.status(404).json({ error: 'User not found and could not fetch from Auth0' });
      }
      // If Auth0 fails but user exists, return current user
      res.json(toSelfWire(user)); // PR-C: user_id aliased to the UUID
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update notification preferences
router.patch('/:user_id/notification-preferences', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' notification preferences' });
    }

    const { preferences } = req.body;
    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'preferences object is required' });
    }

    // Validate shape: each key must have boolean email/sms values
    const validTypes = ['event_created', 'reminder', 'event_updated', 'event_cancelled'];
    for (const [type, channels] of Object.entries(preferences)) {
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Unknown notification type: ${type}` });
      }
      if (typeof channels !== 'object' || channels === null) {
        return res.status(400).json({ error: `Invalid channels for type: ${type}` });
      }
      if (channels.email !== undefined && typeof channels.email !== 'boolean') {
        return res.status(400).json({ error: `email must be a boolean for type: ${type}` });
      }
      if (channels.sms !== undefined && typeof channels.sms !== 'boolean') {
        return res.status(400).json({ error: `sms must be a boolean for type: ${type}` });
      }
    }

    // At least one channel must be enabled globally across all notification types
    const anyEnabled = validTypes.some(type => {
      const channels = preferences[type];
      if (!channels) return true; // missing type defaults to email=true
      return channels.email || channels.sms;
    });
    if (!anyEnabled) {
      return res.status(400).json({ error: 'At least one notification channel must be enabled' });
    }

    // BSEC-01 (D-03): withContactInfo — this path reads user.phone to send the
    // CTIA welcome SMS; defaultScope would strip it.
    const user = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ notification_preferences: preferences });

    // CTIA / carrier compliance: send one-time welcome SMS the first time a user
    // opts in to any SMS notification. Idempotent via sms_welcome_sent_at timestamp.
    // Failure is non-fatal -- preference save still succeeds.
    const anySmsEnabled = Object.values(preferences).some(
      (channels) => channels && channels.sms === true
    );
    const shouldSendWelcome = (
      anySmsEnabled &&
      !user.sms_welcome_sent_at &&
      user.sms_enabled &&
      user.phone &&
      user.phone_verified
    );
    if (shouldSendWelcome) {
      try {
        const result = await smsService.send({
          to: user.phone,
          type: 'sms_welcome',
          data: {},
        });
        if (result.success) {
          await user.update({ sms_welcome_sent_at: new Date() });
        } else {
          console.warn(`[users] Welcome SMS not sent for ${userId}: ${result.error}`);
        }
      } catch (error) {
        console.error(`[users] Welcome SMS error for ${userId}:`, error.message);
      }
    }

    res.json(toSelfWire(user)); // PR-C: user_id aliased to the UUID
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user's timezone
router.patch('/:user_id/timezone', writeOperationLimiter, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' timezone' });
    }

    const { timezone } = req.body;

    if (!timezone || typeof timezone !== 'string' || timezone.trim().length === 0) {
      return res.status(400).json({ error: 'timezone is required and must be a non-empty string' });
    }

    // Validate IANA timezone string
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return res.status(400).json({ error: 'Invalid IANA timezone string' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ timezone });
    res.json({ timezone: user.timezone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save phone number and initiate Twilio Verify verification
router.post('/:user_id/phone', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' phone numbers' });
    }

    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Validate using libphonenumber-js
    const { validatePhone } = require('../utils/phoneValidation');
    const result = validatePhone(phone);
    if (!result.valid) {
      return res.status(400).json({ error: result.error });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Save phone and reset verification status
    await user.update({ phone: result.e164, phone_verified: false });

    // Initiate Twilio Verify
    const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!verifySid) {
      return res.status(500).json({ error: 'Phone verification service is not configured. TWILIO_VERIFY_SERVICE_SID is missing.' });
    }

    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.verify.v2.services(verifySid).verifications.create({
      to: result.e164,
      channel: 'sms',
    });

    res.json({ status: 'verification_sent' });
  } catch (error) {
    console.error('[users] Phone verification initiation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Verify phone with SMS code from Twilio Verify
router.post('/:user_id/phone/verify', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot verify other users\' phone numbers' });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be a string of exactly 6 digits' });
    }

    // BSEC-01 (D-03): withContactInfo — reads user.phone for Twilio verify.
    const user = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.phone) {
      return res.status(400).json({ error: 'No phone number on file to verify' });
    }

    const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!verifySid) {
      return res.status(500).json({ error: 'Phone verification service is not configured. TWILIO_VERIFY_SERVICE_SID is missing.' });
    }

    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const check = await client.verify.v2.services(verifySid).verificationChecks.create({
      to: user.phone,
      code,
    });

    if (check.status === 'approved') {
      await user.update({ phone_verified: true });
      return res.json({ verified: true });
    }

    res.json({ verified: false, error: 'Invalid or expired code' });
  } catch (error) {
    console.error('[users] Phone verification check failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Remove phone number (D-PHONE-02 cascade): clear phone, phone_verified, and
// all 4 notification_preferences[type].sms toggles in ONE atomic Sequelize
// transaction. If any field write fails, the user record is rolled back to
// its prior state — never half-cleared. Returns the updated user so the
// frontend can refresh local state without a second fetch.
//
// NOTE: sms_enabled is intentionally NOT touched here. It's an admin-controlled
// entitlement flag — only the admin flips it via direct DB access. Phone
// removal does not revoke entitlement; the user can re-add a phone later and
// pick up where they left off without admin intervention.
router.delete('/:user_id/phone', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' phone numbers' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build cleared notification_preferences. Mirrors DEFAULT_PREFERENCES
    // shape from periodictabletop/src/app/userProfile/page.js (lines 29-34):
    // 4 keys (event_created, reminder, event_updated, event_cancelled), each
    // with email + sms (and reminder.window_hours). Preserve existing email
    // values + reminder.window_hours; only flip every sms key to false.
    const existingPrefs = user.notification_preferences || {};
    const PREF_KEYS = ['event_created', 'reminder', 'event_updated', 'event_cancelled'];
    const clearedPrefs = {};
    for (const key of PREF_KEYS) {
      const existing = existingPrefs[key] || {};
      const cleared = {
        email: existing.email !== undefined ? existing.email : true,
        sms: false,
      };
      if (key === 'reminder') {
        cleared.window_hours = existing.window_hours !== undefined ? existing.window_hours : 1;
      }
      clearedPrefs[key] = cleared;
    }

    // Atomic cascade. Wrap a single user.update() in sequelize.transaction so
    // future expansion (e.g. clearing sms_welcome_sent_at) stays atomic by
    // construction. Rollback on any failure prevents half-cleared state.
    await sequelize.transaction(async (t) => {
      await user.update(
        {
          phone: null,
          phone_verified: false,
          notification_preferences: clearedPrefs,
        },
        { transaction: t }
      );
    });

    // Re-read to return the post-cascade state to the client.
    await user.reload();
    res.json(toSelfWire(user)); // PR-C: user_id aliased to the UUID
  } catch (error) {
    console.error('[users] Phone removal cascade failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;