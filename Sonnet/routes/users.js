// routes/users.js
const crypto = require('crypto');
const express = require('express');
const { Op, QueryTypes, Transaction } = require('sequelize');
const {
  User,
  Group,
  UserGroup,
  PendingAuth0Deletion,
  // Phase 88.8 plan 09: the email-change routes write three tables. GroupInvite
  // (D-41) and Feedback (D-42) are moved in the SAME transaction as the identity
  // overwrite, and SingleUseToken holds the pending address and the code hash.
  GroupInvite,
  Feedback,
  SingleUseToken,
  sequelize,
} = require('../models');
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
// Phase 88.8 plan 09: the SPEC A9 code mail and the SPEC A13 notice both live in
// plan 10's primitives (sendEmailChangeCode / the email-notice queue). This file
// calls them; it renders no mail copy of its own.
const emailService = require('../services/emailService');
// Phase 88.8 plan 04's PII scrubber — every email-change telemetry payload carries
// the DOMAIN only, never the local part.
const { emailDomain } = require('../utils/provisioningReport');
const { sendError } = require('../utils/errors');

// Phase 88.8 plan 07 (SPEC R7, D-19 backend half): the two "no Users row" statuses the
// deletion service can hand back, mapped to their wire codes. Both deletion endpoints
// read THIS map, so the pre-flight and the DELETE can never put different codes on the
// wire for the same underlying state.
//   not_found       -> 410 account_deleted   (a tombstone exists: the account WAS deleted)
//   not_provisioned -> 404 not_provisioned   (no row, no tombstone: it never existed)
const MISSING_ROW_ENVELOPE = Object.freeze({
  not_found: 'account_deleted',
  not_provisioned: 'not_provisioned',
});

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
    //
    // Phase 88.8 plan 07 (R7): that reasoning is unchanged — a null row still never
    // reaches getDeletionBlockers. What changed is only the CODE emitted: the service's
    // shared classifier decides between the 410 (tombstone present) and the new 404
    // (never provisioned), so this endpoint and DELETE /users/me answer identically.
    const user = await User.findOne({ where: { user_id: sub } });
    if (!user) {
      const status = await accountDeletionService.classifyMissingRow(sub);
      return sendError(res, MISSING_ROW_ENVELOPE[status] || 'account_deleted');
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
    if (result.status === 'not_found' || result.status === 'not_provisioned') {
      // not_found: repeat DELETE inside the retention window → HTTP 410 with code
      // account_deleted on the envelope. Never a bare 401 (a still-valid token must
      // not be bounced by a generic auth guard) and never a raw non-envelope 410
      // (the FE maps a raw 410 to 'unknown' and default-retries it).
      //
      // not_provisioned (Phase 88.8 plan 07, R7): the caller's token is valid but no row
      // was ever created and no tombstone exists → HTTP 404 with the new code, which says
      // "you have no stored data" rather than falsely claiming a deletion happened. The
      // service, not this handler, decides which of the two applies — see
      // classifyMissingRow and its tombstone-FIRST ordering note.
      return sendError(res, MISSING_ROW_ENVELOPE[result.status]);
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

// ============================================================================
// EMAIL-CHANGE ROUTES (Phase 88.8 plan 09) — SPEC R12 as amended by A9, A11, A12
// and A13; CONTEXT D-06, D-07, D-08, D-09, D-10, D-35..D-43.
//
// Five self-only, authenticated, write-limited routes:
//   POST /:user_id/email         request a change (takes an address)
//   POST /:user_id/email/verify  prove control  (takes a code)
//   POST /:user_id/email/resend  re-send for the STORED pending address (no body)
//   POST /:user_id/email/cancel  discard the pending change              (no body)
//   POST /:user_id/email/revert  restore the Auth0 claim                 (no body)
//
// ORDERING NOTE, said out loud because this file already carries a
// must-register-above rule for the deletion routes: every path here carries at
// least TWO segments, so `router.get('/:user_id')` above cannot shadow any of
// them — and that route is a GET while these are all POST. They are registered
// last purely for readability.
//
// PUBLIC LISTS ARE UNTOUCHED. None of these five appears in either server.js
// public list and none carries magicTokenLimiter — all three belonged to the
// RETIRED public-link design (D-09 as amended: a typed code, no link, no public
// route). A link in the mail could be fetched and auto-submitted by a corporate
// link scanner, which would let an attacker's verification complete inside a
// stranger's mail infrastructure.
//
// LOAD RULE, IDENTICAL IN ALL FIVE HANDLERS. Self-gate with `matchesSelf`, then
// ALWAYS load the caller with `User.scope('withContactInfo')` keyed on
// `req.user.user_id` — NEVER `req.selfUser`. matchesSelf's UUID arm memoizes a
// DEFAULT-scope row (middleware/objectAuth.js:73-74 is a bare `User.findOne`, so
// the model's defaultScope exclusion applies), which carries NO `email` and, after
// plan 02, no `email_changed_at`. The profile page sends the UUID shape, so a memo
// reuse would run every address compare against `undefined` in production while
// every sub-shaped test stayed green — the 88-34 Rule-1 defect class.
//
// LOCK ORDER — the caller's `Users` row is taken with SELECT ... FOR UPDATE as the
// FIRST statement inside EVERY one of the five transactions. Each handler touches
// two tables (`Users` and `single_use_tokens`); if any one took them in the other
// order, two handlers racing on the same account could take a Postgres 40P01
// deadlock, which reaches the user as a 500 on a routine double-tap — and this
// plan's own concurrency tests drive exactly that interleave. Do NOT "solve" a
// deadlock here with a retry-on-40P01 wrapper: that hides a lock-order bug behind
// a retry loop. An EARLIER lock on a DIFFERENT table is compatible with
// models/SingleUseToken.js:187-189 ("Do NOT convert this to findOne-then-update",
// T-88.2-07); restructuring the consume itself is not. Inverting this order is a
// decision, not a cleanup.
// ============================================================================

const EMAIL_CHANGE_PURPOSE = 'email_change_verify';
// D-08 as AMENDED: 30 minutes, not 24 hours. The original figure was sized for a
// LINK that might be opened later on another device; a code typed in the session
// that requested it needs no such window.
const EMAIL_CHANGE_CODE_TTL_MS = 30 * 60 * 1000;
// D-10: at most three verification mails per user per hour.
const EMAIL_CHANGE_HOURLY_CAP = 3;
const EMAIL_CHANGE_WINDOW_MS = 60 * 60 * 1000;
// Users.email is a plain STRING, i.e. varchar(255) on both the migration-built and
// the sync-built database.
const EMAIL_MAX_LENGTH = 255;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

// Crockford base32: 0-9 and A-Z without I, L, O and U — the four that are misread
// as 1, 1, 0 and V when a person copies a code off a screen. 32 symbols.
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const EMAIL_CHANGE_CODE_LENGTH = 8;

/**
 * Mint one code. 8 symbols over a 32-symbol alphabet is about 1.1 x 10^12.
 *
 * THE ARITHMETIC, written down because it is WHY there is no attempt counter.
 * The only party who can submit a guess at all is the signed-in account holder,
 * guessing a code for an address they do not control. At the PRODUCTION write
 * limiter's ceiling (10,000 requests / 15 minutes per IP,
 * middleware/rateLimiter.js:43, :78) that is roughly 3 x 10^4 guesses inside the
 * 30-minute lifetime against 10^12 — about 3 in 10^8 per lifetime — and it is
 * capped again at three mints per user per hour. A 6-digit numeric code (10^6)
 * was the rejected alternative: it needs an attempt counter to be safe, which is
 * why the phone flow leans on Twilio's. This one does not.
 */
function generateEmailChangeCode() {
  let out = '';
  for (let i = 0; i < EMAIL_CHANGE_CODE_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[crypto.randomInt(CROCKFORD_ALPHABET.length)];
  }
  return out;
}

/** The mail shows XXXX-XXXX; the dash is display only and is stripped on entry. */
function formatEmailChangeCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Entry normalisation: uppercase, dashes and whitespace ignored. */
function normaliseEmailChangeCode(value) {
  return typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '';
}

/**
 * The code is stored ONLY as its sha256 hash, so a database read exposure yields
 * no live code. consumeByNonce's single atomic UPDATE is untouched — the route
 * hashes first, then looks the hash up.
 */
function hashEmailChangeCode(normalisedCode) {
  return crypto.createHash('sha256').update(normalisedCode).digest('hex');
}

/**
 * ONE telemetry seam for this feature. Every payload carries the sub and the email
 * DOMAIN only (plan 04's `emailDomain`) — never the local part, in Sentry or in
 * the log line. Uses the same defensive try-require Sentry binding as the rest of
 * this file.
 */
function emailChangeTelemetry(op, { sub, address, error = null, message = null, extra = {} } = {}) {
  const payload = { sub, emailDomain: emailDomain(address), ...extra };
  try {
    console.warn(`[users] email-change ${op}:`, JSON.stringify(payload));
  } catch (_e) {
    // Telemetry must never be the thing that throws.
  }
  if (!Sentry) return;
  const context = { tags: { feature: 'email-change', op }, extra: payload };
  if (error && typeof Sentry.captureException === 'function') {
    Sentry.captureException(error, context);
  } else if (typeof Sentry.captureMessage === 'function') {
    Sentry.captureMessage(message || `email-change: ${op}`, { level: 'warning', ...context });
  }
}

/** The load rule, in one place. */
async function loadSelfWithContactInfo(sub, options = {}) {
  return User.scope('withContactInfo').findOne({ where: { user_id: sub }, ...options });
}

/** The lock-order invariant, in one place: the caller's own row, FOR UPDATE. */
async function lockSelfRow(sub, t) {
  return User.scope('withContactInfo').findOne({
    where: { user_id: sub },
    transaction: t,
    lock: Transaction.LOCK.UPDATE,
  });
}

/**
 * The LIVE pending change: active AND unexpired. Rides the leading `purpose,
 * user_id` prefix of single_use_tokens_purpose_user_event_status
 * (models/SingleUseToken.js:142-143), so no index is added.
 *
 * DELIBERATELY NO `send_failed_at IS NULL` CLAUSE, even though the hourly count
 * below has one. The two predicates answer different questions: the count asks
 * "did a mail leave?", this asks "is there a live pending change?". A row whose
 * mail the provider refused is still a live pending change — keeping it
 * hydratable IS the owner's 2026-09-04 ruling, and filtering it out here would
 * restore the dead end from the other direction (a reload would drop the section
 * to idle while Resend still found the row). The column is right there and the
 * filter looks like an omission; it is not.
 */
async function loadPendingEmailChange(sub, options = {}) {
  return SingleUseToken.findOne({
    where: {
      purpose: EMAIL_CHANGE_PURPOSE,
      user_id: sub,
      status: 'active',
      expires_at: { [Op.gt]: new Date() },
    },
    order: [['createdAt', 'DESC']],
    ...options,
  });
}

function projectPendingEmailChange(row) {
  return row ? { address: row.target, expires_at: row.expires_at } : null;
}

/**
 * THE ONE PINNED WIRE BODY, shared by all five routes. Plan 13 keys its entire
 * section state machine on it, so neither repo may change it alone and neither
 * repo's CI can see the other.
 *
 * `email_changed_at` is in here for a MECHANICAL reason, not for completeness.
 * Plan 13 renders the D-38 revert affordance from `self.email_changed_at` and the
 * section's only refresh path is `patchSelfCache`, a SHALLOW merge
 * (src/lib/hooks/selfIdentityCache.ts:39) over a self row pinned
 * staleTime: Infinity that "NEVER self-refreshes" (useSelfIdentity.ts:34, :102).
 * A key missing from THIS body keeps its pre-mutation value in the cache forever,
 * so dropping it would make the revert affordance unreachable in the UI. Removing
 * it is a decision, not a cleanup.
 */
function emailChangeBody(user, pendingRow, outcome, verificationSent) {
  return {
    outcome,
    email: user ? user.email : null,
    pending_email_change: projectPendingEmailChange(pendingRow),
    verification_sent: verificationSent === true,
    email_changed_at:
      user && user.email_changed_at ? new Date(user.email_changed_at).toISOString() : null,
  };
}

async function respondEmailChange(res, sub, outcome, verificationSent) {
  const fresh = await loadSelfWithContactInfo(sub);
  const pending = await loadPendingEmailChange(sub);
  return res.json(emailChangeBody(fresh, pending, outcome, verificationSent));
}

/**
 * D-10's hourly count. Runs INSIDE the caller's transaction, AFTER the row lock.
 *
 * DECISION Phase 88.8 D-10 (review round 3, carried forward): counted INSIDE the
 * locked transaction, chosen OVER counting it before the transaction opens.
 * Counted outside, the count runs on its own connection with no lock held: under
 * READ COMMITTED — the default here, since config/database.js sets no isolation
 * level — K concurrent requests all read the same pre-burst count, all pass, all
 * then serialise on the row lock, and all mint and send. The row lock serialises
 * the writes but cannot un-send the mails, so a burst mails a stranger K times
 * instead of three. writeOperationLimiter is no backstop at 10,000 requests /
 * 15 minutes per IP. This is the SOLE control behind T-88.8-42, and the
 * sequential fourth-request test PASSES while the control is bypassed — the
 * concurrency test is the one that proves it. Moving this count back outside the
 * transaction is a decision, not a cleanup.
 *
 * THE PREDICATE'S POLARITY IS THE OTHER HALF, and only one polarity is safe:
 * "count by default, exclude on PROVEN failure" — never "count only proven
 * successes". The send happens AFTER the commit, outside the lock, so a count
 * keyed on a success marker would read zero for every member of a concurrent
 * burst, all of which would then mint and send. Count-by-default keeps the
 * T-88.8-42 proof intact: every fresh row counts the instant it commits. The
 * `send_failed_at` exclusion is a strictly-later compensating write on a row that
 * has ALREADY been counted, so it can never open the burst window. Inverting this
 * is a decision, not a cleanup.
 */
async function countRecentEmailChangeMints(sub, t) {
  return SingleUseToken.count({
    where: {
      purpose: EMAIL_CHANGE_PURPOSE,
      user_id: sub,
      createdAt: { [Op.gt]: new Date(Date.now() - EMAIL_CHANGE_WINDOW_MS) },
      send_failed_at: null,
    },
    transaction: t,
  });
}

/** The revoke half of revoke-then-mint (the routes/rsvp.js:147-158 idiom, minus its event scoping). */
async function revokeActiveEmailChangeTokens(sub, t) {
  return SingleUseToken.update(
    { status: 'revoked' },
    {
      where: { purpose: EMAIL_CHANGE_PURPOSE, user_id: sub, status: 'active' },
      transaction: t,
    }
  );
}

/**
 * The mint half. A nonce collision at 10^12 is a unique violation, so retry once.
 *
 * The retry runs inside a SAVEPOINT (a nested Sequelize transaction) and not
 * directly on `t`: in Postgres a unique violation ABORTS the enclosing
 * transaction, so a bare retry would itself fail with "current transaction is
 * aborted". Without the savepoint the retry is decorative.
 */
async function mintEmailChangeToken(sub, target, t) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const code = generateEmailChangeCode();
    try {
      const row = await sequelize.transaction({ transaction: t }, async (sp) =>
        SingleUseToken.create(
          {
            nonce: hashEmailChangeCode(code),
            user_id: sub,
            purpose: EMAIL_CHANGE_PURPOSE,
            target,
            status: 'active',
            expires_at: new Date(Date.now() + EMAIL_CHANGE_CODE_TTL_MS),
          },
          { transaction: sp }
        )
      );
      return { row, code };
    } catch (err) {
      lastError = err;
      if (err && err.name === 'SequelizeUniqueConstraintError') continue;
      throw err;
    }
  }
  throw lastError;
}

