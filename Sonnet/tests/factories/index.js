// tests/factories/index.js
//
// Central fixture factory for the re-keyed tables (BTEST-03, D-04; Phase 87.1 BINT-02).
//
// FINAL UUID-ONLY STATE (Phase 87.1, Plan 09):
//   Phase 87.1 re-keyed 7 tables from the Auth0 STRING user column onto the Users.id
//   UUID surrogate. The domain-by-domain cutover (Plans 04-08) is complete and Plan 09
//   removed the old Auth0-string columns from the 7 models, so the sync()-built test DB
//   now has ONLY the `*_uuid` columns. The transitional dual-write is GONE — every
//   builder here writes ONLY the new `*_uuid` column(s), always resolved from the fixture
//   user's `.id` (UUID), never `.user_id`.
//
// WHY THE UUID VALUE IS ALWAYS `.id`:
//   The recurring fixture bug across the route suites was seeding a join column with the
//   wrong keyspace (e.g. `UserGroup.create({ user_id: testUser.id })` — the UUID into the
//   old STRING column). These builders read `user.id` for the UUID column internally, so
//   callers physically cannot cross keyspaces. The Auth0 STRING sub still lives on
//   `user.user_id` for auth-stub / request-shaping, mirroring tests/helpers/authStub.js.
//
// SCOPE: seeding only. Assertion-side lookups (findOne/destroy) are corrected per-suite.

const {
  User,
  Group,
  UserGroup,
  EventRsvp,
  EventBring,
  EventBallotVote,
  SentNotification,
  GroupInvite,
  Friendship,
} = require('../../models');

// Module-scoped monotonic counter so each call is unique within a run.
let seq = 0;

/**
 * Create a User with the Auth0 STRING user_id (the correct join key).
 * @param {object} overrides - spread last; can override user_id/username/email/etc.
 * @returns {Promise<User>}
 */
async function makeUser(overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return User.create({
    user_id: `auth0|test-${ts}-${n}`, // Auth0 STRING — the old join key
    username: `user-${ts}-${n}`,
    email: `user-${ts}-${n}@example.com`,
    ...overrides,
  });
}

/**
 * Create a Group with a unique group_id handle + name.
 * @param {object} overrides - spread last.
 * @returns {Promise<Group>}
 */
async function makeGroup(overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return Group.create({
    group_id: `group-${ts}-${n}`,
    name: `Group ${ts}-${n}`,
    ...overrides,
  });
}

/**
 * Seed a UserGroup membership row. UUID-only: `user_uuid` (user.id).
 * @param {User} user
 * @param {Group} group
 * @param {('pending'|'member'|'admin'|'owner')} [role='member']
 * @returns {Promise<UserGroup>}
 */
async function addToGroup(user, group, role = 'member') {
  return UserGroup.create({
    user_uuid: user.id, // Users.id UUID (the join key)
    group_id: group.id,
    role,
  });
}

/**
 * Seed an EventRsvp. UUID-only: `user_uuid` (user.id).
 * @param {Event} event
 * @param {User} user
 * @param {object} overrides - spread last (e.g. { status: 'no' }).
 * @returns {Promise<EventRsvp>}
 */
async function makeEventRsvp(event, user, overrides = {}) {
  return EventRsvp.create({
    event_id: event.id,
    user_uuid: user.id, // Users.id UUID (the join key)
    status: 'yes',
    ...overrides,
  });
}

/**
 * Seed an EventBring. UUID-only: `user_uuid` (user.id).
 * @param {Event} event
 * @param {User} user
 * @param {Game} game
 * @param {object} overrides - spread last.
 * @returns {Promise<EventBring>}
 */
async function makeEventBring(event, user, game, overrides = {}) {
  return EventBring.create({
    event_id: event.id,
    user_uuid: user.id, // Users.id UUID (the join key)
    game_id: game.id,
    ...overrides,
  });
}

/**
 * Seed an EventBallotVote. UUID-only: `user_uuid` (user.id).
 * @param {EventBallotOption} option
 * @param {User} user
 * @param {object} overrides - spread last.
 * @returns {Promise<EventBallotVote>}
 */
async function makeEventBallotVote(option, user, overrides = {}) {
  return EventBallotVote.create({
    option_id: option.id,
    user_uuid: user.id, // Users.id UUID (the join key)
    ...overrides,
  });
}

/**
 * Seed a SentNotification. UUID-only: `user_uuid` (user.id).
 * @param {Event} event
 * @param {User} user
 * @param {object} overrides - spread last (e.g. { phone, notification_type }).
 * @returns {Promise<SentNotification>}
 */
async function makeSentNotification(event, user, overrides = {}) {
  const n = ++seq;
  return SentNotification.create({
    user_uuid: user.id, // Users.id UUID (the join key)
    event_id: event.id,
    phone: `+1555555${String(1000 + (n % 9000)).padStart(4, '0')}`,
    channel: 'sms',
    notification_type: 'event_created',
    ...overrides,
  });
}

/**
 * Seed a GroupInvite. UUID-only: `invited_by_uuid` (inviter.id). Note this FK is
 * NULLABLE by design (D-04, ON DELETE SET NULL) — a pending invite outlives its inviter.
 * @param {Group} group
 * @param {User} inviter
 * @param {object} overrides - spread last (e.g. { invited_email, status }).
 * @returns {Promise<GroupInvite>}
 */
async function makeGroupInvite(group, inviter, overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return GroupInvite.create({
    group_id: group.id,
    invited_email: `invitee-${ts}-${n}@example.com`,
    invited_by_uuid: inviter.id, // Users.id UUID (the inviter FK)
    token: `invite-token-${ts}-${n}`,
    status: 'pending',
    ...overrides,
  });
}

/**
 * Seed a Friendship. UUID-only on BOTH endpoints: requester_uuid/addressee_uuid (`.id`).
 * @param {User} requester
 * @param {User} addressee
 * @param {object} overrides - spread last (e.g. { status: 'accepted' }).
 * @returns {Promise<Friendship>}
 */
async function makeFriendship(requester, addressee, overrides = {}) {
  return Friendship.create({
    requester_uuid: requester.id, // Users.id UUID (the requester endpoint)
    addressee_uuid: addressee.id, // Users.id UUID (the addressee endpoint)
    status: 'pending',
    ...overrides,
  });
}

module.exports = {
  makeUser,
  makeGroup,
  addToGroup,
  makeEventRsvp,
  makeEventBring,
  makeEventBallotVote,
  makeSentNotification,
  makeGroupInvite,
  makeFriendship,
};
