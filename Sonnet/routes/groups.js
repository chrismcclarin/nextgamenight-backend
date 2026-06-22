// routes/groups.js
const express = require('express');
const crypto = require('crypto');
const {
  Group,
  User,
  UserGroup,
  Event,
  Game,
  EventParticipation,
  EventRsvp,
  EventBring,
  EventBallotOption,
  EventBallotVote,
  GameReview,
  UserGame,
  sequelize,
} = require('../models');
const { Op } = require('sequelize');
const router = express.Router();
const { validateGroupCreate, validateGroupUpdate, validateUUID } = require('../middleware/validators');
const {
  getUserRoleInGroup,
  isOwnerOrAdmin,
  isOwner,
  isActiveMember,
  stripMemberPII,
} = require('../services/authorizationService');

// Phase 71.1-02 (post-checkpoint scope expansion): when a user leaves a group
// (voluntary self-leave OR admin/owner removal), cascade-delete their per-user
// rows on FUTURE group events so organizers don't see floating RSVP / brings /
// ballot-vote rows with no participant record. Past/completed events are
// preserved verbatim — they carry historical attendance, score, and placement
// data that must never be rewritten by a membership change.
//
// Scope: events where `start_date > NOW()` AND status IN ('scheduled', 'in_progress').
//
// FK type asymmetry (load-bearing — do NOT normalize):
//   - EventParticipation.user_id  = UUID    (User.id)
//   - EventRsvp.user_id           = STRING  (Auth0 user_id)
//   - EventBring.user_id          = STRING  (Auth0 user_id)
//   - EventBallotVote.user_id     = STRING  (Auth0 user_id) — joined to event
//                                          via EventBallotOption.event_id
// The asymmetry is required by email-link RSVP /respond, eventBrings my-brings
// gates, and the game-only-participant flow (Phase 71.1). See
// `.planning/phases/71.1-game-only-participant-read-access/71.1-01-SUMMARY.md`.
//
// Audit log: this helper deliberately does NOT write EventAuditLog
// `remove_participant` rows. Those are reserved for the per-event Remove flow
// (Phase 65-01 EVT-08) which triggers the silent-welcome-back suppression on
// re-join. A leave-group cascade should NOT silence the per-event
// welcome-back if the user later QR-rejoins a specific event — they left the
// group, not any individual event explicitly.
async function cascadeDeleteFutureEventDataOnLeaveGroup({
  authUserId,
  userUuid,
  group_id,
  transaction,
}) {
  // Scope: any event whose start_date is in the future, regardless of status.
  // We deliberately do NOT filter on status. Two reasons:
  //   1. Production data has been observed with future events stamped
  //      `status='completed'` (data hygiene bug, separate todo). A status
  //      filter would silently exclude them and leak forward-commitment rows.
  //   2. The cascade is about removing forward intent — if the event hasn't
  //      happened yet, the leaving user's RSVP/brings/vote on it is moot
  //      regardless of whether it's scheduled, in_progress, completed, or
  //      cancelled. Past events stay untouched (history preserved).
  const now = new Date();
  const futureEvents = await Event.findAll({
    where: {
      group_id,
      start_date: { [Op.gt]: now },
    },
    attributes: ['id'],
    transaction,
  });
  if (futureEvents.length === 0) return;
  const futureEventIds = futureEvents.map(e => e.id);

  await EventParticipation.destroy({
    where: { event_id: { [Op.in]: futureEventIds }, user_id: userUuid },
    transaction,
  });
  await EventRsvp.destroy({
    where: { event_id: { [Op.in]: futureEventIds }, user_id: authUserId },
    transaction,
  });
  await EventBring.destroy({
    where: { event_id: { [Op.in]: futureEventIds }, user_id: authUserId },
    transaction,
  });

  // EventBallotVote is keyed by option_id, not event_id — JOIN through
  // EventBallotOption to scope votes to this group's future events.
  const futureBallotOptions = await EventBallotOption.findAll({
    where: { event_id: { [Op.in]: futureEventIds } },
    attributes: ['id'],
    transaction,
  });
  if (futureBallotOptions.length > 0) {
    await EventBallotVote.destroy({
      where: {
        option_id: { [Op.in]: futureBallotOptions.map(o => o.id) },
        user_id: authUserId,
      },
      transaction,
    });
  }
}

