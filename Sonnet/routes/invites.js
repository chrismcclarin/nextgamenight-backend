// routes/invites.js
// Group invite endpoints: send, accept, decline, pending, accept-by-token, info-by-token, group-pending
const express = require('express');
const crypto = require('crypto');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Group, User, UserGroup, GroupInvite, Friendship, Event, EventParticipation } = require('../models');
const { body, validationResult } = require('express-validator');
const emailService = require('../services/emailService');

const { isOwnerOrAdmin } = require('../services/authorizationService');

const router = express.Router();

// ============================================
// Shared transactional invite-accept body (SPEC Req 2 / D-03).
//
// BOTH accept routes — id-based POST /:invite_id/accept AND token-based
// POST /accept-by-token (the primary email-link flow) — delegate to this ONE
// helper so a single atomic code path exists and neither route can drift out of
// atomicity later. The three writes (invite status flip + UserGroup activation)
// run in ONE managed sequelize.transaction(): on any failure after the status
// flip, the whole thing rolls back — an invite can never be left 'accepted'
// without an active UserGroup membership.
//
// Gotcha (RESEARCH Pitfall 3): findOrCreate opens its own savepoint if not given
// the transaction. `{ transaction: t }` MUST be threaded through EVERY nested
// write, including findOrCreate's options — omitting it silently escapes the txn
// and reintroduces the half-commit this plan forbids.
//
// Callers own their OWN pre-checks/authorization (existence, expiry, email match
// on the verified req.user.user_id) BEFORE invoking this helper.
async function acceptInviteTransactional(invite, user) {
  const t = await sequelize.transaction();
  try {
    // Write 1: flip invite status
    await invite.update(
      { status: 'accepted', accepted_at: new Date() },
      { transaction: t }
    );

    // Write 2: create-or-find the membership row (transaction: t MANDATORY)
    const [userGroup, created] = await UserGroup.findOrCreate({
      where: {
        user_id: user.user_id,
        group_id: invite.group_id,
      },
      defaults: {
        user_id: user.user_id,
        group_id: invite.group_id,
        role: 'member',
        status: 'active',
        joined_at: new Date(),
      },
      transaction: t,
    });

    // Write 3: if the membership row already existed, activate it
    if (!created) {
      await userGroup.update(
        { role: 'member', status: 'active', joined_at: new Date() },
        { transaction: t }
      );
    }

    await t.commit();
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

// ============================================
// GET /info/:token - Public endpoint (no auth)
// Returns invite details for pre-login display
// Note: This route is mounted separately in server.js BEFORE auth middleware
// ============================================
router.get('/info/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const invite = await GroupInvite.findOne({
      where: { token, status: 'pending' },
      include: [
        {
          model: Group,
          attributes: ['name'],
        },
        {
          model: User,
          as: 'Inviter',
          attributes: ['username'],
        },
      ],
    });

    if (!invite) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    // Count active group members
    const memberCount = await UserGroup.count({
      where: { group_id: invite.group_id, status: 'active' },
    });

    // Return only display info -- no sensitive fields
    res.json({
      group_name: invite.Group ? invite.Group.name : 'Unknown Group',
      inviter_name: invite.Inviter ? invite.Inviter.username : 'Someone',
      member_count: memberCount,
    });
  } catch (error) {
    console.error('Error fetching invite info:', error);
    res.status(500).json({ error: 'Failed to fetch invite info' });
  }
});