/**
 * Send the CODE mail, synchronously, AFTER the commit, to the NEW address only.
 * Returns the value `verification_sent` carries — the provider's own result
 * (services/emailService.js:45-47 returns `{ success: false }` rather than
 * throwing when unconfigured), NEVER a literal `true` written after the commit.
 *
 * DECISION Phase 88.8 (owner ruling 2026-09-04, review round 4): the token
 * SURVIVES a provider refusal, chosen OVER destroying it. This marker sits at the
 * failure arm because it REVERSES an earlier version of this plan — a reader who
 * finds the destroy in the history must be able to see why it went.
 *
 * Destroying the row created a state with no exit while the response and the UI
 * both claimed otherwise. All four follow mechanically from the destroy: resend
 * reads the address to re-send from the ACTIVE TOKEN ROW, so with no row it
 * answers the validation envelope forever; verify has no `nonce` to match; the
 * self read computes `pending_email_change: null`, so a reload drops the section
 * to idle; and yet the response still said `outcome: 'code_sent'`, which plan 13
 * renders as awaiting-code with Resend promoted. Three controls, two that cannot
 * work and one that reports an error that is not the truth.
 *
 * The intent behind the destroy — NOT charging a user for a mail that never left
 * — is preserved separately and explicitly by `send_failed_at`, whose column
 * comment in models/SingleUseToken.js names the same four rejected alternatives:
 *   (a) let the refused attempt consume the budget — a provider outage would spend
 *       a user's whole hourly allowance on mails that never left, and the shipped
 *       remedy for a refusal is Resend, which mints again;
 *   (b) revoke instead of destroy — a revoked row still counts under a
 *       created-rows predicate, and it kills hydration too;
 *   (c) back-date `createdAt` so the row falls out of the window — a falsified
 *       timestamp is the fragile-shortcut class this project bans;
 *   (d) send the mail INSIDE the transaction and roll back on refusal — that holds
 *       a `Users` row lock across a network call to the mail provider while four
 *       other handlers queue behind it, and it deletes the pending change the
 *       owner ruled must survive.
 * Re-adding the destroy is a decision, not a cleanup.
 *
 * LOCAL AND CI CONSEQUENCE, stated so nobody reads it as a bug: emailService
 * no-ops without RESEND_API_KEY and returns `{ success: false }`, so in any
 * environment without a mail key EVERY send is a refusal, `send_failed_at` is
 * always stamped, and the hourly cap therefore never trips unless the test mocks
 * a SUCCESSFUL send.
 */
