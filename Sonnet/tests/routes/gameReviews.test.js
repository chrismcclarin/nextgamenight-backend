// tests/routes/gameReviews.test.js
const request = require('supertest');
const express = require('express');
const gameReviewRoutes = require('../../routes/gameReviews');
const { GameReview, User, Group, Game } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

// POST and DELETE derive the actor from req.user (BSEC-01 / BE-100 default-deny
// authz, Phase 83). GET routes use req.query.user_id for the access check.
// Build a per-test app that injects req.user ahead of the router; pass null for
// the unauthenticated case.
function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor ? { user_id: actor.user_id, email: actor.email } : undefined;
    next();
  });
  app.use('/api/game-reviews', gameReviewRoutes);
  return app;
}

describe('GameReview Routes', () => {
  let testUser1, testUser2, testGroup, testGame;

  // Seed in beforeEach so fixtures survive the global per-test TRUNCATE
  // (plan-01 isolation harness). Connection lifecycle is owned by
  // tests/globalTeardown.js — this suite never calls sequelize.close().
  // testUser1 is a member of the group; testUser2 is a non-member.
  // NOTE: GameReview.rating validates 0-5 (middleware/validators.js:247-250).
  beforeEach(async () => {
    testUser1 = await makeUser({ username: 'testuser1' });
    testUser2 = await makeUser({ username: 'testuser2' });
    testGroup = await makeGroup({ name: 'Test Group' });
    testGame = await Game.create({ name: 'Test Game', is_custom: true });

    // Add user1 to group (Auth0 string user_id via factory).
    await addToGroup(testUser1, testGroup);
  });

  describe('GET /api/game-reviews/game/:game_id/group/:group_id', () => {
    it('should get reviews for a game in a group', async () => {
      await GameReview.create({
        user_id: testUser1.id, // GameReview.user_id is UUID — correct.
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4,
        review_text: 'Great game!'
      });

      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/game/${testGame.id}/group/${testGroup.id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0]).toHaveProperty('rating');
      expect(response.body[0]).toHaveProperty('User');
      expect(response.body[0]).toHaveProperty('Game');
    });

    it('should return empty array if no reviews exist', async () => {
      const newGame = await Game.create({ name: 'New Game', is_custom: true });

      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/game/${newGame.id}/group/${testGroup.id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(0);
    });

    it('should return 403 if user_id provided but user not in group', async () => {
      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/game/${testGame.id}/group/${testGroup.id}?user_id=${testUser2.user_id}`)
        .expect(403);

      expect(response.body.error).toBe('Access denied to this group');
    });

    it('should allow access if user_id provided and user is in group', async () => {
      await GameReview.create({
        user_id: testUser1.id,
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4.5
      });

      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/game/${testGame.id}/group/${testGroup.id}?user_id=${testUser1.user_id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should handle database errors gracefully', async () => {
      // Invalid UUID format triggers a DB query error.
      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/game/invalid-id/group/${testGroup.id}`)
        .expect(500);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/game-reviews/user/:user_id/group/:group_id', () => {
    it('should get all reviews by a user in a group', async () => {
      await GameReview.create({
        user_id: testUser1.id,
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4.5,
        review_text: 'Amazing game!'
      });

      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/user/${testUser1.user_id}/group/${testGroup.id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0]).toHaveProperty('rating');
      expect(response.body[0]).toHaveProperty('User');
      expect(response.body[0]).toHaveProperty('Game');
    });

    it('should return empty array if user has no reviews', async () => {
      const newUser = await makeUser({ username: 'newuser' });
      await addToGroup(newUser, testGroup);

      const response = await request(makeApp(newUser))
        .get(`/api/game-reviews/user/${newUser.user_id}/group/${testGroup.id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBe(0);
    });

    it('should return 403 if user_id provided but user not in group', async () => {
      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/user/${testUser1.user_id}/group/${testGroup.id}?user_id=${testUser2.user_id}`)
        .expect(403);

      expect(response.body.error).toBe('Access denied to this group');
    });

    it('should return 404 if user not found', async () => {
      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/user/non-existent-user/group/${testGroup.id}`)
        .expect(404);

      expect(response.body.error).toBe('User not found');
    });

    it('should allow access if user_id provided and user is in group', async () => {
      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/user/${testUser1.user_id}/group/${testGroup.id}?user_id=${testUser1.user_id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should handle database errors when fetching reviews', async () => {
      const response = await request(makeApp(testUser1))
        .get(`/api/game-reviews/user/${testUser1.user_id}/group/invalid-uuid`)
        .expect(500);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('POST /api/game-reviews', () => {
    it('should create a new review', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4,
        review_text: 'Excellent game!',
        is_recommended: true
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(Number(response.body.rating)).toBe(4);
      expect(response.body.review_text).toBe(reviewData.review_text);
    });

    it('should update existing review if one already exists', async () => {
      await GameReview.create({
        user_id: testUser1.id,
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 3.5
      });

      const updateData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4.5,
        review_text: 'Updated review'
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(updateData)
        .expect(200);

      expect(Number(response.body.rating)).toBe(4.5);
      expect(response.body.review_text).toBe('Updated review');
    });

    it('should return 403 if user not in group', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4
      };

      const response = await request(makeApp(testUser2))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(403);

      expect(response.body.error).toBe('Pending members cannot perform this action');
    });

    it('should return 401 if unauthenticated', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4
      };

      const response = await request(makeApp(null))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    it('should create review with only rating', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 3.5
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(Number(response.body.rating)).toBe(3.5);
      expect(response.body.review_text).toBeNull();
    });

    it('should create review with only review_text', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        review_text: 'Great game without rating'
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.review_text).toBe(reviewData.review_text);
    });

    it('should create review with is_recommended flag', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4.5,
        is_recommended: true
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(200);

      expect(response.body.is_recommended).toBe(true);
    });

    it('should return 400 for rating out of range', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 11 // Invalid: validator allows 0-5
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    it('should return 400 for missing required fields', async () => {
      const reviewData = {
        // Missing group_id and game_id (both required UUIDs by the validator)
        rating: 4
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    it('should include User and Game in response', async () => {
      const reviewData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(200);

      expect(response.body).toHaveProperty('User');
      expect(response.body).toHaveProperty('Game');
      expect(response.body.User).toHaveProperty('username');
      expect(response.body.Game).toHaveProperty('name');
    });

    it('should return 400 for invalid group_id format', async () => {
      const reviewData = {
        group_id: 'invalid-uuid',
        game_id: testGame.id,
        rating: 4
      };

      const response = await request(makeApp(testUser1))
        .post('/api/game-reviews')
        .send(reviewData)
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('DELETE /api/game-reviews/:id', () => {
    it('should delete a review', async () => {
      const review = await GameReview.create({
        user_id: testUser1.id,
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4
      });

      const response = await request(makeApp(testUser1))
        .delete(`/api/game-reviews/${review.id}`)
        .expect(200);

      expect(response.body.message).toBe('Review deleted successfully');

      const deletedReview = await GameReview.findByPk(review.id);
      expect(deletedReview).toBeNull();
    });

    it('should return 403 if user does not own the review', async () => {
      const review = await GameReview.create({
        user_id: testUser1.id,
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4
      });

      const response = await request(makeApp(testUser2))
        .delete(`/api/game-reviews/${review.id}`)
        .expect(403);

      expect(response.body.error).toBe('Access denied');
    });

    it('should return 404 if review not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(makeApp(testUser1))
        .delete(`/api/game-reviews/${fakeId}`)
        .expect(404);

      expect(response.body.error).toBe('Review not found');
    });

    it('should return 401 if unauthenticated', async () => {
      const review = await GameReview.create({
        user_id: testUser1.id,
        group_id: testGroup.id,
        game_id: testGame.id,
        rating: 4
      });

      const response = await request(makeApp(null))
        .delete(`/api/game-reviews/${review.id}`)
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });

    it('should handle invalid UUID format gracefully', async () => {
      const response = await request(makeApp(testUser1))
        .delete('/api/game-reviews/invalid-uuid')
        .expect(500);

      expect(response.body).toHaveProperty('error');
    });
  });
});
