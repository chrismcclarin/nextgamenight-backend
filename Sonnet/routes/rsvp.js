// routes/rsvp.js
// RSVP CRUD API endpoints for event responses (yes/no/maybe)
const express = require('express');
const crypto = require('crypto');
const { Op, UniqueConstraintError } = require('sequelize');
const { EventRsvp, EventBring, Event, User, Game, Group, EventParticipation, SingleUseToken } = require('../models');
const { validateRsvpCreate } = require('../middleware/validators');
const { verifyAuth0Token } = require('../middleware/auth0');
const { enqueueCleanupJobForAttendee } = require('../services/gcalCleanupService');
const router = express.Router();

// ============================================
// Phase 75 / GCAL-01: per-attendee GCal cleanup dispatch
// ============================================

/**
 * Dispatch a GCal cleanup job for the user-event pair IF this represents a
 * transition that leaves a ghost on the user's calendar.
 *
 * Triggering condition: any transition INTO 'no' from a non-'no' prior state
 * leaves a ghost to clean up, because GCal entries are created for every
 * connected attendee at event creation (not just on RSVP yes). So:
 *   - null -> no    (RSVP "no" without ever clicking yes)
 *   - maybe -> no
 *   - yes -> no
 *   - DELETE-of-any-non-no synthesizes newStatus='no' and flows through here
 * The no -> no path short-circuits as idempotent (nothing to clean up that
 * a prior no -> no transition didn't already handle).
 *
 * Only fires if the user has a stored google_calendar_event_id on their
 * EventParticipation row. Best-effort + non-blocking — caller's RSVP
 * write/delete is never affected.
 *
 * @param {Object} params
 * @param {string} params.eventId
 * @param {string} params.authUserId  Auth0 user_id string (from token or magic-link payload)
 * @param {string|null} params.oldStatus   'yes' | 'no' | 'maybe' | null
 * @param {string} params.newStatus   'yes' | 'no' | 'maybe'
 */
async function maybeDispatchGcalCleanup({ eventId, authUserId, oldStatus, newStatus }) {
  // Fire on any transition INTO 'no' from a non-'no' state. The no->no
  // path is idempotent and intentionally skipped.
  if (newStatus !== 'no' || oldStatus === 'no') return;
  try {
    // Translate Auth0 string user_id -> User.id (UUID) for EventParticipation lookup.
    // EventRsvp.user_id is the Auth0 sub; EventParticipation.user_id is the User UUID.
    const user = await User.findOne({
      where: { user_id: authUserId },
      attributes: ['id'],
    });
    if (!user) return;

    const participation = await EventParticipation.findOne({
      where: { event_id: eventId, user_id: user.id },
      attributes: ['id', 'google_calendar_event_id'],
    });
    if (!participation || !participation.google_calendar_event_id) {
      // No GCal entry to clean up — silent skip per CONTEXT D-FAILURE.
      return;
    }

    await enqueueCleanupJobForAttendee({
      eventId,
      eventParticipationId: participation.id,
      userId: user.id,
      googleCalendarEventId: participation.google_calendar_event_id,
    });
  } catch (err) {
    // Best-effort + non-blocking — never let a cleanup-dispatch issue
    // affect the caller. The service itself is already best-effort, but
    // wrap defensively in case findOne throws or the require failed.
    console.error('[rsvp:maybeDispatchGcalCleanup] dispatch failed (non-fatal):', err.message);
  }
}

// ============================================
// HMAC-based RSVP Token Utilities
// ============================================

/**
 * Generate an HMAC-SHA256 token for RSVP magic links.
 * Stateless: no DB storage needed. Verification re-computes the HMAC.
 * @param {string} eventId - Event UUID
 * @param {string} userId - Auth0 user ID string
 * @param {string} status - 'yes' | 'maybe' | 'no'
 * @returns {string} URL-safe base64 HMAC signature
 */
