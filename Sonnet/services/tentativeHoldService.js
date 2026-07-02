// services/tentativeHoldService.js
// Orchestrates tentative calendar holds for top availability suggestions
// Creates holds during voting period, cleans up when event is confirmed

const crypto = require('crypto');
const { Op } = require('sequelize');
const { AvailabilitySuggestion, AvailabilityPrompt, User, Group, Game } = require('../models');
const googleCalendarService = require('./googleCalendarService');

// Environment configuration
const TENTATIVE_HOLD_LIMIT = parseInt(process.env.TENTATIVE_HOLD_LIMIT || '3', 10);

// Phase 87 / BINT-01 (D-04): RFC-4648 extended-hex ("base32hex") alphabet.
// This is EXACTLY Google Calendar's allowed event-id charset (0-9a-v), so ids
// encoded with it are always valid GCal ids without further sanitisation.
const BASE32HEX_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

/**
 * Encode a Buffer to a base32hex string (RFC-4648 extended hex, no padding).
 * @param {Buffer} buffer
 * @returns {string} base32hex-encoded string
 */
function base32hexEncode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32HEX_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32HEX_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Phase 87 / BINT-01 (D-04): compute a DETERMINISTIC Google Calendar event id
 * for a (suggestion, user) pair. Stable across retries so re-creating a hold
 * reuses the same id (GCal returns 409 => idempotent success) and cleanup can
 * always recompute the id even if the stored map is missing/partial.
 *
 * Result = 'h' + base32hex(sha256("hold-<suggestionId>-<userId>")).slice(0,40)
 * => ~41 chars, all within GCal's charset (0-9a-v), length >= 5.
 *
 * @param {string} suggestionId
 * @param {string} userId
 * @returns {string} deterministic base32hex GCal event id
 */
function deterministicHoldId(suggestionId, userId) {
  const digest = crypto
    .createHash('sha256')
    .update(`hold-${suggestionId}-${userId}`)
    .digest();
  return 'h' + base32hexEncode(digest).slice(0, 40);
}

/**
 * Format a Date object to ISO 8601 datetime string for Google Calendar API
 * @param {Date} date - Date object to format
 * @returns {string} ISO datetime string (e.g., "2026-02-15T18:00:00")
 */
function formatDateTimeISO(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    throw new Error('Invalid date provided to formatDateTimeISO');
  }

  // Convert to ISO string and remove the 'Z' and milliseconds
  // Google Calendar API expects: YYYY-MM-DDTHH:mm:ss
  const isoString = date.toISOString();
  return isoString.replace(/\.\d{3}Z$/, '');
}

/**
 * Create tentative calendar holds for top suggestions meeting minimum threshold
 * Called after availability responses are aggregated
 *
 * @param {string} promptId - UUID of the AvailabilityPrompt
 * @param {Object} options - Optional configuration
 * @param {number} options.limit - Override TENTATIVE_HOLD_LIMIT (default: 3)
 * @returns {Promise<Object>} { successCount, failureCount, suggestions: [...] }
 */
async function createHoldsForTopSuggestions(promptId, options = {}) {
  const limit = options.limit || TENTATIVE_HOLD_LIMIT;
  const result = {
    successCount: 0,
    failureCount: 0,
    suggestions: []
  };

  try {
    // Get top suggestions meeting minimum threshold
    const suggestions = await AvailabilitySuggestion.findAll({
      where: {
        prompt_id: promptId,
        meets_minimum: true,
        converted_to_event_id: null
      },
      order: [['score', 'DESC'], ['suggested_start', 'ASC']],
      limit: limit
    });

    if (suggestions.length === 0) {
      console.log(`No qualifying suggestions found for prompt ${promptId}`);
      return result;
    }

    // Get prompt with group and game info
    const prompt = await AvailabilityPrompt.findByPk(promptId, {
      include: [
        { model: Group },
        { model: Game }
      ]
    });

    if (!prompt) {
      console.error(`Prompt ${promptId} not found`);
      return result;
    }

    // Process each suggestion
    for (const suggestion of suggestions) {
      const suggestionResult = {
        suggestionId: suggestion.id,
        holdsCreated: 0,
        holdsFailed: 0,
        userHoldIds: {}
      };

      // Get users who are participants AND have calendar connected
      const participantUserIds = suggestion.participant_user_ids || [];

      if (participantUserIds.length === 0) {
        console.log(`No participants for suggestion ${suggestion.id}`);
        result.suggestions.push(suggestionResult);
        continue;
      }

      const users = await User.findAll({
        where: {
          user_id: {
            [Op.in]: participantUserIds
          },
          google_calendar_enabled: true,
          google_calendar_token: {
            [Op.ne]: null
          }
        }
      });

      if (users.length === 0) {
        console.log(`No users with Google Calendar connected for suggestion ${suggestion.id}`);
        result.suggestions.push(suggestionResult);
        continue;
      }

      // Create holds for each user
      for (const user of users) {
        try {
          // Phase 87 / BINT-01: deterministic client-supplied id makes the create
          // idempotent — a retry reuses the same id and GCal returns 409-as-success.
          const holdId = deterministicHoldId(suggestion.id, user.user_id);

          const eventData = {
            groupName: prompt.Group?.name || 'Game Group',
            gameName: prompt.Game?.name || 'Game Night',
            startDateTime: formatDateTimeISO(suggestion.suggested_start),
            endDateTime: formatDateTimeISO(suggestion.suggested_end),
            timezone: user.timezone || 'UTC',
            id: holdId
          };

          const calendarEvent = await googleCalendarService.createTentativeHold(
            eventData,
            user.google_calendar_token,
            user.google_calendar_refresh_token
          );

          // Track the hold. Use the deterministic id we supplied (identical to
          // calendarEvent.id on both fresh-create and the _duplicate 409 path).
          suggestionResult.userHoldIds[user.user_id] = holdId;
          suggestionResult.holdsCreated++;

          // Phase 87 / BINT-01: PERSIST INCREMENTALLY inside the loop so every id
          // is written to the DB as it is created. If a later user's create fails
          // (or the job is retried), no hold is left created-but-untracked.
          await suggestion.update({
            tentative_calendar_event_ids: {
              ...(suggestion.tentative_calendar_event_ids || {}),
              [user.user_id]: holdId
            }
          });

          // Update user's token if it was refreshed
          if (calendarEvent._new_access_token) {
            await User.update(
              { google_calendar_token: calendarEvent._new_access_token },
              { where: { user_id: user.user_id } }
            );
          }
        } catch (error) {
          // Only genuine (non-409) failures land here — 409 duplicates are
          // resolved as success inside googleCalendarService.createTentativeHold.
          console.error(`Failed to create tentative hold for user ${user.user_id}:`, error.message);
          suggestionResult.holdsFailed++;
        }
      }

      // Ids were persisted incrementally above; here we only tally the outcome.
      if (Object.keys(suggestionResult.userHoldIds).length > 0) {
        result.successCount++;
      } else if (suggestionResult.holdsFailed > 0) {
        result.failureCount++;
      }

      result.suggestions.push(suggestionResult);
    }

    console.log(`Created tentative holds for ${result.successCount} suggestions (${result.failureCount} failures)`);
    return result;
  } catch (error) {
    console.error('Error in createHoldsForTopSuggestions:', error.message);
    throw error;
  }
}

