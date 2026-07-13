// routes/friendships.js
// Friendship CRUD routes: list, search, request, accept, decline, remove
const express = require('express');
const { Op, UniqueConstraintError } = require('sequelize');
const { User, Friendship } = require('../models');
const { body, validationResult } = require('express-validator');
const { resolveTargetUserUuidOnly } = require('../utils/resolveTargetUser');

const router = express.Router();

// Shared Requester/Addressee include shape — the nested objects the FE compares
// against (nested `.id` UUID, D-05).
const USER_INCLUDES = [
  {
    model: User,
    as: 'Requester',
    // BSEC-01 (D-03): email removed — a friend list must not expose other
    // users' email addresses. Phase 87.3 PR-C (plan 09, Req 1): the sub
    // `user_id` is removed from the nested include too — id + username are
    // the FE's read surface (PR-B cut every nested-sub reader to `.id`).
    attributes: ['id', 'username'],
  },
  {
    model: User,
    as: 'Addressee',
    attributes: ['id', 'username'],
  },
];

// ============================================
// Phase 87.3 PR-C wire serializer (plan 09, SPEC Req 2 carry-UUID lock): the
// flat `requester_id` / `addressee_id` field NAMES are retained but their
// VALUES now carry the Users.id UUID (equal to the nested Requester.id /
// Addressee.id) — no Auth0 sub crosses the wire. Params are named
// `requesterUuid`/`addresseeUuid` so any leftover call site still passing a
// sub under the old `requesterAuth0` key resolves to undefined and falls back
// to the row's own UUID columns instead of silently leaking the sub.
// ============================================
function toFriendshipWire(friendship, { requesterUuid, addresseeUuid } = {}) {
  const plain = friendship.toJSON ? friendship.toJSON() : { ...friendship };
  plain.requester_id =
    requesterUuid ?? plain.requester_uuid ?? (plain.Requester && plain.Requester.id);
  plain.addressee_id =
    addresseeUuid ?? plain.addressee_uuid ?? (plain.Addressee && plain.Addressee.id);
  // Keep the wire to ONE identifier pair (pre-cutover shape had no *_uuid):
  // the surrogate FK columns duplicate the flat fields' values post-alias.
  delete plain.requester_uuid;
  delete plain.addressee_uuid;
  return plain;
}

