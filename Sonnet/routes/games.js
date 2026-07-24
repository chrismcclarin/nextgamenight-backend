// routes/games.js
const express = require('express');
const { Game, Event, EventParticipation, GameReview, User, UserGame, UserGroup } = require('../models');
const { Op } = require('sequelize');
const { matchesSelf } = require('../middleware/objectAuth');
const { optionalAuth } = require('../middleware/auth0');
// Phase 87.4 Plan 02 (KEYMISS mitigation): resolve a UUID self-param to the
// sub-keyed Users row.
const { isUuid } = require('../utils/resolveTargetUser');
const router = express.Router();

// BSEC-02 / BE-098: this router is mounted under the global `/api` default-deny
// authn layer (server.js). Post 87.5 SW-01/SW-02, ONLY the two search GETs
// (`/search-all`, `/bgg/search`) are allow-listed public there. Everything else
// — `GET /:id` (SW-01: its includes expose events/participants/winner UUIDs, so
// it is authed; sole consumer is the authenticated gameDetail page) and the
// write handlers (`POST /resolve`, `POST /import-bgg/:bgg_id`) — requires a
// valid JWT before the handler runs.
// 87.6 dead-api-surface cleanup deleted the custom-CRUD sinks (`POST /`,
// `PUT /:id`, `DELETE /:id`) and the self-scoped event-form game picker
// (superseded by the search-all picker) — all caller-less; they are 404-pinned
// in games.test.js.


// BGG API integration helper
const bggService = require('../services/bggService');
// BGG CSV service for local game searches (faster, no rate limits)
const bggCsvService = require('../services/bggCsvService');


// GET / (catalog listing) DELETED — 87.5 adversarial-review sweep SW-02.
// Zero product callers (the gamesAPI.getGames wrapper was dead; every real flow
// uses /search-all or lists/games), and its ?group_id arm attached a group's
// GameReviews + reviewer usernames to an UNAUTHENTICATED response.
// Same dead-route policy as the 87.5-06/WR-02 lists deletions: caller-less
// routes are removed, not left as an unwatched public surface.


// Unified search: local custom games + BGG results
//
// 87.5 adversarial review ML-06: the route stays on the public allow-list (the
// catalog/BGG arm is genuinely public), but the ?user_id PERSONALIZATION arm is
// now token-gated. Post-87.x, Users.id UUIDs circulate to every co-member on the
// wire (heatmap availableMembers, respondents, rosters), so an unauthenticated
// `?user_id=<uuid>` probe could enumerate a user's owned games + cross-group play
// history. optionalAuth verifies a bearer token when present (req.user null
// otherwise); the local arm runs ONLY for the caller's own verified identity
// (matchesSelf, either keyspace). Anonymous callers get BGG-only results — the FE
// always calls this authenticated with the caller's own id, so no surface changes.
router.get('/search-all', optionalAuth, async (req, res) => {
  try {
    const { query, group_id, user_id } = req.query;

    // If query is too short or missing, return empty results
    if (!query || query.trim().length < 2) {
      return res.json({ local: [], bgg: [] });
    }

    let local = [];

    // Local search: find games the user/group has used — verified self only (ML-06).
    if (user_id && req.user && (await matchesSelf(req, user_id))) {
      try {
        // 87.5-06 (T-875-06-SEARCHALL / KEYMISS): the ?user_id param carries the
        // caller's identifier. Plan 11 flips the FE searchAll senders from the
        // caller's Auth0 sub to their Users.id UUID — so resolve BOTH shapes
        // (findByPk on the UUID, findOne on the sub) — the same dual-resolution
        // shape the now-deleted event-form picker route also carried (87.6). A
        // sub-only lookup would silently miss a UUID-identified caller and return zero
        // local results while BGG results keep rendering. matchesSelf has already
        // proven the param IS the caller (either keyspace), and memoized
        // req.selfUser for the UUID arm — reuse it before hitting Users again.
        const user = req.selfUser
          ?? (isUuid(user_id)
            ? await User.findByPk(user_id)
            : await User.findOne({ where: { user_id } }));
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


// POST / (create custom game) DELETED — 87.6 dead-api-surface cleanup (Tier 1,
// item 1). Zero product callers (the gamesAPI.createGame wrapper was dead), and
// its custom-create capability is superseded by the live POST /games/resolve
// (above), which does `Game.create({ ..., is_custom: true })`. The
// GAME_USER_FIELDS mass-assignment allow-list that guarded this sink + the now-
// deleted PUT /:id was removed with them (no remaining consumer). Pinned 404 in
// tests/routes/games.test.js.


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


// PUT /:id (update game) + DELETE /:id (delete game) DELETED — 87.6 dead-api-
// surface cleanup (Tier 3, items 18/19; owner batch decision 2026-07-22). No FE
// wrapper and zero callers. The custom-game edit/remove capability is owned by a
// pending future feature (todo 2026-07-22-edit-and-remove-custom-games-feature.md)
// which will reintroduce authored, authorized handlers. Pinned 404 in
// tests/routes/games.test.js.


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

// Event-form game picker route DELETED — 87.6 dead-api-surface cleanup (Tier 1,
// item 2). Zero product callers (the gamesAPI.getGamesForEvent wrapper was dead),
// superseded by the live GET /games/search-all picker (GameComboInput on the
// event form). 404-pinned in tests/routes/games.test.js (that pin carries the
// exact deleted path for resurrection protection).

module.exports = router;