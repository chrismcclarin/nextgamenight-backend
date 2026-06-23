// tests/routes/users.test.js
const request = require('supertest');
const express = require('express');
const userRoutes = require('../../routes/users');
const { stubAuth } = require('../helpers/authStub');
const { User, Group, UserGroup, sequelize } = require('../../models');

// Create test app
const app = express();
app.use(express.json());
app.use('/api/users', userRoutes);

// Build an app that injects a fixed verified actor (req.user) before the router,
// so routes deriving the subject from the JWT (e.g. POST / — BE-049) are exercised.
function makeApp(userId) {
  const a = express();
  a.use(express.json());
  a.use(stubAuth({ user_id: userId, email: `${userId}@example.com` }));
  a.use('/api/users', userRoutes);
  return a;
}

describe('User Routes', () => {
  // Clean up database before each test
  beforeEach(async () => {
    await UserGroup.destroy({ where: {} });
    await User.destroy({ where: {} });
    await Group.destroy({ where: {} });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe('POST /api/users (self-upsert — BE-049)', () => {
    it('should create the authenticated user from the verified JWT', async () => {
      const response = await request(makeApp('test-user-1'))
        .post('/api/users')
        .send({ username: 'testuser', email: 'test@example.com' })
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.username).toBe('testuser');
      expect(response.body.email).toBe('test@example.com');
      expect(response.body.user_id).toBe('test-user-1');
    });

    it('should update the authenticated user if their row already exists', async () => {
      await User.create({
        user_id: 'test-user-2',
        username: 'oldusername',
        email: 'old@example.com'
      });

      const response = await request(makeApp('test-user-2'))
        .post('/api/users')
        .send({ username: 'newusername', email: 'new@example.com' })
        .expect(200);

      expect(response.body.user_id).toBe('test-user-2');
      expect(response.body.username).toBe('newusername');
      expect(response.body.email).toBe('new@example.com');
    });

    it('should IGNORE a forged body user_id and only touch the caller\'s own row (BE-049)', async () => {
      // Victim row the attacker tries to overwrite.
      await User.create({
        user_id: 'auth0|victim-B',
        username: 'victim',
        email: 'victim@example.com'
      });

      // Caller A posts a body claiming to be victim B.
      const response = await request(makeApp('auth0|caller-A'))
        .post('/api/users')
        .send({ user_id: 'auth0|victim-B', username: 'hacked', email: 'hacked@evil.com' })
        .expect(200);

      // The write landed on caller A's OWN row, not the victim's.
      expect(response.body.user_id).toBe('auth0|caller-A');

      const victim = await User.scope('withContactInfo').findOne({ where: { user_id: 'auth0|victim-B' } });
      expect(victim.username).toBe('victim');
      expect(victim.email).toBe('victim@example.com');
    });

    it('should return 401 when there is no authenticated user', async () => {
      const response = await request(app) // module app: no req.user injected
        .post('/api/users')
        .send({ username: 'nobody', email: 'nobody@example.com' })
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });
  });

  describe('GET /api/users/:user_id', () => {
    it('should get user by user_id', async () => {
      // Create test user
      const testUser = await User.create({
        user_id: 'test-user-3',
        username: 'testuser3',
        email: 'test3@example.com'
      });

      // 83-05 gates GET /:user_id with requireParamMatchesToken — the verified
      // actor must match the path param, so inject req.user for that user.
      const response = await request(makeApp(testUser.user_id))
        .get(`/api/users/${testUser.user_id}`)
        .expect(200);

      expect(response.body.user_id).toBe(testUser.user_id);
      expect(response.body.username).toBe(testUser.username);
    });

    it('should auto-provision the authenticated user on first read (Phase 78)', async () => {
      // GET /:user_id auto-creates the verified user if their row does not yet
      // exist (TZ-01 auto-create), so a self-read of a brand-new id returns 200
      // with a freshly-created row rather than 404.
      const response = await request(makeApp('auth0|first-time-user'))
        .get('/api/users/auth0|first-time-user')
        .expect(200);

      expect(response.body.user_id).toBe('auth0|first-time-user');
      const created = await User.findOne({ where: { user_id: 'auth0|first-time-user' } });
      expect(created).not.toBeNull();
    });

    it('should include groups when user has groups', async () => {
      // Create user and group
      const testUser = await User.create({
        user_id: 'test-user-4',
        username: 'testuser4',
        email: 'test4@example.com'
      });

      const testGroup = await Group.create({
        group_id: 'test-group-4',
        name: 'Test Group'
      });

      await UserGroup.create({
        user_id: testUser.user_id, // Auth0 STRING id (sourceKey), NOT the UUID testUser.id
        group_id: testGroup.id
      });

      const response = await request(makeApp(testUser.user_id))
        .get(`/api/users/${testUser.user_id}`)
        .expect(200);

      expect(response.body).toHaveProperty('Groups');
      expect(Array.isArray(response.body.Groups)).toBe(true);
    });
  });

  describe('GET /api/users/search/email/:email (WR-01 — cross-user PII)', () => {
    const enc = (e) => encodeURIComponent(e);

    it('cross-user search returns identity + searched email but NEVER phone', async () => {
      await User.create({
        user_id: 'auth0|wr01-victim',
        username: 'victim',
        email: 'wr01-victim@example.com',
        phone: '+15555550123',
      });

      const response = await request(makeApp('auth0|wr01-caller'))
        .get(`/api/users/search/email/${enc('wr01-victim@example.com')}`)
        .expect(200);

      expect(response.body.user_id).toBe('auth0|wr01-victim');
      expect(response.body.username).toBe('victim');
      expect(response.body.email).toBe('wr01-victim@example.com'); // echoed (caller supplied it)
      expect(response.body).not.toHaveProperty('phone'); // the real leak — must be gone
    });

    it('self search returns the full profile incl. phone', async () => {
      await User.create({
        user_id: 'auth0|wr01-self',
        username: 'selfie',
        email: 'wr01-self@example.com',
        phone: '+15555559999',
      });

      const response = await request(makeApp('auth0|wr01-self'))
        .get(`/api/users/search/email/${enc('wr01-self@example.com')}`)
        .expect(200);

      expect(response.body.user_id).toBe('auth0|wr01-self');
      expect(response.body.phone).toBe('+15555559999'); // own row → full contact info
    });
  });
});

