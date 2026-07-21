// routes/games.js
const express = require('express');
const { Game, Event, EventParticipation, GameReview, User, UserGame, UserGroup } = require('../models');
const { Op } = require('sequelize');
const { requireParamMatchesToken } = require('../middleware/objectAuth');
// Phase 87.4 Plan 02 (KEYMISS mitigation): resolve a UUID self-param to the
// sub-keyed Users row.
const { isUuid } = require('../utils/resolveTargetUser');
const router = express.Router();

// BSEC-02 / BE-098: this router is mounted under the global `/api` default-deny
// authn layer (server.js). The public game-search GETs (`/`, `/search-all`,
// `/:id`, `/bgg/search`) are EXACT-match allow-listed there, so they reach the
// handlers below with no token. The write handlers (`POST /`, `POST /resolve`,
// `POST /import-bgg/:bgg_id`, `PUT /:id`, `DELETE /:id`) are NOT allow-listed,
// so the default-deny layer already requires a valid JWT before they run.
// `GET /for-event/:group_id/:user_id` is also NOT allow-listed (it is not one
// of the four public search paths) — it requires a token AND, because it returns
// the named user's OWNED games, an object-level self-check (see its handler).


// BGG API integration helper
const bggService = require('../services/bggService');
// BGG CSV service for local game searches (faster, no rate limits)
const bggCsvService = require('../services/bggCsvService');


