// tests/factories/index.js
//
// Central fixture factory for the re-keyed tables (BTEST-03, D-04; Phase 87.1 BINT-02).
//
// TRANSITIONAL DUAL-WRITE (Phase 87.1, Plans 03-09):
//   Phase 87.1 re-keys 7 tables from the Auth0 STRING user column onto the Users.id
//   UUID surrogate. During the domain-by-domain cutover (Plans 04-08) BOTH keyspaces
//   must stay valid in the sync()-built test DB: routes not yet cut over still read the
//   old string column, and routes already cut over read the new *_uuid column. So every
//   builder here writes BOTH — the old Auth0-string column(s) AND the new *_uuid
//   column(s), the latter always resolved from the fixture user's `.id` (UUID), never
//   `.user_id`. This dual-write is REMOVED in Plan 09 once all writers are cut over and
//   the old string columns are dropped from the models.
//
// WHY THE UUID VALUE IS ALWAYS `.id`:
//   The recurring fixture bug across the route suites was seeding a join column with the
//   wrong keyspace (e.g. `UserGroup.create({ user_id: testUser.id })` — the UUID into the
//   STRING column). These builders read `user.user_id` for the old string column and
//   `user.id` for the UUID column internally, so callers physically cannot cross the
//   keyspaces. It mirrors the `{ user_id: <string> }` contract in tests/helpers/authStub.js.
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
 * Seed a UserGroup membership row. DUAL-WRITE: old string `user_id` (user.user_id)
 * AND new UUID FK `user_uuid` (user.id).
 * @param {User} user
 * @param {Group} group
 * @param {('pending'|'member'|'admin'|'owner')} [role='member']
 * @returns {Promise<UserGroup>}
 */
async function addToGroup(user, group, role = 'member') {
  return UserGroup.create({
    user_id: user.user_id, // Auth0 STRING (old keyspace)
    user_uuid: user.id, // Users.id UUID (new keyspace)
    group_id: group.id,
    role,
  });
}

/**
 * Seed an EventRsvp. DUAL-WRITE: `user_id` (user.user_id) AND `user_uuid` (user.id).
 * @param {Event} event
 * @param {User} user
 * @param {object} overrides - spread last (e.g. { status: 'no' }).
 * @returns {Promise<EventRsvp>}
 */
async function makeEventRsvp(event, user, overrides = {}) {
  return EventRsvp.create({
    event_id: event.id,
    user_id: user.user_id, // Auth0 STRING (old keyspace)
    user_uuid: user.id, // Users.id UUID (new keyspace)
    status: 'yes',
    ...overrides,
  });
}

/**
 * Seed an EventBring. DUAL-WRITE: `user_id` (user.user_id) AND `user_uuid` (user.id).
 * @param {Event} event
 * @param {User} user
 * @param {Game} game
 * @param {object} overrides - spread last.
 * @returns {Promise<EventBring>}
 */
async function makeEventBring(event, user, game, overrides = {}) {
  return EventBring.create({
    event_id: event.id,
    user_id: user.user_id, // Auth0 STRING (old keyspace)
    user_uuid: user.id, // Users.id UUID (new keyspace)
    game_id: game.id,
    ...overrides,
  });
}

/**
 * Seed an EventBallotVote. DUAL-WRITE: `user_id` (user.user_id) AND `user_uuid` (user.id).
 * @param {EventBallotOption} option
 * @param {User} user
 * @param {object} overrides - spread last.
 * @returns {Promise<EventBallotVote>}
 */
async function makeEventBallotVote(option, user, overrides = {}) {
  return EventBallotVote.create({
    option_id: option.id,
    user_id: user.user_id, // Auth0 STRING (old keyspace)
    user_uuid: user.id, // Users.id UUID (new keyspace)
    ...overrides,
  });
}

/**
 * Seed a SentNotification. DUAL-WRITE: `user_id` (user.user_id) AND `user_uuid` (user.id).
 * @param {Event} event
 * @param {User} user
 * @param {object} overrides - spread last (e.g. { phone, notification_type }).
 * @returns {Promise<SentNotification>}
 */
async function makeSentNotification(event, user, overrides = {}) {
  const n = ++seq;
  return SentNotification.create({
    user_id: user.user_id, // Auth0 STRING (old keyspace)
    user_uuid: user.id, // Users.id UUID (new keyspace)
    event_id: event.id,
    phone: `+1555555${String(1000 + (n % 9000)).padStart(4, '0')}`,
    channel: 'sms',
    notification_type: 'event_created',
    ...overrides,
  });
}

/**
 * Seed a GroupInvite. DUAL-WRITE: old string `invited_by` (inviter.user_id) AND new
 * UUID FK `invited_by_uuid` (inviter.id).
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
    invited_by: inviter.user_id, // Auth0 STRING (old keyspace)
    invited_by_uuid: inviter.id, // Users.id UUID (new keyspace)
    token: `invite-token-${ts}-${n}`,
    status: 'pending',
    ...overrides,
  });
}

/**
 * Seed a Friendship. DUAL-WRITE on BOTH endpoints: old string requester_id/addressee_id
 * (`.user_id`) AND new UUID FKs requester_uuid/addressee_uuid (`.id`).
 * @param {User} requester
 * @param {User} addressee
 * @param {object} overrides - spread last (e.g. { status: 'accepted' }).
 * @returns {Promise<Friendship>}
 */
async function makeFriendship(requester, addressee, overrides = {}) {
  return Friendship.create({
    requester_id: requester.user_id, // Auth0 STRING (old keyspace)
    requester_uuid: requester.id, // Users.id UUID (new keyspace)
    addressee_id: addressee.user_id, // Auth0 STRING (old keyspace)
    addressee_uuid: addressee.id, // Users.id UUID (new keyspace)
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
