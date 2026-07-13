// routes/gameReviews.js
const express = require('express');
const { GameReview, User, Game } = require('../models');
const router = express.Router();
const { validateReviewCreate, validateUUID } = require('../middleware/validators');
const { isActiveMember, isMemberOrHigher } = require('../services/authorizationService');
const { resolveTargetUserUuidOnly } = require('../utils/resolveTargetUser');


// Get reviews for a game in a specific group
router.get('/game/:game_id/group/:group_id', async (req, res) => {
  try {
    const { game_id, group_id } = req.params;

    // Authorize on the VERIFIED caller (req.user), not the client-supplied
    // ?user_id (spoofable, and omitting it skipped the check entirely —
    // FSEC-02, same fix as the sibling /user/:user_id/group/:group_id route).
    const callerId = req.user?.user_id;
    if (!callerId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const hasAccess = await isActiveMember(callerId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }

    // Phase 87.3 PR-C (plan 09 Task 2b, Req 1): the reviewer's nested User
    // include is sub-free — id/username only. Safe: gameDetail's review-author
    // reads were cut to review.User.id by plan 06 (PR-B, merged first).
    const reviews = await GameReview.findAll({
      where: { game_id, group_id },
      include: [
        { model: User, attributes: ['id', 'username'] },
        { model: Game, attributes: ['name'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json(reviews);
  } catch (error) {
    console.error('[gameReviews] request failed:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Get all reviews by a user in a group
router.get('/user/:user_id/group/:group_id', async (req, res) => {
  try {
    const { user_id: target_user_id, group_id } = req.params;

    // Authorize on the VERIFIED caller (req.user), not a client-supplied ?user_id.
    // The FE dropped the spoofable ?user_id query param (FSEC-02), so the old
    // `if (user_id)` gate no longer fired — leaving this endpoint with zero
    // authorization. Enforce group membership unconditionally on the token identity.
    const callerId = req.user?.user_id;
    if (!callerId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const hasAccess = await isActiveMember(callerId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied to this group' });
    }

    // Phase 87.3 PR-C (deferred review #1/#12, amended D1): the target lookup
    // was SUB-ONLY — contracted UUID-only to match this plan's end-state (the
    // FE client fn is dead code today; any future caller sources member ids
    // from the aliased rosters, which now carry UUIDs). A sub-shaped target
    // rejects as not-found.
    const targetUser = await resolveTargetUserUuidOnly(target_user_id);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // PR-C (Req 1): nested User include sub-free — id/username only.
    const reviews = await GameReview.findAll({
      where: { user_id: targetUser.id, group_id },
      include: [
        { model: User, attributes: ['id', 'username'] },
        { model: Game, attributes: ['name', 'image_url'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json(reviews);
  } catch (error) {
    console.error('[gameReviews] request failed:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Create or update a review
router.post('/', validateReviewCreate, async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { group_id, game_id, rating, review_text, is_recommended } = req.body;

    // Verify user is at least a full member (pending members cannot write reviews)
    const hasAccess = await isMemberOrHigher(userId, group_id);
    if (!hasAccess) {
      return res.status(403).json({ error: 'Pending members cannot perform this action', required_role: 'member' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check if review already exists
    // Note: GameReview.user_id is UUID (references Users.id), not Users.user_id (Auth0 string)
    const existingReview = await GameReview.findOne({
      where: { user_id: user.id, group_id, game_id }
    });
    
    // Validate and convert rating (0-5, increments of 0.5)
    let ratingValue = null;
    if (rating !== null && rating !== undefined && rating !== '') {
      ratingValue = parseFloat(rating);
      if (isNaN(ratingValue)) {
        return res.status(400).json({ error: 'Rating must be a valid number' });
      }
      if (ratingValue < 0 || ratingValue > 5) {
        return res.status(400).json({ error: 'Rating must be between 0 and 5' });
      }
      // Round to nearest 0.5 increment
      ratingValue = Math.round(ratingValue * 2) / 2;
    }
    
    let review;
    if (existingReview) {
      // Update existing review
      await existingReview.update({ 
        rating: ratingValue, 
        review_text: review_text || null, 
        is_recommended: is_recommended !== undefined ? is_recommended : null 
      });
      review = existingReview;
    } else {
      // Create new review
      // Note: GameReview.user_id is UUID (references Users.id), not Users.user_id (Auth0 string)
      review = await GameReview.create({
        user_id: user.id,
        group_id,
        game_id,
        rating: ratingValue,
        review_text: review_text || null,
        is_recommended: is_recommended !== undefined ? is_recommended : null
      });
    }
    
    // Fetch complete review data. PR-C (Req 1): nested User include sub-free.
    const completeReview = await GameReview.findByPk(review.id, {
      include: [
        { model: User, attributes: ['id', 'username'] },
        { model: Game, attributes: ['name', 'image_url'] }
      ]
    });
    
    res.json(completeReview);
  } catch (error) {
    console.error('[gameReviews] request failed:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Delete a review
router.delete('/:id', async (req, res) => {
  try {
    // BSEC-01 / BE-100: derive the actor from the verified JWT — NEVER from
    // req.body.user_id (which any client can spoof to delete another user's
    // review). Matches the POST handler's own pattern at :76.
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const review = await GameReview.findByPk(req.params.id, {
      include: [{ model: User }]
    });

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    // Verify the verified actor owns the review.
    if (review.User.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await review.destroy();
    res.json({ message: 'Review deleted successfully' });
  } catch (error) {
    console.error('[gameReviews] request failed:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});


module.exports = router;