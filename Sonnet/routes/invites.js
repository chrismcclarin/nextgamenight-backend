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
const { resolveTargetUserUuidOnly } = require('../utils/resolveTargetUser');
const { lockGroupRow } = require('../utils/groupRowLock');

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
    // WR-01 (88.2 review): FIRST statement of the transaction is the shared
    // Groups-row lock (utils/groupRowLock.js — the same guard softDeleteGroup,
    // restore, purge and join-by-token take), then a paranoid liveness re-read
    // INSIDE it. The routes' Group.findByPk gates run outside any lock, so a
    // softDeleteGroup committing between that gate and this transaction would
    // otherwise land a LIVE, UNSTAMPED membership row on a hidden group (create
    // branch) or restore() a row the delete just stamped (carve-out #9 branch) —
    // the identical race join-by-token closes the same way (routes/groups.js
    // AF-3 marker has the full lock-serializes-but-cannot-refuse analysis).
    // Callers map `{ gone: true }` to the same 410 their pre-transaction gates
    // emit, so all gated write paths answer identically.
    await lockGroupRow(invite.group_id, t);
    const live = await Group.findByPk(invite.group_id, { transaction: t });
    if (!live) {
      await t.rollback();
      return { gone: true };
    }

    // Write 1: flip invite status
    await invite.update(
      { status: 'accepted', accepted_at: new Date() },
      { transaction: t }
    );

    // Write 2: create-or-find the membership row (transaction: t MANDATORY)
    // D-11 (Phase 87.1, BINT-02): UserGroup is keyed on the Users.id UUID surrogate
    // (user_uuid). Plan 09 cutover: the old Auth0-string user_id column was removed
    // from the model.
    //
    // DECISION Phase 88.2 AF-3: an explicit findOne({ paranoid: false }) +
    // restore-or-create was chosen OVER findOrCreate. findOrCreate is
    // paranoid-filtered, so once UserGroup went paranoid (plan 01) it CANNOT SEE a
    // membership row that a group soft-delete stamped — it takes the CREATE branch,
    // which the new PARTIAL unique index `usergroups_user_uuid_group_id_uq`
    // (WHERE "deletedAt" IS NULL) explicitly permits. That yields a SECOND, live row
    // for the same (user_uuid, group_id) pair. The group restore then un-stamps the
    // first row, two rows have deletedAt IS NULL for the same pair, the unique index
    // is violated, and the WHOLE restore transaction aborts — identically on every
    // retry. The group becomes permanently unrecoverable and is purged at day 30
    // while its members are actively trying to save it.
    //
    // The route gates below (410 on a soft-deleted group) should make the stamped
    // branch unreachable, but this lookup removes the failure mode STRUCTURALLY
    // rather than depending on a gate holding: restoring one row is always safe,
    // creating a second is catastrophic.
    //
    // `paranoid: false` here is a WRITE-PATH INTEGRITY read, not a soft-deleted-content
    // read — it exists solely to prevent a duplicate row and discloses nothing. It is
    // carve-out #9 in the table plan 07 writes into groupRecoveryService.js's header.
    const existing = await UserGroup.findOne({
      where: {
        user_uuid: user.id,
        group_id: invite.group_id,
      },
      paranoid: false, // AF-3: must see rows a group soft-delete stamped
      transaction: t,
    });

    let userGroup = existing;

    if (!existing) {
      // No row at all — create one, exactly the previous `defaults` object.
      userGroup = await UserGroup.create(
        {
          user_uuid: user.id,
          group_id: invite.group_id,
          role: 'member',
          status: 'active',
          joined_at: new Date(),
        },
        { transaction: t }
      );
    } else {
      // A stamped row means this pair ALREADY has a membership record. Reuse it —
      // never create alongside it.
      if (existing.deletedAt !== null && existing.deletedAt !== undefined) {
        await existing.restore({ transaction: t });
      }

      // Write 3: activate the existing (or just-restored) membership row.
      await userGroup.update(
        { role: 'member', status: 'active', joined_at: new Date() },
        { transaction: t }
      );
    }

    await t.commit();
    return { gone: false };
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
        // DECISION Phase 88.2 F-04: the INNER-JOIN flag below was chosen OVER a
        // hand-written `where`/`deletedAt` filter on the outer query, and OVER making
        // GroupInvite paranoid. D-01 deliberately leaves GroupInvite non-paranoid, so
        // Sequelize puts Group's paranoid clause in the JOIN's ON clause — the invite
        // row SURVIVES with `Group: null` instead of being dropped. Marking the include
        // required makes it an INNER JOIN, so a soft-deleted group's invite yields no
        // row and the `if (!invite)` 404 below fires.
        // THIS ROUTE IS ON THE PUBLIC ALLOWLIST (server.js: GET /invites/info). Without
        // the flag an UNAUTHENTICATED caller holding an old invite token gets HTTP 200
        // disclosing that a group existed (degraded to 'Unknown Group'). Removing it
        // reopens a public information-disclosure leak — it is not cosmetic and it is
        // not a redundant flag.
        {
          model: Group,
          attributes: ['name'],
          required: true,
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
        // friend_user_id path takes precedence over email.
        // 1) Gate on an ACCEPTED friendship between the requester and the
        //    target (bidirectional). This prevents using the endpoint as an
        //    email/membership oracle for arbitrary user_ids.
        //
        // D-11 (Phase 87.1, BINT-02): Friendship is keyed on the Users.id UUID
        // surrogate (requester_uuid/addressee_uuid). Resolve BOTH the caller and
        // the friend-target to Users.id before the gate. A missing Users row on
        // either side fails closed (treated as "no friendship").
        //
        // Phase 87.3 PR-C (plan 09, user D1 contraction): friend_user_id is
        // UUID-ONLY — the PR-A sub fallback (AF16) is removed. Safe because
        // PR-B (plan 06, AF12b) cut both FE senders (friends-page bulk invite,
        // FriendInvitePanel) to the nested `.id`. A sub-shaped identifier now
        // fails the resolve → the friendship gate 403s (fails closed).
        const callerUser = await User.findOne({ where: { user_id: userId } });
        const friendUserRow = await resolveTargetUserUuidOnly(friend_user_id);

        // WR-02: you cannot invite yourself via the friend path. There is no
        // self-friendship row so the gate below also blocks it, but guard
        // explicitly on canonical (resolved) identity — not the raw param — so it
        // fires whether the client sent a UUID or a sub.
        if (callerUser && friendUserRow && friendUserRow.id === callerUser.id) {
          return res.status(400).json({ error: "You can't invite yourself" });
        }

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

        // 2) Resolve the friend's email SERVER-SIDE only (never returned to
        //    client). Re-fetch withContactInfo by the RESOLVED primary key so
        //    the lookup is identifier-shape-independent (87.3).
        const friendUser = await User.scope('withContactInfo').findByPk(friendUserRow.id);

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
            user_uuid: existingUser.id,
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

      // Resolve the caller's Users.id once for the invited_by_uuid surrogate.
      // D-04 (Phase 87.1, BINT-02): invited_by_uuid is NULLABLE; the caller passed
      // isOwnerOrAdmin above (which fails closed on a missing Users row) so callerRow
      // is normally present, but fall back to null defensively rather than emit a raw
      // 500. Plan 09 cutover: the old Auth0-string invited_by column was removed from
      // the model — the invite is keyed solely on invited_by_uuid.
      const callerRow = await User.findOne({ where: { user_id: userId } });

      // Create GroupInvite row
      const invite = await GroupInvite.create({
        group_id,
        invited_email: normalizedEmail,
        invited_by_uuid: callerRow ? callerRow.id : null,
        token,
        status: 'pending',
      });

      // If invited email matches an existing user, also create/update UserGroup row.
      //
      // Phase 88.2 AF-3 disposition: this is the SAME paranoid-filtered findOrCreate
      // shape that acceptInviteTransactional had to abandon, and it is left as-is
      // DELIBERATELY. Its safety rests entirely on the `Group.findByPk(group_id)`
      // liveness check earlier in this handler (the "Verify group exists" 404 above),
      // which is paranoid after plan 01 — so a soft-deleted group is refused upstream
      // and this call only ever runs for a LIVE group. IF THAT CHECK IS EVER REMOVED
      // OR MOVED BELOW THIS POINT, this site inherits the accept-path defect: a
      // paranoid-filtered create branch that the partial unique index
      // `usergroups_user_uuid_group_id_uq` permits, producing a duplicate live row
      // that makes a group restore abort permanently.
      if (existingUser) {
        const [userGroup, created] = await UserGroup.findOrCreate({
          where: {
            user_uuid: existingUser.id,
            group_id,
          },
          defaults: {
            user_uuid: existingUser.id,
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
          // Get inviter info for the email (reuse the caller row resolved above)
          const inviterName = callerRow ? callerRow.username : 'Someone';

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
        // DECISION Phase 88.2 F-04: the INNER-JOIN flag below was chosen OVER a
        // hand-written `where`/`deletedAt` filter on the outer query, and OVER making
        // GroupInvite paranoid. Same root cause as the GET /info/:token include above:
        // GroupInvite is a NON-paranoid root (D-01), so Group's paranoid clause lands
        // in the JOIN's ON clause and nulls the association instead of dropping the
        // invite. With INNER JOIN, a soft-deleted group's invites leave the list
        // entirely and the enrichment loop below never sees a null `invite.Group`
        // (which would otherwise surface as `group_name: 'Unknown Group'`).
        {
          model: Group,
          attributes: ['id', 'name'],
          required: true,
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

    // DECISION Phase 88.2 AF-3: an explicit Group.findByPk liveness gate was chosen
    // OVER making GroupInvite paranoid (D-01 deliberately does not) and OVER relying
    // on the READ-path filters from Task 1 (those are reads; nothing on this WRITE
    // path looks at Group at all). Group IS paranoid, so findByPk returns null for a
    // soft-deleted group.
    //
    // Without this gate an invitee following an emailed link into a group inside its
    // recovery window gets { success: true } and — because the membership lookup is
    // paranoid-filtered — a LIVE UserGroup{status:'active'} row on a hidden group.
    // getUserRoleInGroup then returns 'member' and isActiveMember/isMemberOrHigher
    // PASS, which is the exact choke point the rest of this phase relies on to deny
    // access to the hidden group's retained GameReview rows and lists.
    //
    // PLACEMENT AFTER THE EMAIL-MATCH 403 IS DELIBERATE AND MUST NOT BE TIDIED
    // EARLIER. GroupInvite is non-paranoid, so an UNMATCHED caller can reach the
    // invite lookup; gating before the match check would turn this endpoint into an
    // existence oracle for any authenticated user holding an invite id or token.
    // After the match, the only person who learns anything is the addressee, who
    // already knew the group existed.
    //
    // 410 here, not the read paths' indistinguishable 404: by this point the caller
    // is authenticated AND email-matched, so a precise answer costs no disclosure
    // and a vague one just strands them.
    const group = await Group.findByPk(invite.group_id);
    if (!group) {
      return res.status(410).json({ error: 'This group is no longer available' });
    }

    // Atomic three-write flow (status flip + UserGroup activation) — see helper.
    // WR-01: the helper re-checks liveness under the shared row lock; `gone`
    // maps to the same 410 the pre-transaction gate above emits.
    const acceptResult = await acceptInviteTransactional(invite, user);
    if (acceptResult.gone) {
      return res.status(410).json({ error: 'This group is no longer available' });
    }

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

    // DECISION Phase 88.2 AF-3 — the decline path gets the gate too. Its
    // UserGroup.destroy below is a HARD delete (force: true, plan 03). On a
    // soft-deleted group that row is one of the STAMPED rows plan 07's restore must
    // bring back, so declining would silently drop that member from the restored
    // roster and break SPEC-REQ-9's before/after row-set equality. Chosen OVER
    // leaving decline ungated (the "it only removes their own invite" reading), which
    // ignores that the row is shared state during the recovery window. No UX cost:
    // Task 1's INNER JOIN on GET /pending already removes soft-deleted groups'
    // invites from the list, so nobody is left staring at an invite they cannot
    // dismiss. Placement AFTER the email-match 403 is the anti-oracle choice.
    const group = await Group.findByPk(invite.group_id);
    if (!group) {
      return res.status(410).json({ error: 'This group is no longer available' });
    }

    // WR-01 (88.2 review): the gate above runs outside any lock, so the writes
    // below take the shared Groups-row lock (utils/groupRowLock.js) and re-read
    // liveness INSIDE it. Without this, a softDeleteGroup committing in the gap
    // lets the force-destroy hard-delete a row the delete just STAMPED — silently
    // shortening the restorable roster and breaking SPEC-REQ-9's before/after
    // row-set equality, the exact outcome the gate's own AF-3 marker exists to
    // prevent. `gone` maps to the gate's identical 410.
    const declineResult = await sequelize.transaction(async (t) => {
      await lockGroupRow(invite.group_id, t);
      const live = await Group.findByPk(invite.group_id, { transaction: t });
      if (!live) {
        return { gone: true };
      }

      // Update invite status
      await invite.update({ status: 'declined' }, { transaction: t });

      // If a UserGroup row exists with status 'invited', destroy it (keyed on the
      // Users.id UUID surrogate — D-11).
      // F-02: hard delete — declining an invite physically removes the row. The `force`
      // flag sits on the `.destroy(` line deliberately: the CI grep gate is LINE-scoped,
      // so putting it on a later line would leave this call reported as a hit.
      await UserGroup.destroy({ force: true,
        where: {
          user_uuid: user.id,
          group_id: invite.group_id,
          status: 'invited',
        },
        transaction: t,
      });

      return { gone: false };
    });

    if (declineResult.gone) {
      return res.status(410).json({ error: 'This group is no longer available' });
    }

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

    // DECISION Phase 88.2 AF-3 — same liveness gate as POST /:invite_id/accept; see
    // the full rationale there. Chosen OVER making GroupInvite paranoid and OVER
    // relying on the Task 1 read-path filters. Placement AFTER the email-match 403
    // is the anti-oracle choice, not incidental ordering.
    const group = await Group.findByPk(invite.group_id);
    if (!group) {
      return res.status(410).json({ error: 'This group is no longer available' });
    }

    // Atomic three-write flow (status flip + UserGroup activation) — same shared
    // helper as the id-based route, so this PRIMARY email-link path is atomic too.
    // WR-01: the helper re-checks liveness under the shared row lock; `gone`
    // maps to the same 410 the pre-transaction gate above emits.
    const acceptResult = await acceptInviteTransactional(invite, user);
    if (acceptResult.gone) {
      return res.status(410).json({ error: 'This group is no longer available' });
    }

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