// ============================================
// GET / - List friendships for current user
// Query params: status (default: 'accepted'), direction ('sent' or 'received')
// ============================================
router.get('/', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { status = 'accepted', direction } = req.query;

    // D-11 (Phase 87.1): Friendship is keyed on the Users.id UUID surrogate
    // (requester_uuid/addressee_uuid). Resolve the caller's Auth0 string to
    // Users.id ONCE — comparing a UUID column against an Auth0 string is
    // always-false and would silently return an empty friend list. Fail-safe:
    // a caller with no Users row simply has no friendships.
    const caller = await User.findOne({ where: { user_id: userId } });
    if (!caller) {
      return res.json([]);
    }

    let whereClause;

    if (status === 'accepted') {
      // Accepted friendships: user can be either requester or addressee
      whereClause = {
        [Op.or]: [
          { requester_uuid: caller.id },
          { addressee_uuid: caller.id },
        ],
        status: 'accepted',
      };
    } else if (status === 'pending' && direction === 'received') {
      // Pending requests received by user
      whereClause = {
        addressee_uuid: caller.id,
        status: 'pending',
      };
    } else if (status === 'pending' && direction === 'sent') {
      // Pending requests sent by user
      whereClause = {
        requester_uuid: caller.id,
        status: 'pending',
      };
    } else {
      // Default: query by status with bidirectional lookup
      whereClause = {
        [Op.or]: [
          { requester_uuid: caller.id },
          { addressee_uuid: caller.id },
        ],
        status,
      };
    }

    const friendships = await Friendship.findAll({
      where: whereClause,
      include: USER_INCLUDES,
      order: [['createdAt', 'DESC']],
    });

    // For accepted friendships, derive the "friend" field for frontend
    // convenience. The friend-derive uses the UUID compare; the emitted flat
    // id fields carry the Users.id UUID via toFriendshipWire (PR-C, Req 2).
    if (status === 'accepted') {
      const result = friendships.map((f) => {
        const plain = toFriendshipWire(f);
        plain.friend = f.requester_uuid === caller.id ? plain.Addressee : plain.Requester;
        return plain;
      });
      return res.json(result);
    }

    // PR-C: the raw pending/sent/default path rides the same UUID-carrying
    // serializer as the accepted branch.
    res.json(friendships.map((f) => toFriendshipWire(f)));
  } catch (error) {
    console.error('Error fetching friendships:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// GET /search - Search user by exact email (local DB only)
// Query param: email (required)
// Does NOT use Auth0 Management API -- only local Users table
// ============================================
router.get('/search', async (req, res) => {
  try {
    const { email } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'Email query parameter is required' });
    }

    const user = await User.findOne({
      where: { email: email.toLowerCase() },
      // BSEC-01 (D-03): email removed from the projection (the WHERE filter is
      // unaffected). The searcher supplied the email; echoing it back is
      // unnecessary. Phase 87.3 PR-C (BE-12, user D1 resolution): the flat sub
      // `user_id` is DROPPED — the sole sanctioned drop of this phase. The only
      // FE consumer (the friends page) reads `foundUser.id` (plan 06) and the
      // friend-request send is UUID-only post-PR-C.
      attributes: ['id', 'username'],
    });

    if (!user) {
      return res.status(404).json({ error: 'No user found with that email' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error searching user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// POST /request - Send a friend request
// Body: { addressee_user_id } (Auth0 user_id string)
// ============================================
router.post(
  '/request',
  [
    body('addressee_user_id')
      .isString()
      .notEmpty()
      .withMessage('addressee_user_id is required'),
  ],
  async (req, res) => {
    try {
      // Validate input
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const userId = req.user.user_id;
      const { addressee_user_id } = req.body;

      // D-11 (Phase 87.1): resolve BOTH the caller and the target to Users.id
      // before touching the UUID-keyed Friendship columns. The target must be a
      // real local user (friend requests originate from /search, which only
      // returns local Users rows).
      //
      // Phase 87.3 PR-C (plan 09, user D1 contraction): the target identifier
      // is UUID-ONLY — the PR-A sub fallback (AF7) is removed. Safe because
      // PR-B (plan 06, AF12b) cut every FE sender of addressee_user_id to the
      // nested `.id`. A sub-shaped target now rejects as not-found (accepted
      // stale-bundle trade-off; do not re-add the fallback).
      const caller = await User.findOne({ where: { user_id: userId } });
      if (!caller) {
        return res.status(403).json({ error: 'Caller not found' });
      }
      const addresseeUser = await resolveTargetUserUuidOnly(addressee_user_id);
      if (!addresseeUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent self-friending — compare canonical (resolved) identity, not the
      // raw param, so the guard fires whether the client sent a UUID or a sub
      // (a raw sub-vs-UUID compare would silently stop rejecting self-requests).
      if (addresseeUser.id === caller.id) {
        return res.status(400).json({ error: 'Cannot send a friend request to yourself' });
      }

      // Check for existing friendship in either direction (UUID keyspace)
      const existing = await Friendship.findOne({
        where: {
          [Op.or]: [
            { requester_uuid: caller.id, addressee_uuid: addresseeUser.id },
            { requester_uuid: addresseeUser.id, addressee_uuid: caller.id },
          ],
        },
      });

      if (existing) {
        switch (existing.status) {
          case 'accepted':
            return res.status(409).json({ error: 'Already friends' });
          case 'pending':
            return res.status(409).json({ error: 'Friend request already pending' });
          case 'blocked':
            return res.status(403).json({ error: 'Cannot send friend request' });
          case 'declined':
            // Re-request after decline: update in-place, RESET DIRECTIONALITY.
            // The re-requester (the caller) becomes the new requester, so this
            // swaps requester_uuid/addressee_uuid to the caller→target direction
            // (guaranteeing only the new addressee can accept — not the
            // re-requester). Plan 09 cutover: the old Auth0-string requester_id /
            // addressee_id columns were removed from the model.
            await existing.update({
              requester_uuid: caller.id,
              addressee_uuid: addresseeUser.id,
              status: 'pending',
            });
            // PR-C: flat fields CARRY the resolved Users.id UUIDs (Req 2 —
            // names stable, values UUID). This include-less path maps the
            // UUIDs by the same requester/addressee direction the update wrote.
            return res.status(200).json(
              toFriendshipWire(existing, {
                requesterUuid: caller.id,
                addresseeUuid: addresseeUser.id,
              })
            );
          default:
            break;
        }
      }

      // No existing row: create new friendship request. Phase 87 / BINT-01
      // (T-87-07): a concurrent duplicate request can win the race between the
      // findOne pre-check above and this create, violating the Friendship
      // functional unique index (LEAST/GREATEST canonical requester/addressee
      // key — migration-only, absent from the model). Absorb the
      // UniqueConstraintError -> re-find the winning row and return the SAME
      // success shape the happy path returns, so a double-submit degrades to
      // success (exactly one row) instead of a 500. Canonical keying unchanged.
      try {
        // Phase 87.1 (Plan 09 cutover): keyed on the Users.id UUID endpoints — the old
        // Auth0-string requester_id / addressee_id columns were removed from the model.
        const friendship = await Friendship.create({
          requester_uuid: caller.id, // Users.id UUID (requester endpoint)
          addressee_uuid: addresseeUser.id, // Users.id UUID (addressee endpoint)
          status: 'pending',
        });

        // PR-C: flat fields CARRY the resolved Users.id UUIDs (Req 2). The
        // create() row has no includes, so the explicit resolved UUIDs are the
        // source (they equal the row's requester_uuid/addressee_uuid).
        return res.status(201).json(
          toFriendshipWire(friendship, {
            requesterUuid: caller.id,
            addresseeUuid: addresseeUser.id,
          })
        );
      } catch (createErr) {
        if (createErr instanceof UniqueConstraintError) {
          // Concurrent duplicate won the race — re-find and return the winner with a
          // shape BYTE-IDENTICAL to the happy path (F5). The happy path serializes a
          // create() row with NO includes, so re-find WITHOUT USER_INCLUDES (nested
          // Requester/Addressee objects would otherwise leak on ONLY this path). The
          // winner may be in EITHER direction, so map requester/addressee UUIDs by
          // which uuid landed in requester_uuid (PR-C: the flats carry UUIDs).
          const raceRow = await Friendship.findOne({
            where: {
              [Op.or]: [
                { requester_uuid: caller.id, addressee_uuid: addresseeUser.id },
                { requester_uuid: addresseeUser.id, addressee_uuid: caller.id },
              ],
            },
          });
          if (raceRow) {
            const callerIsRequester = raceRow.requester_uuid === caller.id;
            return res.status(201).json(
              toFriendshipWire(raceRow, {
                requesterUuid: callerIsRequester ? caller.id : addresseeUser.id,
                addresseeUuid: callerIsRequester ? addresseeUser.id : caller.id,
              })
            );
          }
          throw createErr; // Unexpected state — re-throw
        }
        throw createErr;
      }
    } catch (error) {
      console.error('Error sending friend request:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ============================================
// POST /:id/accept - Accept a friend request
// Only the addressee can accept
// ============================================
router.post('/:id/accept', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;

    // D-11: resolve the caller's Auth0 string to Users.id ONCE, then compare
    // against the UUID ownership column. The old `addressee_id !== userId`
    // (UUID column vs Auth0 string) was always-true — a classic silent-failure
    // site that 403'd every legitimate addressee.
    const caller = await User.findOne({ where: { user_id: userId } });
    if (!caller) {
      return res.status(403).json({ error: 'Only the recipient can accept a friend request' });
    }

    const friendship = await Friendship.findByPk(id, { include: USER_INCLUDES });

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    // Only the addressee can accept (UUID compare)
    if (friendship.addressee_uuid !== caller.id) {
      return res.status(403).json({ error: 'Only the recipient can accept a friend request' });
    }

    // Must be pending to accept
    if (friendship.status !== 'pending') {
      return res.status(400).json({ error: 'Friend request is not pending' });
    }

    await friendship.update({ status: 'accepted' });

    // PR-C: the caller IS the addressee — pass the caller's resolved UUID; the
    // requester UUID falls back to the row's requester_uuid (Req 2 carry-UUID).
    res.status(200).json(toFriendshipWire(friendship, { addresseeUuid: caller.id }));
  } catch (error) {
    console.error('Error accepting friend request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// POST /:id/decline - Decline a friend request
// Only the addressee can decline
// ============================================
router.post('/:id/decline', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;

    // D-11: resolve caller UUID once, compare the UUID ownership column.
    const caller = await User.findOne({ where: { user_id: userId } });
    if (!caller) {
      return res.status(403).json({ error: 'Only the recipient can decline a friend request' });
    }

    const friendship = await Friendship.findByPk(id, { include: USER_INCLUDES });

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    // Only the addressee can decline (UUID compare)
    if (friendship.addressee_uuid !== caller.id) {
      return res.status(403).json({ error: 'Only the recipient can decline a friend request' });
    }

    // Must be pending to decline
    if (friendship.status !== 'pending') {
      return res.status(400).json({ error: 'Friend request is not pending' });
    }

    await friendship.update({ status: 'declined' });

    // PR-C: caller IS the addressee — pass the caller's resolved UUID.
    res.status(200).json(toFriendshipWire(friendship, { addresseeUuid: caller.id }));
  } catch (error) {
    console.error('Error declining friend request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// DELETE /:id - Remove a friend (unfriend)
// Either requester or addressee can remove
// ============================================
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.user_id;

    // D-11: resolve caller UUID once, compare the UUID ownership columns.
    const caller = await User.findOne({ where: { user_id: userId } });
    if (!caller) {
      return res.status(403).json({ error: 'Not authorized to remove this friendship' });
    }

    const friendship = await Friendship.findOne({
      where: { id, status: 'accepted' },
    });

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    // Verify caller is either requester or addressee (UUID compare)
    if (friendship.requester_uuid !== caller.id && friendship.addressee_uuid !== caller.id) {
      return res.status(403).json({ error: 'Not authorized to remove this friendship' });
    }

    await friendship.destroy();

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error removing friend:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