// ============================================
// POST /send - Send a group invite by email OR by friend_user_id
//
// Two paths:
//   1) email: classic open invite (anyone-by-email).
//   2) friend_user_id: invite an existing friend WITHOUT the client ever
//      handling the friend's email. The email is resolved server-side, behind
//      an accepted-friendship gate. This preserves the Phase 83-06 PII
//      default-deny (friend emails never cross the client boundary) while
//      restoring the friend-invite UX.
// ============================================
router.post(
  '/send',
  [
    // Exactly one of `email` / `friend_user_id` / `participant_user_id` must be
    // present — the count is enforced in the handler (see inviteeSelectors).
    body('email').optional().isEmail().normalizeEmail().withMessage('Valid email is required'),
    body('friend_user_id').optional().isString().trim().notEmpty().withMessage('friend_user_id must be a non-empty string'),
    body('participant_user_id').optional().isUUID().withMessage('participant_user_id must be a valid User id'),
    body('group_id').isUUID().withMessage('Valid group_id is required'),
  ],
  async (req, res) => {
    try {
      // Validate input
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, friend_user_id, participant_user_id, group_id } = req.body;
      const userId = req.user.user_id;

      // Exactly one invitee selector must be supplied. Rejecting ambiguous
      // multi-selector payloads (rather than silently applying precedence) keeps
      // the authorized path unambiguous — each selector carries its own authz
      // gate (friendship / group-event participation / open-email).
      const inviteeSelectors = [email, friend_user_id, participant_user_id].filter(Boolean);
      if (inviteeSelectors.length === 0) {
        return res
          .status(400)
          .json({ error: 'An invitee is required: provide exactly one of email, friend_user_id, or participant_user_id' });
      }
      if (inviteeSelectors.length > 1) {
        return res
          .status(400)
          .json({ error: 'Provide only one of email, friend_user_id, or participant_user_id' });
      }

      // WR-01: authorize FIRST. Only an owner/admin may invite, and checking this
      // before any friendship/user lookup keeps unauthorized callers off the
      // friend-resolution path entirely (no oracle surface for non-members).
      const hasPermission = await isOwnerOrAdmin(userId, group_id);
      if (!hasPermission) {
        return res.status(403).json({ error: 'Only group owners and admins can send invites' });
      }

      let normalizedEmail;

      if (friend_user_id) {
        // WR-02: you cannot invite yourself via the friend path. There is no
        // self-friendship row so this is implicitly blocked, but guard explicitly.
        if (friend_user_id === userId) {
          return res.status(400).json({ error: "You can't invite yourself" });
        }

        // friend_user_id path takes precedence over email.
        // 1) Gate on an ACCEPTED friendship between the requester and the
        //    target (bidirectional). This prevents using the endpoint as an
        //    email/membership oracle for arbitrary user_ids.
        //
        // D-11 (Phase 87.1, BINT-02): Friendship is keyed on the Users.id UUID
        // surrogate (requester_uuid/addressee_uuid). Resolve BOTH the caller and
        // the friend-target Auth0 strings to Users.id before the gate — a UUID
        // column compared against an Auth0 string is always-false, which would
        // silently 403 every legitimate friend-invite. A missing Users row on
        // either side fails closed (treated as "no friendship").
        const callerUser = await User.findOne({ where: { user_id: userId } });
        const friendUserRow = await User.findOne({ where: { user_id: friend_user_id } });
        const friendship = callerUser && friendUserRow
          ? await Friendship.findOne({
            where: {
              status: 'accepted',
              [Op.or]: [
                { requester_uuid: callerUser.id, addressee_uuid: friendUserRow.id },
                { requester_uuid: friendUserRow.id, addressee_uuid: callerUser.id },
              ],
            },
          })
          : null;

        if (!friendship) {
          return res
            .status(403)
            .json({ error: 'You can only invite your friends this way' });
        }

        // 2) Resolve the friend's email SERVER-SIDE only (never returned to client).
        const friendUser = await User.scope('withContactInfo').findOne({
          where: { user_id: friend_user_id },
        });

        if (!friendUser || !friendUser.email) {
          return res.status(404).json({ error: 'Friend not found' });
        }

        normalizedEmail = friendUser.email.toLowerCase();
      } else if (participant_user_id) {
        // participant_user_id path — invite a guest who played in one of this
        // group's events to join the group (e.g. the game-detail guest-invite
        // affordance, restored after 83-06 stripped participant emails from the
        // client). `participant_user_id` is a User.id UUID (matches
        // EventParticipation.user_id), NOT an Auth0 user_id string.
        //
        // 1) Bound the path to actual participants of THIS group's events. Like
        //    the friendship gate above, this stops the endpoint being an
        //    email/existence oracle for arbitrary User ids — only people the
        //    owner/admin already shares a group event with are resolvable here.
        const isGroupEventParticipant = await EventParticipation.findOne({
          where: { user_id: participant_user_id },
          include: [{ model: Event, where: { group_id }, attributes: [], required: true }],
          attributes: ['id'],
        });

        if (!isGroupEventParticipant) {
          return res
            .status(403)
            .json({ error: "You can only invite this group's event participants this way" });
        }

        // 2) Resolve the participant's email SERVER-SIDE only (never returned to
        //    the client) — preserves the 83-06 PII default-deny.
        const participantUser = await User.scope('withContactInfo').findByPk(participant_user_id);

        if (!participantUser || !participantUser.email) {
          return res.status(404).json({ error: 'Participant not found' });
        }

        // 3) Block self-invite (the participant is the requester themselves).
        if (participantUser.user_id === userId) {
          return res.status(400).json({ error: "You can't invite yourself" });
        }

        normalizedEmail = participantUser.email.toLowerCase();
      } else {
        normalizedEmail = email.toLowerCase();
      }

      // Verify group exists
      const group = await Group.findByPk(group_id);
      if (!group) {
        return res.status(404).json({ error: 'Group not found' });
      }

      // Check if email is already an active member
      const existingUser = await User.findOne({
        where: sequelize.where(
          sequelize.fn('LOWER', sequelize.col('email')),
          normalizedEmail
        ),
      });

      if (existingUser) {
        const activeUserGroup = await UserGroup.findOne({
          where: {
            user_id: existingUser.user_id,
            group_id,
            status: 'active',
          },
        });

        if (activeUserGroup) {
          return res.status(409).json({ error: 'This person is already a member of the group' });
        }
      }

      // Check for existing pending invite
      const existingInvite = await GroupInvite.findOne({
        where: {
          group_id,
          invited_email: normalizedEmail,
          status: 'pending',
        },
      });

      if (existingInvite) {
        return res.status(409).json({ error: 'This person already has a pending invite' });
      }

      // Generate secure token
      const token = crypto.randomBytes(32).toString('hex');

      // Create GroupInvite row
      const invite = await GroupInvite.create({
        group_id,
        invited_email: normalizedEmail,
        invited_by: userId,
        token,
        status: 'pending',
      });

      // If invited email matches an existing user, also create/update UserGroup row
      if (existingUser) {
        const [userGroup, created] = await UserGroup.findOrCreate({
          where: {
            user_id: existingUser.user_id,
            group_id,
          },
          defaults: {
            user_id: existingUser.user_id,
            group_id,
            role: 'member',
            status: 'invited',
          },
        });

        // If UserGroup already exists with 'declined' status, update to 'invited'
        if (!created && userGroup.status === 'declined') {
          await userGroup.update({ status: 'invited' });
        }
      }
      // If email does NOT match any User: do NOT create User or UserGroup rows (GROUP-05)

      // Send invite email
      let emailSent = false;
      if (emailService.isConfigured()) {
        try {
          // Get inviter info for the email
          const inviter = await User.findOne({ where: { user_id: userId } });
          const inviterName = inviter ? inviter.username : 'Someone';

          // Count active group members
          const memberCount = await UserGroup.count({
            where: { group_id, status: 'active' },
          });

          const inviteUrl = `${emailService.frontendUrl}/invite/accept?token=${token}`;

          const result = await emailService.sendGroupInviteNotification(normalizedEmail, {
            inviterName,
            groupName: group.name,
            memberCount,
            inviteUrl,
          });

          emailSent = result.success;
        } catch (emailError) {
          console.error('Failed to send invite email:', emailError.message);
          // Email failure is not a blocker -- invite was still created
          emailSent = false;
        }
      }

      res.status(201).json({
        success: true,
        invite_id: invite.id,
        emailSent,
      });
    } catch (error) {
      console.error('Error sending invite:', error);
      res.status(500).json({ error: 'Failed to send invite' });
    }
  }
);

