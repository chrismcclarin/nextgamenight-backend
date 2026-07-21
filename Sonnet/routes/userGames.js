// routes/userGames.js
const express = require('express');
const { UserGame, User, Game } = require('../models');
const bggService = require('../services/bggService');
const router = express.Router();
const { validateBGGUsername, validateAuth0UserId } = require('../middleware/validators');
const { matchesSelf } = require('../middleware/objectAuth');

// Get all games owned by a user
router.get('/user/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Self-gate (87.5-05, SPEC Req 4/5): the requested :user_id must identify the
    // AUTHENTICATED caller. Folded onto the shared matchesSelf dual-accept — it
    // resolves the caller's OWN row from the token (BOLA-safe UUID arm), subsuming
    // the former bespoke `param !== user.id` compare so the two can no longer drift.
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' games' });
    }

    // Resolve the CALLER row for the rest of the handler. On the UUID arm matchesSelf
    // already memoized it as req.selfUser (reuse — no redundant query); on the sub arm
    // it short-circuits DB-free, so fall back to the lookup (sub-shaped traffic is 100%
    // of production during the D-02 rollout window).
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const ownedGames = await UserGame.findAll({
      where: { user_id: user.id },
      include: [{ 
        model: Game,
        required: true  // Use INNER JOIN to exclude orphaned records where Game doesn't exist
      }],
      order: [[Game, 'name', 'ASC']]
    });
    
    // Filter out any null Games (shouldn't happen with required: true, but safety check)
    const games = ownedGames
      .map(ug => ug.Game)
      .filter(game => game !== null && game !== undefined);
    
    res.json(games);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add game to user's owned games
router.post('/user/:user_id/game/:game_id', async (req, res) => {
  try {
    // Use verified user_id from token. (Pre-87.3 this route had NO self-gate:
    // it looked the target up from the raw param, letting any authenticated
    // caller write to any user's collection — PR-C review #19.)
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Self-gate (87.5-05): folded onto the shared matchesSelf dual-accept — resolves
    // the caller's OWN row from the token (BOLA-safe), subsuming the former bespoke
    // `param !== user.id` compare.
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot modify other users\' games' });
    }

    // Resolve the CALLER row: reuse matchesSelf's UUID-arm memoized row when present,
    // fall back to the lookup on the sub arm (DB-free short-circuit leaves it unset).
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const game = await Game.findByPk(req.params.game_id);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    
    const [userGame, created] = await UserGame.findOrCreate({
      where: { user_id: user.id, game_id: game.id },
      defaults: { user_id: user.id, game_id: game.id }
    });
    
    if (!created) {
      return res.json({ message: 'Game already in your collection', game });
    }
    
    res.json({ message: 'Game added to your collection', game });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove game from user's owned games
router.delete('/user/:user_id/game/:game_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Self-gate (87.5-05): folded onto the shared matchesSelf dual-accept — resolves
    // the caller's OWN row from the token (BOLA-safe), subsuming the former bespoke
    // `param !== user.id` compare.
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot modify other users\' games' });
    }

    // Resolve the CALLER row: reuse matchesSelf's UUID-arm memoized row when present,
    // fall back to the lookup on the sub arm.
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userGame = await UserGame.findOne({
      where: { user_id: user.id, game_id: req.params.game_id }
    });
    
    if (!userGame) {
      return res.status(404).json({ error: 'Game not found in your collection' });
    }
    
    await userGame.destroy();
    res.json({ message: 'Game removed from your collection' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import user's entire BGG collection
router.post('/user/:user_id/import-bgg-collection', validateAuth0UserId('user_id'), validateBGGUsername, async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { bgg_username } = req.body;

    // Self-gate (87.5-05): folded onto the shared matchesSelf dual-accept — resolves
    // the caller's OWN row from the token (BOLA-safe), subsuming the former bespoke
    // `param !== user.id` compare.
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot import games for other users' });
    }

    // Resolve the CALLER row: reuse matchesSelf's UUID-arm memoized row when present,
    // fall back to the lookup on the sub arm.
    const user = req.selfUser ?? await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Log import start (sanitized - no user ID)
    if (process.env.NODE_ENV === 'development') {
      console.log(`Starting BGG collection import for BGG username: ${bgg_username.trim()}`);
    }
    
    // Fetch collection from BGG - make parallel calls for both base games and expansions (more efficient than sequential)
    let collection = [];
    try {
      // Make both API calls in parallel instead of sequentially for better performance
      const [baseGames, expansions] = await Promise.all([
        bggService.getUserCollection(bgg_username.trim(), 'boardgame'),
        bggService.getUserCollection(bgg_username.trim(), 'boardgameexpansion')
      ]);
      
      console.log(`BGG base games fetched: ${baseGames.length} games found`);
      console.log(`BGG expansions fetched: ${expansions.length} expansions found`);
      
      // Merge both collections
      collection = [...baseGames, ...expansions];
      console.log(`BGG collection total: ${collection.length} items (${baseGames.length} games + ${expansions.length} expansions)`);
    } catch (bggError) {
      console.error('Error fetching BGG collection:', bggError.message);
      return res.status(500).json({ 
        error: `Failed to fetch BGG collection: ${bggError.message}` 
      });
    }
    
    if (collection.length === 0) {
      return res.json({ 
        message: 'No games found in your BGG collection',
        imported: 0,
        skipped: 0,
        total: 0
      });
    }

    let imported = 0;
    let skipped = 0;
    const errors = [];

    // Import each game
    for (const item of collection) {
      try {
        // Check if game already exists in our database
        let game = await Game.findOne({ where: { bgg_id: item.bgg_id } });
        
        if (!game) {
          // Game doesn't exist, fetch full details from BGG and create it
          // Use the subtype from the collection item (if available) to fetch the correct type
          const gameData = await bggService.getGameById(item.bgg_id, item.subtype || 'boardgame');
          game = await Game.create({
            bgg_id: item.bgg_id,
            name: gameData.name,
            year_published: gameData.year_published,
            min_players: gameData.min_players,
            max_players: gameData.max_players,
            playing_time: gameData.playing_time,
            description: gameData.description,
            image_url: gameData.image_url,
            thumbnail_url: gameData.thumbnail_url,
            is_custom: false
          });
        }

        // Add to user's collection (findOrCreate to avoid duplicates)
        const [userGame, created] = await UserGame.findOrCreate({
          where: { user_id: user.id, game_id: game.id },
          defaults: { user_id: user.id, game_id: game.id }
        });

        if (created) {
          imported++;
        } else {
          skipped++;
        }
      } catch (error) {
        console.error(`Error importing game ${item.bgg_id}:`, error.message);
        errors.push({ bgg_id: item.bgg_id, name: item.name, error: error.message });
      }
    }

    res.json({
      message: `Imported ${imported} games from your BGG collection`,
      imported,
      skipped,
      total: collection.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Error importing BGG collection:', error.message);
    res.status(500).json({ 
      error: error.message || 'An unexpected error occurred while importing your BGG collection'
    });
  }
});

module.exports = router;




