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
  UserGame,
  GameReview,
  MagicToken,
  SingleUseToken,
  Feedback,
  EventBallotOption,
  AvailabilitySuggestion,
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

// ---------------------------------------------------------------------------
// Phase 87.2 (Plan 06, REQ-3) — explicit-cleanup-surface builders.
//
// The account-deletion integrity test must seed a row on EVERY user-referencing
// surface, including the ones the DB CASCADE graph does NOT cover (they are
// deleted/anonymized by explicit code in accountDeletionService.applyDispositions).
// Those surfaces split across TWO keyspaces (RESEARCH Pitfall 1 — the top defect
// risk); each builder below writes the CORRECT key type per the RESEARCH
// disposition inventory so a caller cannot cross keyspaces:
//   - UUID (user.id):        UserGame.user_id, GameReview.user_id
//   - Auth0 sub (user.user_id): MagicToken.user_id, SingleUseToken.user_id,
//                               Feedback.user_id, EventBallotOption.created_by,
//                               and BOTH AvailabilitySuggestion JSONB scrubs.
// ---------------------------------------------------------------------------

/**
 * Seed a UserGame ownership row (explicit-DELETE surface). UUID keyspace: `user_id`
 * = user.id. No FK today — the deletion service hard-deletes these by user.id.
 * @param {User} user
 * @param {Game} game
 * @param {object} overrides - spread last.
 * @returns {Promise<UserGame>}
 */
async function makeUserGame(user, game, overrides = {}) {
  return UserGame.create({
    user_id: user.id, // Users.id UUID (RESEARCH: UserGame is a UUID surface)
    game_id: game.id,
    ...overrides,
  });
}

/**
 * Seed a GameReview (explicit-DELETE surface, hard delete per D-18). UUID keyspace:
 * `user_id` = user.id.
 * @param {User} user
 * @param {Group} group
 * @param {Game} game
 * @param {object} overrides - spread last.
 * @returns {Promise<GameReview>}
 */
async function makeGameReview(user, group, game, overrides = {}) {
  return GameReview.create({
    user_id: user.id, // Users.id UUID (RESEARCH: GameReview is a UUID surface)
    group_id: group.id,
    game_id: game.id,
    rating: 4.0,
    review_text: 'A solid game night pick.',
    is_recommended: true,
    ...overrides,
  });
}

/**
 * Seed a MagicToken (explicit-DELETE surface). Auth0-sub keyspace: `user_id`
 * = user.user_id. `prompt_id` is a REQUIRED CASCADE FK to AvailabilityPrompts, so
 * the builder takes a prompt.
 * @param {User} user
 * @param {AvailabilityPrompt} prompt
 * @param {object} overrides - spread last.
 * @returns {Promise<MagicToken>}
 */
async function makeMagicToken(user, prompt, overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return MagicToken.create({
    token_id: `jti-${ts}-${n}`,
    user_id: user.user_id, // Auth0 sub STRING (RESEARCH: MagicToken is an Auth0-sub surface)
    prompt_id: prompt.id,
    status: 'active',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000), // +24h
    ...overrides,
  });
}

/**
 * Seed a SingleUseToken (explicit-DELETE surface). Auth0-sub keyspace: `user_id`
 * = user.user_id. No user FK (association is sourceKey/targetKey only).
 * @param {User} user
 * @param {object} overrides - spread last (e.g. { purpose: 'rsvp', event_id }).
 * @returns {Promise<SingleUseToken>}
 */
async function makeSingleUseToken(user, overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return SingleUseToken.create({
    nonce: `nonce-${ts}-${n}`,
    user_id: user.user_id, // Auth0 sub STRING (RESEARCH: SingleUseToken is an Auth0-sub surface)
    purpose: 'oauth_state',
    status: 'active',
    expires_at: new Date(Date.now() + 60 * 60 * 1000), // +1h
    ...overrides,
  });
}

