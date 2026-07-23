// routes/lists.js
const express = require('express');
const { Event, Game, Group, User, EventParticipation, GameReview } = require('../models');
const { Op, fn, col } = require('sequelize');
const { isActiveMember } = require('../services/authorizationService');
// Phase 87.4 Plan 02 (SPEC Req 5, D-04): shared self-param dual-accept (own sub
// OR own resolved Users.id UUID). Every route in this file now keys isActiveMember
// on the token sub (req.user.user_id), NOT the URL :user_id param, and clamps the
// :user_id self-param to the caller via matchesSelf. Phase 87.4 code-review H-1
// folded the remaining URL-param-gated routes (player-wins, player-picks, etc.) into
// this same pattern — the /games and /players siblings are the precedent.
const { matchesSelf } = require('../middleware/objectAuth');
const router = express.Router();

// 1 + 1b. [REMOVED — Phase 87.5 code-review WR-02, dead-route policy per Plan 06]
// The per-player "games won" routes — player-wins (by name, path
// :group_id/:player_name/:user_id) and player-wins-by-id (by user_id, path
// :group_id/:player_user_id/:user_id) — were deleted. player-wins-by-id filtered
// on `p.User.user_id` / `event.Winner.user_id` from includes that only select
// ['id','username'] (never user_id), so its predicate was ALWAYS false and it
// always returned [] — the identical defect class as the deleted
// games-played-by-id (see route 7b below). player-wins (by name) was functional
// but had ZERO FE callers (confirmed via grep of periodictabletop/src for
// 'player-wins'). Both removed under the Plan-06 dead-route policy. Recoverable
// from git history if ever needed.

// [REMOVED — Phase 87.5 Plan 06, SPEC Req 9/10] Two dead play-count sort routes
// (games ordered by descending and by ascending play count; path
// :group_id/:user_id) were deleted: they 500'd on main and had zero FE callers.
// Their capability is preserved by the unified /lists/games endpoint's sort/order
// params + client-side sort. Recoverable from git history if ever needed.

// 4 + 4b. [REMOVED — Phase 87.5 code-review WR-02, dead-route policy per Plan 06]
// The per-player "games picked" routes — player-picks (by name, path
// :group_id/:player_name/:user_id) and player-picks-by-id (by user_id, path
// :group_id/:player_user_id/:user_id) — were deleted. player-picks-by-id
// filtered on `event.PickedBy.user_id` from an include that only selects
// ['id','username'] (never user_id), so its predicate was ALWAYS false and it
// always returned []. player-picks (by name) was functional but had ZERO FE
// callers (confirmed via grep of periodictabletop/src for 'player-picks'). Both
// removed under the Plan-06 dead-route policy. Recoverable from git history if
// ever needed.

