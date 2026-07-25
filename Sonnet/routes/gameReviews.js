// routes/gameReviews.js
const express = require('express');
const { GameReview, User, Game } = require('../models');
const router = express.Router();
const { validateReviewCreate, validateUUID } = require('../middleware/validators');
const { isActiveMember, isMemberOrHigher } = require('../services/authorizationService');
// (87.6) resolveTargetUserUuidOnly import removed with the deleted
// GET /user/:user_id/group/:group_id route — it was the only consumer here.


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


// GET /user/:user_id/group/:group_id deleted 87.6 (Tier-3, owner batch decision
// 2026-07-22 — REDELETE-EVIDENCE item 14). Never wired: zero FE callers
// (getUserReviews) and zero game-reviews/user path literals across
// periodictabletop/src. The list-your-reviews capability is owned by the future
// feature todo 2026-07-22-review-delete-and-list-your-reviews-feature.md.
// Pinned 404 in the suite.


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


// DELETE /:id deleted 87.6 (Tier-3, owner batch decision 2026-07-22 —
// REDELETE-EVIDENCE item 13). Never wired: zero FE callers (deleteReview). The
// review-delete capability is owned by the future feature todo
// 2026-07-22-review-delete-and-list-your-reviews-feature.md. Review editing
// rides the live POST /game-reviews upsert, which stays untouched. Pinned 404.


module.exports = router;