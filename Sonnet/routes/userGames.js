// routes/userGames.js
const express = require('express');
const { UserGame, User, Game } = require('../models');
const bggService = require('../services/bggService');
const router = express.Router();
const { validateBGGUsername, validateAuth0UserId } = require('../middleware/validators');

// Get all games owned by a user
router.get('/user/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Resolve the CALLER from the verified JWT — the param is only ever
    // compared against the caller's own identifiers below (self-only route).
    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Self-gate: the requested :user_id must identify the AUTHENTICATED caller.
    // Phase 87.3 PR-C (plan 09, Rule 2 deviation): accept the caller's Users.id
    // UUID as well as their Auth0 sub. The self-identity response
    // (GET /users/:user_id) now ALIASES user_id to the UUID, and BringGamePicker
    // feeds `self.user_id` into this route — without the UUID arm every
    // owned-games read from that surface would 403 post-PR-C (silent empty
    // picker). Still strictly self-only: both arms compare the param against
    // the JWT-resolved caller row, never against client-supplied identity.
    if (req.params.user_id !== userId && req.params.user_id !== user.id) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' games' });
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
    const user = await User.findOne({ where: { user_id: req.params.user_id } });
    const game = await Game.findByPk(req.params.game_id);
    
    if (!user || !game) {
      return res.status(404).json({ error: 'User or Game not found' });
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
    
    // Verify that the requested user_id matches the authenticated user
    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot modify other users\' games' });
    }
    
    const user = await User.findOne({ where: { user_id: userId } });
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
    
    // Verify that the requested user_id matches the authenticated user
    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot import games for other users' });
    }
    
    const { bgg_username } = req.body;

    const user = await User.findOne({ where: { user_id: userId } });
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




