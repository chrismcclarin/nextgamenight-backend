// routes/rsvp.js
// RSVP CRUD API endpoints for event responses (yes/no/maybe)
const express = require('express');
const crypto = require('crypto');
const { EventRsvp, EventBring, Event, User, Game, Group } = require('../models');
const { validateRsvpCreate } = require('../middleware/validators');
const { verifyAuth0Token } = require('../middleware/auth0');
const router = express.Router();

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

    // Verify HMAC token by recomputing
    const expectedToken = generateRsvpToken(eventId, userId, status);
    if (token !== expectedToken) {
      return res.status(403).json({ error: 'Invalid or expired link' });
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

    if (existing) {
      await existing.update({ status });
    } else {
      await EventRsvp.create({
        event_id: eventId,
        user_id: userId,
        status,
      });
    }

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

    if (existing) {
      // Update existing RSVP
      await existing.update({ status, note: note || null });
      rsvp = existing;
    } else {
      // Create new RSVP
      rsvp = await EventRsvp.create({
        event_id,
        user_id: userId,
        status,
        note: note || null,
      });
      isCreate = true;
    }

    // Hard-delete bring commitments when RSVP changes to 'no' or 'maybe'
    if (status === 'no' || status === 'maybe') {
      await EventBring.destroy({ where: { event_id, user_id: userId } });
    }

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

    // Hard-delete bring commitments when RSVP is removed
    await EventBring.destroy({ where: { event_id: rsvp.event_id, user_id: rsvp.user_id } });

    await rsvp.destroy();
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