// ============================================
// GET /pending - Get current user's pending invites
// ============================================
router.get('/pending', async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Find user to get their email.
    // BSEC-01 (D-03): withContactInfo — user.email is read below to match invites.
    const user = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Find all pending invites for this user's email (case-insensitive)
    const invites = await GroupInvite.findAll({
      where: {
        invited_email: sequelize.where(
          sequelize.fn('LOWER', sequelize.col('invited_email')),
          user.email.toLowerCase()
        ),
        status: 'pending',
      },
      include: [
        {
          model: Group,
          attributes: ['id', 'name'],
        },
        {
          model: User,
          as: 'Inviter',
          attributes: ['username'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    // Enrich with member counts
    const enriched = await Promise.all(
      invites.map(async (invite) => {
        const memberCount = await UserGroup.count({
          where: { group_id: invite.group_id, status: 'active' },
        });

        return {
          id: invite.id,
          group_id: invite.group_id,
          group_name: invite.Group ? invite.Group.name : 'Unknown Group',
          invited_by_name: invite.Inviter ? invite.Inviter.username : 'Someone',
          member_count: memberCount,
          created_at: invite.createdAt,
          token: invite.token,
        };
      })
    );

    res.json(enriched);
  } catch (error) {
    console.error('Error fetching pending invites:', error);
    res.status(500).json({ error: 'Failed to fetch pending invites' });
  }
});

// ============================================
// POST /:invite_id/accept - Accept a pending invite
// ============================================
router.post('/:invite_id/accept', async (req, res) => {
  try {
    const { invite_id } = req.params;
    const userId = req.user.user_id;

    // Find the pending invite
    const invite = await GroupInvite.findOne({
      where: { id: invite_id, status: 'pending' },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Pending invite not found' });
    }

    // Verify the authenticated user's email matches the invite.
    // BSEC-01 (D-03): withContactInfo — user.email is read for the match below.
    const user = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email.toLowerCase() !== invite.invited_email.toLowerCase()) {
      return res.status(403).json({ error: 'This invite is not for you' });
    }

    // Atomic three-write flow (status flip + UserGroup activation) — see helper.
    await acceptInviteTransactional(invite, user);

    res.json({ success: true, group_id: invite.group_id });
  } catch (error) {
    console.error('Error accepting invite:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// ============================================
// POST /:invite_id/decline - Decline a pending invite
// ============================================
router.post('/:invite_id/decline', async (req, res) => {
  try {
    const { invite_id } = req.params;
    const userId = req.user.user_id;

    // Find the pending invite
    const invite = await GroupInvite.findOne({
      where: { id: invite_id, status: 'pending' },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Pending invite not found' });
    }

    // Verify the authenticated user's email matches.
    // BSEC-01 (D-03): withContactInfo — user.email is read for the match below.
    const user = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email.toLowerCase() !== invite.invited_email.toLowerCase()) {
      return res.status(403).json({ error: 'This invite is not for you' });
    }

    // Update invite status
    await invite.update({ status: 'declined' });

    // If a UserGroup row exists with status 'invited', destroy it
    await UserGroup.destroy({
      where: {
        user_id: user.user_id,
        group_id: invite.group_id,
        status: 'invited',
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error declining invite:', error);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});

// ============================================
// POST /accept-by-token - Accept invite by token (email link flow)
// ============================================
router.post('/accept-by-token', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const userId = req.user.user_id;

    // Find the pending invite by token
    const invite = await GroupInvite.findOne({
      where: { token, status: 'pending' },
    });

    if (!invite) {
      return res.status(404).json({ error: 'Pending invite not found' });
    }

    // Verify the authenticated user's email matches.
    // BSEC-01 (D-03): withContactInfo — user.email is read for the match below.
    const user = await User.scope('withContactInfo').findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.email.toLowerCase() !== invite.invited_email.toLowerCase()) {
      return res.status(403).json({ error: 'This invite is not for you' });
    }

    // Atomic three-write flow (status flip + UserGroup activation) — same shared
    // helper as the id-based route, so this PRIMARY email-link path is atomic too.
    await acceptInviteTransactional(invite, user);

    res.json({ success: true, group_id: invite.group_id });
  } catch (error) {
    console.error('Error accepting invite by token:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// ============================================
// GET /group/:group_id/pending - Get pending invites for a group
// ============================================
router.get('/group/:group_id/pending', async (req, res) => {
  try {
    const { group_id } = req.params;
    const userId = req.user.user_id;

    // Permission: Only owner/admin of the group
    const hasPermission = await isOwnerOrAdmin(userId, group_id);
    if (!hasPermission) {
      return res.status(403).json({ error: 'Only group owners and admins can view pending invites' });
    }

    const invites = await GroupInvite.findAll({
      where: { group_id, status: 'pending' },
      include: [
        {
          model: User,
          as: 'Inviter',
          attributes: ['username'],
        },
      ],
      attributes: ['id', 'invited_email', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });

    const result = invites.map((invite) => ({
      id: invite.id,
      invited_email: invite.invited_email,
      invited_by_name: invite.Inviter ? invite.Inviter.username : 'Unknown',
      created_at: invite.createdAt,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching group pending invites:', error);
    res.status(500).json({ error: 'Failed to fetch pending invites' });
  }
});

module.exports = router;
