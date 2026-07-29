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
  UserGame,
  PendingAuth0Deletion,
  SingleUseToken,
  sequelize,
} = require('../models');
const { sendError, ERROR_REGISTRY } = require('../utils/errors');
// resolveTargetUser (dual-key) removed with POST /:group_id/users (Phase 87.6
// groups-add-user); the UUID-only resolver remains for the role/transfer routes.
const { resolveTargetUserUuidOnly } = require('../utils/resolveTargetUser');
const { lockGroupRow } = require('../utils/groupRowLock');
const { matchesSelf } = require('../middleware/objectAuth');
const { Op } = require('sequelize');
const { body, validationResult } = require('express-validator');
const router = express.Router();
const { validateGroupCreate, validateGroupUpdate, validateUUID } = require('../middleware/validators');
const {
  getUserRoleInGroup,
  isOwnerOrAdmin,
  isOwner,
  isActiveMember,
  stripMemberPII,
} = require('../services/authorizationService');
const {
  softDeleteGroup,
  restoreGroupByToken,
  GroupAlreadyDeletedError,
  RECOVERY_WINDOW_DAYS,
} = require('../services/groupRecoveryService');
const { sendGroupOwnershipOffers } = require('../services/groupOwnershipOfferService');

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
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' groups' });
    }

    // Reuse matchesSelf's UUID-arm memoized row when present; fall back to the
    // lookup on the sub arm (DB-free short-circuit leaves it unset). (ML-19)
    let user = req.selfUser ?? await User.findOne({
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
          // Phase 87.3 PR-C: the sub column is no longer selected — the roster
          // user_id field is ALIASED to the UUID below (locked decision).
          attributes: ['id', 'username'],
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

    // Phase 87.3 PR-C ROSTER ALIAS (plan 09 Task 2, LOCKED decision — RESEARCH
    // Open Q1 / Req 2): keep the `user_id` field NAME, set its VALUE to the
    // member's Users.id UUID. Display-only FE refs and React keys keep working;
    // no sub crosses the wire. Safe only inside the closed AF6 window: PR-B
    // (plan 05) cut the ManageMembers mutation senders to member.id, and this
    // same PR-C contracts those target routes UUID-only (Task 1).
    const shapedGroups = groups.map((g) => {
      const json = g.toJSON();
      json.Users = (json.Users || []).map((u) => ({ ...u, user_id: u.id }));
      return json;
    });

    res.json(shapedGroups);
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
        // Phase 87.3 PR-C: the sub column is no longer selected — the roster
        // user_id field is ALIASED to the UUID below (locked decision).
        attributes: ['id', 'username'],
        through: { where: { status: 'active' }, attributes: ['role', 'joined_at'] },
      }],
    });
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Phase 87.3 PR-C ROSTER ALIAS (locked decision, Req 2): user_id NAME kept,
    // VALUE is the member's Users.id UUID. Both roster branches below emit the
    // aliased shape so every roster consumer sees one uniform keyspace.
    const aliasRosterEntry = (u) => ({ ...u, user_id: u.id });

    // Branch 1 — group-member caller. Existing behavior preserved (aliased).
    const callerIsMember = await isActiveMember(callerAuth0Id, group_id);
    if (callerIsMember) {
      return res.json(
        (group.Users || []).map((u) => aliasRosterEntry(u.toJSON ? u.toJSON() : u))
      );
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
      .map(u => aliasRosterEntry(stripMemberPII(u)));

    // CRITICAL — Phase 71.1 cross-plan contract for Plan 02:
    // The caller is a game-only participant — they have no UserGroup row, so
    // group.Users will NEVER include them naturally. Inject a synthetic row
    // built from `callerUser` with UserGroup=null as the explicit signal the
    // frontend uses to (a) detect userScope='game-only' and (b) resolve the
    // caller's User.id UUID for the Leave-event DELETE path.
    const callerJson = callerUser.toJSON ? callerUser.toJSON() : callerUser;
    // PR-C: the injected caller row rides the same alias — its user_id carries
    // the caller's Users.id UUID, never the sub.
    const callerRow = aliasRosterEntry(stripMemberPII({
      ...callerJson,
      UserGroup: null, // explicit null — game-only signal
    }));

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

// POST /:group_id/users — DELETED (Phase 87.6 groups-add-user, Tier 1). Superseded
// by the invite / QR join flows (join-by-token + group invites). The direct
// add-member route had zero FE callers (addUserToGroup, re-confirmed 2026-07-24
// with a multi-line-aware `rg -U`). NOT the same route as GET /:group_id/users
// (the live roster read above, ~L330) — only the POST mutation is removed.
// (resolveTargetUser dual-key import dropped with it; the UUID-only sibling stays.)

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
    // Phase 87.3 PR-C (plan 09, amended D1): UUID-ONLY target resolution — the
    // PR-A sub fallback (AF6 window) is removed; PR-B (plan 05) cut the
    // ManageMembers sender to member.id. A sub-shaped target now 404s
    // (accepted stale-bundle trade-off; do not re-add the fallback).
    const targetUser = await resolveTargetUserUuidOnly(target_user_id);
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

// Public: preview a soft-deleted group from a restore token (no auth required).
//
// Phase 88.2 / SPEC-REQ-9, D-02. Modelled on the QR invite preview directly above:
// a public preview plus an authenticated action (POST /accept-ownership below). The
// token identifies the GROUP; the session identifies the PERSON. Two path segments,
// so it cannot collide with GET /:group_id.
//
// It is registered in BOTH server.js public allow-lists — the `publicRoutes` prefix
// array feeding the no-origin production block AND the `PUBLIC_EXACT` regex list
// feeding the default-deny gate. Updating only one fails in production in a way local
// dev will not reproduce.
router.get('/restore-preview/:token', async (req, res) => {
  try {
    // ONE indistinguishable body for every genuine failure, so this endpoint cannot
    // be used to probe which tokens ever existed. Deliberately identical across a
    // garbage nonce, a revoked token, a purged group and a past deadline.
    const INVALID = { error: 'Invalid or expired restore link' };

    // AF-9: NO `status` predicate. One nonce is shared by the whole roster, so after
    // the first acceptance every other member holds a consumed link — filtering to
    // active here would 404 all of them and make the already-restored branch below
    // unreachable for the COMMON case.
    const token = await SingleUseToken.findOne({
      where: { nonce: req.params.token, purpose: 'group_restore' },
    });

    if (!token || token.status === 'revoked' || token.expires_at <= new Date()) {
      return res.status(404).json(INVALID);
    }

    // DECISION Phase 88.2 D-02: this read escapes the paranoid clause deliberately —
    // this route exists specifically to read a SOFT-DELETED group, and it is
    // carve-out #1 of the ten-entry table enumerated in the header of
    // services/groupRecoveryService.js. Removing the escape breaks recovery entirely;
    // copying the pattern to any other read path reopens the leak this phase closes.
    //
    // The response is also deliberately NARROWER than invite-preview's. An invite link
    // is meant to be shared with non-members, so its preview earns its exposure; a
    // restore link only ever goes to existing members, so a public preview buys no
    // reach — it only saves a login step. Adding member_count, event_count or the
    // group id to the SUCCESS body is a disclosure regression, not a convenience.
    const group = await Group.findByPk(token.group_id, {
      paranoid: false,
      attributes: ['id', 'name', 'purge_after', 'deletedAt'],
    });

    // THE BRANCH ORDER BELOW IS LOAD-BEARING AND THE OBVIOUS ORDER IS WRONG.
    // 1. purged row
    if (!group) {
      return res.status(404).json(INVALID);
    }

    // 2. already back
    //
    // DECISION Phase 88.2 AF-9: this distinct 200 was chosen OVER folding the branch
    // into the blanket 404, and OVER minting one token per recipient. Plan 06 mints
    // ONE nonce and fans the SAME link to every remaining member, so the moment one
    // member accepts, the other N-1 — all legitimate members of a group that is now
    // healthy — follow their emailed link. A blanket 404 tells every one of them
    // "this restore link is no longer valid", which is the majority case, not an edge
    // case. Per-recipient tokens would also make the state reachable, but they
    // multiply token rows by roster size, complicate sibling revocation, and give
    // every member an independently-forwardable credential for the same outcome.
    //
    // The anti-probing property survives intact: a caller without a real 32-byte
    // nonce still gets the same 404 for every input, and the only person who can
    // reach this 200 is someone holding a nonce this system emailed to a member of
    // that exact group — who already knew it existed and can read it anyway. That is
    // why group_id is safe here and NOT in the success body below.
    //
    // The indistinguishable-404 rule still governs every OTHER failure mode.
    // Collapsing this branch back into it silently breaks the majority case.
    if (group.deletedAt === null) {
      return res.json({
        status: 'already_restored',
        group_name: group.name,
        group_id: group.id,
      });
    }

    // 3. deadline gone — AFTER the deletedAt check, and with an EXPLICIT null guard.
    // A successful restore sets purge_after to NULL, and `null <= new Date()` is
    // `true` in JavaScript (null coerces to 0). With this test written bare and
    // placed first, EVERY restored group would fall into the 404 branch and the
    // already-restored 200 above would be unreachable — the exact state AF-9 exists
    // to expose, dead again and silently. Both defences are required: this ordering
    // AND the null guard, so neither a reorder nor a dropped guard alone resurrects
    // the bug. restoreGroupByToken's in-lock re-read pins the identical three
    // branches for the identical reason.
    if (group.purge_after == null || group.purge_after <= new Date()) {
      return res.status(404).json(INVALID);
    }

    // 4. success — a name and a date, and NOTHING else.
    res.json({ group_name: group.name, purge_after: group.purge_after });
  } catch (error) {
    console.error('Error getting group restore preview:', error);
    // Code-review L-5: this route is PUBLIC and unauthenticated — never echo
    // error.message to the caller (the house pattern elsewhere predates this
    // route; Phase 93/BAPI-03 owns converting the rest). Detail stays in the
    // console line above.
    res.status(500).json({ error: 'Internal server error' });
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

    // DECISION Phase 88.2 AF-3: the membership write below runs inside a transaction
    // that takes the SAME `FOR UPDATE` row lock on Groups the other writers use, and
    // RE-READS group liveness inside that lock. This was chosen OVER relying on the
    // delete side's lock to refuse a concurrent join.
    //
    // Why the delete-side lock does NOT close this (read before "simplifying" the
    // gate away): services/accountDeletionService.js's lock makes a concurrent join
    // "wait until the deletion transaction decides", and that refuses the join ONLY
    // because ACCOUNT DELETION DESTROYS THE Groups ROW — the waiting join then fails
    // its FK check. A SOFT delete leaves the Groups row physically in place, so when
    // the lock releases the join's FOR KEY SHARE FK check SUCCEEDS and the row lands.
    // The lock changes timing, not outcome. Only a liveness gate refuses.
    //
    // The lock is what makes the re-read meaningful: without it the same gap simply
    // reopens between the re-read and the insert. The plain `Group.findOne` above is
    // paranoid-filtered too, but it runs several round-trips earlier (auto-provision,
    // tombstone check, User.findOrCreate) with no transaction of its own, so a QR
    // scan landing while an owner deletes passes it against a still-live group and
    // would commit its membership AFTER the delete stamped everything.
    //
    // Harm this refuses: a LIVE UserGroup row on a hidden group for the whole 30-day
    // window — getUserRoleInGroup returns 'member', isActiveMember passes, and the
    // joiner reads the hidden group's non-paranoid GameReview content and its lists
    // through the very choke point the rest of this phase assumes is denying. It also
    // leaves an UNSTAMPED live row that survives plan 07's stamp-matched restore,
    // breaking SPEC-REQ-9 row-set equality.
    //
    // 410 with the same message as the three invite write-path gates, so all four
    // gated write paths answer identically. Placed AFTER the tombstone check above so
    // its `410 account_deleted` envelope is unchanged.
    const joinResult = await sequelize.transaction(async (t) => {
      await lockGroupRow(group.id, t);

      // Group is paranoid (D-01) → null once the delete transaction has stamped it.
      const live = await Group.findByPk(group.id, { transaction: t });
      if (!live) {
        return { gone: true };
      }

      // Check for existing UserGroup
      const existingMembership = await UserGroup.findOne({
        where: { user_uuid: user.id, group_id: group.id },
        transaction: t,
      });

      if (existingMembership) {
        // Already an active member
        if (existingMembership.status === 'active' && existingMembership.role !== 'pending') {
          return { alreadyMember: true };
        }

        // Re-activate declined or pending membership as full member
        await existingMembership.update(
          {
            role: 'member',
            status: 'active',
            joined_at: new Date(),
          },
          { transaction: t }
        );

        return { joined: true };
      }

      // Create new membership -- CRITICAL: role is 'member' NOT 'pending' (QR invites bypass pending)
      // Phase 87.1 (Plan 09 cutover): keyed on user_uuid — the old Auth0-string user_id
      // column was removed from the model.
      await UserGroup.create(
        {
          user_uuid: user.id, // Users.id UUID (the join key)
          group_id: group.id,
          role: 'member',
          status: 'active',
          joined_at: new Date(),
        },
        { transaction: t }
      );

      return { joined: true };
    });

    if (joinResult.gone) {
      return res.status(410).json({ error: 'This group is no longer available' });
    }

    if (joinResult.alreadyMember) {
      return res.json({ already_member: true, group_id: group.id });
    }

    res.json({ success: true, group_id: group.id });
  } catch (error) {
    console.error('Error joining group by token:', error);
    res.status(500).json({ error: error.message });
  }
});

// Accept ownership of a soft-deleted group and restore it (authenticated).
//
// Phase 88.2 / SPEC-REQ-9, D-02, D-04. The authenticated half of the pair: the token
// (in the BODY, mirroring join-by-token above — not a path param) identifies the
// group, the session identifies the person. It is deliberately NOT on either public
// allow-list in server.js and must stay behind the default-deny gate.
//
// Result code -> HTTP status, the mapping plans 09 and 10 are written against:
//   ok               -> 200 { success: true, group_id, group_name }
//   not_a_member     -> 403 { error }
//   already_restored -> 409 { error, code: 'already_restored', group_id }
//   invalid_token    -> 410 { error, code }
//   already_used     -> 410 { error, code }
//   window_expired   -> 410 { error, code }
//
// The bodies are RAW (not the Phase 85 envelope), matching every other handler in
// this file. All four codes ARE registered in utils/errors.js's ERROR_REGISTRY as the
// canonical status/message record — but they are NOT routed through the canonical
// envelope helper, which nests caller data under `details`; the frontend reads the
// 409's id off the raw body as `err.details.group_id`, and one more level of nesting
// would silently kill that redirect. See the MED-1 marker in utils/errors.js.
// (This file's use of that helper is grep-counted, so the name is not spelled out
// here — hazard: a comment inflating the very count a criterion measures.)
router.post('/accept-ownership', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    // NO auto-provisioning of a Users row here, unlike join-by-token above: a restore
    // accepter must ALREADY hold a membership row stamped by this deletion, so a
    // brand-new user can never be legitimate on this path.
    const result = await restoreGroupByToken(token, userId);

    // The wire keys are snake_case and are written out KEY BY KEY on purpose. The
    // service returns camelCase (groupId / groupName); the contract plan 09 types and
    // plan 10 reads is snake_case. A `{ success: true, ...result }` spread would emit
    // groupId/groupName, the frontend would read result.group_id as undefined and
    // redirect to a broken page — with every suite on both sides still green, because
    // the backend tests assert DB state and the frontend test controls its own mock.
    if (result.ok) {
      return res.json({
        success: true,
        group_id: result.groupId,
        group_name: result.groupName,
      });
    }

    if (result.code === 'not_a_member') {
      return res.status(403).json({ error: 'You were not a member of this group' });
    }

    if (result.code === 'already_restored') {
      return res.status(409).json({
        error: ERROR_REGISTRY.already_restored.message,
        code: 'already_restored',
        // AF-9 / MED #20: the id is what lets the frontend redirect the caller into
        // the now-live group instead of dead-ending them. Without it the 409 state is
        // reachable but useless.
        group_id: result.groupId,
      });
    }

    // invalid_token / already_used / window_expired all share 410, so the CODE must
    // ride on the wire — it is the only way the frontend can tell "your group was
    // erased" from "this link is stale" and split its copy by cause.
    const entry = ERROR_REGISTRY[result.code] || ERROR_REGISTRY.internal;
    return res.status(entry.httpStatus).json({ error: entry.message, code: result.code });
  } catch (error) {
    console.error('Error accepting group ownership:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete group - owner only (must come before /:group_id/users/:target_user_id)
//
// Phase 88.2 (SPEC-REQ-1 / SPEC-REQ-2): this DESTROYS NOTHING. It stamps the group,
// its memberships and its events with one timestamp, writes a 30-day recovery
// deadline onto the Groups row, mints a single-use restore token and emails every
// remaining member an offer to take the group over. The purge sweep erases it only
// after the deadline passes.
router.delete('/:group_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id } = req.params;

    // DECISION Phase 88.2 AF-15: authorization-before-existence is RETAINED here,
    // chosen OVER the existence-first order the deletion-impact endpoint below uses.
    // The two handlers differ ON PURPOSE — that one must produce a SPEC-required 404
    // for a soft-deleted group (AF-2), this one must not widen its disclosure.
    //
    // Consequence, and it is the intended one: isOwner resolves through
    // getUserRoleInGroup, whose UserGroup.findOne is paranoid-filtered. After the
    // first soft delete the owner's OWN membership row is stamped, so a SECOND
    // DELETE fails right here and answers 403 — Group.findByPk is never reached and
    // a 404 is unreachable on this route. Nothing is double-stamped, so no
    // already-deleted branch is needed. Do NOT "fix" the asymmetry by adding a
    // carve-out escape read, or by reordering these two guards; SPEC-REQ-6 pins this
    // route's authorization to the ownership check and nothing more.
    //
    // SPEC-REQ-6 also forbids adding a pre-flight refusal, a member-count block or a
    // server-side name check here. Disclosure-not-refusal is an owner-approved
    // accepted-forever decision recorded in 88.2-SPEC.md; a gate re-litigates it.
    const hasPermission = await isOwner(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only the group owner can delete the group' });
    }

    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Capture the name BEFORE the group becomes unreadable — the email is built
    // after the transaction has hidden the row.
    const groupName = group.name;

    // Resolve the acting user's Users.id UUID, the same resolution
    // getUserRoleInGroup performs, so the deleting owner can be excluded from the
    // roster (SPEC-REQ-8 requires 0 emails to them).
    const actor = await User.findOne({ where: { user_id: userId } });

    let purgeAfter;
    let nonce;
    let recipients;
    try {
      ({ purgeAfter, nonce, recipients } = await softDeleteGroup(group_id, {
        excludeUserUuid: actor?.id,
      }));
    } catch (err) {
      if (err instanceof GroupAlreadyDeletedError) {
        // A concurrent DELETE won the row lock. Answer with the SAME 403 an ordinary
        // repeat delete produces above, so the two paths are indistinguishable.
        return res.status(403).json({ error: 'Only the group owner can delete the group' });
      }
      throw err;
    }

    // Plan 10 serves this path in the frontend repo. Same FRONTEND_URL fallback idiom
    // as workers/promptWorker.js and services/promptInvitationService.js.
    const restoreUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/restore/group/${nonce}`;

    // Respond FIRST. `message` is unchanged so no existing FE consumer breaks;
    // recoverable_until is additive.
    res.json({ message: 'Group deleted successfully', recoverable_until: purgeAfter });

    // DECISION Phase 88.2 AF-11: the fanout is FIRE-AND-FORGET, chosen OVER awaiting
    // it. Precedent copied verbatim in form from routes/availabilityPrompt.js, which
    // says in its own comment "Don't await — fanout can take seconds for large
    // groups; the client already has its 201."
    //
    // Why awaiting is wrong here specifically: the dispatch loop is strictly serial
    // (one Resend round-trip per member), so an awaited dispatch makes DELETE latency
    // O(members) x RTT. The FE call traverses the Vercel BFF proxy, which sets no
    // maxDuration and therefore runs at the default serverless cap. On a ~20-member
    // group the request exceeds it, GroupSettings' handleDeleteGroup takes its catch
    // and toasts "Failed to delete group", and the owner is left staring at the modal
    // AFTER the delete has committed and every member has already been emailed. Their
    // retry then hits the repeat-DELETE 403 above. None of it surfaces in CI, where
    // the dispatcher is mocked and returns instantly.
    //
    // D-03 forbids inventing a queue for this, so fire-and-forget is the correct match
    // to the existing pattern. Re-adding await for "reliability" trades a delivery
    // guarantee the dispatcher cannot make anyway for a delete flow that fails
    // visibly after committing.
    //
    // The outer try/catch covers a SYNCHRONOUS throw from the call itself, which the
    // trailing .catch cannot — and it must not reach the handler's own catch, which
    // would try to send a second response.
    try {
      sendGroupOwnershipOffers({ groupName, purgeAfter, restoreUrl, recipients })
        .catch((err) => console.error('[DELETE /groups] ownership-offer fanout error (non-fatal):', err.message));
    } catch (err) {
      console.error('[DELETE /groups] ownership-offer dispatch error (non-fatal):', err.message);
    }
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Owner-only blast-radius preview for the Danger Zone (D-06 / SPEC-REQ-5).
// Placed immediately after the DELETE handler so the delete-flow endpoints stay
// adjacent. The two-segment path cannot collide with GET /:group_id.
//
// D-06 chose a DEDICATED route rather than extending the group-detail response
// precisely so this can 403 a non-owner — group detail is legitimately read by
// ordinary members and therefore cannot. Counts are computed server-side, never
// client-side: a client-side count risks telling the owner "4 events" while the
// delete hides 37, at the exact moment accuracy matters most.
router.get('/:group_id/deletion-impact', validateUUID('group_id'), async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id } = req.params;

    // DECISION Phase 88.2 AF-2: EXISTENCE-BEFORE-AUTHORIZATION here, chosen OVER
    // matching the sibling handlers' authorization-first order (including the DELETE
    // handler directly above, which keeps authz-first on purpose).
    //
    // Why the sibling order cannot be used: isOwner resolves through
    // getUserRoleInGroup, whose UserGroup.findOne is paranoid-filtered. Once the group
    // is soft-deleted the owner's OWN membership row is stamped too, so isOwner
    // returns false and an authz-first order would answer 403 with this lookup never
    // running — making SPEC-REQ-5's required 404 for a soft-deleted group unreachable,
    // and the cheapest way out (relaxing the test to 403) would leave the SPEC
    // criterion silently unmet. Reordering this back is a SPEC regression, not a
    // consistency cleanup.
    //
    // It does not weaken authorization. Group ids are unguessable v4 UUIDs and the
    // route validator has already rejected anything malformed, so the only new
    // information a non-owner gains is "this UUID is not a live group" — for a UUID
    // they had to already possess. The 403 for a LIVE group they do not own, which is
    // the case the gate exists for, is unchanged.
    //
    // The model is paranoid, so this lookup IS the soft-deleted case. This handler is
    // deliberately NOT one of the enumerated carve-outs — do not add an escape flag
    // that would let it read a hidden group.
    const group = await Group.findByPk(group_id);
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const hasPermission = await isOwner(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only the group owner can view deletion impact' });
    }

    // Independent counts, run concurrently — this endpoint's latency is directly
    // visible as the delay before the blast-radius numbers appear in the Danger Zone.
    // Both models are paranoid, so both automatically exclude anything already hidden.
    //
    // The role predicate matches the roster query in groupRecoveryService (see its
    // MED-3 marker) and the in-repo "confirmed members" precedent further down this
    // file. The two queries share a PREDICATE, not a result set: this count includes
    // the acting owner while the fanout excludes them, so member_count is exactly one
    // greater than the number of offers sent. That is intended — this number answers
    // "how many people lose access", which includes the owner. Do NOT "fix" it by
    // subtracting the owner.
    const [member_count, event_count] = await Promise.all([
      UserGroup.count({
        where: {
          group_id,
          status: 'active',
          role: { [Op.in]: ['member', 'admin', 'owner'] },
        },
      }),
      Event.count({ where: { group_id } }),
    ]);

    // recovery_window_days is served so the Danger Zone copy reads the window from
    // the server instead of hard-coding 30 in two places.
    res.json({ member_count, event_count, recovery_window_days: RECOVERY_WINDOW_DAYS });
  } catch (error) {
    console.error('Error getting group deletion impact:', error);
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
    // Phase 87.3 PR-C (amended D1): UUID-ONLY — the PR-A sub fallback is
    // removed (PR-B/plan 05 cut the ManageMembers sender to member.id).
    // decodeURIComponent is a no-op for a UUID but kept for URL hygiene.
    const decodedTargetId = decodeURIComponent(target_user_id);
    const targetUser = await resolveTargetUserUuidOnly(decodedTargetId);
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
    // Phase 87.3 PR-C (amended D1): UUID-ONLY — the PR-A sub fallback is
    // removed (PR-B/plan 05 cut the ManageMembers sender to member.id).
    const decodedTargetId = decodeURIComponent(target_user_id);
    const targetUser = await resolveTargetUserUuidOnly(decodedTargetId);
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

    // F-02: hard delete — a rejected pending membership must physically leave the roster.
    await targetUserGroup.destroy({ force: true });

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
      // F-02: hard delete — leaving a group physically removes the membership row.
      await userGroup.destroy({ transaction: t, force: true });
    });

    res.json({ success: true, message: 'You have left the group' });
  } catch (error) {
    console.error('Error leaving group:', error);
    res.status(500).json({ error: error.message });
  }
});

// Transfer group ownership to another active member (owner only)
// Atomically swaps the requesting owner -> 'admin' and target member -> 'owner' in a single transaction.
// 87.3 code-review #6: express-validator input hygiene — a non-string (e.g.
// array) new_owner_user_id is rejected 400 before any lookup.
router.post(
  '/:group_id/transfer-ownership',
  [body('new_owner_user_id').isString().trim().notEmpty().isLength({ max: 255 }).withMessage('new_owner_user_id is required')],
  async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { group_id } = req.params;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Preserve the pre-validator error envelope for the missing/invalid case.
      return res.status(400).json({ error: 'new_owner_user_id is required' });
    }
    const { new_owner_user_id } = req.body;

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
    // Phase 87.3 PR-C (amended D1): UUID-ONLY — the PR-A sub fallback is
    // removed (PR-B/plan 05 cut the ManageMembers transferTarget.id sender).
    const newOwnerUser = await resolveTargetUserUuidOnly(new_owner_user_id);
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
      // PR-C (Req 2, carry-UUID lock): both echoed identifiers carry the
      // resolved Users.id UUIDs — names stable, no sub crosses the wire.
      new_owner_user_id: newOwnerUser.id,
      previous_owner_user_id: requesterUser.id,
    });
  } catch (error) {
    console.error('Error transferring group ownership:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
  }
);

// Remove user from group (owner or admin can do this, but owner can't remove themselves)
router.delete('/:group_id/users/:target_user_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const { group_id, target_user_id } = req.params; // Target user to remove

    // 87.3 code-review #3 (WR-01): authorize FIRST. Only owner/admin may remove
    // — checking this BEFORE the target lookup keeps unauthorized callers off
    // the user-resolution path entirely (no user-existence oracle: a non-admin
    // probing arbitrary ids gets a uniform 403, never a 404-vs-400 signal).
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only owners and admins can remove users from groups' });
    }

    const requestingUser = await User.findOne({ where: { user_id: userId } });
    // Phase 87.3 PR-C (amended D1): UUID-ONLY target resolution — the PR-A sub
    // fallback (AF6 window) is removed; PR-B (plan 05) cut the ManageMembers
    // remove sender to member.id. A sub-shaped target now 404s.
    const targetUser = await resolveTargetUserUuidOnly(target_user_id);

    if (!requestingUser || !targetUser) {
      return res.status(404).json({ error: 'User not found' });
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
      // F-02: hard delete — removing a member physically removes the membership row.
      await targetUserGroup.destroy({ transaction: t, force: true });
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
    // Phase 87.3 PR-C (Task 2b): the sub column is no longer selected — the
    // owners[]/members[] object literals below ALIAS user_id to the UUID.
    const users = await User.findAll({
      where: { id: { [Op.in]: memberUuids } },
      attributes: ['id', 'username'],
    });

    const userUuids = users.map(u => u.id);
    // Map UUID -> { username } for owner attribution
    const uuidToUser = {};
    for (const u of users) {
      uuidToUser[u.id] = { username: u.username };
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
        // Phase 87.3 PR-C (Task 2b, UNIFORM ALIAS LOCKED — removal or
        // one-side-only cleaning FORBIDDEN): owners[].user_id carries the
        // owner's Users.id UUID (ug.user_id IS that UUID — UserGame is
        // UUID-keyed). GroupLibrary joins owners[].user_id against
        // members[].user_id WITHIN this one payload to drive the owner
        // filter, so BOTH sides alias in this same edit (see members below).
        gameMap.get(game.id).owners.push({
          username: owner.username,
          user_id: ug.user_id,
        });
      }
    }

    // 7. Sort owners alphabetically, build response
    const games = Array.from(gameMap.values());
    for (const game of games) {
      game.owners.sort((a, b) => a.username.localeCompare(b.username));
    }

    // 8. Build member list sorted alphabetically.
    // PR-C uniform alias (other half of the owners<->members intra-payload
    // join): members[].user_id carries the member's Users.id UUID.
    const members = users
      .map(u => ({ user_id: u.id, username: u.username }))
      .sort((a, b) => a.username.localeCompare(b.username));

    res.json({ games, members });
  } catch (error) {
    console.error('Error getting group library:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;