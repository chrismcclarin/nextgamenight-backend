// routes/availabilitySuggestion.js
// API routes for availability suggestions (heatmap data)

const express = require('express');
const router = express.Router();
const { verifyAuth0Token } = require('../middleware/auth0');
const heatmapService = require('../services/heatmapService');
const eventCreationService = require('../services/eventCreationService');
const { AvailabilityPrompt, AvailabilitySuggestion, User, UserGroup } = require('../models');
const { isOwnerOrAdmin, isActiveMember } = require('../services/authorizationService');
// Phase 87.4 code-review M-3: same canonical UUID shape the three sibling readers
// (availabilityPrompt.js, tentativeHoldService.js, eventCreationService.js) use to
// drop deploy-window Auth0-sub residue before it reaches the wire.
const { isUuid } = require('../utils/resolveTargetUser');

/**
 * GET /api/prompts/:promptId/suggestions
 * Fetch suggestions for a prompt with optional filtering
 *
 * Query params:
 * - min_participants (optional): Filter by participant_count >= value
 * - meets_minimum (optional): Filter by meets_minimum = true/false
 *
 * Protected: User must be a member of the prompt's group
 */
router.get('/prompts/:promptId/suggestions', verifyAuth0Token, async (req, res) => {
  try {
    const { promptId } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch the prompt to get group_id
    const prompt = await AvailabilityPrompt.findByPk(promptId);
    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    // Verify user is a member of the prompt's group
    const isMember = await isActiveMember(userId, prompt.group_id);
    if (!isMember) {
      return res.status(403).json({ error: 'You must be a group member to view suggestions' });
    }

    // Parse query parameters
    const options = {};

    // Parse min_participants filter
    if (req.query.min_participants !== undefined) {
      const minParticipants = parseInt(req.query.min_participants, 10);
      if (!isNaN(minParticipants) && minParticipants >= 0) {
        options.minParticipants = minParticipants;
      }
    }

    // Parse meets_minimum filter
    if (req.query.meets_minimum !== undefined) {
      options.meetsMinimum = req.query.meets_minimum === 'true';
    }

    // Fetch suggestions
    const suggestions = await heatmapService.getSuggestions(promptId, options);

    res.json({
      prompt_id: promptId,
      suggestion_count: suggestions.length,
      suggestions: suggestions.map(s => ({
        id: s.id,
        suggested_start: s.suggested_start,
        suggested_end: s.suggested_end,
        participant_count: s.participant_count,
        // M-3 (87.4-review): filter to UUID-shaped ids only — a deploy-window residue
        // row would otherwise emit another member's Auth0 sub. Mirrors the three
        // sibling readers' isUuid guard.
        participant_user_ids: (Array.isArray(s.participant_user_ids) ? s.participant_user_ids : []).filter(isUuid),
        preferred_count: s.preferred_count,
        meets_minimum: s.meets_minimum,
        score: s.score,
        converted_to_event_id: s.converted_to_event_id
      }))
    });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/prompts/:promptId/suggestions/refresh
 * Trigger re-aggregation of responses into suggestions
 *
 * Protected: User must be admin or owner of the prompt's group
 */
router.post('/prompts/:promptId/suggestions/refresh', verifyAuth0Token, async (req, res) => {
  try {
    const { promptId } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch the prompt to get group_id
    const prompt = await AvailabilityPrompt.findByPk(promptId);
    if (!prompt) {
      return res.status(404).json({ error: 'Prompt not found' });
    }

    // Verify user is admin or owner of the prompt's group
    const hasPermission = await isOwnerOrAdmin(userId, prompt.group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only admins and owners can refresh suggestions' });
    }

    // Trigger aggregation
    const result = await heatmapService.aggregateResponses(promptId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        message: result.message
      });
    }

    res.json({
      success: true,
      suggestion_count: result.suggestionCount,
      message: result.message
    });
  } catch (error) {
    console.error('Error refreshing suggestions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/suggestions/:suggestionId/convert
 * Convert an availability suggestion to a confirmed event
 *
 * Creates the event, adds all available participants, and sends confirmation emails.
 * The suggestion is marked as converted and cannot be converted again.
 *
 * Protected: User must be admin or owner of the suggestion's group
 *
 * Response:
 * - 201: Event created successfully
 * - 400: Suggestion already converted (includes existing event_id)
 * - 401: Unauthorized (no token)
 * - 403: Only admins and owners can create events
 * - 404: Suggestion not found
 * - 500: Server error
 */
router.post('/suggestions/:suggestionId/convert', verifyAuth0Token, async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const userId = req.user?.user_id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Fetch the suggestion with its prompt to get group_id
    const suggestion = await AvailabilitySuggestion.findByPk(suggestionId, {
      include: [{
        model: AvailabilityPrompt,
        attributes: ['id', 'group_id']
      }]
    });

    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const prompt = suggestion.AvailabilityPrompt;
    if (!prompt) {
      return res.status(404).json({ error: 'Associated prompt not found' });
    }

    // Verify user is admin or owner of the group
    const hasPermission = await isOwnerOrAdmin(userId, prompt.group_id);
    if (!hasPermission) {
      return res.status(403).json({
        error: 'Only admins and owners can convert suggestions to events'
      });
    }

    // Check if already converted (fast path before calling service)
    if (suggestion.converted_to_event_id) {
      return res.status(400).json({
        error: 'Suggestion already converted to event',
        event_id: suggestion.converted_to_event_id,
        already_converted: true
      });
    }

    // Convert the suggestion to an event
    const result = await eventCreationService.convertSuggestionToEvent(
      suggestionId,
      userId,
      {
        comments: req.body.comments,  // Optional override
        sendEmails: req.body.send_emails !== false  // Default true
      }
    );

    if (!result.success) {
      // Handle case where conversion failed (e.g., race condition)
      if (result.event_id) {
        return res.status(400).json({
          error: result.message,
          event_id: result.event_id,
          already_converted: true
        });
      }
      return res.status(400).json({
        error: result.message
      });
    }

    // Success - return 201 Created
    res.status(201).json({
      success: true,
      event_id: result.event_id,
      message: result.message,
      event: result.event
    });

  } catch (error) {
    console.error('Error converting suggestion to event:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