async function sendEmailChangeCodeMail({ sub, address, code, tokenId }) {
  let result = null;
  try {
    result = await emailService.sendEmailChangeCode(address, formatEmailChangeCode(code));
  } catch (err) {
    result = { success: false, error: err && err.message };
  }
  if (result && result.success === true) return true;

  try {
    // ONE narrow UPDATE. `status` is untouched, so the row stays consumable by
    // consumeByNonce and still hydrates `pending_email_change`.
    await SingleUseToken.update({ send_failed_at: new Date() }, { where: { id: tokenId } });
  } catch (stampFailed) {
    emailChangeTelemetry('code-mail-stamp', { sub, address, error: stampFailed });
  }
  // A console.warn-only failure here would be the exact warn-only class SPEC R4
  // eliminates one file over.
  emailChangeTelemetry('code-mail', {
    sub,
    address,
    error: new Error(
      `Email-change code mail refused by the provider: ${(result && result.error) || 'unknown'}`
    ),
  });
  return false;
}

/** The shared self-gate preamble. Returns the sub, or null once it has answered. */
async function emailChangeSelfGate(req, res) {
  const sub = req.user && req.user.user_id;
  if (!sub) {
    sendError(res, 'unauthorized');
    return null;
  }
  if (!(await matchesSelf(req, req.params.user_id))) {
    sendError(res, 'forbidden');
    return null;
  }
  return sub;
}

