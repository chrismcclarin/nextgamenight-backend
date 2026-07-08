// services/suggestionService.js
// Smart game suggestion service: queries group members' collections
// and filters by player count, play time, weight, and group ratings.

const { Op, fn, col, literal } = require('sequelize');
const { User, Game, UserGame, UserGroup, EventRsvp, GameReview } = require('../models');

/**
 * Get game suggestions for a group or event.
 *
 * @param {Object} params
 * @param {string}  params.groupId     - Group UUID (required)
 * @param {string}  [params.eventId]   - Event UUID (overrides playerCount with RSVP count)
 * @param {number}  [params.playerCount] - Explicit player count (used when no eventId)
 * @param {number}  [params.maxPlayTime] - Maximum playing time in minutes
 * @param {number}  [params.minWeight]   - Minimum BGG weight (1.0-5.0)
 * @param {number}  [params.maxWeight]   - Maximum BGG weight (1.0-5.0)
 * @param {string}  [params.sort]        - Sort: 'rating' (default), 'play_time', 'complexity', 'name'
 * @returns {Promise<Array>} Array of suggestion objects
 */
async function getSuggestions({ groupId, eventId, playerCount, maxPlayTime, minWeight, maxWeight, sort = 'rating' }) {
  let effectivePlayerCount = playerCount;

  try {
    // ------------------------------------------------------------------
    // a) Determine player count source
    // ------------------------------------------------------------------
    // Phase 87.1 (BINT-02, T-87.1-16): EventRsvp and UserGroup are re-keyed onto
    // the user_uuid UUID FK (Users.id). We read user_uuid DIRECTLY here — the old
    // user_id string columns still hold Auth0 strings (or nothing for new rows),
    // so keeping the old reads + Auth0->UUID mapping would empty every suggestion
    // once the string columns are dropped. UserGame.user_id is already a Users.id
    // UUID, so these UUIDs feed straight into its where-clause.
    let rsvpUserUuids = null; // Users.id UUIDs of RSVP'd users

    if (eventId) {
      // Get RSVP'd users for this event (yes + maybe)
      const rsvps = await EventRsvp.findAll({
        where: {
          event_id: eventId,
          status: { [Op.in]: ['yes', 'maybe'] },
        },
        attributes: ['user_uuid'],
      });

      if (rsvps.length === 0) {
        return { suggestions: [], playerCount: 0 };
      }

      rsvpUserUuids = rsvps.map(r => r.user_uuid); // Users.id UUIDs
      effectivePlayerCount = rsvps.length;
    }

    if (!effectivePlayerCount || effectivePlayerCount < 1) {
      return { suggestions: [], playerCount: 0 };
    }

    // ------------------------------------------------------------------
    // b) Determine whose collections to search
    // ------------------------------------------------------------------
    let userUuids;

    if (rsvpUserUuids) {
      // Event-scoped: use RSVP'd users (already Users.id UUIDs)
      userUuids = rsvpUserUuids;
    } else {
      // Group-scoped: all active group members
      const members = await UserGroup.findAll({
        where: {
          group_id: groupId,
          status: 'active',
        },
        attributes: ['user_uuid'], // Users.id UUIDs
      });
      userUuids = members.map(m => m.user_uuid);
    }

    // Drop any null user_uuid (rows not yet dual-written) so a null never
    // poisons the UserGame.user_id where-clause.
    userUuids = userUuids.filter(Boolean);

    if (userUuids.length === 0) {
      return { suggestions: [], playerCount: effectivePlayerCount };
    }

    // Resolve owner usernames by Users.id (uuidToUsername owner-display-name
    // behavior preserved). Missing rows fall through to the 'Unknown' default
    // in the owner-collection step below.
    const users = await User.findAll({
      where: { id: { [Op.in]: userUuids } },
      attributes: ['id', 'username'],
    });

    // Build a lookup: UUID -> username
    const uuidToUsername = {};
    for (const u of users) {
      uuidToUsername[u.id] = u.username;
    }

    // ------------------------------------------------------------------
    // c) Query games from collections
    // ------------------------------------------------------------------
    const gameWhere = {
      bgg_id: { [Op.ne]: null },
      is_custom: false,
      min_players: { [Op.lte]: effectivePlayerCount },
      max_players: { [Op.gte]: effectivePlayerCount },
    };

    if (maxPlayTime) {
      gameWhere.playing_time = { [Op.lte]: parseInt(maxPlayTime, 10) };
    }
    if (minWeight) {
      gameWhere.weight = { ...(gameWhere.weight || {}), [Op.gte]: parseFloat(minWeight) };
    }
    if (maxWeight) {
      gameWhere.weight = { ...(gameWhere.weight || {}), [Op.lte]: parseFloat(maxWeight) };
    }

    // Fetch UserGame entries for these users, including Game data
    const userGames = await UserGame.findAll({
      where: { user_id: { [Op.in]: userUuids } },
      include: [{
        model: Game,
        where: gameWhere,
        attributes: ['id', 'name', 'thumbnail_url', 'image_url', 'min_players', 'max_players', 'playing_time', 'weight'],
      }],
      attributes: ['user_id', 'game_id'],
    });

    // ------------------------------------------------------------------
    // d) Deduplicate games and collect owner information
    // ------------------------------------------------------------------
    const gameMap = new Map(); // game_id -> { game, owners: Set }

    for (const ug of userGames) {
      const game = ug.Game;
      if (!game) continue;

      if (!gameMap.has(game.id)) {
        gameMap.set(game.id, {
          game,
          owners: new Set(),
        });
      }
      const ownerName = uuidToUsername[ug.user_id] || 'Unknown';
      gameMap.get(game.id).owners.add(ownerName);
    }

    if (gameMap.size === 0) {
      return { suggestions: [], playerCount: effectivePlayerCount };
    }

    // ------------------------------------------------------------------
    // e) Fetch group ratings
    // ------------------------------------------------------------------
    const gameIds = Array.from(gameMap.keys());

    const reviews = await GameReview.findAll({
      where: {
        group_id: groupId,
        game_id: { [Op.in]: gameIds },
        rating: { [Op.ne]: null },
      },
      attributes: ['game_id', 'rating'],
    });

    // Aggregate: average rating and count per game
    const ratingMap = {}; // game_id -> { sum, count }
    for (const r of reviews) {
      if (!ratingMap[r.game_id]) {
        ratingMap[r.game_id] = { sum: 0, count: 0 };
      }
      ratingMap[r.game_id].sum += parseFloat(r.rating);
      ratingMap[r.game_id].count += 1;
    }

    // ------------------------------------------------------------------
    // f) Build result array
    // ------------------------------------------------------------------
    const suggestions = [];

    for (const [gameId, { game, owners }] of gameMap) {
      if (!game || !game.name) {
        console.warn('Skipping suggestion with incomplete game data:', gameId);
        continue;
      }

      const rating = ratingMap[gameId];
      const avgRating = rating ? Math.round((rating.sum / rating.count) * 10) / 10 : null;

      suggestions.push({
        id: game.id,
        name: game.name,
        thumbnail_url: game.thumbnail_url,
        image_url: game.image_url,
        min_players: game.min_players,
        max_players: game.max_players,
        playing_time: game.playing_time,
        weight: game.weight != null ? parseFloat(game.weight) : null,
        owners: Array.from(owners).sort(),
        avg_group_rating: avgRating,
        review_count: rating ? rating.count : 0,
      });
    }

    // ------------------------------------------------------------------
    // g) Sort results
    // ------------------------------------------------------------------
    switch (sort) {
      case 'play_time':
        suggestions.sort((a, b) => {
          const aTime = a.playing_time ?? Infinity;
          const bTime = b.playing_time ?? Infinity;
          return aTime - bTime || (a.name || '').localeCompare(b.name || '');
        });
        break;

      case 'complexity':
        suggestions.sort((a, b) => {
          const aW = a.weight ?? Infinity;
          const bW = b.weight ?? Infinity;
          return aW - bW || (a.name || '').localeCompare(b.name || '');
        });
        break;

      case 'name':
        suggestions.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;

      case 'rating':
      default:
        suggestions.sort((a, b) => {
          // Rated games first, then by rating DESC, then name ASC
          if (a.avg_group_rating == null && b.avg_group_rating == null) return (a.name || '').localeCompare(b.name || '');
          if (a.avg_group_rating == null) return 1;
          if (b.avg_group_rating == null) return -1;
          return b.avg_group_rating - a.avg_group_rating || (a.name || '').localeCompare(b.name || '');
        });
        break;
    }

    return { suggestions, playerCount: effectivePlayerCount };
  } catch (err) {
    console.warn('suggestionService.getSuggestions error:', err.message, { groupId, eventId });
    return { suggestions: [], playerCount: effectivePlayerCount || 0 };
  }
}

module.exports = { getSuggestions };
