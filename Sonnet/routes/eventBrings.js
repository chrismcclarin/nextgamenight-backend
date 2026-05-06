// routes/eventBrings.js
// CRUD API endpoints for event bring commitments (games users will bring)
const express = require('express');
const { EventBring, EventRsvp, Event, User, UserGame, Game, sequelize } = require('../models');
const { verifyAuth0Token } = require('../middleware/auth0');
const { canReadEventScopedSurface } = require('../services/authorizationService');
const router = express.Router();

// GET /event/:event_id -- Fetch all brings for an event
router.get('/event/:event_id', verifyAuth0Token, async (req, res) => {
  try {
    const { event_id } = req.params;
    const userId = req.user.user_id;

    // Phase 71.1: event-scoped read access. Game-only participants can view
    // brings for the event they joined. Helper resolves Event internally.
    const { allowed, event } = await canReadEventScopedSurface(userId, event_id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (!allowed) {
      return res.status(403).json({ error: 'You must be a participant on this event to view brings' });
    }

    const brings = await EventBring.findAll({
      where: { event_id },
      include: [
        { model: User, attributes: ['id', 'username', 'user_id'] },
        { model: Game, attributes: ['id', 'name', 'thumbnail_url'] },
      ],
      order: [
        [User, 'username', 'ASC'],
        [Game, 'name', 'ASC'],
      ],
    });

    return res.json(brings);
  } catch (error) {
    console.error('Error fetching event brings:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// PUT /event/:event_id/my-brings -- Bulk replace user's bring list for an event
router.put('/event/:event_id/my-brings', verifyAuth0Token, async (req, res) => {
  try {
    const { event_id } = req.params;
    const userId = req.user.user_id;
    const { game_ids } = req.body;

    // Validate input
    if (!Array.isArray(game_ids)) {
      return res.status(400).json({ error: 'game_ids must be an array' });
    }

    // Verify event exists
    const event = await Event.findByPk(event_id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Verify user has RSVP 'yes' for this event
    const rsvp = await EventRsvp.findOne({
      where: { event_id, user_id: userId, status: 'yes' },
    });
    if (!rsvp) {
      return res.status(403).json({ error: 'Must RSVP yes to mark games to bring' });
    }

    // If empty array, just clear all brings
    if (game_ids.length === 0) {
      await EventBring.destroy({ where: { event_id, user_id: userId } });
      return res.json([]);
    }

    // Auth0->UUID bridge: find User record to get UUID for UserGame lookup
    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify ownership: UserGame.user_id is UUID (User.id), NOT Auth0 string
    const ownedGames = await UserGame.findAll({
      where: { user_id: user.id, game_id: game_ids },
      attributes: ['game_id'],
    });
    const ownedGameIds = ownedGames.map(ug => ug.game_id);
    const unownedGameIds = game_ids.filter(gid => !ownedGameIds.includes(gid));

    if (unownedGameIds.length > 0) {
      return res.status(400).json({
        error: 'You can only bring games you own',
        invalid_game_ids: unownedGameIds,
      });
    }

    // Transaction: clear existing + bulk create new
    const result = await sequelize.transaction(async (t) => {
      await EventBring.destroy({
        where: { event_id, user_id: userId },
        transaction: t,
      });

      const records = game_ids.map(game_id => ({
        event_id,
        user_id: userId,
        game_id,
      }));

      await EventBring.bulkCreate(records, { transaction: t });

      // Re-fetch with includes
      return EventBring.findAll({
        where: { event_id, user_id: userId },
        include: [
          { model: Game, attributes: ['id', 'name', 'thumbnail_url'] },
        ],
        order: [[Game, 'name', 'ASC']],
        transaction: t,
      });
    });

    return res.json(result);
  } catch (error) {
    console.error('Error updating brings:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// DELETE /:bring_id -- Remove a single bring
router.delete('/:bring_id', verifyAuth0Token, async (req, res) => {
  try {
    const { bring_id } = req.params;
    const userId = req.user.user_id;

    const bring = await EventBring.findByPk(bring_id);
    if (!bring) {
      return res.status(404).json({ error: 'Bring record not found' });
    }

    // Only the owner can remove their own bring
    if (bring.user_id !== userId) {
      return res.status(403).json({ error: 'You can only remove your own brings' });
    }

    await bring.destroy();
    return res.status(200).json({ message: 'Bring removed' });
  } catch (error) {
    console.error('Error removing bring:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