// Get all games (with optional search)
router.get('/', async (req, res) => {
  try {
    const { search, is_custom, group_id } = req.query;
    const where = {};
    
    if (search) {
      where.name = { [Op.iLike]: `%${search}%` };
    }
    
    if (is_custom !== undefined) {
      where.is_custom = is_custom === 'true';
    }
    
    const games = await Game.findAll({
      where,
      order: [['name', 'ASC']],
      include: group_id ? [{
        model: GameReview,
        where: { group_id },
        required: false,
        include: [{ model: User, attributes: ['username'] }]
      }] : []
    });
    
    res.json(games);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Unified search: local custom games + BGG results
router.get('/search-all', async (req, res) => {
  try {
    const { query, group_id, user_id } = req.query;

    // If query is too short or missing, return empty results
    if (!query || query.trim().length < 2) {
      return res.json({ local: [], bgg: [] });
    }

    let local = [];

    // Local search: find games the user/group has used
    if (user_id) {
      try {
        // 87.5-06 (T-875-06-SEARCHALL / KEYMISS): this is a PUBLIC route with no
        // auth gate, so the ?user_id query-param is the only place the caller's
        // identifier is interpreted. Plan 11 flips the FE searchAll senders from
        // the caller's Auth0 sub to their Users.id UUID — so resolve BOTH shapes
        // (findByPk on the UUID, findOne on the sub), matching the dual-resolution
        // precedent already on the sibling /games/for-event route. A sub-only
        // lookup would silently miss a UUID-identified caller and return zero
        // local results while BGG results keep rendering.
        const user = isUuid(user_id)
          ? await User.findByPk(user_id)
          : await User.findOne({ where: { user_id } });
        if (user) {
          // Get all active group_ids for the user. Phase 87.1 (BINT-02): the
          // subject user was resolved from the ?user_id query-param above (this
          // is a PUBLIC route — no req.user), so key UserGroup on the re-keyed
          // user_uuid (Users.id) rather than the legacy Auth0-string column.
          const userGroups = await UserGroup.findAll({
            where: { user_uuid: user.id, status: 'active' },
            attributes: ['group_id']
          });
          const groupIds = userGroups.map(ug => ug.group_id);

          // Get game_ids from events in those groups
          let eventGameIds = [];
          if (groupIds.length > 0) {
            const events = await Event.findAll({
              where: {
                group_id: { [Op.in]: groupIds },
                game_id: { [Op.not]: null }
              },
              attributes: ['game_id'],
              group: ['game_id']
            });
            eventGameIds = events.map(e => e.game_id);
          }

          // Get game_ids from UserGame for this user
          const userGames = await UserGame.findAll({
            where: { user_id: user.id },
            attributes: ['game_id']
          });
          const userGameIds = userGames.map(ug => ug.game_id);

          // Combine unique game IDs
          const allGameIds = [...new Set([...eventGameIds, ...userGameIds])];

          if (allGameIds.length > 0) {
            local = await Game.findAll({
              where: {
                id: { [Op.in]: allGameIds },
                name: { [Op.iLike]: `%${query.trim()}%` }
              },
              attributes: ['id', 'name', 'bgg_id', 'is_custom', 'year_published'],
              order: [['name', 'ASC']],
              limit: 10
            });
          }
        }
      } catch (localError) {
        console.warn('Local game search error (non-fatal):', localError.message);
        // Continue with empty local results
      }
    }

    // BGG search: local CSV first, then live API fallback if few results
    let bgg = [];
    try {
      bgg = await bggCsvService.searchGames(query.trim(), 20);
    } catch (bggError) {
      console.warn('BGG CSV search error (non-fatal):', bggError.message);
    }

    // If CSV returned fewer than 5 results, also search the live BGG API
    if (bgg.length < 5) {
      try {
        const apiResults = await bggService.searchGames(query.trim());
        // Merge API results, skipping any already found in CSV results
        const existingBggIds = new Set(bgg.map(g => g.bgg_id));
        const newApiResults = (apiResults || [])
          .filter(g => !existingBggIds.has(g.bgg_id))
          .slice(0, 20 - bgg.length);
        bgg = [...bgg, ...newApiResults];
      } catch (apiError) {
        console.warn('BGG API search error (non-fatal):', apiError.message);
        // Continue with whatever CSV results we have
      }
    }

    res.json({ local, bgg });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Resolve a game name to an existing custom game or create a new one
router.post('/resolve', async (req, res) => {
  try {
    const { name } = req.body;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Game name is required' });
    }

    const trimmedName = name.trim();

    // Case-insensitive exact match on custom games
    let game = await Game.findOne({
      where: {
        name: { [Op.iLike]: trimmedName },
        is_custom: true
      }
    });

    if (game) {
      return res.json(game);
    }

    // No match found -- create a new custom game
    try {
      game = await Game.create({
        name: trimmedName,
        is_custom: true,
        bgg_id: null
      });
      return res.json(game);
    } catch (createError) {
      // Handle race condition: another request may have created it concurrently
      if (createError.name === 'SequelizeUniqueConstraintError') {
        game = await Game.findOne({
          where: {
            name: { [Op.iLike]: trimmedName },
            is_custom: true
          }
        });
        if (game) {
          return res.json(game);
        }
      }
      throw createError;
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Get game by ID
router.get('/:id', async (req, res) => {
  try {
    const game = await Game.findByPk(req.params.id, {
      include: [
        {
          model: Event,
          include: [
            { model: User, as: 'Winner', attributes: ['id', 'username'] },
            { model: EventParticipation, include: [{ model: User, attributes: ['username'] }] }
          ]
        },
        {
          model: GameReview,
          include: [{ model: User, attributes: ['username'] }]
        }
      ]
    });
    
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    res.json(game);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// BSEC-01 / D-05C: mass-assignment allow-list for the Game write sinks.
// games.js has NO express-validator validators, so the Sequelize `fields:`
// option is the ONLY guard against a client setting columns the handler never
// intended (e.g. forging is_custom/bgg_id/id). Excludes server-controlled
// columns: id (PK), bgg_id + is_custom (forced by the handlers below).
const GAME_USER_FIELDS = [
  'name',
  'year_published',
  'min_players',
  'max_players',
  'playing_time',
  'weight',
  'description',
  'image_url',
  'thumbnail_url',
  'theme',
  'url'
];

// Create custom game
router.post('/', async (req, res) => {
  try {
    // BSEC-01 / D-05C: build gameData by EXPLICIT allow-list pick rather than a
    // body spread. This is defense-in-depth (the `fields:` option below is a
    // second guard) AND keeps the file clear of the mass-assignment spread
    // idiom the CI grep gate forbids.
    const gameData = { is_custom: true, bgg_id: null };
    for (const key of GAME_USER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) {
        gameData[key] = req.body[key];
      }
    }

    // fields: includes the user-supplyable columns PLUS the two the handler
    // force-sets (is_custom/bgg_id) so the explicit values above persist.
    const game = await Game.create(gameData, {
      fields: [...GAME_USER_FIELDS, 'is_custom', 'bgg_id']
    });
    res.json(game);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Import game from BGG
router.post('/import-bgg/:bgg_id', async (req, res) => {
  try {
    const { bgg_id } = req.params;
    
    // Check if game already exists
    const existingGame = await Game.findOne({ where: { bgg_id } });
    if (existingGame) {
      // If existing record is missing key data (e.g. from CSV import), backfill from BGG API
      if (!existingGame.image_url || !existingGame.min_players) {
        try {
          const bggData = await bggService.getGameById(bgg_id);
          await existingGame.update({
            min_players: existingGame.min_players || bggData.min_players,
            max_players: existingGame.max_players || bggData.max_players,
            playing_time: existingGame.playing_time || bggData.playing_time,
            description: existingGame.description || bggData.description,
            image_url: bggData.image_url || existingGame.image_url,
            thumbnail_url: bggData.thumbnail_url || existingGame.thumbnail_url,
          });
        } catch (backfillError) {
          console.warn('BGG backfill failed (non-fatal):', backfillError.message);
        }
      }
      return res.json(existingGame);
    }

    // Fetch from BGG API
    const bggData = await bggService.getGameById(bgg_id);

    const game = await Game.create({
      bgg_id: parseInt(bgg_id),
      name: bggData.name,
      year_published: bggData.year_published,
      min_players: bggData.min_players,
      max_players: bggData.max_players,
      playing_time: bggData.playing_time,
      description: bggData.description,
      image_url: bggData.image_url,
      thumbnail_url: bggData.thumbnail_url,
      is_custom: false
    });

    res.json(game);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Update game
router.put('/:id', async (req, res) => {
  try {
    const game = await Game.findByPk(req.params.id);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    // BSEC-01 / D-05C: only user-editable columns may be updated. is_custom,
    // bgg_id, and id are NOT in the allow-list so a client cannot flip a BGG
    // game to custom or forge its bgg_id via PUT.
    await game.update(req.body, { fields: GAME_USER_FIELDS });
    res.json(game);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Delete game
router.delete('/:id', async (req, res) => {
  try {
    const game = await Game.findByPk(req.params.id);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    await game.destroy();
    res.json({ message: 'Game deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search BGG for games
// Uses local database (from CSV dump) for fast, unlimited searches
// Falls back to API if local search fails
router.get('/bgg/search', async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ error: 'Search query is required' });
    }
    
    // Try local database search first (fast, no rate limits)
    try {
      const localResults = await bggCsvService.searchGames(query);
      if (localResults && localResults.length > 0) {
        return res.json(localResults);
      }
    } catch (localError) {
      console.warn('Local search failed, falling back to API:', localError.message);
      // Continue to API fallback
    }
    
    // Fallback to API if local search returns no results or fails
    // This should rarely be needed once CSV is imported
    const apiResults = await bggService.searchGames(query);
    res.json(apiResults);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get games for event form (group played + user owned)
// BSEC-02 audit (Task 1): this returns the named user's OWNED games merged with
// the group's played games, so it is a self-scoped read — a BOLA candidate, NOT
// public event-form data. Gate it: the actor (verified JWT) must equal the
// :user_id param. The frontend only ever calls this for the logged-in user.
router.get('/for-event/:group_id/:user_id', requireParamMatchesToken('user_id'), async (req, res) => {
  try {
    const { group_id, user_id } = req.params;

    // Get user. Phase 87.4 Plan 02 (T-874-02-KEYMISS): the self-gated param may
    // be the caller's own Users.id UUID (post-PR-2) — resolve it to the PK rather
    // than querying the still-sub-keyed Users.user_id column (which would miss and
    // 404 the caller's own owned-games list).
    // M-4 (87.4-review): reuse the caller's own row memoized by matchesSelf (via
    // requireParamMatchesToken) for the UUID shape — no duplicate Users lookup. The
    // sub shape sets no memo and resolves by the sub column here.
    const user = req.selfUser
      ? req.selfUser
      : (isUuid(user_id)
          ? await User.findByPk(user_id)
          : await User.findOne({ where: { user_id } }));
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get games played by this group
    const groupEvents = await Event.findAll({
      where: { group_id },
      include: [{ model: Game }],
      attributes: ['game_id']
    });
    const groupGameIds = [...new Set(groupEvents.map(e => e.game_id).filter(Boolean))];
    
    // Get games owned by user
    const userOwnedGames = await UserGame.findAll({
      where: { user_id: user.id },
      include: [{ model: Game }]
    });
    const ownedGameIds = userOwnedGames.map(ug => ug.game_id);
    
    // Combine and get unique games
    const allGameIds = [...new Set([...groupGameIds, ...ownedGameIds])];
    
    const games = await Game.findAll({
      where: { id: allGameIds },
      order: [['name', 'ASC']]
    });
    
    // Mark which games are owned
    const gamesWithOwnership = games.map(game => ({
      ...game.toJSON(),
      is_owned: ownedGameIds.includes(game.id),
      is_group_game: groupGameIds.includes(game.id)
    }));
    
    res.json(gamesWithOwnership);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;