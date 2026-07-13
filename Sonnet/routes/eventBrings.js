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

    // Phase 87.3 PR-C (plan 09, Req 1): nested User include no longer carries
    // the sub — id/username only (PR-B cut every nested-sub reader to `.id`).
    const brings = await EventBring.findAll({
      where: { event_id },
      include: [
        { model: User, attributes: ['id', 'username'] },
        { model: Game, attributes: ['id', 'name', 'thumbnail_url'] },
      ],
      order: [
        [User, 'username', 'ASC'],
        [Game, 'name', 'ASC'],
      ],
    });

    // PR-C (Req 2 carry-UUID lock): each row's flat user_id carries the nested
    // User.id UUID — name stable, no drop (BringSummary/BringGamePicker key on
    // the nested id; the flat field flips in lockstep with the roster alias).
    const shaped = brings.map((b) => {
      const json = b.toJSON();
      json.user_id = json.User?.id;
      return json;
    });

    return res.json(shaped);
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

    // Phase 87.1 (BINT-02, D-11): resolve the verified caller to Users.id ONCE and
    // reuse it for every gate/write below (RSVP-yes gate, bring destroy/create, the
    // transactional re-fetch). Fail-closed with the existing 404 envelope (never a
    // raw 500) if the caller has no Users row.
    const caller = await User.findOne({ where: { user_id: userId } });
    if (!caller) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify user has RSVP 'yes' for this event. Key on user_uuid — post-cutover
    // EventRsvp rows carry only user_uuid, so an Auth0-keyed gate would 403 EVERY PUT.
    const rsvp = await EventRsvp.findOne({
      where: { event_id, user_uuid: caller.id, status: 'yes' },
    });
    if (!rsvp) {
      return res.status(403).json({ error: 'Must RSVP yes to mark games to bring' });
    }

    // If empty array, just clear all brings
    if (game_ids.length === 0) {
      await EventBring.destroy({ where: { event_id, user_uuid: caller.id } });
      return res.json([]);
    }

    // Verify ownership: UserGame.user_id is UUID (User.id), NOT Auth0 string
    // (NON-SITE — already UUID-keyed, left unchanged).
    const ownedGames = await UserGame.findAll({
      where: { user_id: caller.id, game_id: game_ids },
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

    // Transaction: clear existing + bulk create new. Phase 87.1 (D-11): key the
    // destroy, the create, AND the transactional re-fetch READ on user_uuid — an
    // Auth0-keyed re-fetch would return an empty body post-cutover (the UUID-keyed
    // rows match nothing on the Auth0 keyspace). The old Auth0-string user_id column
    // was removed from the model in Plan 09.
    const result = await sequelize.transaction(async (t) => {
      await EventBring.destroy({
        where: { event_id, user_uuid: caller.id },
        transaction: t,
      });

      const records = game_ids.map(game_id => ({
        event_id,
        user_uuid: caller.id,
        game_id,
      }));

      await EventBring.bulkCreate(records, { transaction: t });

      // Re-fetch with includes
      return EventBring.findAll({
        where: { event_id, user_uuid: caller.id },
        include: [
          { model: Game, attributes: ['id', 'name', 'thumbnail_url'] },
        ],
        order: [[Game, 'name', 'ASC']],
        transaction: t,
      });
    });

    // PR-C (write-path response): this endpoint is self-only, so every returned
    // row belongs to the caller. Serialize the flat user_id as the caller's
    // resolved Users.id UUID (Req 2 — name stable, value UUID, never the sub).
    const shaped = result.map((r) => {
      const json = r.toJSON();
      json.user_id = caller.id;
      return json;
    });

    return res.json(shaped);
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

    // Only the owner can remove their own bring. Phase 87.1 (D-11): resolve the
    // verified caller to Users.id and compare user_uuid. Fail-closed: a null
    // resolve (no Users row) is treated as non-owner → 403, never a raw 500.
    const caller = await User.findOne({
      where: { user_id: userId },
      attributes: ['id'],
    });
    if (!caller || bring.user_uuid !== caller.id) {
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