/**
 * Clean up all tentative calendar holds when an event is created
 * Called after convertSuggestionToEvent completes
 *
 * @param {string} suggestionId - UUID of the suggestion that was converted (for logging)
 * @param {string} promptId - UUID of the AvailabilityPrompt
 * @returns {Promise<Object>} { deleted: number, failed: number }
 */
async function cleanupHoldsOnEventCreation(suggestionId, promptId) {
  const result = { deleted: 0, failed: 0 };

  try {
    // Get all suggestions for this prompt (not just the converted one)
    // We want to clean up holds from ALL suggestions since only one can be the event
    const suggestions = await AvailabilitySuggestion.findAll({
      where: { prompt_id: promptId }
    });

    if (suggestions.length === 0) {
      console.log(`No suggestions found for prompt ${promptId}`);
      return result;
    }

    for (const suggestion of suggestions) {
      // Phase 87 / BINT-01: reap by the stored id map FIRST, then RECOMPUTE the
      // deterministic id for any participant missing from the stored map. This is a
      // backstop so a hold that was created on GCal but not yet persisted (crash /
      // partial failure between events.insert and suggestion.update) is still reaped.
      const storedIds = suggestion.tentative_calendar_event_ids || {};
      const participantUserIds = suggestion.participant_user_ids || [];
      const holdIds = { ...storedIds };
      for (const userId of participantUserIds) {
        if (!holdIds[userId]) {
          holdIds[userId] = deterministicHoldId(suggestion.id, userId);
        }
      }

      if (Object.keys(holdIds).length === 0) {
        continue;
      }

      // For each user with a hold, delete it
      for (const [userId, calendarEventId] of Object.entries(holdIds)) {
        const user = await User.findOne({
          where: { user_id: userId }
        });

        if (user?.google_calendar_token) {
          try {
            const success = await googleCalendarService.deleteTentativeHold(
              calendarEventId,
              user.google_calendar_token,
              user.google_calendar_refresh_token
            );

            if (success) {
              result.deleted++;
            } else {
              result.failed++;
            }
          } catch (error) {
            console.error(`Failed to delete tentative hold ${calendarEventId}:`, error.message);
            result.failed++;
          }
        } else {
          // User doesn't have calendar token anymore - consider it cleaned up
          console.log(`User ${userId} no longer has calendar token, skipping hold deletion`);
        }
      }

      // Clear the hold IDs from the suggestion
      await suggestion.update({ tentative_calendar_event_ids: null });
    }

    console.log(`Cleaned up tentative holds: ${result.deleted} deleted, ${result.failed} failed`);
    return result;
  } catch (error) {
    console.error('Error in cleanupHoldsOnEventCreation:', error.message);
    // Don't rethrow - cleanup errors shouldn't break the main flow
    return result;
  }
}

module.exports = {
  createHoldsForTopSuggestions,
  cleanupHoldsOnEventCreation,
  // Export for testing
  formatDateTimeISO,
  deterministicHoldId,
  base32hexEncode,
  TENTATIVE_HOLD_LIMIT
};
