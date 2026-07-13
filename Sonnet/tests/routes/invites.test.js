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
const { Group, User, UserGroup, GroupInvite, Friendship, Event, EventParticipation } = require('../../models');

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
      user_uuid: owner.id, // D-11 dual-write (Plan 87.1-05): isOwnerOrAdmin keys user_uuid
      group_id: group.id,
      role: 'owner',
      status: 'active',
    });

    currentActor = owner.user_id;
  });

  it('(a) invite-by-friend_user_id succeeds, creates a pending invite, and returns NO email', async () => {
    // Accepted friendship (owner is requester).
    await Friendship.create({
      requester_uuid: owner.id, // D-11 dual-write (Plan 87.1-05)
      addressee_uuid: friend.id, // D-11 dual-write (Plan 87.1-05)
      status: 'accepted',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // PR-C: senders pass the Users.id UUID (plan 06 cut)
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

    // D-04 (Phase 87.1, Plan 09): the send-create records the caller's Users.id UUID
    // in invited_by_uuid (the old Auth0-string invited_by column was removed).
    expect(invite.invited_by_uuid).toBe(owner.id);
  });

  it('(a2) accepted friendship works when the FRIEND is the requester (bidirectional)', async () => {
    await Friendship.create({
      requester_uuid: friend.id, // D-11 dual-write (Plan 87.1-05)
      addressee_uuid: owner.id, // D-11 dual-write (Plan 87.1-05)
      status: 'accepted',
    });

    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // PR-C: senders pass the Users.id UUID (plan 06 cut)
      .expect(201);
  });

  it('(b) invite-by-friend_user_id with no accepted friendship → 403 (no oracle)', async () => {
    // No Friendship row at all.
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // PR-C: senders pass the Users.id UUID (plan 06 cut)
      .expect(403);

    expect(res.body.error).toMatch(/only invite your friends/i);

    // No invite should have been created.
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('(b2) a PENDING (not accepted) friendship is NOT enough → 403', async () => {
    await Friendship.create({
      requester_uuid: owner.id, // D-11 dual-write (Plan 87.1-05)
      addressee_uuid: friend.id, // D-11 dual-write (Plan 87.1-05)
      status: 'pending',
    });

    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // PR-C: senders pass the Users.id UUID (plan 06 cut)
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
      requester_uuid: outsider.id, // D-11 dual-write (Plan 87.1-05)
      addressee_uuid: friend.id, // D-11 dual-write (Plan 87.1-05)
      status: 'accepted',
    });
    currentActor = outsider.user_id;

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // PR-C: senders pass the Users.id UUID (plan 06 cut)
      .expect(403);

    expect(res.body.error).toMatch(/owners and admins/i);

    // Nothing created.
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('(f) friend already an active member → 409 (friend path reuses the member guard, IN-03)', async () => {
    await Friendship.create({
      requester_uuid: owner.id, // D-11 dual-write (Plan 87.1-05)
      addressee_uuid: friend.id, // D-11 dual-write (Plan 87.1-05)
      status: 'accepted',
    });
    await UserGroup.create({
      user_uuid: friend.id, // D-11 dual-write (Plan 87.1-05)
      group_id: group.id,
      role: 'member',
      status: 'active',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // PR-C: senders pass the Users.id UUID (plan 06 cut)
      .expect(409);

    expect(res.body.error).toMatch(/already a member/i);
  });

  it('(g) friend already has a pending invite → 409 (friend path reuses the pending guard, IN-03)', async () => {
    await Friendship.create({
      requester_uuid: owner.id, // D-11 dual-write (Plan 87.1-05)
      addressee_uuid: friend.id, // D-11 dual-write (Plan 87.1-05)
      status: 'accepted',
    });
    await GroupInvite.create({
      group_id: group.id,
      invited_email: friend.email.toLowerCase(),
      invited_by_uuid: owner.id,
      token: 'pre-existing-pending-token',
      status: 'pending',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // PR-C: senders pass the Users.id UUID (plan 06 cut)
      .expect(409);

    expect(res.body.error).toMatch(/pending invite/i);
  });

  it('(h) a user cannot invite themselves via friend_user_id → 400 (WR-02)', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: owner.id }) // PR-C: UUID shape
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

// SEAM-01 (83.3 cross-phase audit): POST /invites/send gains a
// `participant_user_id` path so an owner/admin can invite a guest who played in
// one of the group's events to join the group. Restores the game-detail
// guest-invite affordance that broke when 83-06 stripped participant emails from
// the client. Email is resolved SERVER-SIDE; the path is BOUND to actual
// group-event participants so it isn't an existence/email oracle for arbitrary
// User ids. NOTE: participant_user_id is a User.id UUID (= EventParticipation.user_id).
describe('POST /invites/send — participant_user_id path (83.3 SEAM-01)', () => {
  let owner;
  let guest;
  let group;
  let event;

  beforeEach(async () => {
    owner = await User.create({
      user_id: 'auth0|seam01-owner',
      username: 'seam01-owner',
      email: 'seam01-owner@example.com',
    });

    guest = await User.create({
      user_id: 'auth0|seam01-guest',
      username: 'seam01-guest',
      email: 'seam01-guest@example.com',
    });

    group = await Group.create({
      group_id: 'seam01-test-group',
      name: 'Seam01 Test Group',
    });

    await UserGroup.create({
      user_uuid: owner.id, // D-11 dual-write (Plan 87.1-05): isOwnerOrAdmin keys user_uuid
      group_id: group.id,
      role: 'owner',
      status: 'active',
    });

    event = await Event.create({
      group_id: group.id,
      start_date: new Date('2026-01-01T18:00:00Z'),
    });

    // The guest played in the group's event (keyed on User.id UUID).
    await EventParticipation.create({
      event_id: event.id,
      user_id: guest.id,
      is_guest: true,
    });

    currentActor = owner.user_id;
  });

  it('(a) invite-by-participant_user_id succeeds, creates a pending invite, and returns NO email', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: guest.id })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.invite_id).toBeTruthy();

    // No PII leak: the resolved guest email must not appear in the response.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(guest.email);
    expect(res.body).not.toHaveProperty('invited_email');

    const invite = await GroupInvite.findOne({
      where: { group_id: group.id, status: 'pending' },
    });
    expect(invite).not.toBeNull();
    expect(invite.invited_email.toLowerCase()).toBe(guest.email.toLowerCase());

    // The success path must also create the guest's UserGroup row as 'invited'
    // (the core mutation — keyed on the Auth0 string user_id).
    const ug = await UserGroup.findOne({
      where: { user_uuid: guest.id, group_id: group.id },
    });
    expect(ug).not.toBeNull();
    expect(ug.status).toBe('invited');
    expect(ug.role).toBe('member');
  });

  it('(b) a User who is NOT a participant of this group\'s events → 403 (no oracle)', async () => {
    const stranger = await User.create({
      user_id: 'auth0|seam01-stranger',
      username: 'seam01-stranger',
      email: 'seam01-stranger@example.com',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: stranger.id })
      .expect(403);

    expect(res.body.error).toMatch(/participant/i);
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('(c) participation in a DIFFERENT group\'s event does not grant access → 403', async () => {
    const otherGroup = await Group.create({
      group_id: 'seam01-other-group',
      name: 'Seam01 Other Group',
    });
    const otherEvent = await Event.create({
      group_id: otherGroup.id,
      start_date: new Date('2026-02-01T18:00:00Z'),
    });
    const otherGuest = await User.create({
      user_id: 'auth0|seam01-otherguest',
      username: 'seam01-otherguest',
      email: 'seam01-otherguest@example.com',
    });
    await EventParticipation.create({
      event_id: otherEvent.id,
      user_id: otherGuest.id,
      is_guest: true,
    });

    // otherGuest participated in otherGroup's event, but we're inviting to `group`.
    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: otherGuest.id })
      .expect(403);
  });

  it('(d) non-owner/admin caller is blocked → 403 (authorize-first)', async () => {
    const randomMember = await User.create({
      user_id: 'auth0|seam01-member',
      username: 'seam01-member',
      email: 'seam01-member@example.com',
    });
    await UserGroup.create({
      user_uuid: randomMember.id, // Plan 09: keyed on user_uuid (old user_id column removed)
      group_id: group.id,
      role: 'member',
      status: 'active',
    });
    currentActor = randomMember.user_id;

    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: guest.id })
      .expect(403);
  });

  it('(e) guest already has a pending invite → 409 (reuses the pending guard)', async () => {
    await GroupInvite.create({
      group_id: group.id,
      invited_email: guest.email.toLowerCase(),
      invited_by_uuid: owner.id,
      token: 'seam01-existing-token',
      status: 'pending',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: guest.id })
      .expect(409);

    expect(res.body.error).toMatch(/pending invite/i);
  });

  it('(f) a non-UUID participant_user_id is rejected → 400', async () => {
    await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: 'not-a-uuid' })
      .expect(400);
  });

  it('(g) participant already an active member → 409 (reuses the member guard)', async () => {
    await UserGroup.create({
      user_uuid: guest.id, // D-11 dual-write (Plan 87.1-05)
      group_id: group.id,
      role: 'member',
      status: 'active',
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: guest.id })
      .expect(409);

    expect(res.body.error).toMatch(/already a member/i);
  });

  it('(h) a user cannot invite themselves via participant_user_id → 400 (self-guard)', async () => {
    // The owner is also a participant in the group's event, so the bound-check
    // passes and execution reaches the self-guard.
    await EventParticipation.create({
      event_id: event.id,
      user_id: owner.id,
    });

    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: owner.id })
      .expect(400);

    expect(res.body.error).toMatch(/yourself/i);

    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('(i) sending more than one invitee selector → 400 (no silent precedence)', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, participant_user_id: guest.id, email: 'someone@example.com' })
      .expect(400);

    expect(res.body.error).toMatch(/only one/i);
  });
});

