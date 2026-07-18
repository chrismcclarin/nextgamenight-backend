// services/heatmapService.js
// Service for aggregating availability responses into suggestions with scoring

const {
  AvailabilityResponse,
  AvailabilitySuggestion,
  AvailabilityPrompt,
  Game,
  User,
  sequelize
} = require('../models');
const { Op } = require('sequelize');

/**
 * Calculate suggestion score based on participant and preference counts
 * Formula: participantCount * 1.0 + preferredCount * 0.5
 * @param {number} participantCount - Number of users available for this slot
 * @param {number} preferredCount - Number of users who marked this as 'preferred'
 * @returns {number} Calculated score as float
 */
function calculateScore(participantCount, preferredCount) {
  return participantCount * 1.0 + preferredCount * 0.5;
}

/**
 * Aggregate all responses for a prompt into availability suggestions
 * Extracts unique time slots, counts participants, calculates scores, and upserts suggestions
 * @param {string} promptId - UUID of the AvailabilityPrompt
 * @returns {Promise<{success: boolean, suggestionCount: number, message: string}>}
 */
async function aggregateResponses(promptId) {
  const transaction = await sequelize.transaction();

  try {
    // Fetch the prompt with its associated game (if any) to determine min_participants
    const prompt = await AvailabilityPrompt.findByPk(promptId, {
      include: [{
        model: Game,
        required: false,
        attributes: ['id', 'min_players']
      }],
      transaction
    });

    if (!prompt) {
      await transaction.rollback();
      return { success: false, suggestionCount: 0, message: 'Prompt not found' };
    }

    // Determine minimum participants threshold
    // Priority: game's minPlayers > default of 2
    let minParticipants = 2; // Default
    if (prompt.Game) {
      // Handle both naming conventions (camelCase and snake_case)
      minParticipants = prompt.Game.min_players || 2;
    }

    // Fetch all responses for this prompt.
    // Phase 87.4 (D-05): eager-load each responder's User so we can store the
    // Users.id UUID (not the Auth0 sub) in participant_user_ids. The association
    // (AvailabilityResponse.belongsTo(User)) already exists, so this adds no extra
    // query — the join rides along with the single findAll.
    const responses = await AvailabilityResponse.findAll({
      where: { prompt_id: promptId },
      include: [{ model: User, attributes: ['id', 'user_id'] }],
      transaction
    });

    if (responses.length === 0) {
      // Delete any existing suggestions if no responses
      await AvailabilitySuggestion.destroy({
        where: { prompt_id: promptId },
        transaction
      });
      await transaction.commit();
      return { success: true, suggestionCount: 0, message: 'No responses to aggregate' };
    }

    // Aggregate time slots across all responses
    // Key: "start|end" (ISO strings), Value: { participants: Set, preferredBy: Set }
    const slotMap = new Map();

    // Phase 87.4 (D-05): participant_user_ids stores Users.id UUIDs, not Auth0 subs.
    // Source each participant from response.User.id. A responder whose row has no
    // resolvable Users row (a departed member — response.User null) is DROPPED from
    // every slot (never stored as a null, never left as a sub); we log the total
    // dropped-responder COUNT only (no raw subs, per T14).
    let droppedResponderCount = 0;
    for (const response of responses) {
      const participantUuid = response.User ? response.User.id : null;
      if (!participantUuid) {
        droppedResponderCount++;
        continue;
      }
      const timeSlots = response.time_slots || [];

      for (const slot of timeSlots) {
        // Normalize slot key using ISO strings for start and end
        const key = `${slot.start}|${slot.end}`;

        if (!slotMap.has(key)) {
          slotMap.set(key, {
            start: slot.start,
            end: slot.end,
            participants: new Set(),
            preferredBy: new Set()
          });
        }

        const slotData = slotMap.get(key);
        slotData.participants.add(participantUuid);

        // Track preferred selections
        if (slot.preference === 'preferred') {
          slotData.preferredBy.add(participantUuid);
        }
      }
    }

    if (droppedResponderCount > 0) {
      console.log(
        `[PU-UUID] Dropped ${droppedResponderCount} responder(s) with no resolvable Users row ` +
        `from prompt ${promptId} suggestions (count only; no subs logged).`
      );
    }

    // Delete existing suggestions for this prompt (full replace strategy)
    await AvailabilitySuggestion.destroy({
      where: { prompt_id: promptId },
      transaction
    });

    // Create new suggestions from aggregated data
    const suggestions = [];
    for (const [key, slotData] of slotMap) {
      const participantCount = slotData.participants.size;
      const preferredCount = slotData.preferredBy.size;
      const score = calculateScore(participantCount, preferredCount);
      const meetsMinimum = participantCount >= minParticipants;

      suggestions.push({
        prompt_id: promptId,
        suggested_start: new Date(slotData.start),
        suggested_end: new Date(slotData.end),
        participant_count: participantCount,
        participant_user_ids: Array.from(slotData.participants),
        preferred_count: preferredCount,
        meets_minimum: meetsMinimum,
        score: score
      });
    }

    // Bulk create all suggestions
    if (suggestions.length > 0) {
      await AvailabilitySuggestion.bulkCreate(suggestions, { transaction });
    }

    await transaction.commit();

    console.log(`Aggregated ${responses.length} responses into ${suggestions.length} suggestions for prompt ${promptId}`);

    return {
      success: true,
      suggestionCount: suggestions.length,
      message: `Aggregated ${responses.length} responses into ${suggestions.length} suggestions`
    };

  } catch (error) {
    await transaction.rollback();
    console.error('Error aggregating responses:', error);
    throw error;
  }
}

/**
 * Fetch suggestions for a prompt with optional filtering
 * @param {string} promptId - UUID of the AvailabilityPrompt
 * @param {Object} options - Filter options
 * @param {number} [options.minParticipants] - Filter by participant_count >= value
 * @param {boolean} [options.meetsMinimum] - Filter by meets_minimum = true
 * @param {string} [options.orderBy='score'] - Field to order by
 * @param {string} [options.orderDirection='DESC'] - Order direction
 * @returns {Promise<AvailabilitySuggestion[]>} Array of suggestion records
 */
async function getSuggestions(promptId, options = {}) {
  try {
    const where = { prompt_id: promptId };

    // Apply minParticipants filter
    if (options.minParticipants !== undefined) {
      where.participant_count = { [Op.gte]: options.minParticipants };
    }

    // Apply meetsMinimum filter
    if (options.meetsMinimum !== undefined) {
      where.meets_minimum = options.meetsMinimum;
    }

    // Build order clause
    const orderField = options.orderBy || 'score';
    const orderDirection = options.orderDirection || 'DESC';
    const order = [[orderField, orderDirection]];

    // Add secondary sort by suggested_start for deterministic ordering
    if (orderField !== 'suggested_start') {
      order.push(['suggested_start', 'ASC']);
    }

    const suggestions = await AvailabilitySuggestion.findAll({
      where,
      order,
      attributes: [
        'id',
        'prompt_id',
        'suggested_start',
        'suggested_end',
        'participant_count',
        'participant_user_ids',
        'preferred_count',
        'meets_minimum',
        'score',
        'converted_to_event_id',
        'createdAt',
        'updatedAt'
      ]
    });

    return suggestions;

  } catch (error) {
    console.error('Error fetching suggestions:', error);
    throw error;
  }
}

module.exports = {
  aggregateResponses,
  calculateScore,
  getSuggestions
};
