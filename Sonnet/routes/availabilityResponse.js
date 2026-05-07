// routes/availabilityResponse.js
// Availability response submission via magic token authentication
// NOTE: This route uses magic token auth, NOT Auth0

const express = require('express');
const router = express.Router();
const { UniqueConstraintError } = require('sequelize');
const { validateToken } = require('../services/magicTokenService');
const { AvailabilityPrompt, AvailabilityResponse } = require('../models');
const { magicTokenLimiter } = require('../middleware/rateLimiter');

/**
 * POST /api/availability-responses
 * Submit or update an availability response using magic token authentication
 *
 * Body: {
 *   magic_token: string,           // Required - magic token from email link
 *   time_slots: [                  // Required unless is_unavailable=true
 *     { start: ISO8601, end: ISO8601, preference: 'preferred' | 'if-need-be' }
 *   ],
 *   user_timezone: string,         // Required - IANA timezone (e.g., 'America/New_York')
 *   is_unavailable: boolean        // Optional - if true, time_slots can be empty
 * }
 *
 * Response:
 *   Success: { success: true, response_id: uuid, updated: boolean }
 *   Token error: { error: string, action: 'request_new' }
 *   Validation error: { error: string }
 *   Deadline passed: { error: string }
 */
router.post('/', magicTokenLimiter, async (req, res) => {
  try {
    const { magic_token, time_slots, user_timezone, is_unavailable } = req.body;

    // 1. Validate required fields
    if (!magic_token) {
      return res.status(400).json({
        error: 'Token is required'
      });
    }

    if (!user_timezone) {
      return res.status(400).json({
        error: 'Timezone is required'
      });
    }

    // time_slots required unless marking as unavailable
    if (!is_unavailable && (!time_slots || !Array.isArray(time_slots) || time_slots.length === 0)) {
      return res.status(400).json({
        error: 'Time slots are required unless marking as unavailable'
      });
    }

    // Validate time_slots structure if provided
    if (time_slots && Array.isArray(time_slots) && time_slots.length > 0) {
      for (const slot of time_slots) {
        if (!slot.start || !slot.end) {
          return res.status(400).json({
            error: 'Each time slot must have start and end times'
          });
        }
        if (slot.preference && !['preferred', 'if-need-be'].includes(slot.preference)) {
          return res.status(400).json({
            error: 'Time slot preference must be "preferred" or "if-need-be"'
          });
        }
      }
    }

    // 2. Validate magic token
    const tokenResult = await validateToken(magic_token, null, { consume: false });

    if (!tokenResult.valid) {
      // Generic error message for all token failures (security)
      return res.status(400).json({
        error: 'This link is no longer valid.',
        action: 'request_new'
      });
    }

    const { decoded } = tokenResult;
    const userId = decoded.sub;
    const promptId = decoded.prompt_id;
    const tokenJti = decoded.jti;

    // 3. Check if prompt exists and is active
    const prompt = await AvailabilityPrompt.findByPk(promptId);

    if (!prompt) {
      return res.status(400).json({
        error: 'This availability prompt no longer exists.',
        action: 'request_new'
      });
    }

    if (prompt.status !== 'active') {
      return res.status(400).json({
        error: 'This availability prompt is no longer accepting responses.'
      });
    }

    // 4. Check if deadline has passed
    const now = new Date();
    if (prompt.deadline && new Date(prompt.deadline) < now) {
      return res.status(400).json({
        error: 'The deadline for this availability prompt has passed.'
      });
    }

    // 5. Upsert availability response
    // Look for existing response by this user for this prompt
    const existingResponse = await AvailabilityResponse.findOne({
      where: {
        prompt_id: promptId,
        user_id: userId
      }
    });

    const responseData = {
      time_slots: is_unavailable ? [] : time_slots,
      user_timezone,
      submitted_at: now,
      magic_token_used: tokenJti
    };

    let response;
    let updated = false;

    if (existingResponse) {
      // Update existing response
      await existingResponse.update(responseData);
      response = existingResponse;
      updated = true;
    } else {
      // Create new response — handle race condition where a concurrent request
      // creates the record between our findOne check and this create call
      try {
        response = await AvailabilityResponse.create({
          prompt_id: promptId,
          user_id: userId,
          ...responseData
        });
      } catch (createErr) {
        if (createErr instanceof UniqueConstraintError) {
          // Concurrent request already created the record — find and update it
          const raceRecord = await AvailabilityResponse.findOne({
            where: { prompt_id: promptId, user_id: userId }
          });
          if (raceRecord) {
            await raceRecord.update(responseData);
            response = raceRecord;
            updated = true;
          } else {
            throw createErr; // Unexpected state — re-throw
          }
        } else {
          throw createErr;
        }
      }
    }

    // Phase 71.2 / D-ADAPT-03: after a successful response upsert, check whether
    // all active members have now responded. If so, the lifecycle service
    // closes the prompt and fires the close-notification email + Schedule it?
    // CTA. Best-effort — errors logged not thrown so the response submit still
    // succeeds even if the consensus check fails.
    try {
      const lifecycleService = require('../services/promptLifecycleService');
      await lifecycleService.checkConsensusAndClose(promptId);
    } catch (consensusErr) {
      console.error('[availabilityResponse] consensus check failed (non-fatal):', consensusErr.message);
    }

    res.status(200).json({
      success: true,
      response_id: response.id,
      updated
    });

  } catch (err) {
    console.error('Availability response submission error:', err);
    res.status(500).json({
      error: 'An error occurred while submitting your response. Please try again.'
    });
  }
});

/**
 * GET /api/availability-responses/:promptId
 * Get existing response for pre-fill (when user returns to edit)
 *
 * Query: magic_token=<token>
 *
 * Response:
 *   Found: { response: { time_slots, user_timezone, submitted_at } }
 *   Not found: null (200 with null body)
 *   Token error: { error: string, action: 'request_new' }
 */
router.get('/:promptId', magicTokenLimiter, async (req, res) => {
  try {
    const { promptId } = req.params;
    const { magic_token } = req.query;

    if (!magic_token) {
      return res.status(400).json({
        error: 'Token is required',
        action: 'request_new'
      });
    }

    // Validate magic token
    const tokenResult = await validateToken(magic_token, null, { consume: false });

    if (!tokenResult.valid) {
      return res.status(400).json({
        error: 'This link is no longer valid.',
        action: 'request_new'
      });
    }

    const { decoded } = tokenResult;
    const userId = decoded.sub;

    // Verify token's prompt_id matches requested promptId
    if (decoded.prompt_id !== promptId) {
      return res.status(400).json({
        error: 'Token does not match this availability prompt.',
        action: 'request_new'
      });
    }

    // Find existing response
    const response = await AvailabilityResponse.findOne({
      where: {
        prompt_id: promptId,
        user_id: userId
      },
      attributes: ['id', 'time_slots', 'user_timezone', 'submitted_at']
    });

    if (!response) {
      return res.status(200).json(null);
    }

    res.status(200).json({
      response: {
        id: response.id,
        time_slots: response.time_slots,
        user_timezone: response.user_timezone,
        submitted_at: response.submitted_at
      }
    });

  } catch (err) {
    console.error('Get availability response error:', err);
    res.status(500).json({
      error: 'An error occurred while retrieving your response.'
    });
  }
});

module.exports = router;
