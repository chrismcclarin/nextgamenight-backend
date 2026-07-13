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
  GroupInvite,
  PendingAuth0Deletion,
  sequelize,
} = require('../models');
const { sendError } = require('../utils/errors');
const { resolveTargetUser } = require('../utils/resolveTargetUser');
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
// UNIFORM UUID KEYING (Phase 87.1, BINT-02 / D-01 / D-11): all four cascade
// tables are now keyed on the Users.id UUID surrogate (`*.user_uuid`), resolved
// ONCE from the leaving user's Users row before the cascade runs. The former FK
// type asymmetry (EventParticipation on UUID; EventRsvp/EventBring/EventBallotVote
// on the Auth0 STRING) is gone — every destroy below targets `user_uuid`, so a
// single resolved UUID drives the whole cascade. EventBallotVote is still joined
// to the event via EventBallotOption.event_id (option-keyed table). See
// `.planning/phases/71.1-game-only-participant-read-access/71.1-01-SUMMARY.md`.
//
// Audit log: this helper deliberately does NOT write EventAuditLog
// `remove_participant` rows. Those are reserved for the per-event Remove flow
// (Phase 65-01 EVT-08) which triggers the silent-welcome-back suppression on
// re-join. A leave-group cascade should NOT silence the per-event
// welcome-back if the user later QR-rejoins a specific event — they left the
// group, not any individual event explicitly.
async function cascadeDeleteFutureEventDataOnLeaveGroup({
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

  // D-11 uniform UUID keying: all four tables key on user_uuid (Users.id).
  await EventParticipation.destroy({
    where: { event_id: { [Op.in]: futureEventIds }, user_id: userUuid },
    transaction,
  });
  await EventRsvp.destroy({
    where: { event_id: { [Op.in]: futureEventIds }, user_uuid: userUuid },
    transaction,
  });
  await EventBring.destroy({
    where: { event_id: { [Op.in]: futureEventIds }, user_uuid: userUuid },
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
        user_uuid: userUuid,
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
      // SPEC Req 6 (Phase 87.2 tombstone guard, self-keyed): a still-valid token
      // surviving account deletion must not JIT re-create the Users row. Pinned
      // refusal shape: 410 account_deleted on the Phase 85 envelope.
      if (await PendingAuth0Deletion.isTombstoned(userId)) {
        return sendError(res, 'account_deleted');
      }
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
    // D-11: UserGroup is keyed on user_uuid (Users.id UUID), not the Auth0 string.
    const userGroups = await UserGroup.findAll({
      where: { user_uuid: user.id, status: 'active' },
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
    
    // Creator is set as 'owner'. Phase 87.1 (Plan 09 cutover): keyed on user_uuid
    // (Users.id FK) — the old Auth0-string user_id column was removed from the model.
    await UserGroup.create({
      user_uuid: user.id, // Users.id UUID (the join key)
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

    // V5: the client-supplied `user_id` is resolved to a Users row server-side
    // here — never trusted directly as the UserGroup FK.
    // Phase 87.3 (PR-A expand): dual-keyed — resolve by Users.id UUID first (the
    // post-PR-C roster shape the FE friend-invite sender will pass in plan 06),
    // falling back to the Auth0 sub (today's shape).
    const user = await resolveTargetUser(user_id);
    const group = await Group.findByPk(req.params.group_id);

    if (!user || !group) {
      return res.status(404).json({ error: 'User or Group not found' });
    }

    // D-11: key on user_uuid (Users.id). Phase 87.1 (Plan 09 cutover): the old
    // Auth0-string user_id column was removed from the model.
    await UserGroup.findOrCreate({
      where: {
        user_uuid: user.id,
        group_id: group.id
      },
      defaults: {
        user_uuid: user.id, // Users.id UUID (the join key)
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
    
    // Prevent changing owner's role (owner can't demote themselves).
    // Phase 87.3 (PR-A expand): dual-keyed target resolution — Users.id UUID
    // first (post-PR-C roster shape), Auth0 sub fallback (today's shape).
    const targetUser = await resolveTargetUser(target_user_id);
    if (!targetUser) {
      return res.status(404).json({ error: 'Target user not found' });
    }
    
    // D-11: targetUser (resolved above from the Auth0-string param) keyed by user_uuid.
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_uuid: targetUser.id,
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

    // D-11: UserGroup is keyed on user_uuid (Users.id). Resolve the caller's Users
    // row FIRST. A QR deep-link can be a brand-new user's very first API call, so
    // auto-provision (mirrors the GET /user/:user_id auto-create) to preserve that
    // flow rather than 404 a legitimate first-time joiner.
    //
    // Only persist the token's email if Auth0 has VERIFIED it. An unverified email in
    // the token can be attacker-controlled — persisting it on a first-time row could
    // claim another person's address or trip the Users.email UNIQUE constraint. When
    // unverified, provision with a synthetic, collision-resistant fallback derived from
    // the (sanitized) Auth0 sub.
    const syntheticEmail = `${userId.replace(/[|:]/g, '-')}@auth0.local`;
    const joinerEmail = req.user.email_verified === true && req.user.email
      ? req.user.email
      : syntheticEmail;
    const joinerName = req.user.name || req.user.nickname || req.user.given_name
      || req.user.email?.split('@')[0] || 'User';

    // SPEC Req 6 (Phase 87.2 tombstone guard, self-keyed): covers BOTH findOrCreate
    // calls below (primary + unique-collision retry — same sub). A still-valid token
    // surviving account deletion must not re-provision the Users row by joining a
    // group. Pinned refusal shape: 410 account_deleted on the Phase 85 envelope.
    if (await PendingAuth0Deletion.isTombstoned(userId)) {
      return sendError(res, 'account_deleted');
    }

    let user;
    try {
      [user] = await User.findOrCreate({
        where: { user_id: userId },
        defaults: { user_id: userId, email: joinerEmail, username: joinerName },
      });
    } catch (error) {
      // Email UNIQUE collision on a first-time create (the verified token email is
      // already owned by another Users row). Retry with the synthetic fallback so a
      // legitimate first-time joiner still provisions instead of hitting a raw 500 —
      // mirrors the events.js auto-create fallback pattern.
      if (error.name === 'SequelizeUniqueConstraintError') {
        [user] = await User.findOrCreate({
          where: { user_id: userId },
          defaults: { user_id: userId, email: syntheticEmail, username: joinerName },
        });
      } else {
        throw error;
      }
    }

    // Check for existing UserGroup
    const existingMembership = await UserGroup.findOne({
      where: { user_uuid: user.id, group_id: group.id },
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
    // Phase 87.1 (Plan 09 cutover): keyed on user_uuid — the old Auth0-string user_id
    // column was removed from the model.
    await UserGroup.create({
      user_uuid: user.id, // Users.id UUID (the join key)
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

    // Delete all pending invites for this group — GroupInvite.group_id has NO FK,
    // so skipping this orphans rows carrying invitee email PII.
    await GroupInvite.destroy({ where: { group_id } });

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

    // V5 / D-11: resolve the client-supplied target to a Users row, then key
    // UserGroup on user_uuid (never trust the raw param as the FK).
    // Phase 87.3 (PR-A expand): dual-keyed — Users.id UUID first (post-PR-C
    // shape), Auth0 sub fallback (today's shape). decodeURIComponent is a no-op
    // for a UUID but preserved for the sub path.
    const decodedTargetId = decodeURIComponent(target_user_id);
    const targetUser = await resolveTargetUser(decodedTargetId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Pending member not found' });
    }
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_uuid: targetUser.id,
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

    // V5 / D-11: resolve the client-supplied target to a Users row, then key
    // UserGroup on user_uuid (never trust the raw param as the FK).
    // Phase 87.3 (PR-A expand): dual-keyed — Users.id UUID first (post-PR-C
    // shape), Auth0 sub fallback (today's shape). decodeURIComponent is a no-op
    // for a UUID but preserved for the sub path.
    const decodedTargetId = decodeURIComponent(target_user_id);
    const targetUser = await resolveTargetUser(decodedTargetId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Pending member not found' });
    }
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_uuid: targetUser.id,
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

    // D-11: resolve the caller's Users row ONCE; UserGroup is keyed on user_uuid.
    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'You are not a member of this group' });
    }

    const userGroup = await UserGroup.findOne({
      where: {
        user_uuid: user.id,
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
    // The caller's Users.id UUID (resolved above) drives the now-uniform
    // UUID-keyed cascade.
    await sequelize.transaction(async (t) => {
      await cascadeDeleteFutureEventDataOnLeaveGroup({
        userUuid: user.id,
        group_id,
        transaction: t,
      });
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

    // D-11: resolve both parties' Users rows; UserGroup is keyed on user_uuid.
    // 2. Requester must be the current active owner
    const requesterUser = await User.findOne({ where: { user_id: userId } });
    if (!requesterUser) {
      return res.status(403).json({ error: 'Only the group owner can transfer ownership' });
    }
    const requesterUg = await UserGroup.findOne({
      where: { user_uuid: requesterUser.id, group_id, status: 'active' },
    });
    if (!requesterUg || requesterUg.role !== 'owner') {
      return res.status(403).json({ error: 'Only the group owner can transfer ownership' });
    }

    // 3. Target must be an active member (pending members are filtered out by status: 'active').
    // Phase 87.3 (PR-A expand): new_owner_user_id is dual-keyed — Users.id UUID
    // first (post-PR-C roster shape), Auth0 sub fallback (today's shape).
    const newOwnerUser = await resolveTargetUser(new_owner_user_id);
    if (!newOwnerUser) {
      return res.status(404).json({ error: 'Target user is not an active member of this group' });
    }

    // 4. Self-transfer guard — compare canonical (resolved) identity, not the raw
    // param, so it fires whether the client sent a UUID or a sub (a raw
    // sub-vs-UUID compare would silently let a self-transfer through).
    if (newOwnerUser.id === requesterUser.id) {
      return res.status(400).json({ error: 'Cannot transfer ownership to yourself' });
    }
    const targetUg = await UserGroup.findOne({
      where: { user_uuid: newOwnerUser.id, group_id, status: 'active' },
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
      // 87.3 code-review #7: echo the RESOLVED sub, never the raw client param —
      // once plan 05 cuts the FE sender to member.id (a UUID), a raw echo would
      // mix keyspaces in one payload (UUID next to previous_owner's sub). Same
      // treatment the friendships handlers give their echoed identifiers.
      new_owner_user_id: newOwnerUser.user_id,
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
    // Phase 87.3 (PR-A expand): dual-keyed target resolution — Users.id UUID
    // first (post-PR-C roster shape), Auth0 sub fallback (today's shape).
    const targetUser = await resolveTargetUser(target_user_id);

    if (!requestingUser || !targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Only owner or admin can remove users
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can remove users from groups' });
    }

    // Owner cannot remove themselves (they must transfer ownership first or
    // delete the group). Compare canonical (resolved) identity, not the raw
    // param, so the guard fires whether the client sent a UUID or a sub.
    if (requestingUser.id === targetUser.id) {
      const requestingRole = await getUserRoleInGroup(userId, group_id);
      if (requestingRole === 'owner') {
        return res.status(400).json({ error: 'Group owner cannot remove themselves. Transfer ownership first or delete the group.' });
      }
    }
    
    // D-11: targetUser (resolved above from the Auth0-string param) keyed by user_uuid.
    const targetUserGroup = await UserGroup.findOne({
      where: {
        user_uuid: targetUser.id,
        group_id: group_id,
        status: 'active'
      }
    });

    if (!targetUserGroup) {
      return res.status(404).json({ error: 'User is not a member of this group' });
    }

    // Phase 71.1-02: atomic membership removal + future-event cascade.
    // targetUser.id (Users.id UUID) drives the now-uniform UUID-keyed cascade.
    await sequelize.transaction(async (t) => {
      await cascadeDeleteFutureEventDataOnLeaveGroup({
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
    // D-11: UserGroup is keyed on user_uuid — select it directly (these ARE the
    // Users.id UUIDs), so no Auth0-string bridge is needed and this survives the
    // Plan 09 removal of the UserGroup.user_id column.
    const memberRecords = await UserGroup.findAll({
      where: {
        group_id,
        status: 'active',
        role: { [Op.in]: ['member', 'admin', 'owner'] },
      },
      attributes: ['user_uuid'],
    });

    const memberUuids = memberRecords.map(m => m.user_uuid).filter(Boolean);

    if (memberUuids.length === 0) {
      return res.json({ games: [], members: [] });
    }

    // 4. Load the member Users directly by UUID.
    const users = await User.findAll({
      where: { id: { [Op.in]: memberUuids } },
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