/**
 * The 429 body. `middleware/rateLimiter.js:10` builds it as
 * `formatEnvelope('rate_limited', undefined, message).body`; `sendError` is the
 * same call plus the status, so the wire body is byte-identical without exporting
 * a second helper from the limiter module.
 */
function sendEmailChangeRateLimited(res) {
  return sendError(
    res,
    'rate_limited',
    undefined,
    'Too many verification emails for this account. Please try again in an hour.'
  );
}

// ---------------------------------------------------------------------------
// POST /:user_id/email — request a change
// ---------------------------------------------------------------------------
//
// DECISION Phase 88.8 D-10: a PER-ROUTE write limiter on all five, chosen OVER
// matching the three neighbouring phone routes, which carry none. These endpoints
// send mail to an arbitrary caller-supplied address and the phone routes cannot.
// The shape follows the shipped self-delete at DELETE /me, not the phone block.
// Without this note someone will harmonize the limiter away.
router.post('/:user_id/email', writeOperationLimiter, async (req, res) => {
  try {
    const sub = await emailChangeSelfGate(req, res);
    if (!sub) return undefined;

    // The `email` request key is PINNED and asserted on both sides. It is the
    // shared referent after SPEC A12 (`Users.email` here, `self.email` in the
    // frontend UserSchema) and it matches the shipped phone analogue, which sends
    // `{ phone }`. A body carrying any OTHER key is refused, because a positive
    // test alone does not pin a key — it passes under whatever key the route
    // happens to read.
    const body = req.body || {};
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'email' || typeof body.email !== 'string') {
      return sendError(res, 'validation');
    }
    const normalised = provisioningService.normaliseEmail(body.email);
    if (!normalised || normalised.length > EMAIL_MAX_LENGTH || !EMAIL_FORMAT.test(normalised)) {
      return sendError(res, 'validation');
    }

    const state = { outcome: null, minted: null, code: null, rateLimited: false, missing: false };
    await sequelize.transaction(async (t) => {
      const locked = await lockSelfRow(sub, t);
      if (!locked) {
        state.missing = true;
        return;
      }

      if (provisioningService.normaliseEmail(locked.email) === normalised) {
        // There is NO clear-the-column branch any more, and that is worth a
        // sentence: the previous design cleared a SECOND address column here,
        // which is precisely what made a resend-by-re-POST unsafe and forced SPEC
        // A11's separate route. Nothing is cleared now, so that hazard is gone —
        // but the dedicated resend route STAYS, because A11 is a locked amendment
        // and because a resend that accepted an address would be a second request
        // endpoint wearing the first one's name.
        state.outcome = 'unchanged';
        return;
      }

      const recent = await countRecentEmailChangeMints(sub, t);
      if (recent >= EMAIL_CHANGE_HOURLY_CAP) {
        state.rateLimited = true;
        return;
      }

      await revokeActiveEmailChangeTokens(sub, t);
      const minted = await mintEmailChangeToken(sub, normalised, t);
      state.minted = minted.row;
      state.code = minted.code;
      state.outcome = 'code_sent';
    });

    // `Users.email` IS NOT WRITTEN HERE. AT ALL (D-35). `email` is an identity key
    // and `phone` is not, so the phone flow's store-then-verify shape at
    // routes/users.js POST /:user_id/phone is exactly wrong here: an unverified
    // address sitting in the identity column is matched by all FOUR
    // `invited_email` authorization sites (routes/invites.js:512-518 — the
    // GET /pending visibility list — plus the accept gates at :593, :664 and :757)
    // and returned by friend search (routes/friendships.js:146), which would let
    // anyone type a stranger's address, never verify it, and be matched to that
    // stranger's invites.
    if (state.missing) return sendError(res, 'not_found');
    if (state.rateLimited) return sendEmailChangeRateLimited(res);

    let verificationSent = false;
    if (state.outcome === 'code_sent') {
      verificationSent = await sendEmailChangeCodeMail({
        sub,
        address: normalised,
        code: state.code,
        tokenId: state.minted.id,
      });
    }
    return respondEmailChange(res, sub, state.outcome, verificationSent);
  } catch (error) {
    console.error('[users] email-change request failed:', error.message);
    return sendError(res, 'internal');
  }
});

