// routes/ballot.js
// Ballot CRUD API endpoints for game voting on events
const express = require('express');
const { Op, UniqueConstraintError } = require('sequelize');
const {
  Event,
  EventBallotOption,
  EventBallotVote,
  EventRsvp,
  Game,
  User,
  sequelize,
} = require('../models');
const { validateBallotOptions, validateBallotVote } = require('../middleware/validators');
const {
  isOwnerOrAdmin,
  isMemberOrHigher,
  canReadEventScopedSurface,
} = require('../services/authorizationService');
const router = express.Router();

/**
 * Close the ballot: count votes, determine winner or tie, update event
 * @param {Object} event - Event Sequelize instance
 * @param {Array} options - EventBallotOption instances with EventBallotVotes included
 */
async function closeBallot(event, options) {
  // Count votes per option
  const voteCounts = options.map(opt => ({
    option: opt,
    count: opt.EventBallotVotes ? opt.EventBallotVotes.length : 0,
  }));

  const maxVotes = Math.max(...voteCounts.map(v => v.count), 0);

  if (maxVotes === 0) {
    // No votes cast -- organizer must pick fallback
    event.ballot_status = 'closed';
    await event.save();
    return { tied: false, noVotes: true };
  }

  const winners = voteCounts.filter(v => v.count === maxVotes);

  if (winners.length === 1) {
    // Single winner
    const winner = winners[0].option;
    if (winner.game_id) {
      event.game_id = winner.game_id;
    }
    event.ballot_status = 'closed';
    await event.save();
    return { tied: false, noVotes: false, winner: winner };
  }

  // Tie -- organizer must resolve
  event.ballot_status = 'closed';
  await event.save();
  return { tied: true, noVotes: false, tiedOptions: winners.map(w => w.option) };
}