function generateRsvpToken(eventId, userId, status) {
  const payload = `${eventId}:${userId}:${status}`;
  return crypto
    .createHmac('sha256', process.env.MAGIC_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
}

/**
 * Build a full RSVP magic link URL.
 * @param {string} frontendUrl - Frontend base URL (e.g. https://nextgamenight.app)
 * @param {string} eventId - Event UUID
 * @param {string} userId - Auth0 user ID string
 * @param {string} status - 'yes' | 'maybe' | 'no'
 * @returns {string} Full URL for the RSVP landing page
 */
function generateRsvpUrl(frontendUrl, eventId, userId, status) {
  const token = generateRsvpToken(eventId, userId, status);
  return `${frontendUrl}/rsvp/${token}?e=${eventId}&u=${encodeURIComponent(userId)}&s=${status}`;
}

// RSVP single-use link lifetime. Reminder emails go out around an event; 30 days
// is generous and still bounds replayability (BE-071). DB-row exp (not signed
// into the HMAC payload) so in-flight links don't break by a signature change.
const RSVP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * D-04 / BSEC-03: mint the THREE single-use rows (yes/maybe/no) for one email,
 * sharing one email_batch_id so consuming any one revokes its siblings.
 *
 * Resend semantics: the RSVP HMAC is DETERMINISTIC over `${eventId}:${userId}:${status}`,
 * so the three link strings are byte-identical across emails for a given user/event.
 * The `nonce` column (= the HMAC token) is UNIQUE, so a resend cannot insert a second
 * row for the same status. Instead, resending REACTIVATES the three rows: it revokes
 * any prior active rsvp rows for this (user_id, event_id) — covering the case where a
 * status is no longer in this batch — then UPSERTS the three rows back to `active` with
 * a FRESH email_batch_id and a new expiry. Net effect: after a resend exactly one of the
 * three is consumable (single-use), any previously-consumed answer is re-enabled (the
 * point of resending), and only the newest batch_id is consumable so sibling revocation
 * still scopes to one email.
 *
 * The row `nonce` IS the HMAC token string (the signature layer stays; the row adds
 * exp + single-use), so /respond can consume directly by the recomputed HMAC.
 *
 * Best-effort + non-blocking at the call site: a mint failure must never block
 * event creation/update. Returns the email_batch_id (or null on failure).
 *
 * @param {string} eventId
 * @param {string} userId - Auth0 user_id string
 * @returns {Promise<string|null>} email_batch_id
 */
async function mintRsvpBatch(eventId, userId) {
  const emailBatchId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + RSVP_TOKEN_TTL_MS);

  // Resend-revoke: invalidate every prior active rsvp link for this user/event,
  // so any status NOT in the new batch (and any stale batch_id) stops being consumable.
  await SingleUseToken.update(
    { status: 'revoked' },
    {
      where: {
        purpose: 'rsvp',
        user_id: userId,
        event_id: eventId,
        status: 'active',
      },
    }
  );

  const statuses = ['yes', 'maybe', 'no'];
  // UPSERT on the unique `nonce` so a deterministic-HMAC resend reactivates the
  // SAME three rows (active again, fresh batch_id + expiry, used_at cleared)
  // rather than colliding on the unique constraint.
  await SingleUseToken.bulkCreate(
    statuses.map((status) => ({
      nonce: generateRsvpToken(eventId, userId, status),
      user_id: userId,
      purpose: 'rsvp',
      event_id: eventId,
      email_batch_id: emailBatchId,
      rsvp_status: status,
      status: 'active',
      expires_at: expiresAt,
      used_at: null,
    })),
    {
      updateOnDuplicate: [
        'email_batch_id',
        'rsvp_status',
        'status',
        'expires_at',
        'used_at',
        'updatedAt',
      ],
    }
  );

  return emailBatchId;
}

const { canReadEventScopedSurface } = require('../services/authorizationService');

// ============================================
// Public endpoint (no auth required)
// ============================================

