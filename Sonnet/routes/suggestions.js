// routes/suggestions.js
// REST API endpoints for smart game suggestions.
// Mounted at /api/suggestions (auth required via server.js verifyAuth0Token).

const express = require('express');
const { Event } = require('../models');
const { getSuggestions } = require('../services/suggestionService');
const { isActiveMember, canReadEventScopedSurface } = require('../services/authorizationService');
const router = express.Router();

// ============================================
// GET /event/:eventId
// Suggestions for a specific event (player count from RSVPs)
// ============================================

router.get('/event/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const { maxPlayTime, minWeight, maxWeight, sort } = req.query;
    const userId = req.user.user_id;

    // Phase 71.1: event-scoped read access. Game-only participants can view
    // suggestions for the event they joined. Helper resolves Event internally
    // and returns it so we can pass event.group_id to getSuggestions.
    const { allowed, event } = await canReadEventScopedSurface(userId, eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (!allowed) {
      return res.status(403).json({ error: 'You must be a participant on this event to view suggestions' });
    }

    const result = await getSuggestions({
      groupId: event.group_id,
      eventId,
      maxPlayTime,
      minWeight,
      maxWeight,
      sort,
    });

    return res.json({
      suggestions: result.suggestions,
      player_count: result.playerCount,
    });
  } catch (err) {
    console.warn('Suggestions service degraded:', err.message);
    console.error('Suggestions event error:', err);
    return res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// ============================================
// GET /group/:groupId
// Suggestions for a group (player count required)
// ============================================

router.get('/group/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const { playerCount, maxPlayTime, minWeight, maxWeight, sort } = req.query;
    const userId = req.user.user_id;

    if (!playerCount) {
      return res.status(400).json({ error: 'playerCount query parameter is required' });
    }

    const parsedPlayerCount = parseInt(playerCount, 10);
    if (isNaN(parsedPlayerCount) || parsedPlayerCount < 1) {
      return res.status(400).json({ error: 'playerCount must be a positive integer' });
    }

    // Verify requesting user is an active group member
    const isMember = await isActiveMember(userId, groupId);
    if (!isMember) {
      return res.status(403).json({ error: 'You must be an active group member to view suggestions' });
    }

    const result = await getSuggestions({
      groupId,
      playerCount: parsedPlayerCount,
      maxPlayTime,
      minWeight,
      maxWeight,
      sort,
    });

    return res.json({
      suggestions: result.suggestions,
      player_count: result.playerCount,
    });
  } catch (err) {
    console.warn('Suggestions service degraded:', err.message);
    console.error('Suggestions group error:', err);
    return res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

module.exports = router;