// Get all groups for a user
// user_id is now extracted from verified JWT token (req.user.user_id)
router.get('/user/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token, not from params
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify that the requested user_id matches the authenticated user
    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' groups' });
    }

    let user = await User.findOne({
      where: { user_id: userId }
    });

    // If user doesn't exist, auto-create using Auth0 token info
    if (!user) {
      // For Google sign-in, email should be available in the token
      const userEmail = req.user.email;
      if (!userEmail) {
        console.warn(`No email found in token for user ${userId}. Available fields:`, {
          name: req.user.name,
          nickname: req.user.nickname,
          given_name: req.user.given_name,
          family_name: req.user.family_name,
        });
      }

      // Email is required, so use a valid email format if not provided
      // This should rarely happen with Google sign-in
      const finalEmail = userEmail || `${userId.replace(/[|:]/g, '-')}@auth0.local`;
      const userName = req.user.name || req.user.nickname || req.user.given_name || req.user.email?.split('@')[0] || 'User';

      try {
        const [newUser, created] = await User.findOrCreate({
          where: { user_id: userId },
          defaults: {
            user_id: userId,
            email: finalEmail,
            username: userName,
          }
        });
        user = newUser;

        if (created) {
          console.log(`Auto-created user: ${user.user_id} (${user.username}) with email: ${user.email}`);
        }
      } catch (error) {
        // If creation fails (e.g., email already exists), try to find the user
        console.error('Error auto-creating user:', error.message);
        user = await User.findOne({ where: { user_id: userId } });
        if (!user) {
          throw error; // Re-throw if we still can't find/create the user
        }
      }
    }
    
    // Get all groups for this user using UserGroup join
    const userGroups = await UserGroup.findAll({
      where: { user_id: user.user_id, status: 'active' }, // Use user.user_id (Auth0 string) not user.id (UUID)
      attributes: ['group_id']
    });
    
    const groupIds = userGroups.map(ug => ug.group_id);
    
    // Get all groups with their members and recent events
    const groups = await Group.findAll({
      where: { id: groupIds },
      include: [
        {
          model: User,
          // BSEC-01 / BE-043: drop `email` from this list-all read (PII leak).
          // The durable safe-by-default fix is the User defaultScope (D-03 / 83-06).
          attributes: ['id', 'username', 'user_id'],
          through: { where: { status: 'active' }, attributes: ['role', 'joined_at'] }
        },
        {
          model: Event,
          limit: 1,
          order: [['createdAt', 'DESC']],
          include: [{
            model: Game,
            attributes: ['name', 'image_url', 'theme']
          }]
        }
      ]
    });
    
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new group
router.post('/', validateGroupCreate, async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { name } = req.body;

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const group = await Group.create({
      name,
      group_id: `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    });
    
    // Creator is set as 'owner'
    await UserGroup.create({
      user_id: user.user_id, // Use user.user_id (Auth0 string) not user.id (UUID)
      group_id: group.id,
      role: 'owner'
    });
    
    res.json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get a single group by ID
router.get('/:group_id', validateUUID('group_id'), async (req, res) => {
  try {
    // BSEC-01 / BE-043: this was OPEN — any authenticated user could read any
    // group's whole row INCLUDING `invite_token` (a join secret). Two fixes:
    //   1) Object-level gate: the caller must be an active member of the group.
    //   2) Stop the `invite_token` leak — now handled durably by the
    //      `Group.defaultScope` excluding `invite_token` (83-06, BSEC-01),
    //      which supersedes the per-query exclude 83-05 applied here. The
    //      default read below is fail-closed; the membership GATE remains the
    //      load-bearing authz fix.
    const callerAuth0Id = req.user?.user_id;
    if (!callerAuth0Id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id } = req.params;

    const hasAccess = await isActiveMember(callerAuth0Id, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }

    // defaultScope already excludes invite_token (safe-by-default).
    const group = await Group.findByPk(group_id);

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all users in a group.
//
// Phase 71.1 made this endpoint role-aware (Path 1 in CONTEXT — branched
// response shape inside this handler so the frontend has a single uniform
// data-fetch shape):
//
//   - Group-member caller (any active role): full roster, current behavior
//     unchanged. Email/phone/calendar fields exposed as before.
//   - Game-only caller (no UserGroup row but at least one EventParticipation
//     row on a non-cancelled event in this group): roster filtered to
//     event participants only, PII stripped, AND the caller's own row
//     injected with UserGroup=null. The injection is a load-bearing
//     cross-plan contract — Plan 02 frontend reads it as the SINGLE
//     authoritative source of (a) userScope='game-only' detection and
//     (b) the caller's User.id UUID for the Leave-event DELETE call.
//   - Neither (no UserGroup row AND no EventParticipation row in this
//     group): 403.
//
// Previously this endpoint had NO authz gate at all (T-71.1-02 information
// disclosure). The new gate is intentional and tightens existing behavior.
router.get('/:group_id/users', async (req, res) => {
  try {
    const callerAuth0Id = req.user?.user_id;
    if (!callerAuth0Id) return res.status(401).json({ error: 'Unauthorized' });

    const { group_id } = req.params;

    const group = await Group.findByPk(group_id, {
      include: [{
        model: User,
        // BSEC-01 (D-03): email removed — the member-caller branch returns this
        // roster raw (group.Users), so email here leaked PII to group members.
        // The game-only branch already strips PII via stripMemberPII.
        attributes: ['id', 'username', 'user_id'],
        through: { where: { status: 'active' }, attributes: ['role', 'joined_at'] },
      }],
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Branch 1 — group-member caller. Existing behavior preserved verbatim.
    const callerIsMember = await isActiveMember(callerAuth0Id, group_id);
    if (callerIsMember) {
      return res.json(group.Users || []);
    }

    // Branch 2 — game-only caller. Must have at least one EventParticipation
    // row on a non-cancelled event in THIS group. Resolve caller User UUID
    // first (EventParticipation.user_id is UUID, NOT Auth0 string).
    const callerUser = await User.findOne({ where: { user_id: callerAuth0Id } });
    if (!callerUser) return res.status(403).json({ error: 'Access denied' });

    const callerEventsInGroup = await Event.findAll({
      where: { group_id, status: { [Op.ne]: 'cancelled' } },
      attributes: ['id'],
      include: [{
        model: EventParticipation,
        where: { user_id: callerUser.id },
        required: true,
        attributes: ['id'],
      }],
    });

    if (callerEventsInGroup.length === 0) {
      // Branch 3 — neither group-member nor game-only.
      return res.status(403).json({ error: 'Access denied' });
    }

    // Caller is a game-only participant. Build the filtered roster:
    // co-attendees on the events the caller is participating in.
    const callerEventIds = callerEventsInGroup.map(e => e.id);
    const coParticipations = await EventParticipation.findAll({
      where: { event_id: { [Op.in]: callerEventIds } },
      attributes: ['user_id'], // User.id UUIDs
    });
    const coParticipantUuids = [...new Set(coParticipations.map(p => p.user_id))];

    // The full roster from the Group.Users include is keyed by User.id UUID.
    // Filter to co-attendees only, then strip PII. Role badges (User.UserGroup)
    // are preserved for actual group members in the result so "who's running
    // this" is visible per CONTEXT decision.
    const rosterFromGroup = (group.Users || [])
      .filter(u => coParticipantUuids.includes(u.id))
      .map(u => stripMemberPII(u));

    // CRITICAL — Phase 71.1 cross-plan contract for Plan 02:
    // The caller is a game-only participant — they have no UserGroup row, so
    // group.Users will NEVER include them naturally. Inject a synthetic row
    // built from `callerUser` with UserGroup=null as the explicit signal the
    // frontend uses to (a) detect userScope='game-only' and (b) resolve the
    // caller's User.id UUID for the Leave-event DELETE path.
    const callerJson = callerUser.toJSON ? callerUser.toJSON() : callerUser;
    const callerRow = stripMemberPII({
      ...callerJson,
      UserGroup: null, // explicit null — game-only signal
    });

    // Dedupe by id in case any future include-graph change accidentally
    // surfaces the caller via group.Users.
    const rosterFiltered = [
      callerRow,
      ...rosterFromGroup.filter(u => u.id !== callerRow.id),
    ];

    return res.json(rosterFiltered);
  } catch (error) {
    console.error('Error fetching group users:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Add user to group (owner/admin only — BE-044)
router.post('/:group_id/users', async (req, res) => {
  try {
    const { user_id } = req.body;

    // BE-044 (BSEC-01): gate behind owner/admin. Without this any authenticated
    // caller could add arbitrary users to any group (object-level authz hole).
    const callerAuth0Id = req.user?.user_id;
    const hasPermission = await isOwnerOrAdmin(callerAuth0Id, req.params.group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can add members to a group' });
    }

    const user = await User.findOne({ where: { user_id } });
    const group = await Group.findByPk(req.params.group_id);

    if (!user || !group) {
      return res.status(404).json({ error: 'User or Group not found' });
    }
    
    await UserGroup.findOrCreate({
      where: {
        user_id: user.user_id, // Use user.user_id (Auth0 string) not user.id (UUID)
        group_id: group.id
      },
      defaults: {
        user_id: user.user_id, // Use user.user_id (Auth0 string) not user.id (UUID)
        group_id: group.id,
        role: 'member'
      }
    });

    res.json({ message: 'User added to group successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user role in group (only owner can do this)
router.put('/:group_id/users/:target_user_id/role', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { group_id, target_user_id } = req.params; // Target user to update
    const { role } = req.body; // New role: 'member', 'admin', or 'owner'
    
    // Only owner can change roles
    const requestingUser = await User.findOne({ where: { user_id: userId } });
    if (!requestingUser) {
      return res.status(404).json({ error: 'Requesting user not found' });
    }
    
    const isRequestingOwner = await isOwner(userId, group_id);
    if (!isRequestingOwner) {
      return res.status(403).json({ error: 'Only the group owner can change user roles' });
    }
    
    // Validate role
    if (!['member', 'admin', 'owner'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be member, admin, or owner' });
    }
    
    // Prevent changing owner's role (owner can't demote themselves)
    const targetUser = await User.findOne({ where: { user_id: target_user_id } });
    if (!targetUser) {
      return res.status(404).json({ error: 'Target user not found' });
    }
    
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_id: targetUser.user_id, // Use targetUser.user_id (Auth0 string) not targetUser.id (UUID)
        group_id: group_id,
        status: 'active'
      }
    });

    if (!targetUserGroup) {
      return res.status(404).json({ error: 'User is not a member of this group' });
    }

    // If trying to change own role and they're the owner, don't allow demotion
    if (requestingUser.id === targetUser.id && targetUserGroup.role === 'owner' && role !== 'owner') {
      return res.status(400).json({ error: 'Group owner cannot change their own role' });
    }
    
    // Update the role
    await targetUserGroup.update({ role });
    
    res.json({ message: 'User role updated successfully', role });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get (or lazily generate) the group's invite token
router.get('/:group_id/invite-token', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id } = req.params;

    // Any active member can view/share the QR invite
    const hasAccess = await isActiveMember(userId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // BSEC-01 (BE-043): withInviteToken — load-bearing token-stability fix.
    // The defaultScope excludes invite_token, so a default read would leave
    // group.invite_token undefined, making `if (!group.invite_token)` ALWAYS
    // true → the token would regenerate on every QR view (invalidating prior
    // links). The scope populates the real column so we only generate when
    // genuinely absent, and so res.json serializes the actual token.
    const group = await Group.scope('withInviteToken').findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Lazily generate invite token if not set
    if (!group.invite_token) {
      group.invite_token = crypto.randomBytes(32).toString('hex');
      await group.save();
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.json({
      invite_token: group.invite_token,
      invite_url: `${frontendUrl}/invite/group/${group.invite_token}`,
    });
  } catch (error) {
    console.error('Error getting group invite token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Regenerate the group's invite token (owner/admin only)
router.post('/:group_id/reset-invite-token', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id } = req.params;

    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can reset the invite token' });
    }

    // BSEC-01 (BE-043): withInviteToken — read the row with invite_token so the
    // rotated value is set on a fully-hydrated instance and serialized back.
    const group = await Group.scope('withInviteToken').findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    group.invite_token = crypto.randomBytes(32).toString('hex');
    await group.save();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.json({
      invite_token: group.invite_token,
      invite_url: `${frontendUrl}/invite/group/${group.invite_token}`,
    });
  } catch (error) {
    console.error('Error resetting group invite token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Public: preview group info from invite token (no auth required)
router.get('/invite-preview/:token', async (req, res) => {
  try {
    const group = await Group.findOne({
      where: { invite_token: req.params.token },
    });

    if (!group) {
      return res.status(404).json({ error: 'Invalid invite link' });
    }

    // Count active members
    const memberCount = await UserGroup.count({
      where: { group_id: group.id, status: 'active' },
    });

    res.json({
      group_name: group.name,
      group_description: group.description || null,
      member_count: memberCount,
      group_id: group.id,
    });
  } catch (error) {
    console.error('Error getting group invite preview:', error);
    res.status(500).json({ error: error.message });
  }
});

// Join a group by invite token (authenticated)
router.post('/join-by-token', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const group = await Group.findOne({
      where: { invite_token: token },
    });

    if (!group) {
      return res.status(404).json({ error: 'Invalid invite link' });
    }

    // Check for existing UserGroup
    const existingMembership = await UserGroup.findOne({
      where: { user_id: userId, group_id: group.id },
    });

    if (existingMembership) {
      // Already an active member
      if (existingMembership.status === 'active' && existingMembership.role !== 'pending') {
        return res.json({ already_member: true, group_id: group.id });
      }

      // Re-activate declined or pending membership as full member
      await existingMembership.update({
        role: 'member',
        status: 'active',
        joined_at: new Date(),
      });

      return res.json({ success: true, group_id: group.id });
    }

    // Create new membership -- CRITICAL: role is 'member' NOT 'pending' (QR invites bypass pending)
    await UserGroup.create({
      user_id: userId,
      group_id: group.id,
      role: 'member',
      status: 'active',
      joined_at: new Date(),
    });

    res.json({ success: true, group_id: group.id });
  } catch (error) {
    console.error('Error joining group by token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete group - owner only (must come before /:group_id/users/:target_user_id)
router.delete('/:group_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { group_id } = req.params;
    
    // Check if user is owner
    const hasPermission = await isOwner(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only the group owner can delete the group' });
    }
    
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    // Delete all event participations for events in this group
    const events = await Event.findAll({ where: { group_id } });
    const eventIds = events.map(e => e.id);
    if (eventIds.length > 0) {
      await EventParticipation.destroy({ where: { event_id: { [Op.in]: eventIds } } });
    }
    
    // Delete all events for this group
    await Event.destroy({ where: { group_id } });
    
    // Delete all game reviews for this group
    await GameReview.destroy({ where: { group_id } });
    
    // Delete all user-group associations
    await UserGroup.destroy({ where: { group_id } });
    
    // Finally, delete the group
    await group.destroy();
    
    res.json({ message: 'Group deleted successfully' });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Approve a pending member (owner/admin only)
router.post('/:group_id/users/:target_user_id/approve', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { group_id, target_user_id } = req.params;

    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can approve members' });
    }

    const decodedTargetId = decodeURIComponent(target_user_id);
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_id: decodedTargetId,
        group_id: group_id,
        status: 'active',
        role: 'pending',
      },
    });

    if (!targetUserGroup) {
      return res.status(404).json({ error: 'Pending member not found' });
    }

    await targetUserGroup.update({ role: 'member' });

    res.json({ success: true, message: 'Member approved' });
  } catch (error) {
    console.error('Error approving member:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reject a pending member (owner/admin only)
router.post('/:group_id/users/:target_user_id/reject', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { group_id, target_user_id } = req.params;

    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can reject members' });
    }

    const decodedTargetId = decodeURIComponent(target_user_id);
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_id: decodedTargetId,
        group_id: group_id,
        status: 'active',
        role: 'pending',
      },
    });

    if (!targetUserGroup) {
      return res.status(404).json({ error: 'Pending member not found' });
    }

    await targetUserGroup.destroy();

    res.json({ success: true, message: 'Member rejected and removed from group' });
  } catch (error) {
    console.error('Error rejecting member:', error);
    res.status(500).json({ error: error.message });
  }
});

// Leave a group voluntarily (any non-owner member)
router.post('/:group_id/leave', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { group_id } = req.params;

    const userGroup = await UserGroup.findOne({
      where: {
        user_id: userId,
        group_id: group_id,
        status: 'active',
      },
    });

    if (!userGroup) {
      return res.status(404).json({ error: 'You are not a member of this group' });
    }

    if (userGroup.role === 'owner') {
      return res.status(403).json({ error: 'Group owner cannot leave. Transfer ownership or delete the group.' });
    }

    // Phase 71.1-02: atomic membership removal + future-event cascade.
    // Resolve caller's User.id UUID inside the transaction so the cascade
    // helper can target EventParticipation rows (UUID-keyed) correctly.
    await sequelize.transaction(async (t) => {
      const callerRow = await User.findOne({
        where: { user_id: userId },
        attributes: ['id'],
        transaction: t,
      });
      if (callerRow) {
        await cascadeDeleteFutureEventDataOnLeaveGroup({
          authUserId: userId,
          userUuid: callerRow.id,
          group_id,
          transaction: t,
        });
      }
      await userGroup.destroy({ transaction: t });
    });

    res.json({ success: true, message: 'You have left the group' });
  } catch (error) {
    console.error('Error leaving group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Transfer group ownership to another active member (owner only)
// Atomically swaps the requesting owner -> 'admin' and target member -> 'owner' in a single transaction.
router.post('/:group_id/transfer-ownership', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { group_id } = req.params;
    const { new_owner_user_id } = req.body || {};

    // 1. Body validation
    if (!new_owner_user_id || typeof new_owner_user_id !== 'string') {
      return res.status(400).json({ error: 'new_owner_user_id is required' });
    }

    // 2. Self-transfer guard
    if (new_owner_user_id === userId) {
      return res.status(400).json({ error: 'Cannot transfer ownership to yourself' });
    }

    // 3. Requester must be the current active owner
    const requesterUg = await UserGroup.findOne({
      where: { user_id: userId, group_id, status: 'active' },
    });
    if (!requesterUg || requesterUg.role !== 'owner') {
      return res.status(403).json({ error: 'Only the group owner can transfer ownership' });
    }

    // 4. Target must be an active member (pending members are filtered out by status: 'active')
    const targetUg = await UserGroup.findOne({
      where: { user_id: new_owner_user_id, group_id, status: 'active' },
    });
    if (!targetUg) {
      return res.status(404).json({ error: 'Target user is not an active member of this group' });
    }

    // Atomic role swap — must be both-or-neither to avoid two-owners / zero-owners states.
    await sequelize.transaction(async (t) => {
      await requesterUg.update({ role: 'admin' }, { transaction: t });
      await targetUg.update({ role: 'owner' }, { transaction: t });
    });

    res.json({
      success: true,
      message: 'Ownership transferred',
      new_owner_user_id,
      previous_owner_user_id: userId,
    });
  } catch (error) {
    console.error('Error transferring group ownership:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove user from group (owner or admin can do this, but owner can't remove themselves)
router.delete('/:group_id/users/:target_user_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { group_id, target_user_id } = req.params; // Target user to remove
    
    const requestingUser = await User.findOne({ where: { user_id: userId } });
    const targetUser = await User.findOne({ where: { user_id: target_user_id } });
    
    if (!requestingUser || !targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Only owner or admin can remove users
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can remove users from groups' });
    }
    
    // Owner cannot remove themselves (they must transfer ownership first or delete the group)
    if (userId === target_user_id) {
      const requestingRole = await getUserRoleInGroup(userId, group_id);
      if (requestingRole === 'owner') {
        return res.status(400).json({ error: 'Group owner cannot remove themselves. Transfer ownership first or delete the group.' });
      }
    }
    
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_id: targetUser.user_id, // Use targetUser.user_id (Auth0 string) not targetUser.id (UUID)
        group_id: group_id,
        status: 'active'
      }
    });

    if (!targetUserGroup) {
      return res.status(404).json({ error: 'User is not a member of this group' });
    }

    // Phase 71.1-02: atomic membership removal + future-event cascade.
    // targetUser has both user_id (Auth0 string) and id (UUID) already loaded
    // at line ~727, so no extra lookup is needed here.
    await sequelize.transaction(async (t) => {
      await cascadeDeleteFutureEventDataOnLeaveGroup({
        authUserId: targetUser.user_id,
        userUuid: targetUser.id,
        group_id,
        transaction: t,
      });
      await targetUserGroup.destroy({ transaction: t });
    });

    res.json({ message: 'User removed from group successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update group settings (profile picture, background) - owner or admin only
router.put('/:group_id/settings', validateUUID('group_id'), validateGroupUpdate, async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { profile_picture_url, background_color, background_image_url } = req.body;
    const { group_id } = req.params;
    
    // Check if user has permission (owner or admin)
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can update group settings' });
    }
    
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    
    // Update only provided fields
    const updateData = {};
    if (profile_picture_url !== undefined) updateData.profile_picture_url = profile_picture_url;
    if (background_color !== undefined) updateData.background_color = background_color;
    if (background_image_url !== undefined) updateData.background_image_url = background_image_url;
    
    await group.update(updateData);
    
    res.json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get the group's shared game library (all confirmed members' games, deduplicated)
router.get('/:group_id/library', async (req, res) => {
  try {
    // 1. Auth check
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id } = req.params;

    // 2. Access check - must be active member
    const hasAccess = await isActiveMember(userId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // 3. Get confirmed group members (exclude pending)
    const memberRecords = await UserGroup.findAll({
      where: {
        group_id,
        status: 'active',
        role: { [Op.in]: ['member', 'admin', 'owner'] },
      },
      attributes: ['user_id'],
    });

    const auth0Ids = memberRecords.map(m => m.user_id);

    if (auth0Ids.length === 0) {
      return res.json({ games: [], members: [] });
    }

    // 4. Bridge Auth0 string IDs -> User UUIDs
    const users = await User.findAll({
      where: { user_id: { [Op.in]: auth0Ids } },
      attributes: ['id', 'user_id', 'username'],
    });

    const userUuids = users.map(u => u.id);
    // Map UUID -> { username, auth0Id } for owner attribution
    const uuidToUser = {};
    for (const u of users) {
      uuidToUser[u.id] = { username: u.username, user_id: u.user_id };
    }

    if (userUuids.length === 0) {
      return res.json({ games: [], members: [] });
    }

    // 5. Query all games owned by these members
    // CRITICAL: UserGame.user_id is UUID, NOT Auth0 string
    const userGames = await UserGame.findAll({
      where: { user_id: { [Op.in]: userUuids } },
      include: [{
        model: Game,
        required: true, // INNER JOIN - skip orphaned UserGame records
        attributes: ['id', 'name', 'thumbnail_url', 'image_url', 'min_players', 'max_players', 'playing_time', 'weight'],
      }],
    });

    // 6. Deduplicate games, aggregate owners
    const gameMap = new Map();
    for (const ug of userGames) {
      const game = ug.Game;
      if (!game) continue;

      if (!gameMap.has(game.id)) {
        gameMap.set(game.id, {
          id: game.id,
          name: game.name,
          thumbnail_url: game.thumbnail_url,
          image_url: game.image_url,
          min_players: game.min_players,
          max_players: game.max_players,
          playing_time: game.playing_time,
          weight: game.weight != null ? parseFloat(game.weight) : null,
          owners: [],
        });
      }

      const owner = uuidToUser[ug.user_id];
      if (owner) {
        gameMap.get(game.id).owners.push({
          username: owner.username,
          user_id: owner.user_id,
        });
      }
    }

    // 7. Sort owners alphabetically, build response
    const games = Array.from(gameMap.values());
    for (const game of games) {
      game.owners.sort((a, b) => a.username.localeCompare(b.username));
    }

    // 8. Build member list sorted alphabetically
    const members = users
      .map(u => ({ user_id: u.user_id, username: u.username }))
      .sort((a, b) => a.username.localeCompare(b.username));

    res.json({ games, members });
  } catch (error) {
    console.error('Error getting group library:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;