// ============================================
// GET /:eventId -- Get ballot for an event
// ============================================
router.get('/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.user_id;

    // Phase 87.1 (BINT-02, D-11): resolve the caller to Users.id once for the
    // user_voted compute below (votes are keyed on user_uuid post-cutover). A
    // null resolve leaves caller undefined → user_voted is false everywhere
    // (fail-closed; canReadEventScopedSurface already gates access).
    const caller = await User.findOne({
      where: { user_id: userId },
      attributes: ['id'],
    });
    const callerUuid = caller ? caller.id : null;

    // Find event with ballot options and votes
    const event = await Event.findByPk(eventId, {
      include: [
        {
          model: EventBallotOption,
          include: [
            { model: EventBallotVote },
            { model: Game, attributes: ['id', 'name', 'thumbnail_url'] },
          ],
          order: [['display_order', 'ASC']],
        },
      ],
    });

    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Phase 71.1: event-scoped read access. Game-only participants can read
    // the ballot for the event they joined. Helper resolves the Event again
    // internally — discard its bare event; we keep the includes-laden one
    // already loaded above for downstream rendering.
    const { allowed } = await canReadEventScopedSurface(userId, eventId);
    if (!allowed) {
      return res.status(403).json({ error: 'Only event participants and group members can view the ballot' });
    }

    // If no ballot exists
    if (!event.ballot_status && (!event.EventBallotOptions || event.EventBallotOptions.length === 0)) {
      return res.json({ ballot_status: null });
    }

    // Lazy auto-close: if rsvp_deadline passed and ballot is still open
    let closeResult = null;
    if (event.rsvp_deadline && new Date(event.rsvp_deadline) < new Date() && event.ballot_status === 'open') {
      closeResult = await closeBallot(event, event.EventBallotOptions || []);
      // Reload event to get updated values
      await event.reload({
        include: [
          {
            model: EventBallotOption,
            include: [
              { model: EventBallotVote },
              { model: Game, attributes: ['id', 'name', 'thumbnail_url'] },
            ],
          },
        ],
      });
    }

    // Check if user is organizer (owner/admin)
    const isOrganizer = await isOwnerOrAdmin(userId, event.group_id);

    const options = event.EventBallotOptions || [];

    // Determine winner info
    let winner = null;
    if (event.ballot_status === 'closed' && event.game_id) {
      // Find the winning option by game_id
      const winningOption = options.find(opt => opt.game_id === event.game_id);
      if (winningOption) {
        winner = { game_id: winningOption.game_id, game_name: winningOption.game_name };
      } else {
        // game_id was set but not found in options (edge case); look up game directly
        const game = await Game.findByPk(event.game_id, { attributes: ['id', 'name'] });
        if (game) {
          winner = { game_id: game.id, game_name: game.name };
        }
      }
    }

    // Determine tie-break / fallback state
    const needsTieBreak = event.ballot_status === 'closed' && !event.game_id && closeResult?.tied === true;
    const needsFallbackPick = event.ballot_status === 'closed' && !event.game_id && closeResult?.noVotes === true;

    // Also detect tie/fallback from persisted state (not just fresh close)
    const persistedNeedsTieBreak = event.ballot_status === 'closed' && !event.game_id && !needsFallbackPick;
    const persistedNeedsFallbackPick = event.ballot_status === 'closed' && !event.game_id && options.every(opt => !opt.EventBallotVotes || opt.EventBallotVotes.length === 0);

    if (isOrganizer) {
      // Organizer response: includes vote counts
      const tiedOptions = (needsTieBreak || persistedNeedsTieBreak) ? (() => {
        const maxVotes = Math.max(...options.map(opt => (opt.EventBallotVotes || []).length), 0);
        if (maxVotes === 0) return null;
        return options
          .filter(opt => (opt.EventBallotVotes || []).length === maxVotes)
          .map(opt => ({ id: opt.id, game_id: opt.game_id, game_name: opt.game_name }));
      })() : null;

      return res.json({
        ballot_status: event.ballot_status,
        rsvp_deadline: event.rsvp_deadline,
        options: options
          .sort((a, b) => a.display_order - b.display_order)
          .map(opt => ({
            id: opt.id,
            game_id: opt.game_id,
            game_name: opt.game_name,
            display_order: opt.display_order,
            vote_count: (opt.EventBallotVotes || []).length,
            user_voted: (opt.EventBallotVotes || []).some(v => v.user_uuid === callerUuid),
          })),
        winner,
        needs_tie_break: needsTieBreak || (persistedNeedsTieBreak && !persistedNeedsFallbackPick),
        needs_fallback_pick: needsFallbackPick || persistedNeedsFallbackPick,
        tied_options: tiedOptions,
      });
    }

    // Non-organizer voter response: own vote state only, no vote counts
    return res.json({
      ballot_status: event.ballot_status,
      rsvp_deadline: event.rsvp_deadline,
      options: options
        .sort((a, b) => a.display_order - b.display_order)
        .map(opt => ({
          id: opt.id,
          game_id: opt.game_id,
          game_name: opt.game_name,
          display_order: opt.display_order,
          user_voted: (opt.EventBallotVotes || []).some(v => v.user_uuid === callerUuid),
        })),
      winner,
    });
  } catch (error) {
    console.error('Error fetching ballot:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /:eventId/options -- Create/set ballot options (organizer only)
// ============================================
router.post('/:eventId/options', validateBallotOptions, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.user_id;
    const { options } = req.body;

    // Phase 87.5 (BINT-02, PR-1): resolve the verified caller to Users.id ONCE.
    // The creator FK is now created_by_uuid (UUID), so the authz compare + the
    // first-creation stamp both key on this UUID, never the Auth0 sub. A null
    // resolve → callerUuid null → isCreator false → the ballot falls to
    // owner/admin-only (never a client-asserted creator identity).
    const caller = await User.findOne({
      where: { user_id: userId },
      attributes: ['id'],
    });
    const callerUuid = caller ? caller.id : null;

    // Find event
    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Require rsvp_deadline
    if (!event.rsvp_deadline) {
      return res.status(400).json({ error: 'Event must have an RSVP deadline to create a ballot' });
    }

    // Phase 87 (T-87-01): read the ballot's current creator BEFORE any destroy
    // so we can enforce creator-based replace/wipe authz AND preserve the
    // original creator on replace. Phase 87.5: project created_by_uuid — the UUID
    // creator FK the authz compares against. Projecting the old created_by would
    // read undefined for created_by_uuid and silently kill creator authz.
    const existing = await EventBallotOption.findOne({
      where: { event_id: eventId },
      attributes: ['created_by_uuid'],
    });

    // Authz on the caller's server-resolved Users.id (Phase 83 default-deny —
    // never a client-supplied id). isCreator REQUIRES current membership too, so a
    // creator later removed from the group cannot replace/wipe (EoP fix).
    const isAdmin = await isOwnerOrAdmin(userId, event.group_id);
    const isMember = await isMemberOrHigher(userId, event.group_id);
    const isCreator = !!existing && existing.created_by_uuid !== null && existing.created_by_uuid === callerUuid;

    if (existing) {
      // Replacing/wiping an existing ballot: creator (still a member) OR
      // owner/admin. Legacy created_by IS NULL → isCreator false → owner/admin
      // only (D-05).
      if (!(isAdmin || (isCreator && isMember))) {
        return res.status(403).json({ error: 'Only the ballot creator or a group owner/admin can replace or wipe ballot options' });
      }
    } else if (!isMember) {
      // First-ever creation: keep the existing member-or-higher gate.
      return res.status(403).json({ error: 'Pending members cannot create ballot options', required_role: 'member' });
    }

    // Preserve the ballot's original creator UUID on replace; stamp the actor's
    // UUID on first-ever creation. An owner/admin edit must NOT overwrite
    // created_by_uuid with the editor's id (#8).
    const preservedCreator = existing?.created_by_uuid ?? callerUuid;

    // BulkCreate new options
    const optionRows = options.map((opt, index) => ({
      event_id: eventId,
      game_id: opt.game_id || null,
      game_name: opt.game_name,
      display_order: index,
      created_by_uuid: preservedCreator,
    }));

    // Atomic replace (T-87-02): destroy + bulkCreate (+ status flip) in ONE
    // managed transaction so a mid-op failure rolls back → no zero-option
    // ballot. destroy CASCADE-deletes votes on removed options.
    const t = await sequelize.transaction();
    let created;
    try {
      await EventBallotOption.destroy({ where: { event_id: eventId }, transaction: t });
      created = await EventBallotOption.bulkCreate(optionRows, { transaction: t });
      if (event.ballot_status !== 'open') {
        event.ballot_status = 'open';
        await event.save({ transaction: t });
      }
      await t.commit();
    } catch (txErr) {
      await t.rollback();
      throw txErr;
    }

    return res.status(201).json({
      ballot_status: 'open',
      options: created.map(opt => ({
        id: opt.id,
        game_id: opt.game_id,
        game_name: opt.game_name,
        display_order: opt.display_order,
      })),
    });
  } catch (error) {
    console.error('Error creating ballot options:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// PUT /:eventId/options -- Update ballot options (organizer only, before close)
// ============================================
router.put('/:eventId/options', validateBallotOptions, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.user_id;
    const { options } = req.body;

    // Phase 87.5 (BINT-02, PR-1): resolve the verified caller to Users.id ONCE for
    // the UUID-keyed creator authz + preserve-on-replace below (see the POST handler
    // note). A null resolve → callerUuid null → isCreator false → owner/admin-only.
    const caller = await User.findOne({
      where: { user_id: userId },
      attributes: ['id'],
    });
    const callerUuid = caller ? caller.id : null;

    // Find event
    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Must be open
    if (event.ballot_status !== 'open') {
      return res.status(400).json({ error: 'Cannot update options on a closed ballot' });
    }

    // Phase 87 (T-87-01): read the ballot's current creator BEFORE any destroy
    // so we can enforce creator-based replace/wipe authz AND preserve the
    // original creator on replace. Phase 87.5: project created_by_uuid — the UUID
    // creator FK the authz compares against (projecting created_by would read
    // undefined for created_by_uuid and silently kill creator authz).
    const existing = await EventBallotOption.findOne({
      where: { event_id: eventId },
      attributes: ['created_by_uuid'],
    });

    // Authz on the caller's server-resolved Users.id (Phase 83 default-deny —
    // never a client-supplied id). isCreator REQUIRES current membership too, so a
    // creator later removed from the group cannot replace/wipe (EoP fix).
    const isAdmin = await isOwnerOrAdmin(userId, event.group_id);
    const isMember = await isMemberOrHigher(userId, event.group_id);
    const isCreator = !!existing && existing.created_by_uuid !== null && existing.created_by_uuid === callerUuid;

    if (existing) {
      // Replacing/wiping an existing ballot: creator (still a member) OR
      // owner/admin. Legacy created_by IS NULL → isCreator false → owner/admin
      // only (D-05).
      if (!(isAdmin || (isCreator && isMember))) {
        return res.status(403).json({ error: 'Only the ballot creator or a group owner/admin can replace or wipe ballot options' });
      }
    } else if (!isMember) {
      // No existing options: keep the existing member-or-higher gate.
      return res.status(403).json({ error: 'Pending members cannot update ballot options', required_role: 'member' });
    }

    // Preserve the ballot's original creator UUID on replace; stamp the actor's
    // UUID if there were no existing options. An owner/admin edit must NOT
    // overwrite created_by_uuid with the editor's id (#8).
    const preservedCreator = existing?.created_by_uuid ?? callerUuid;

    // BulkCreate replacement options
    const optionRows = options.map((opt, index) => ({
      event_id: eventId,
      game_id: opt.game_id || null,
      game_name: opt.game_name,
      display_order: index,
      created_by_uuid: preservedCreator,
    }));

    // Atomic replace (T-87-02): destroy + bulkCreate in ONE managed
    // transaction so a mid-op failure rolls back → no zero-option ballot.
    // destroy CASCADE-deletes votes on removed options.
    const t = await sequelize.transaction();
    let created;
    try {
      await EventBallotOption.destroy({ where: { event_id: eventId }, transaction: t });
      created = await EventBallotOption.bulkCreate(optionRows, { transaction: t });
      await t.commit();
    } catch (txErr) {
      await t.rollback();
      throw txErr;
    }

    return res.json({
      ballot_status: 'open',
      options: created.map(opt => ({
        id: opt.id,
        game_id: opt.game_id,
        game_name: opt.game_name,
        display_order: opt.display_order,
      })),
    });
  } catch (error) {
    console.error('Error updating ballot options:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /:eventId/vote -- Toggle vote on an option (approval voting)
// ============================================
router.post('/:eventId/vote', validateBallotVote, async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.user_id;
    const { option_id } = req.body;

    // Find event
    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Must be open
    if (event.ballot_status !== 'open') {
      return res.status(400).json({ error: 'Voting is closed for this ballot' });
    }

    // POLL-06 (D-BALLOT-02 + D-BALLOT-06 + D-BALLOT-07):
    // Belt-and-suspenders gate. Apply to ALL ballots immediately, NO flag.
    //
    // 1. Event-scoped surface access — Phase 71.1 widened from active-group
    //    membership to canReadEventScopedSurface so a game-only participant
    //    (EventParticipation row, no UserGroup row) can vote on the event
    //    they joined. Closes the H-D edge case from POLL-06: a stale
    //    EventRsvp without any current scope-membership now fails this gate.
    // 2. Yes/Maybe RSVP for this event (D-BALLOT-02 — keep current scope).
    //    Look up the row WITHOUT a status filter so we can include the
    //    actual status in the 403 message ("...your RSVP is currently no").
    const { allowed } = await canReadEventScopedSurface(userId, eventId);
    if (!allowed) {
      return res.status(403).json({
        error: 'Only event participants can vote on the ballot',
      });
    }

    // Phase 87.1 (BINT-02, D-11): resolve the verified caller to Users.id ONCE and
    // reuse it for the RSVP-eligibility gate AND the vote find/create below. Fail-
    // closed with the existing participant 403 envelope (never a raw 500) if the
    // caller has no Users row.
    const caller = await User.findOne({
      where: { user_id: userId },
      attributes: ['id'],
    });
    if (!caller) {
      return res.status(403).json({
        error: 'Only event participants can vote on the ballot',
      });
    }

    // Yes/Maybe RSVP-eligibility gate. Key on user_uuid — post-cutover EventRsvp
    // rows carry only user_uuid, so an Auth0-keyed gate would 403 EVERY vote.
    const rsvp = await EventRsvp.findOne({
      where: { event_id: eventId, user_uuid: caller.id },
    });
    if (!rsvp || !['yes', 'maybe'].includes(rsvp.status)) {
      const currentStatus = rsvp?.status || 'not set';
      return res.status(403).json({
        error: `Only attendees who RSVPed Yes or Maybe can vote — your RSVP is currently ${currentStatus}`,
      });
    }

    // Verify the option belongs to this event
    const option = await EventBallotOption.findOne({
      where: { id: option_id, event_id: eventId },
    });
    if (!option) {
      return res.status(404).json({ error: 'Ballot option not found for this event' });
    }

    // Toggle vote: if exists, delete; if not, create. Phase 87.1 (D-11): key on
    // user_uuid (Users.id) — the old Auth0-string user_id column was removed from
    // the model in Plan 09.
    const existingVote = await EventBallotVote.findOne({
      where: { option_id, user_uuid: caller.id },
    });

    if (existingVote) {
      await existingVote.destroy();
      return res.json({ voted: false });
    }

    // Phase 87 (T-87-03): absorb the (option_id, user_uuid) unique-constraint
    // race. A concurrent duplicate double-click already created the row → the
    // vote is idempotently "on"; return success instead of 500.
    try {
      await EventBallotVote.create({ option_id, user_uuid: caller.id });
    } catch (voteErr) {
      if (voteErr instanceof UniqueConstraintError) {
        return res.json({ voted: true });
      }
      throw voteErr;
    }
    return res.json({ voted: true });
  } catch (error) {
    console.error('Error toggling vote:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================
// POST /:eventId/resolve-tie -- Organizer picks winner from tie
// ============================================
router.post('/:eventId/resolve-tie', async (req, res) => {
  try {
    const { eventId } = req.params;
    const userId = req.user.user_id;
    const { option_id } = req.body;

    if (!option_id) {
      return res.status(400).json({ error: 'option_id is required' });
    }

    // Find event
    const event = await Event.findByPk(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Must be closed
    if (event.ballot_status !== 'closed') {
      return res.status(400).json({ error: 'Ballot must be closed to resolve a tie' });
    }

    // Must not already have a game_id (i.e., tie or no-vote scenario)
    if (event.game_id) {
      return res.status(400).json({ error: 'Ballot already has a winner' });
    }

    // Verify user is organizer (owner/admin)
    const organizer = await isOwnerOrAdmin(userId, event.group_id);
    if (!organizer) {
      return res.status(403).json({ error: 'Only group owners and admins can resolve ties' });
    }

    // Verify option belongs to this event
    const option = await EventBallotOption.findOne({
      where: { id: option_id, event_id: eventId },
    });
    if (!option) {
      return res.status(404).json({ error: 'Ballot option not found for this event' });
    }

    // Set event game_id if option has one
    if (option.game_id) {
      event.game_id = option.game_id;
    }
    await event.save();

    return res.json({
      winner: {
        game_id: option.game_id,
        game_name: option.game_name,
      },
    });
  } catch (error) {
    console.error('Error resolving tie:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
