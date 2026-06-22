// tests/routes/groups.invite.test.js
// BSEC-01 / BE-043: Group.invite_token defaultScope (safe-by-default) +
// withInviteToken opt-in + token-stability regression (the review-flagged bug).
//
// Behaviors:
//   1) a default Group read has NO invite_token (safe-by-default)
//   2) a .scope('withInviteToken')/.unscoped() read HAS invite_token
//   3) TOKEN STABILITY — two sequential lazy-generate GET calls for a group
//      that ALREADY has a token return the SAME invite_token (no regeneration
//      on the second QR view). This proves the mutation site reads the column
//      via the scope so `if (!group.invite_token)` is correctly false.
//
// The global tests/setup.js beforeAll requires a test DB, so this whole file
// runs in CI; locally without Postgres it is gated off by that setup hook.

const request = require('supertest');
const express = require('express');
const groupRoutes = require('../../routes/groups');
const { Group, User, UserGroup, sequelize } = require('../../models');

// Harness: inject a verified req.user before the router (mirrors the real
// verifyAuth0Token middleware that server.js mounts). Vary per-test via the
// shared `currentActor` ref.
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/groups', groupRoutes);

describe('BSEC-01 Group invite_token defaultScope + stability', () => {
  let owner;
  let group;

  const cleanup = async () => {
    // UserGroup.group_id is a UUID (Group.id), so we must resolve the group's
    // UUID by its string group_id before deleting its memberships.
    const existing = await Group.findOne({ where: { group_id: 'bsec01-invite-group' } });
    if (existing) {
      await UserGroup.destroy({ where: { group_id: existing.id } });
      await Group.destroy({ where: { id: existing.id } });
    }
    await User.destroy({ where: { user_id: 'auth0|bsec01-invite-owner' } });
  };

  beforeAll(async () => {
    await cleanup();

    owner = await User.create({
      user_id: 'auth0|bsec01-invite-owner',
      username: 'invite-owner',
      email: 'invite-owner@example.com',
    });

    group = await Group.create({
      group_id: 'bsec01-invite-group',
      name: 'Invite Test Group',
    });

    await UserGroup.create({
      user_id: owner.user_id, // Auth0 string — UserGroup.user_id is the Auth0 sub
      group_id: group.id,     // UUID — references Group.id
      role: 'owner',
      status: 'active',
    });
  });

  afterAll(async () => {
    await cleanup();
    await sequelize.close();
  });

  beforeEach(() => {
    currentActor = owner.user_id;
  });

  it('Test 1: a default Group read has NO invite_token', async () => {
    const row = await Group.findByPk(group.id);
    expect(row).not.toBeNull();
    expect(row.toJSON()).not.toHaveProperty('invite_token');
  });

  it('Test 2a: .scope("withInviteToken") read includes invite_token', async () => {
    // Ensure a token exists first via the lazy-generate endpoint.
    await request(app).get(`/api/groups/${group.id}/invite-token`).expect(200);
    const row = await Group.scope('withInviteToken').findByPk(group.id);
    expect(row.invite_token).toBeTruthy();
    expect(typeof row.invite_token).toBe('string');
  });

  it('Test 2b: .unscoped() read includes invite_token', async () => {
    const row = await Group.unscoped().findByPk(group.id);
    expect(row.invite_token).toBeTruthy();
  });

  it('Test 3: TOKEN STABILITY — two sequential lazy-generate GETs return the SAME token', async () => {
    const first = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);
    const second = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);

    expect(first.body.invite_token).toBeTruthy();
    expect(second.body.invite_token).toBe(first.body.invite_token);
    // And the DB row was not rewritten to a new value.
    const row = await Group.scope('withInviteToken').findByPk(group.id);
    expect(row.invite_token).toBe(first.body.invite_token);
  });

  it('Test 3b: reset-invite-token rotates to a DIFFERENT token, then it is stable again', async () => {
    const before = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);

    const rotated = await request(app)
      .post(`/api/groups/${group.id}/reset-invite-token`)
      .expect(200);

    expect(rotated.body.invite_token).toBeTruthy();
    expect(rotated.body.invite_token).not.toBe(before.body.invite_token);

    // After rotation, the lazy-generate GET must return the rotated token,
    // not regenerate yet again.
    const afterRotate = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);
    expect(afterRotate.body.invite_token).toBe(rotated.body.invite_token);
  });

  it('non-member cannot read the invite token (membership gate intact)', async () => {
    currentActor = 'auth0|not-a-member';
    await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(403);
  });
});