/**
 * Seed a Feedback row (ANONYMIZE surface — deletion nulls both keys, keeps the text).
 * Auth0-sub keyspace: `user_id` = user.user_id, PLUS `user_email` = user.email.
 * Override `{ user_id: null }` to seed the email-only-keyed variant (reachable ONLY
 * through the `user_email = :email` half of the anonymize predicate — the real-DB
 * proof the withContactInfo scope loaded the user's email past defaultScope).
 * @param {User} user
 * @param {object} overrides - spread last.
 * @returns {Promise<Feedback>}
 */
async function makeFeedback(user, overrides = {}) {
  const n = ++seq;
  return Feedback.create({
    type: 'bug',
    subject: `Feedback ${n}`,
    description: 'Something to keep after anonymization.',
    user_id: user.user_id, // Auth0 sub STRING (RESEARCH: Feedback.user_id is an Auth0-sub surface)
    user_email: user.email, // email-half of the anonymize predicate
    ...overrides,
  });
}

/**
 * Seed an EventBallotOption. Phase 87.5 (BINT-02, PR-1): the OPERATIVE creator key is
 * now `created_by_uuid` = user.id (the UUID FK; deletion nulls it via the explicit scrub
 * + the SET NULL FK). The legacy Auth0-sub `created_by` column is RETAINED until Plan 07
 * as the rollback net, so we ALSO seed it (= user.user_id) — this keeps the wire-sweep
 * guard (`created_by sub column never serializes`) exercising a populated sub column.
 * `event_id` is a REQUIRED CASCADE FK to Events, so the builder takes an event.
 * @param {Event} event
 * @param {User} user - the option's creator (created_by_uuid = user.id; created_by = user.user_id).
 * @param {object} overrides - spread last (e.g. { game_id, game_name }).
 * @returns {Promise<EventBallotOption>}
 */
async function makeEventBallotOption(event, user, overrides = {}) {
  const n = ++seq;
  return EventBallotOption.create({
    event_id: event.id,
    game_name: `Ballot Game ${n}`,
    display_order: 0,
    created_by_uuid: user.id,     // UUID FK — the operative creator key (legacy created_by sub column + attribute dropped in Plan 07)
    ...overrides,
  });
}

/**
 * Seed an AvailabilitySuggestion (JSONB-SCRUB surface). BOTH JSONB shapes are keyed
 * by the Auth0 sub (user.user_id):
 *   - participant_user_ids: JSONB array of subs (deletion removes the sub element)
 *   - tentative_calendar_event_ids: JSONB map { sub: gcalEventId } (deletion removes
 *     the sub key AFTER the gcal hold value is read for Google-side cleanup)
 * participant_count is seeded consistent with participant_user_ids so the scrub's
 * denormalized recompute can be asserted. `prompt_id` is a REQUIRED CASCADE FK.
 * @param {AvailabilityPrompt} prompt
 * @param {User} user - the participant whose sub is embedded in both JSONB shapes.
 * @param {object} overrides - spread last.
 * @returns {Promise<AvailabilitySuggestion>}
 */
async function makeAvailabilitySuggestion(prompt, user, overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return AvailabilitySuggestion.create({
    prompt_id: prompt.id,
    suggested_start: new Date(ts),
    suggested_end: new Date(ts + 2 * 60 * 60 * 1000), // +2h
    participant_user_ids: [user.id], // Phase 87.4 Plan 03 flip: Users.id UUID array (was Auth0 sub)
    participant_count: 1, // consistent with the single seeded participant
    tentative_calendar_event_ids: { [user.user_id]: `gcal-hold-${ts}-${n}` }, // { sub: gcalId } — stays sub-keyed (5b, out of scope)
    preferred_count: 0,
    meets_minimum: false,
    score: 1.0,
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
  // Phase 87.2 Plan 06 — explicit-cleanup-surface builders.
  makeUserGame,
  makeGameReview,
  makeMagicToken,
  makeSingleUseToken,
  makeFeedback,
  makeEventBallotOption,
  makeAvailabilitySuggestion,
};