// ---------------------------------------------------------------------------
// POST /:user_id/email/resend — re-send for the STORED pending address
// ---------------------------------------------------------------------------
/**
 * DECISION Phase 88.8 DR-F: a DEDICATED route, chosen OVER re-POSTing the request
 * endpoint with the stored address. A separate route cannot take an address BY
 * CONSTRUCTION, which is a stronger guarantee than remembering a guard inside an
 * already multi-branch handler; and reusing the request endpoint would put
 * resend-intent and change-intent behind one conditional, i.e. a second endpoint
 * wearing the first one's name. Merging this back into the request route is a
 * decision, not a cleanup.
 *
 * (Written as a BLOCK comment on purpose. This plan's marker gate greps this file
 * with line comments STRIPPED FIRST, so the plan's own prose in a line comment
 * cannot satisfy it — and a line-comment marker would be stripped too and the gate
 * would read 0. Same reason applies to the D-38 marker on the revert route below.)
 */
router.post('/:user_id/email/resend', writeOperationLimiter, async (req, res) => {
  try {
    const sub = await emailChangeSelfGate(req, res);
    if (!sub) return undefined;

    const state = { missing: false, none: false, rateLimited: false, target: null, code: null, tokenId: null };
    await sequelize.transaction(async (t) => {
      const locked = await lockSelfRow(sub, t);
      if (!locked) {
        state.missing = true;
        return;
      }

      // THE ROW PREDICATE IS `status === 'active'` AND NOTHING ELSE. There is NO
      // `expires_at` clause, and its absence is the whole point of this route
      // (review round 5, cross-finding synthesis ruling). Verify returns
      // `outcome: 'expired'` in exactly ONE situation — the row is still
      // `status: 'active'` and its `expires_at` has passed — and plan 13 renders
      // that outcome by PROMOTING Resend as the remedy. Under an "active AND
      // unexpired" predicate the promoted control was guaranteed to fail: the one
      // row Resend would have to find is the one row the predicate excluded, so
      // the user pressed the control the UI had just recommended and got the
      // validation envelope. That is the same dead-end class the owner's
      // 2026-09-04 keep-the-token ruling closed on the provider-refused arm,
      // reopened one branch over. Adding an `expires_at` clause back is a
      // decision, not a cleanup.
      //
      // CANCEL SEMANTICS ARE PRESERVED BY THIS EXACT PHRASING. Cancel sets
      // `revoked`, and a revoked row is not active — so a change the user
      // deliberately discarded still cannot be resent, with no extra clause. Do
      // NOT rewrite this as "non-consumed, non-revoked": that phrasing is
      // ambiguous about the `used` state and invites a `status !== 'revoked'`
      // inversion that would resurrect a CONSUMED row. `status === 'active'`
      // already excludes both.
      const existing = await SingleUseToken.findOne({
        where: { purpose: EMAIL_CHANGE_PURPOSE, user_id: sub, status: 'active' },
        order: [['createdAt', 'DESC']],
        transaction: t,
      });
      if (!existing) {
        state.none = true;
        return;
      }

      const recent = await countRecentEmailChangeMints(sub, t);
      if (recent >= EMAIL_CHANGE_HOURLY_CAP) {
        state.rateLimited = true;
        return;
      }

      await revokeActiveEmailChangeTokens(sub, t);
      // The address comes from THAT ROW'S `target` — never from the request.
      const minted = await mintEmailChangeToken(sub, existing.target, t);
      state.target = existing.target;
      state.code = minted.code;
      state.tokenId = minted.row.id;
    });

    if (state.missing) return sendError(res, 'not_found');
    if (state.none) return sendError(res, 'validation');
    if (state.rateLimited) return sendEmailChangeRateLimited(res);

    const verificationSent = await sendEmailChangeCodeMail({
      sub,
      address: state.target,
      code: state.code,
      tokenId: state.tokenId,
    });
    return respondEmailChange(res, sub, 'code_sent', verificationSent);
  } catch (error) {
    console.error('[users] email-change resend failed:', error.message);
    return sendError(res, 'internal');
  }
});

