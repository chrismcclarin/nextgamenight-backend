// routes/availabilitySuggestion.js
// API routes for availability suggestions (heatmap data)

const express = require('express');
const router = express.Router();
const { verifyAuth0Token } = require('../middleware/auth0');
const eventCreationService = require('../services/eventCreationService');
const { AvailabilityPrompt, AvailabilitySuggestion } = require('../models');
const { isOwnerOrAdmin } = require('../services/authorizationService');
// [87.6-07] heatmapService / isActiveMember / isUuid / User / UserGroup imports
// dropped with the deleted GET suggestions + POST refresh routes; the remaining
// POST /suggestions/:suggestionId/convert route uses only the imports above.

// [87.6-07, Tier 2] GET /prompts/:promptId/suggestions + POST
// /prompts/:promptId/suggestions/refresh DELETED — orphan reads with zero FE
// callers (promptAPI.getSuggestions; NOT the LIVE suggestionsAPI.getEventSuggestions,
// a different game-suggestions feature used by BrowseMoreModal — untouched).
// COVERAGE PROOF: the same aggregated rows are served live by
// GET /prompts/:promptId/heatmap (availabilityPrompt.js:761 → heatmapService), and
// re-aggregation happens automatically on prompt close
// (promptLifecycleService.js:202 calls heatmapService.aggregateResponses). The
// router STAYS MOUNTED for POST /suggestions/:suggestionId/convert below.
// 404-pinned in tests/routes/deadRoutes.pin.test.js.

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