// 5. Games by theme
router.get('/by-theme/:group_id/:theme/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token (self-param dual-accept — same pattern as
    // the /games and /players siblings; the path :user_id alone is spoofable).
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id, theme, user_id } = req.params;

    // Verify the requested user_id is the caller's own identity (dual-accept: own
    // sub OR own resolved UUID). The group-scoped data query below keys on
    // group_id + isActiveMember(token sub), not this param.
    if (!(await matchesSelf(req, user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' data' });
    }

    const hasAccess = await isActiveMember(userId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }
    
    const events = await Event.findAll({
      where: { group_id },
      include: [
        { 
          model: Game, 
          attributes: ['name', 'theme', 'url'],
          where: { theme: { [Op.iLike]: `%${theme}%` } }
        }
      ],
      order: [['start_date', 'DESC']]
    });
    
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Unified games list endpoint with sorting
// GET /api/lists/games/:group_id/:user_id?sort=name|play_count|last_played|rating&order=asc|desc
router.get('/games/:group_id/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { group_id, user_id } = req.params;
    
    // Verify the requested user_id is the caller's own identity (dual-accept:
    // own sub OR own resolved UUID). The group-scoped data query below keys on
    // group_id + isActiveMember(token sub), not this param, so no keyspace
    // resolution of the param is needed.
    if (!(await matchesSelf(req, user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' data' });
    }
    
    const { sort = 'last_played', order = 'desc' } = req.query;
    
    const hasAccess = await isActiveMember(userId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }
    
    // Validate sort parameter
    const validSorts = ['name', 'play_count', 'last_played', 'rating'];
    const sortField = validSorts.includes(sort) ? sort : 'last_played';
    const sortOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    
    // Get all events for the group with game information and winner/picker data.
    // Phase 87.3 PR-C (Task 2b): the sub column is no longer selected — the
    // winners/pickers entries below ALIAS user_id to the Users.id UUID.
    const events = await Event.findAll({
      where: { group_id },
      include: [
        {
          model: Game,
          attributes: ['id', 'name', 'image_url', 'theme', 'year_published', 'min_players', 'max_players', 'playing_time', 'description']
        },
        { model: User, as: 'Winner', attributes: ['id', 'username'] },
        { model: User, as: 'PickedBy', attributes: ['id', 'username'] }
      ],
      order: [['start_date', 'DESC']]
    });
    
    // Get all reviews for games in this group to calculate average ratings
    const reviews = await GameReview.findAll({
      where: { 
        group_id,
        rating: { [Op.not]: null } // Only count reviews with ratings
      },
      attributes: [
        'game_id',
        [fn('AVG', col('rating')), 'avg_rating'],
        [fn('COUNT', col('rating')), 'review_count']
      ],
      group: ['game_id'],
      raw: true
    });
    
    // Create a map of game_id to average rating
    const ratingMap = {};
    reviews.forEach(review => {
      const gameId = review.game_id;
      ratingMap[gameId] = {
        avg_rating: review.avg_rating ? parseFloat(review.avg_rating) : null,
        review_count: review.review_count ? parseInt(review.review_count) : 0
      };
    });
    
    // Aggregate unique games with metadata
    const gameMap = new Map();
    
    events.forEach(event => {
      if (!event.Game) return;
      
      const gameId = event.Game.id;
      const eventDate = new Date(event.start_date);
      
      if (!gameMap.has(gameId)) {
        gameMap.set(gameId, {
          id: gameId,
          name: event.Game.name,
          image_url: event.Game.image_url,
          theme: event.Game.theme,
          year_published: event.Game.year_published,
          min_players: event.Game.min_players,
          max_players: event.Game.max_players,
          playing_time: event.Game.playing_time,
          description: event.Game.description,
          play_count: 0,
          last_played: null,
          first_played: null,
          avg_rating: ratingMap[gameId]?.avg_rating || null,
          review_count: ratingMap[gameId]?.review_count || 0,
          winners: [],
          pickers: []
        });
      }
      
      const game = gameMap.get(gameId);
      game.play_count++;
      
      // Update last played
      if (!game.last_played || eventDate > new Date(game.last_played)) {
        game.last_played = eventDate.toISOString();
      }
      
      // Update first played
      if (!game.first_played || eventDate < new Date(game.first_played)) {
        game.first_played = eventDate.toISOString();
      }

      // Track winner for this event.
      // Phase 87.3 PR-C (Task 2b, ALIAS LOCKED — removal FORBIDDEN): each
      // winners/pickers entry's user_id VALUE is the Users.id UUID (name
      // stable, Req 2). GroupGamesList cross-payload-JOINS these user_id keys
      // against roster member user_id keys (Task 2 aliases those to UUIDs in
      // this SAME PR-C) — both join sides flip in lockstep; dropping the field
      // would silently empty the winner/picker merge and filter-by-member.
      if (event.Winner) {
        const existing = game.winners.find(w => w.user_id === event.Winner.id);
        if (existing) {
          existing.count++;
        } else {
          game.winners.push({ id: event.Winner.id, username: event.Winner.username, user_id: event.Winner.id, count: 1, is_custom: false });
        }
      } else if (event.winner_name) {
        const existing = game.winners.find(w => w.is_custom && w.username === event.winner_name);
        if (existing) {
          existing.count++;
        } else {
          game.winners.push({ id: null, username: event.winner_name, user_id: null, count: 1, is_custom: true });
        }
      }

      // Track picker for this event (same PR-C alias lock as winners above).
      if (event.PickedBy) {
        const existing = game.pickers.find(p => p.user_id === event.PickedBy.id);
        if (existing) {
          existing.count++;
        } else {
          game.pickers.push({ id: event.PickedBy.id, username: event.PickedBy.username, user_id: event.PickedBy.id, count: 1, is_custom: false });
        }
      } else if (event.picked_by_name) {
        const existing = game.pickers.find(p => p.is_custom && p.username === event.picked_by_name);
        if (existing) {
          existing.count++;
        } else {
          game.pickers.push({ id: null, username: event.picked_by_name, user_id: null, count: 1, is_custom: true });
        }
      }
    });
    
    // Convert to array
    let games = Array.from(gameMap.values());
    
    // Sort based on sort parameter
    switch (sortField) {
      case 'name':
        games.sort((a, b) => {
          const comparison = a.name.localeCompare(b.name);
          return sortOrder === 'ASC' ? comparison : -comparison;
        });
        break;
        
      case 'play_count':
        games.sort((a, b) => {
          const comparison = a.play_count - b.play_count;
          return sortOrder === 'ASC' ? comparison : -comparison;
        });
        break;
        
      case 'last_played':
        games.sort((a, b) => {
          const dateA = a.last_played ? new Date(a.last_played) : new Date(0);
          const dateB = b.last_played ? new Date(b.last_played) : new Date(0);
          const comparison = dateA - dateB;
          return sortOrder === 'ASC' ? comparison : -comparison;
        });
        break;
        
      case 'rating':
        games.sort((a, b) => {
          // Games with no ratings go to the end
          if (!a.avg_rating && !b.avg_rating) return 0;
          if (!a.avg_rating) return 1;
          if (!b.avg_rating) return -1;
          
          const comparison = a.avg_rating - b.avg_rating;
          return sortOrder === 'ASC' ? comparison : -comparison;
        });
        break;
    }
    
    res.json(games);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. [REMOVED — Phase 87.5 Plan 06, SPEC Req 9/10] Two more dead routes were
// deleted: the games-sorted-by-name listing (path :group_id/:user_id) and the
// per-player games-by-name listing (path :group_id/:player_name/:user_id). Both
// 500'd on main and had zero FE callers. Name-sorted listing is preserved by the
// unified /lists/games endpoint's sort/order params + client-side sort.
// Recoverable from git history if ever needed.

// 7b. [REMOVED — Phase 87.4 Plan 02, SPEC Req 6] The dead "games-played-by-id"
// endpoint (path :group_id/:player_user_id/:user_id) was deleted. It filtered on
// `p.user_id` from a `User, as: 'Players'` include that only selects
// ['id','username'] (never user_id), so the predicate was always false and the
// route always returned []. Zero consumers (no FE reference; confirmed via grep
// of periodictabletop/src). Recoverable from git history if ever needed.

// 8. All players in a group (aggregated from all games)
router.get('/players/:group_id/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token (same self-check as the /games sibling —
    // the path param alone is spoofable: any known member sub read group stats;
    // PR-C review #7).
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id, user_id } = req.params;

    // Verify the requested user_id is the caller's own identity (dual-accept:
    // own sub OR own resolved UUID). The group-scoped data query below keys on
    // group_id + isActiveMember(token sub), not this param, so no keyspace
    // resolution of the param is needed.
    if (!(await matchesSelf(req, user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' data' });
    }

    const hasAccess = await isActiveMember(userId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }
    
    // Get all events for the group with participations
    const events = await Event.findAll({
      where: { group_id },
      include: [
        {
          model: EventParticipation,
          include: [{ model: User, attributes: ['id', 'username', 'user_id'] }]
        },
        { model: User, as: 'Winner', attributes: ['id', 'username', 'user_id'] }
      ]
    });
    
    // Aggregate player statistics
    const playerStats = {};
    
    events.forEach(event => {
      if (event.EventParticipations && Array.isArray(event.EventParticipations)) {
        event.EventParticipations.forEach(participation => {
          const player = participation.User;
          // Phase 87.3 PR-C (user D3, mechanical read-only emitter): the
          // aggregation's INTERNAL keying stays sub-keyed (playerKey below) —
          // only the SERIALIZED user_id value flips to the Users.id UUID.
          const playerKey = player.user_id;

          if (!playerStats[playerKey]) {
            playerStats[playerKey] = {
              user_id: player.id, // D3: emitted value is the UUID (name stable)
              name: player.username,
              games_played: 0,
              games_won: 0,
              total_score: 0
            };
          }
          playerStats[playerKey].games_played++;
          
          // Check if this player won
          if (event.Winner && event.Winner.user_id === player.user_id) {
            playerStats[playerKey].games_won++;
          }
          
          // Get score from participation
          if (participation.score !== undefined) {
            playerStats[playerKey].total_score += participation.score;
          }
        });
      }
    });
    
    // Convert to array and calculate averages
    const players = Object.values(playerStats).map(player => ({
      ...player,
      average_score: player.games_played > 0 ? (player.total_score / player.games_played).toFixed(2) : 0,
      win_rate: player.games_played > 0 ? ((player.games_won / player.games_played) * 100).toFixed(1) : 0
    }));
    
    // Sort by player name
    players.sort((a, b) => a.name.localeCompare(b.name));
    
    res.json(players);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;