// ---------------------------------------------------------------------------
// POST /:user_id/email/cancel — discard a pending change
// ---------------------------------------------------------------------------
//
// DECISION Phase 88.8 A11: a separate route, chosen OVER an "empty address" or
// "same address" branch on the request handler. A branch would put a DESTRUCTIVE
// intent behind an address-shaped body, which is the exact shape SPEC A11 already
// rejected for resend; a route that accepts no address cannot discard the wrong
// thing. It also gives the profile section and the phone Playwright census an
// honest way to return the fixture to its starting state, which a client-side-only
// "never mind" cannot do — an abandoned code stays active for its full 30 minutes
// and re-hydrates the pending state on the next mount.
//
// CANCEL AND THE BUDGET, stated exactly. Cancel MINTS nothing, so it adds nothing
// to the hourly count. It also REFUNDS nothing: the row it revokes was counted
// because its mail was ACTUALLY SENT, and revoking a token cannot un-send a mail.
// Do not add a `send_failed_at` stamp here — the only thing that ever takes a row
// out of the count is a PROVEN provider refusal, and a mail the user chose to
// abandon still reached the inbox it was addressed to, which is precisely the
// exposure T-88.8-42 caps.
router.post('/:user_id/email/cancel', writeOperationLimiter, async (req, res) => {
  try {
    const sub = await emailChangeSelfGate(req, res);
    if (!sub) return undefined;

    let missing = false;
    await sequelize.transaction(async (t) => {
      const locked = await lockSelfRow(sub, t);
      if (!locked) {
        missing = true;
        return;
      }
      // This route writes NOTHING to `Users`. It cannot touch the identity column
      // at all, which is the point.
      await revokeActiveEmailChangeTokens(sub, t);
    });

    if (missing) return sendError(res, 'not_found');
    // Idempotent: a cancel with nothing pending is a success, not an error.
    return respondEmailChange(res, sub, 'cancelled', false);
  } catch (error) {
    console.error('[users] email-change cancel failed:', error.message);
    return sendError(res, 'internal');
  }
});

module.exports = router;