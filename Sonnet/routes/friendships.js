// routes/friendships.js
// Friendship CRUD routes: list, search, request, accept, decline, remove
const express = require('express');
const { Op, UniqueConstraintError } = require('sequelize');
const { User, Friendship } = require('../models');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// Shared Requester/Addressee include shape — used to resolve the Auth0-string
// display ids for the D-10/D-12 wire shim (see toFriendshipWire).
const USER_INCLUDES = [
  {
    model: User,
    as: 'Requester',
    // BSEC-01 (D-03): email removed — a friend list must not expose other
    // users' email addresses; username + user_id suffice for display.
    attributes: ['id', 'username', 'user_id'],
  },
  {
    model: User,
    as: 'Addressee',
    attributes: ['id', 'username', 'user_id'],
  },
];

// ============================================
// D-10/D-12 wire shim (Phase 87.1, BINT-02): the frozen frontend consumes
// `requester_id` / `addressee_id` as Auth0 user_id STRINGS. During the UUID
// cutover the string columns are still dual-written, but Plan 09 DROPS them —
// so we serialize the Auth0 strings from the included Requester/Addressee User
// rows (their `.user_id`) or explicit args, and STRIP the surrogate
// `requester_uuid` / `addressee_uuid` FKs. That keeps every mutation/list
// response byte-stable across the Plan 09 column drop and never leaks a UUID.
// ============================================
function toFriendshipWire(friendship, { requesterAuth0, addresseeAuth0 } = {}) {
  const plain = friendship.toJSON ? friendship.toJSON() : { ...friendship };
  const reqAuth0 =
    requesterAuth0 ?? (plain.Requester && plain.Requester.user_id) ?? plain.requester_id;
  const addrAuth0 =
    addresseeAuth0 ?? (plain.Addressee && plain.Addressee.user_id) ?? plain.addressee_id;
  plain.requester_id = reqAuth0;
  plain.addressee_id = addrAuth0;
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
    // convenience. The friend-derive uses the UUID compare (not the Auth0
    // string) but the emitted id fields stay Auth0 strings via toFriendshipWire.
    if (status === 'accepted') {
      const result = friendships.map((f) => {
        const plain = toFriendshipWire(f);
        plain.friend = f.requester_uuid === caller.id ? plain.Addressee : plain.Requester;
        return plain;
      });
      return res.json(result);
    }

    // D-12: the raw pending/sent/default path must ALSO serialize Auth0 strings
    // and strip the *_uuid columns — not just the accepted branch.
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
      // unnecessary — user_id + username are enough to send a friend request.
      attributes: ['id', 'username', 'user_id'],
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

      // Prevent self-friending
      if (addressee_user_id === userId) {
        return res.status(400).json({ error: 'Cannot send a friend request to yourself' });
      }

      // D-11 (Phase 87.1): resolve BOTH the caller and the target Auth0 strings
      // to Users.id before touching the UUID-keyed Friendship columns. The
      // target must be a real local user (friend requests originate from
      // /search, which only returns local Users rows).
      const caller = await User.findOne({ where: { user_id: userId } });
      if (!caller) {
        return res.status(403).json({ error: 'Caller not found' });
      }
      const addresseeUser = await User.findOne({ where: { user_id: addressee_user_id } });
      if (!addresseeUser) {
        return res.status(404).json({ error: 'User not found' });
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
            // D-12 shim: emit Auth0 strings, strip the *_uuid columns.
            return res.status(200).json(
              toFriendshipWire(existing, {
                requesterAuth0: userId,
                addresseeAuth0: addressee_user_id,
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

        // D-12 shim: emit Auth0 strings, strip the *_uuid columns.
        return res.status(201).json(
          toFriendshipWire(friendship, {
            requesterAuth0: userId,
            addresseeAuth0: addressee_user_id,
          })
        );
      } catch (createErr) {
        if (createErr instanceof UniqueConstraintError) {
          // Concurrent duplicate won the race — re-find and return the winner
          // with a byte-identical response shape (a serialized Friendship row).
          // The winner may be in EITHER direction, so serialize its Auth0
          // strings from the included Requester/Addressee rows (D-12).
          const raceRow = await Friendship.findOne({
            where: {
              [Op.or]: [
                { requester_uuid: caller.id, addressee_uuid: addresseeUser.id },
                { requester_uuid: addresseeUser.id, addressee_uuid: caller.id },
              ],
            },
            include: USER_INCLUDES,
          });
          if (raceRow) {
            return res.status(201).json(toFriendshipWire(raceRow));
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

    // D-12 shim: the caller IS the addressee, so addressee Auth0 = userId;
    // requester Auth0 comes from the include. Strip the *_uuid columns.
    res.status(200).json(toFriendshipWire(friendship, { addresseeAuth0: userId }));
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

    // D-12 shim: caller IS the addressee; strip the *_uuid columns.
    res.status(200).json(toFriendshipWire(friendship, { addresseeAuth0: userId }));
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
