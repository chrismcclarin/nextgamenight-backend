// tests/routes/invites.test.js
// Phase 83.2 (INVITE-01): POST /invites/send gains a `friend_user_id` path that
// resolves the friend's email SERVER-SIDE behind an accepted-friendship gate, so
// the client never handles friend emails (preserves 83-06 PII default-deny).
//
// Behaviors covered:
//   a) invite-by-friend_user_id succeeds (201), creates a pending GroupInvite,
//      and the response carries NO email (no PII leak).
//   b) invite-by-friend_user_id with no accepted friendship → 403 (no oracle).
//   c) the classic invite-by-email path still works (201).
//   d) neither email nor friend_user_id → 400.
//
// The global tests/setup.js beforeAll requires a test DB and beforeEach TRUNCATEs
// all tables, so owner/group/friend rows are seeded per-test.

const request = require('supertest');
const express = require('express');
const invitesRoutes = require('../../routes/invites');
const { Group, User, UserGroup, GroupInvite, Friendship } = require('../../models');

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
app.use('/api/invites', invitesRoutes);

describe('POST /invites/send — friend_user_id path (83.2 INVITE-01)', () => {
  let owner;
  let friend;
  let group;

  beforeEach(async () => {
    owner = await User.create({
      user_id: 'auth0|invite-owner',
      username: 'invite-owner',
      email: 'invite-owner@example.com',
    });

    friend = await User.create({
      user_id: 'auth0|invite-friend',
      username: 'invite-friend',
      email: 'invite-friend@example.com',
    });

    group = await Group.create({
      group_id: 'invite-test-group',
      name: 'Invite Test Group',
    });

    await UserGroup.create({
      user_id: owner.user_id,
      group_id: group.id,
      role: 'owner',
      status: 'active',
    });

    currentActor = owner.user_id;
  });

  it('(a) invite-by-friend_user_id succeeds, creates a pending invite, and returns NO email', async () => {
    // Accepted friendship (owner is requester).
    await Friendship.create({
      requester_id: owner.user_id,
      addressee_id: friend.user_id,
      status: 'accepted',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.invite_id).toBeTruthy();

    // No PII leak: the resolved friend email must not appear anywhere in the body.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(friend.email);
    expect(res.body).not.toHaveProperty('email');
    expect(res.body).not.toHaveProperty('invited_email');

    // The invite was created server-side with the resolved email.
    const invite = await GroupInvite.findOne({
      where: { group_id: group.id, status: 'pending' },
    });
    expect(invite).not.toBeNull();
    expect(invite.invited_email.toLowerCase()).toBe(friend.email.toLowerCase());
  });

  it('(a2) accepted friendship works when the FRIEND is the requester (bidirectional)', async () => {
    await Friendship.create({
      requester_id: friend.user_id,
      addressee_id: owner.user_id,
      status: 'accepted',
    });

    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id })
      .expect(201);
  });

  it('(b) invite-by-friend_user_id with no accepted friendship → 403 (no oracle)', async () => {
    // No Friendship row at all.
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id })
      .expect(403);

    expect(res.body.error).toMatch(/only invite your friends/i);

    // No invite should have been created.
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('(b2) a PENDING (not accepted) friendship is NOT enough → 403', async () => {
    await Friendship.create({
      requester_id: owner.user_id,
      addressee_id: friend.user_id,
      status: 'pending',
    });

    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id })
      .expect(403);
  });

  it('(c) the classic invite-by-email path still works → 201', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, email: 'newperson@example.com' })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.invite_id).toBeTruthy();

    const invite = await GroupInvite.findOne({
      where: { group_id: group.id, status: 'pending' },
    });
    expect(invite.invited_email).toBe('newperson@example.com');
  });

  it('(d) neither email nor friend_user_id → 400', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id })
      .expect(400);

    expect(res.body.error).toMatch(/required/i);
  });

  it('(e) non-owner/admin caller is blocked even WITH an accepted friendship → 403 (authorize-first, WR-01)', async () => {
    // An outsider who is genuinely friends with `friend` but is NOT an
    // owner/admin of the group. The permission gate runs BEFORE the friendship
    // lookup, so they are rejected on permission, not friendship.
    const outsider = await User.create({
      user_id: 'auth0|invite-outsider',
      username: 'invite-outsider',
      email: 'invite-outsider@example.com',
    });
    await Friendship.create({
      requester_id: outsider.user_id,
      addressee_id: friend.user_id,
      status: 'accepted',
    });
    currentActor = outsider.user_id;

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id })
      .expect(403);

    expect(res.body.error).toMatch(/owners and admins/i);

    // Nothing created.
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('(f) friend already an active member → 409 (friend path reuses the member guard, IN-03)', async () => {
    await Friendship.create({
      requester_id: owner.user_id,
      addressee_id: friend.user_id,
      status: 'accepted',
    });
    await UserGroup.create({
      user_id: friend.user_id,
      group_id: group.id,
      role: 'member',
      status: 'active',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id })
      .expect(409);

    expect(res.body.error).toMatch(/already a member/i);
  });

  it('(g) friend already has a pending invite → 409 (friend path reuses the pending guard, IN-03)', async () => {
    await Friendship.create({
      requester_id: owner.user_id,
      addressee_id: friend.user_id,
      status: 'accepted',
    });
    await GroupInvite.create({
      group_id: group.id,
      invited_email: friend.email.toLowerCase(),
      invited_by: owner.user_id,
      token: 'pre-existing-pending-token',
      status: 'pending',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id })
      .expect(409);

    expect(res.body.error).toMatch(/pending invite/i);
  });

  it('(h) a user cannot invite themselves via friend_user_id → 400 (WR-02)', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: owner.user_id })
      .expect(400);

    expect(res.body.error).toMatch(/yourself/i);

    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('(i) an empty-string friend_user_id is rejected → 400 (WR-03)', async () => {
    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: '' })
      .expect(400);
  });
});
