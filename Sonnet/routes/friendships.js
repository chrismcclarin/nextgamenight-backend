// routes/friendships.js
// Friendship CRUD routes: list, search, request, accept, decline, remove
const express = require('express');
const { Op } = require('sequelize');
const { User, Friendship } = require('../models');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// ============================================
// GET / - List friendships for current user
// Query params: status (default: 'accepted'), direction ('sent' or 'received')
// ============================================
router.get('/', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { status = 'accepted', direction } = req.query;

    let whereClause;

    if (status === 'accepted') {
      // Accepted friendships: user can be either requester or addressee
      whereClause = {
        [Op.or]: [
          { requester_id: userId },
          { addressee_id: userId },
        ],
        status: 'accepted',
      };
    } else if (status === 'pending' && direction === 'received') {
      // Pending requests received by user
      whereClause = {
        addressee_id: userId,
        status: 'pending',
      };
    } else if (status === 'pending' && direction === 'sent') {
      // Pending requests sent by user
      whereClause = {
        requester_id: userId,
        status: 'pending',
      };
    } else {
      // Default: query by status with bidirectional lookup
      whereClause = {
        [Op.or]: [
          { requester_id: userId },
          { addressee_id: userId },
        ],
        status,
      };
    }

    const friendships = await Friendship.findAll({
      where: whereClause,
      include: [
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
      ],
      order: [['createdAt', 'DESC']],
    });

    // For accepted friendships, derive the "friend" field for frontend convenience
    if (status === 'accepted') {
      const result = friendships.map((f) => {
        const plain = f.toJSON();
        plain.friend = f.requester_id === userId ? plain.Addressee : plain.Requester;
        return plain;
      });
      return res.json(result);
    }

    res.json(friendships);
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

      // Check for existing friendship in either direction
      const existing = await Friendship.findOne({
        where: {
          [Op.or]: [
            { requester_id: userId, addressee_id: addressee_user_id },
            { requester_id: addressee_user_id, addressee_id: userId },
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
            // Re-request after decline: update in-place, reset directionality
            await existing.update({
              requester_id: userId,
              addressee_id: addressee_user_id,
              status: 'pending',
            });
            return res.status(200).json(existing);
          default:
            break;
        }
      }

      // No existing row: create new friendship request
      const friendship = await Friendship.create({
        requester_id: userId,
        addressee_id: addressee_user_id,
        status: 'pending',
      });

      res.status(201).json(friendship);
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

    const friendship = await Friendship.findByPk(id);

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    // Only the addressee can accept
    if (friendship.addressee_id !== userId) {
      return res.status(403).json({ error: 'Only the recipient can accept a friend request' });
    }

    // Must be pending to accept
    if (friendship.status !== 'pending') {
      return res.status(400).json({ error: 'Friend request is not pending' });
    }

    await friendship.update({ status: 'accepted' });

    res.status(200).json(friendship);
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

    const friendship = await Friendship.findByPk(id);

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    // Only the addressee can decline
    if (friendship.addressee_id !== userId) {
      return res.status(403).json({ error: 'Only the recipient can decline a friend request' });
    }

    // Must be pending to decline
    if (friendship.status !== 'pending') {
      return res.status(400).json({ error: 'Friend request is not pending' });
    }

    await friendship.update({ status: 'declined' });

    res.status(200).json(friendship);
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

    const friendship = await Friendship.findOne({
      where: { id, status: 'accepted' },
    });

    if (!friendship) {
      return res.status(404).json({ error: 'Friendship not found' });
    }

    // Verify user is either requester or addressee
    if (friendship.requester_id !== userId && friendship.addressee_id !== userId) {
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