// BINT-01 (Phase 87-02, SPEC Req 2 / D-03): the invite-accept flow flips the
// invite status AND activates the UserGroup membership in ONE managed
// transaction. A failure AFTER the status flip but DURING UserGroup activation
// must roll back everything — no invite may be left 'accepted' without an active
// UserGroup membership. This must hold on BOTH accept routes: the id-based
// POST /:invite_id/accept AND the token-based POST /accept-by-token (the primary
// email-link path). We force the failure by making UserGroup.findOrCreate reject
// once, then assert the invite rolled back to 'pending' and no active membership
// exists. The token-path test is what proves the shared transactional helper is
// actually wired into accept-by-token, not just the id-based handler.
describe('POST invite-accept — atomicity rollback on BOTH paths (87-02 BINT-01)', () => {
  let inviter;
  let invitee;
  let group;
  let invite;

  beforeEach(async () => {
    // invited_by_uuid carries a FK to Users.id — seed a real inviter row.
    inviter = await User.create({
      user_id: 'auth0|bint01-inviter',
      username: 'bint01-inviter',
      email: 'bint01-inviter@example.com',
    });

    invitee = await User.create({
      user_id: 'auth0|bint01-invitee',
      username: 'bint01-invitee',
      email: 'bint01-invitee@example.com',
    });

    group = await Group.create({
      group_id: 'bint01-test-group',
      name: 'BINT01 Test Group',
    });

    invite = await GroupInvite.create({
      group_id: group.id,
      invited_email: invitee.email.toLowerCase(),
      invited_by_uuid: inviter.id,
      token: 'bint01-accept-token',
      status: 'pending',
    });

    currentActor = invitee.user_id;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('(id-based) a failure during UserGroup activation rolls back the status flip → invite stays pending, no active membership', async () => {
    // Force the SECOND write (membership) to fail AFTER the status flip.
    jest
      .spyOn(UserGroup, 'findOrCreate')
      .mockRejectedValueOnce(new Error('simulated UserGroup failure'));

    await request(app)
      .post(`/api/invites/${invite.id}/accept`)
      .send({})
      .expect(500);

    // The invite must NOT be left 'accepted' — the txn rolled back.
    const reloaded = await GroupInvite.findByPk(invite.id);
    expect(reloaded.status).toBe('pending');

    // And no active UserGroup membership was created for (user, group).
    const activeMembership = await UserGroup.findOne({
      where: { user_uuid: invitee.id, group_id: group.id, status: 'active' },
    });
    expect(activeMembership).toBeNull();
  });

  it('(accept-by-token) a failure during UserGroup activation rolls back the status flip → invite stays pending, no active membership', async () => {
    jest
      .spyOn(UserGroup, 'findOrCreate')
      .mockRejectedValueOnce(new Error('simulated UserGroup failure'));

    await request(app)
      .post('/api/invites/accept-by-token')
      .send({ token: invite.token })
      .expect(500);

    const reloaded = await GroupInvite.findByPk(invite.id);
    expect(reloaded.status).toBe('pending');

    const activeMembership = await UserGroup.findOne({
      where: { user_uuid: invitee.id, group_id: group.id, status: 'active' },
    });
    expect(activeMembership).toBeNull();
  });
});

// D-12 (Phase 87.1, BINT-02): GroupInvite carries NO raw invited_by wire shim —
// only invited_by_name is serialized, resolved via the Inviter association which
// Plan 03 re-keyed to invited_by_uuid (NOT invited_by → Users.user_id). This test
// pins that the inviter name still resolves post-flip: the seeded invite carries
// invited_by_uuid so the association join finds the inviter, and GET /pending
// emits invited_by_name = the inviter's username.
describe('GET /invites/pending — invited_by_name via the Inviter association (87.1 D-12)', () => {
  let inviter;
  let invitee;
  let group;

  beforeEach(async () => {
    inviter = await User.create({
      user_id: 'auth0|d12-inviter',
      username: 'd12-inviter',
      email: 'd12-inviter@example.com',
    });

    invitee = await User.create({
      user_id: 'auth0|d12-invitee',
      username: 'd12-invitee',
      email: 'd12-invitee@example.com',
    });

    group = await Group.create({
      group_id: 'd12-test-group',
      name: 'D12 Test Group',
    });

    // Seed the invite with BOTH columns so the assertion stays valid before AND
    // after the Plan 03 factory flip — the Inviter association is keyed on
    // invited_by_uuid, so without it invited_by_name would degrade to 'Someone'.
    await GroupInvite.create({
      group_id: group.id,
      invited_email: invitee.email.toLowerCase(),
      invited_by_uuid: inviter.id,
      token: 'd12-pending-token',
      status: 'pending',
    });

    currentActor = invitee.user_id;
  });

  it('resolves invited_by_name from the Inviter association (invited_by_uuid → Users)', async () => {
    const res = await request(app)
      .get('/api/invites/pending')
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].invited_by_name).toBe(inviter.username);
    // D-12: no raw invited_by id leaks onto the wire.
    expect(res.body[0]).not.toHaveProperty('invited_by');
    expect(res.body[0]).not.toHaveProperty('invited_by_uuid');
  });
});

