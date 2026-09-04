// routes/users.js
const express = require('express');
const { User, Group, UserGroup, PendingAuth0Deletion, sequelize } = require('../models');
const router = express.Router();
// (validateUserSearch import removed — its only consumer, GET /search/email/:email,
// was deleted in Phase 87.6 users-search-email.)
const { writeOperationLimiter } = require('../middleware/rateLimiter');
const { requireParamMatchesToken, matchesSelf } = require('../middleware/objectAuth');
// Phase 87.4 Plan 02 (KEYMISS mitigation): resolve a UUID self-param to the
// sub-keyed Users row.
const { isUuid } = require('../utils/resolveTargetUser');
// Phase 88.8 plan 04 (D-13): the JIT provisioning + repair policy moved to this service.
// The `clampProvisionedUsername` and `auth0Service` imports that used to sit here went
// with it — this file no longer derives a username or calls the Auth0 Management API at
// any point. Verified dead before removal (grep, 2026-09-04), not removed on assumption.
const provisioningService = require('../services/provisioningService');
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

// GET /search/email/:email — DELETED (Phase 87.6 users-search-email, Tier 1).
// Superseded by friendshipsAPI.searchUserByEmail → GET /friendships/search
// (BE-12), the sole live email-search path (callers: friends/page.js,
// FriendInvitePanel.js — both use friendshipsAPI, not the deleted usersAPI twin).
// The WR-01 cross-user PII regression this route carried is now enforced on the
// surviving /friendships/search test (friendships.test.js BE-12, strengthened to
// an exact-projection + PII-victim assertion in the same commit that retired the
// WR-01 block here). Zero FE callers of usersAPI.searchUserByEmail (re-confirmed
// 2026-07-24, object-qualified grep).

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
    // M-4 (87.4-review): this self-read genuinely needs the withContactInfo scope +
    // Group include, which matchesSelf's memoized default-scope row does NOT carry, so
    // it re-fetches. But it reuses req.selfUuid (the caller's own UUID matchesSelf
    // already resolved) as the PK so the re-fetch is a keyed findByPk — no second
    // sub-column lookup, and an uppercase UUID param resolves via the stored-lowercase
    // memo (L-3). The sub shape (no memo) resolves by the sub column.
    const selfPk = req.selfUuid || (isUuid(req.params.user_id) ? req.params.user_id : null);
    let user = selfPk
      ? await User.scope('withContactInfo').findByPk(selfPk, {
          include: [{ model: Group }],
        })
      : await User.scope('withContactInfo').findOne({
          where: { user_id: req.params.user_id },
          include: [{ model: Group }],
        });
    
    // SECURITY (unchanged, and the reason auto-creation is safe at all): the
    // verifyAuth0Token middleware proves the caller exists in Auth0, because a valid
    // access token can only be issued by Auth0; requireParamMatchesToken above proves the
    // target is the caller themselves. Both hold before the delegate below runs.
    // -----------------------------------------------------------------------
    // Phase 88.8 plan 04 (D-13; SPEC R2, R3, R4 and the storage half of R11).
    //
    // The ENTIRE just-in-time provisioning and repair policy that used to live inline
    // here — the claims-first three-way rule, the Auth0 Management fallback, the
    // username chain with its Phase 88-34 clamp DECISION block, the synthetic-address
    // mint, the verified-email posture, the picture_url cadence, and BOTH of the two
    // Management repair sites this handler used to carry — now lives in
    // services/provisioningService.js. This handler is a thin delegate, the shape the
    // shipped DELETE /me at :93-130 established. Every DECISION marker that explained
    // the old code MOVED WITH IT. Do not re-inline any of it here.
    //
    // KEY ON THE TOKEN SUB (req.user.user_id), NEVER req.params.user_id.
    // This route is gated by requireParamMatchesToken('user_id'), whose UUID arm
    // (middleware/objectAuth.js:59-84) accepts the caller's OWN Users.id UUID as well as
    // their Auth0 sub, and the self-read above resolves that shape deliberately (Phase
    // 87.4 M-4, the KEYMISS path). The service keys findOrCreate on Users.user_id, which
    // holds SUBS — handing it a UUID would miss, mint a brand-new UUID-keyed row, and
    // return that row to the caller as their own profile: exactly the class-2 hygiene row
    // plan 05's report exists to find. The gate has ALREADY proved the param is the
    // caller's identity in one keyspace or the other, so the token sub is the only value
    // that can correctly key Users.user_id. The analogue site records the same intent in
    // shipped code — routes/events.js:193-195. (The two `req.user.user_id ===
    // req.params.user_id` guards that used to wrap the create and repair branches were
    // what kept a UUID param out of them; they are gone with the branches, and this rule
    // is what replaces them.)
    // -----------------------------------------------------------------------
    if (req.user && req.user.user_id) {
      if (!user) {
        // SPEC Req 6 (tombstone guard): a still-valid access token whose Auth0 identity
        // was deleted must NOT JIT re-create the Users row (Auth0 deletion does not
        // revoke issued tokens for up to ~24h). Refuse with the pinned 410
        // account_deleted envelope — the SAME shape as repeat DELETE — and create
        // nothing. Runs BEFORE the service and only on the no-row path, exactly as
        // before, and keys on the SUB because PendingAuth0Deletion keys on auth0_sub: a
        // UUID here would make the whole check a silent no-op.
        if (await PendingAuth0Deletion.isTombstoned(req.user.user_id)) {
          return sendError(res, 'account_deleted');
        }
      }

      const provisioned = await provisioningService.provisionOrRepair({
        sub: req.user.user_id,
        claims: req.user,
        detectedTimezone,
      });

      if (provisioned.status === 'identity_gone') {
        // Phase 87.2 SPEC Req 6, preserved exactly: getUserById returned null (a hard
        // 404), so the Auth0 identity was DELETED from the dashboard. Nothing is
        // re-materialised. Only the CREATE path can produce this — on the repair path a
        // null Management result deliberately leaves a live user's row alone rather than
        // signing them out; see the DECISION marker in the service.
        return sendError(res, 'account_deleted');
      }

      if (!user) {
        // First provisioning: respond with the row the SERVICE returns, so a UUID-keyed
        // self-read and a sub-keyed one return the same row.
        user = provisioned.user;
      } else if (provisioned.changed) {
        // A repair landed. Re-read with the Group include so the response keeps the
        // association the initial self-read carried — the same reload the old repair
        // block performed after an update.
        // BSEC-01 (D-03): withContactInfo — own profile returned with email.
        user = await User.scope('withContactInfo').findOne({
          where: { user_id: req.user.user_id },
          include: [{ model: Group }],
        });
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

    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' tutorial status' });
    }

    // Reuse matchesSelf's UUID-arm memoized row when present; fall back to the
    // lookup on the sub arm (DB-free short-circuit leaves it unset). (ML-19)
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
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

    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot reset other users\' tutorial status' });
    }

    // Reuse matchesSelf's UUID-arm memoized row when present; fall back to the
    // lookup on the sub arm (DB-free short-circuit leaves it unset). (ML-19)
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ tutorial_version: 0 });
    res.json({ tutorial_version: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST / — DELETED (Phase 87.6 users-create, Tier 1). Superseded by the JIT
// auto-create branch in GET /:user_id (~L200, Phase 78 TZ-01 auto-create), which
// provisions the caller's row on first authenticated read. NOT superseded by the
// old FOLLOW-UP's POST /:user_id/refresh (itself deleted this phase, Tier 3 —
// evidence-rot correction from RESEARCH item 6). Zero FE callers of
// createOrUpdateUser (re-confirmed 2026-07-24).

// Update user's username
router.put('/:user_id/username', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Verify that the requested user_id matches the authenticated user
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' usernames' });
    }
    
    const { username } = req.body;
    
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({ error: 'Username is required and must be a non-empty string' });
    }
    
    if (username.length > 50) {
      return res.status(400).json({ error: 'Username must be 50 characters or less' });
    }
    
    // Reuse matchesSelf's UUID-arm memoized row when present; fall back to the
    // lookup on the sub arm (DB-free short-circuit leaves it unset). (ML-19)
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await user.update({ username: username.trim() });

    res.json(toSelfWire(user)); // PR-C: user_id aliased to the UUID
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /:user_id/refresh — DELETED (Phase 87.6 users-refresh, Tier 3, owner batch
// decision 2026-07-22). Redundant with the JIT auto-create branch in
// GET /:user_id (~L200), which reconciles email/username from Auth0 on read.
// Zero FE callers; no /users/:id/refresh path literal in periodictabletop/src
// (re-confirmed 2026-07-24).

// Update notification preferences
router.patch('/:user_id/notification-preferences', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!(await matchesSelf(req, req.params.user_id))) {
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

    if (!(await matchesSelf(req, req.params.user_id))) {
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

    // Reuse matchesSelf's UUID-arm memoized row when present; fall back to the
    // lookup on the sub arm (DB-free short-circuit leaves it unset). (ML-19)
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
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

    if (!(await matchesSelf(req, req.params.user_id))) {
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

    // Reuse matchesSelf's UUID-arm memoized row when present; fall back to the
    // lookup on the sub arm (DB-free short-circuit leaves it unset). (ML-19)
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
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

    if (!(await matchesSelf(req, req.params.user_id))) {
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

    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' phone numbers' });
    }

    // Reuse matchesSelf's UUID-arm memoized row when present; fall back to the
    // lookup on the sub arm (DB-free short-circuit leaves it unset). (ML-19)
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
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