// GET /respond -- Public RSVP via HMAC magic link token
router.get('/respond', async (req, res) => {
  try {
    const { token, e: eventId, u: userId, s: status } = req.query;

    // Validate required params
    if (!token || !eventId || !userId || !status) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Validate status value
    if (!['yes', 'maybe', 'no'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be yes, maybe, or no.' });
    }

    // Verify HMAC token by recomputing (the signature layer)
    const expectedToken = generateRsvpToken(eventId, userId, status);
    if (token !== expectedToken) {
      return res.status(403).json({ error: 'Invalid or expired link' });
    }

    // D-04 / BSEC-03: single-use gate. ATOMICALLY consume the matching active
    // SingleUseToken row (the row nonce IS this HMAC token). This MUST happen
    // AFTER the HMAC check but BEFORE any EventRsvp write, so a replayed/expired/
    // superseded link returns 403 WITHOUT mutating RSVP state. Zero rows ->
    //   - already used (replay)
    //   - expired (past expires_at)
    //   - revoked (a sibling answer in the same email was consumed, or a newer
    //     reminder superseded this batch)
    //   - BACKWARD-COMPAT: an HMAC-valid in-flight pre-deploy link that has NO
    //     paired row. Accepted one-time breakage (documented in SUMMARY): the
    //     user gets a friendly "link expired — open the event to RSVP" 403.
    const consumed = await SingleUseToken.consumeByNonce(token);
    if (
      !consumed ||
      consumed.purpose !== 'rsvp' ||
      consumed.event_id !== eventId ||
      consumed.user_id !== userId ||
      consumed.rsvp_status !== status
    ) {
      return res.status(403).json({
        error: 'expired_link',
        message: 'This RSVP link has expired or was already used. Open the event to RSVP.',
      });
    }

    // Consuming one answer revokes the OTHER answers from the same email
    // (one RSVP answer per email — the user can't later click a different answer).
    if (consumed.email_batch_id) {
      await SingleUseToken.update(
        { status: 'revoked' },
        {
          where: {
            email_batch_id: consumed.email_batch_id,
            status: 'active',
          },
        }
      );
    }

    // Look up the event
    const event = await Event.findByPk(eventId, {
      include: [
        { model: Game, attributes: ['name'] },
        { model: Group, attributes: ['id', 'name'] },
      ],
    });
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Check if event is cancelled
    if (event.status === 'cancelled') {
      return res.status(410).json({
        error: 'event_cancelled',
        group_id: event.Group?.id || event.group_id,
      });
    }

    // Check if event is in the past
    const eventDate = new Date(event.start_date);
    if (eventDate < new Date()) {
      return res.status(410).json({
        error: 'event_passed',
        event_name: event.Game?.name || 'Game Session',
        group_id: event.Group?.id || event.group_id,
      });
    }

    // Upsert RSVP: find existing or create
    const existing = await EventRsvp.findOne({
      where: { event_id: eventId, user_id: userId },
    });
    // Phase 75 / GCAL-01: capture old status BEFORE the update so we can
    // detect yes->no transitions (the only case that triggers GCal cleanup).
    const oldStatus = existing ? existing.status : null;

    if (existing) {
      await existing.update({ status });
    } else {
      await EventRsvp.create({
        event_id: eventId,
        user_id: userId,
        status,
      });
    }

    // Phase 75 / GCAL-01: yes -> no triggers GCal cleanup for this attendee.
    // Fire-and-forget; never blocks the RSVP response.
    maybeDispatchGcalCleanup({
      eventId,
      authUserId: userId,
      oldStatus,
      newStatus: status,
    }).catch((err) =>
      console.error('[rsvp:GET /respond] GCal cleanup dispatch error (non-fatal):', err.message)
    );

    // Format event date for display
    const formattedDate = eventDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    return res.status(200).json({
      success: true,
      status,
      event_name: event.Game?.name || 'Game Session',
      event_date: formattedDate,
      group_id: event.Group?.id || event.group_id,
      group_name: event.Group?.name || '',
    });
  } catch (error) {
    console.error('Error processing RSVP token response:', error.message);
    return res.status(500).json({ error: 'Something went wrong processing your RSVP.' });
  }
});

// ============================================
// Authenticated endpoints (require Auth0 token)
// ============================================

// POST / -- Create or update RSVP (upsert pattern)
router.post('/', verifyAuth0Token, validateRsvpCreate, async (req, res) => {
  try {
    const { event_id, status, note } = req.body;
    const userId = req.user.user_id;

    // Phase 71.1: gate widened from group-membership to event-scoped surface.
    // Game-only participants (EventParticipation row, no UserGroup row) can
    // RSVP on the specific event they joined.
    const { allowed } = await canReadEventScopedSurface(userId, event_id);
    if (!allowed) {
      return res.status(403).json({ error: 'You must be a participant on this event to RSVP' });
    }

    // Look up the event (must exist and not be cancelled). The helper above
    // also resolved the event but downstream code reads event.status, and the
    // helper's bare event lacks any includes — keep the dedicated findByPk so
    // future include additions stay co-located with their consumer.
    const event = await Event.findByPk(event_id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (event.status === 'cancelled') {
      return res.status(400).json({ error: 'Cannot RSVP to a cancelled event' });
    }

    // Upsert: find existing RSVP or create new
    const existing = await EventRsvp.findOne({
      where: { event_id, user_id: userId },
    });

    let rsvp;
    let isCreate = false;
    // Phase 75 / GCAL-01: capture old status BEFORE the update so we can
    // detect yes->no transitions (the only case that triggers GCal cleanup).
    const oldStatus = existing ? existing.status : null;

    if (existing) {
      // Update existing RSVP
      await existing.update({ status, note: note || null });
      rsvp = existing;
    } else {
      // Create new RSVP. Phase 87 / BINT-01 (T-87-06): a concurrent first-RSVP
      // for the same (event_id, user_id) can win the race between our findOne
      // above and this create, violating EventRsvp's unique index. Absorb the
      // UniqueConstraintError -> re-find + update, degrading a double-click to
      // success (200) instead of a 500. NOT Model.upsert: the handler needs the
      // create-vs-update distinction (isCreate) and oldStatus (captured above)
      // for the yes->no GCal-cleanup dispatch, both of which upsert would hide.
      try {
        rsvp = await EventRsvp.create({
          event_id,
          user_id: userId,
          status,
          note: note || null,
        });
        isCreate = true;
      } catch (createErr) {
        if (createErr instanceof UniqueConstraintError) {
          // Concurrent create won the race — treat as an update, not a create.
          const raceRow = await EventRsvp.findOne({
            where: { event_id, user_id: userId },
          });
          if (raceRow) {
            await raceRow.update({ status, note: note || null });
            rsvp = raceRow;
            isCreate = false;
          } else {
            throw createErr; // Unexpected state — re-throw
          }
        } else {
          throw createErr;
        }
      }
    }

    // Hard-delete bring commitments when RSVP changes to 'no' or 'maybe'
    if (status === 'no' || status === 'maybe') {
      await EventBring.destroy({ where: { event_id, user_id: userId } });
    }

    // Phase 75 / GCAL-01: yes -> no triggers GCal cleanup for this attendee.
    // Fire-and-forget; never blocks the RSVP response.
    maybeDispatchGcalCleanup({
      eventId: event_id,
      authUserId: userId,
      oldStatus,
      newStatus: status,
    }).catch((err) =>
      console.error('[rsvp:POST] GCal cleanup dispatch error (non-fatal):', err.message)
    );

    // Re-fetch with User include for response
    const result = await EventRsvp.findByPk(rsvp.id, {
      include: [{ model: User, attributes: ['id', 'username', 'user_id'] }],
    });

    return res.status(isCreate ? 201 : 200).json(result);
  } catch (error) {
    console.error('Error creating/updating RSVP:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// GET /event/:event_id -- Get all RSVPs for an event
router.get('/event/:event_id', verifyAuth0Token, async (req, res) => {
  try {
    const { event_id } = req.params;
    const userId = req.user.user_id;

    // Phase 71.1: event-scoped read access. Game-only participants can view
    // RSVPs for the event they joined.
    const { allowed, event } = await canReadEventScopedSurface(userId, event_id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (!allowed) {
      return res.status(403).json({ error: 'You must be a participant on this event to view RSVPs' });
    }

    // Fetch all RSVPs for this event
    const rsvps = await EventRsvp.findAll({
      where: { event_id },
      include: [{ model: User, attributes: ['id', 'username', 'user_id'] }],
      order: [
        // Custom order: yes first, maybe second, no third
        [EventRsvp.sequelize.literal(`CASE WHEN "EventRsvp"."status" = 'yes' THEN 0 WHEN "EventRsvp"."status" = 'maybe' THEN 1 WHEN "EventRsvp"."status" = 'no' THEN 2 END`), 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });

    // Compute summary counts
    const summary = { yes: 0, maybe: 0, no: 0 };
    rsvps.forEach((r) => {
      if (summary.hasOwnProperty(r.status)) {
        summary[r.status]++;
      }
    });

    return res.json({ rsvps, summary });
  } catch (error) {
    console.error('Error fetching event RSVPs:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// GET /user/:user_id -- Get all RSVPs for a user (across events)
router.get('/user/:user_id', verifyAuth0Token, async (req, res) => {
  try {
    const { user_id } = req.params;
    const userId = req.user.user_id;

    // Only allow users to fetch their own RSVPs
    if (userId !== user_id) {
      return res.status(403).json({ error: 'You can only view your own RSVPs' });
    }

    const rsvps = await EventRsvp.findAll({
      where: { user_id },
      include: [
        {
          model: Event,
          attributes: ['id', 'start_date', 'group_id', 'game_id', 'status'],
          include: [
            { model: Game, attributes: ['id', 'name'] },
          ],
        },
      ],
      order: [[Event, 'start_date', 'DESC']],
    });

    return res.json(rsvps);
  } catch (error) {
    console.error('Error fetching user RSVPs:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /:rsvp_id -- Remove an RSVP
router.delete('/:rsvp_id', verifyAuth0Token, async (req, res) => {
  try {
    const { rsvp_id } = req.params;
    const userId = req.user.user_id;

    const rsvp = await EventRsvp.findByPk(rsvp_id);
    if (!rsvp) {
      return res.status(404).json({ error: 'RSVP not found' });
    }

    // Only the RSVP owner can delete it
    if (rsvp.user_id !== userId) {
      return res.status(403).json({ error: 'You can only remove your own RSVP' });
    }

    // Phase 75 / GCAL-01: capture status + event_id BEFORE destroy.
    // rsvp.status is gone after destroy; we need it to detect the
    // "was-yes" condition that triggers a cleanup dispatch.
    const priorStatus = rsvp.status;
    const eventId = rsvp.event_id;

    // Hard-delete bring commitments when RSVP is removed
    await EventBring.destroy({ where: { event_id: rsvp.event_id, user_id: rsvp.user_id } });

    await rsvp.destroy();

    // Phase 75 / GCAL-01: if the user was previously RSVPed 'yes', dispatch
    // a GCal cleanup job — same code path as the yes->no transition.
    // Synthesize newStatus='no' since the row is gone (effective non-attendance).
    // Fire-and-forget; never blocks the DELETE response.
    maybeDispatchGcalCleanup({
      eventId,
      authUserId: userId,
      oldStatus: priorStatus,
      newStatus: 'no',
    }).catch((err) =>
      console.error('[rsvp:DELETE] GCal cleanup dispatch error (non-fatal):', err.message)
    );

    return res.status(200).json({ message: 'RSVP removed' });
  } catch (error) {
    console.error('Error removing RSVP:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Export router as default + named exports for email template use
module.exports = router;
module.exports.generateRsvpUrl = generateRsvpUrl;
module.exports.generateRsvpToken = generateRsvpToken;
module.exports.mintRsvpBatch = mintRsvpBatch;