// ============================================================================
// Phase 87.3 PR-C (plan 09, user D1 contraction): POST /send resolves its
// client-supplied friend_user_id UUID-ONLY — the PR-A sub fallback (AF16) is
// removed now that PR-B (plan 06, AF12b) cut both FE senders to the nested
// `.id`. The UUID shape succeeds; a sub-shaped identifier no longer resolves
// and fails CLOSED at the accepted-friendship gate (403 — never an invite).
// The resolved friend email is still resolved server-side (no PII leak).
// ============================================================================
describe('POST /invites/send — friend_user_id UUID-only resolution (87.3 PR-C contraction)', () => {
  let owner;
  let friend;
  let group;

  beforeEach(async () => {
    owner = await User.create({
      user_id: 'auth0|dk-invite-owner',
      username: 'dk-invite-owner',
      email: 'dk-invite-owner@example.com',
    });
    friend = await User.create({
      user_id: 'auth0|dk-invite-friend',
      username: 'dk-invite-friend',
      email: 'dk-invite-friend@example.com',
    });
    group = await Group.create({ group_id: 'dk-invite-group', name: 'DK Invite Group' });
    await UserGroup.create({
      user_uuid: owner.id,
      group_id: group.id,
      role: 'owner',
      status: 'active',
    });
    await Friendship.create({
      requester_uuid: owner.id,
      addressee_uuid: friend.id,
      status: 'accepted',
    });
    currentActor = owner.user_id;
  });

  it('accepts a UUID-shaped friend_user_id (post-PR-C shape): passes the friendship gate, creates the invite, no PII leak', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.id }) // UUID, not the sub
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.invite_id).toBeTruthy();
    // Email resolved server-side — must not appear on the wire.
    const bodyStr = JSON.stringify(res.body);
    expect(bodyStr).not.toContain(friend.email);

    const invite = await GroupInvite.findOne({ where: { group_id: group.id, status: 'pending' } });
    expect(invite).not.toBeNull();
    expect(invite.invited_email.toLowerCase()).toBe(friend.email.toLowerCase());
  });

  it('REJECTS a sub-shaped friend_user_id (D1 contraction — sub fallback removed) -> 403, fails closed, no invite', async () => {
    // Pre-contraction this succeeded via the sub fallback. Post-PR-C the sub no
    // longer resolves, so the friendship gate fails CLOSED. Accepted trade-off:
    // a stale pre-PR-C bundle sending a sub gets a 403, never a wrong-target hit.
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: friend.user_id }) // Auth0 sub
      .expect(403);
    expect(res.body.error).toMatch(/only invite your friends/i);
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('rejects a self-invite via the UUID shape -> 400 (guard on resolved identity, no fail-open)', async () => {
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: owner.id }) // owner's OWN uuid
      .expect(400);
    expect(res.body.error).toMatch(/yourself/i);
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });

  it('the friendship gate still denies a UUID-shaped friend_user_id with NO accepted friendship -> 403', async () => {
    const stranger = await User.create({
      user_id: 'auth0|dk-invite-stranger',
      username: 'dk-invite-stranger',
      email: 'dk-invite-stranger@example.com',
    });
    const res = await request(app)
      .post('/api/invites/send')
      .send({ group_id: group.id, friend_user_id: stranger.id }) // UUID, not friends
      .expect(403);
    expect(res.body.error).toMatch(/only invite your friends/i);
    const count = await GroupInvite.count({ where: { group_id: group.id } });
    expect(count).toBe(0);
  });
});
