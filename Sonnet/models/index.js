// models/index.js
// LOAD TESTING NOTE: Increase pool.max to 20 when running Artillery load tests
// Set SEQUELIZE_POOL_MAX=20 or manually update pool.max before running:
// npm run load:generate-tokens && SEQUELIZE_POOL_MAX=20 LOAD_TEST_TARGET=http://localhost:4000 npx artillery run tests/load/availability-pipeline.yml
const User = require('./User');
const Group = require('./Group');
const Game = require('./Game');
const Event = require('./Event');
const EventParticipation = require('./EventParticipation');
const UserGroup = require('./UserGroup');
const GameReview = require('./GameReview');
const UserGame = require('./UserGame');
const UserAvailability = require('./UserAvailability');
const GroupPromptSettings = require('./GroupPromptSettings');
const AvailabilityPrompt = require('./AvailabilityPrompt');
const AvailabilityResponse = require('./AvailabilityResponse');
const AvailabilitySuggestion = require('./AvailabilitySuggestion');
const MagicToken = require('./MagicToken');
const SingleUseToken = require('./SingleUseToken');
const TokenAnalytics = require('./TokenAnalytics');
const EmailMetrics = require('./EmailMetrics');
const Feedback = require('./Feedback');
const Friendship = require('./Friendship');
const GroupInvite = require('./GroupInvite');
const EventRsvp = require('./EventRsvp');
const EventBring = require('./EventBring');
const EventBallotOption = require('./EventBallotOption');
const EventBallotVote = require('./EventBallotVote');
const SentNotification = require('./SentNotification');
const SchedulerRun = require('./SchedulerRun');
const EventAuditLog = require('./EventAuditLog');
// Phase 87.2 (REQ-6, D-08): durable Auth0-deletion marker. No associations — it
// must outlive the deleted Users row, so it carries no FK to Users.
const PendingAuth0Deletion = require('./PendingAuth0Deletion');
const sequelize = require('../config/database');


// Define associations
// Users ↔ Groups (Many-to-Many)
// Phase 87.1 (BINT-02, D-01): re-keyed onto the internal UUID surrogate Users.id via
// the user_uuid FK column. The join now uses the DEFAULT source/target key (Users.id),
// so no sourceKey/targetKey override is needed. ON DELETE CASCADE removes a deleted
// user's group memberships.
//
// DECISION Phase 88.2 D-01: `through: { model: UserGroup, unique: false }` OVER the
// bare `through: UserGroup` this used to be. Sequelize's belongsToMany defaults
// `through.unique` to TRUE, which makes sync() emit a table-level composite UNIQUE
// CONSTRAINT — `UserGroups_user_uuid_group_id_key` — on top of whatever the model's
// own `indexes` array declares. That FULL constraint silently defeats the PARTIAL
// unique index (`WHERE "deletedAt" IS NULL`) that models/UserGroup.js and migration
// 20260725000001 both declare, so a soft-deleted membership would still occupy the
// unique slot and POST /groups/join-by-token would 500 on re-join.
//
// This is a pure CI/prod drift: no migration has ever created that constraint, so
// prod does not have it (prod's only composite uniqueness is
// `usergroups_user_uuid_group_id_uq`, which 20260725000001 rebuilds as partial; the
// legacy `UserGroups_user_id_group_id_key` went away with the column in
// 20260720000004). It existed ONLY in the sync()-built test/CI database — which is
// why the re-join regression test in tests/routes/groups.invite.test.js caught it
// and nothing else would have.
//
// Uniqueness is NOT lost: the model's explicit partial unique index is the single
// declared source, matching the migration byte-for-byte. Turning this back on would
// re-break re-join in CI only. Changing it is a decision, not a cleanup.
User.belongsToMany(Group, {
  through: { model: UserGroup, unique: false },
  foreignKey: 'user_uuid' // UUID FK column in UserGroup that references Users.id
});
Group.belongsToMany(User, {
  through: { model: UserGroup, unique: false },
  foreignKey: 'group_id', // Column in UserGroup that references Group
  otherKey: 'user_uuid' // UUID FK column in UserGroup that references Users.id
});


// UserGroup → User (direct association for worker include queries)
UserGroup.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });
User.hasMany(UserGroup, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });

// Groups ↔ Events (One-to-Many)
Group.hasMany(Event, { foreignKey: 'group_id' });
Event.belongsTo(Group, { foreignKey: 'group_id' });


// Games ↔ Events (One-to-Many)
Game.hasMany(Event, { foreignKey: 'game_id' });
Event.belongsTo(Game, { foreignKey: 'game_id' });


// Users ↔ Events (Many-to-Many through EventParticipation)
User.belongsToMany(Event, { through: EventParticipation, foreignKey: 'user_id' });
Event.belongsToMany(User, { through: EventParticipation, foreignKey: 'event_id' });


// Direct associations for easier queries
Event.hasMany(EventParticipation, { foreignKey: 'event_id' });
EventParticipation.belongsTo(Event, { foreignKey: 'event_id' });
// Phase 87 (BINT-02): onDelete CASCADE for association-level clarity, matching
// the column-level FK in models/EventParticipation.js and the SET NULL precedent
// on the Creator associations below. Deleting a User cascades away their
// EventParticipation rows.
User.hasMany(EventParticipation, { foreignKey: 'user_id', onDelete: 'CASCADE' });
EventParticipation.belongsTo(User, { foreignKey: 'user_id', onDelete: 'CASCADE' });


// Winner and Picker associations
Event.belongsTo(User, { as: 'Winner', foreignKey: 'winner_id' });
Event.belongsTo(User, { as: 'PickedBy', foreignKey: 'picked_by_id' });


// Game Reviews
User.hasMany(GameReview, { foreignKey: 'user_id' });
GameReview.belongsTo(User, { foreignKey: 'user_id' });
Group.hasMany(GameReview, { foreignKey: 'group_id' });
GameReview.belongsTo(Group, { foreignKey: 'group_id' });
Game.hasMany(GameReview, { foreignKey: 'game_id' });
GameReview.belongsTo(Game, { foreignKey: 'game_id' });

// User Owned Games (Many-to-Many)
User.belongsToMany(Game, { through: UserGame, foreignKey: 'user_id', as: 'OwnedGames' });
Game.belongsToMany(User, { through: UserGame, foreignKey: 'game_id', as: 'Owners' });
User.hasMany(UserGame, { foreignKey: 'user_id' });
UserGame.belongsTo(User, { foreignKey: 'user_id' });
Game.hasMany(UserGame, { foreignKey: 'game_id' });
UserGame.belongsTo(Game, { foreignKey: 'game_id' });

// User Availability
// Phase 87.5 (BINT-02, D-01): re-keyed onto Users.id via user_uuid (UUID PK), the
// protective FK ON DELETE CASCADE. Default UUID key — no STRING sourceKey/targetKey.
User.hasMany(UserAvailability, { foreignKey: 'user_uuid', sourceKey: 'id' });
UserAvailability.belongsTo(User, { foreignKey: 'user_uuid', targetKey: 'id' });

// Group Prompt Settings (One-to-One)
Group.hasOne(GroupPromptSettings, { foreignKey: 'group_id' });
GroupPromptSettings.belongsTo(Group, { foreignKey: 'group_id' });

// Availability Prompts (One-to-Many from Group)
Group.hasMany(AvailabilityPrompt, { foreignKey: 'group_id' });
AvailabilityPrompt.belongsTo(Group, { foreignKey: 'group_id' });

// Availability Prompts (Many-to-One from Game, optional)
Game.hasMany(AvailabilityPrompt, { foreignKey: 'game_id' });
AvailabilityPrompt.belongsTo(Game, { foreignKey: 'game_id' });

// Availability Prompts (Many-to-One from GroupPromptSettings, optional)
GroupPromptSettings.hasMany(AvailabilityPrompt, { foreignKey: 'created_by_settings_id' });
AvailabilityPrompt.belongsTo(GroupPromptSettings, { foreignKey: 'created_by_settings_id' });

// Phase 71.2 / D-SCHEMA-05: AvailabilityPrompt creator (manual polls only).
// Used by Plan 03's UI to render "Started by [creator name]" via the Creator association.
// User.id is UUID, so this association uses the default FK (no sourceKey/targetKey override).
AvailabilityPrompt.belongsTo(User, { as: 'Creator', foreignKey: 'created_by_user_id', onDelete: 'SET NULL' });

// Phase 71.2 / D-SCHEMA-06: GroupPromptSettings creator (the user who first set up scheduling).
// Used by Plan 02's recipient resolution: settings.created_by_user_id || group owner.
GroupPromptSettings.belongsTo(User, { as: 'Creator', foreignKey: 'created_by_user_id', onDelete: 'SET NULL' });

// Availability Responses (One-to-Many from Prompt)
AvailabilityPrompt.hasMany(AvailabilityResponse, { foreignKey: 'prompt_id' });
AvailabilityResponse.belongsTo(AvailabilityPrompt, { foreignKey: 'prompt_id' });

// Availability Responses (Many-to-One from User)
// Phase 87.5 (BINT-02, D-01): re-keyed onto Users.id via user_uuid (UUID PK), the
// protective FK ON DELETE CASCADE. Default UUID key — no STRING sourceKey/targetKey.
User.hasMany(AvailabilityResponse, { foreignKey: 'user_uuid', sourceKey: 'id' });
AvailabilityResponse.belongsTo(User, { foreignKey: 'user_uuid', targetKey: 'id' });

// Availability Suggestions (One-to-Many from Prompt)
AvailabilityPrompt.hasMany(AvailabilitySuggestion, { foreignKey: 'prompt_id' });
AvailabilitySuggestion.belongsTo(AvailabilityPrompt, { foreignKey: 'prompt_id' });

// Availability Suggestions (Many-to-One from Event, optional)
// Note: alias 'ConvertedEvent' to distinguish from other Event associations
Event.hasMany(AvailabilitySuggestion, { as: 'ConvertedSuggestions', foreignKey: 'converted_to_event_id' });
AvailabilitySuggestion.belongsTo(Event, { as: 'ConvertedEvent', foreignKey: 'converted_to_event_id' });

// Magic Tokens (One-to-Many from User)
// Note: Uses sourceKey/targetKey because user_id is STRING (Auth0 ID), not UUID
User.hasMany(MagicToken, { foreignKey: 'user_id', sourceKey: 'user_id' });
MagicToken.belongsTo(User, { foreignKey: 'user_id', targetKey: 'user_id' });

// Magic Tokens (One-to-Many from AvailabilityPrompt)
AvailabilityPrompt.hasMany(MagicToken, { foreignKey: 'prompt_id' });
MagicToken.belongsTo(AvailabilityPrompt, { foreignKey: 'prompt_id' });

// Single-Use Tokens (One-to-Many from User) — OAuth state nonce + RSVP single-use
// Note: Uses sourceKey/targetKey because user_id is STRING (Auth0 ID), not UUID
//
// DECISION Phase 88.2 D-02: `onDelete: 'CASCADE'` is stated EXPLICITLY here, chosen
// OVER letting Sequelize infer it. Inference is not stable: Sequelize derives the
// FK's ON DELETE from the attribute's `allowNull`, so the moment 88.2 relaxed
// SingleUseToken.user_id to nullable (so group_restore rows can leave it NULL), the
// sync-built CI database silently re-emitted this constraint as ON DELETE SET NULL.
// Measured before/after against a real Postgres, not inferred.
//
// That flip is not cosmetic. services/pendingAuth0DeletionSweep.js:180-187 destroys
// the ghost Users row FIRST and only then runs
// `SingleUseToken.destroy({ where: { user_id: sub } })` — under SET NULL the delete of
// the user nulls `user_id` out from under that predicate, so the sweep matches zero
// rows and orphans the tokens forever, with a NULL user_id that is now
// indistinguishable from a legitimate group_restore token.
// (services/accountDeletionService.js:273 destroys tokens before the user, so it is
// unaffected either way — the sweep is the one that breaks.)
//
// Prod has NO foreign key on this column at all: migrations/20260618000002-create-
// single-use-tokens.js:49-53 declares `user_id` with no `references`. So this line
// governs the CI/test database only; pinning it keeps that database's behavior
// IDENTICAL to what it was before 88.2 rather than changing it as a side effect.
// group_restore rows are unaffected regardless — their user_id is NULL, so no user
// deletion can ever cascade to them, which is the entire point of D-02.
User.hasMany(SingleUseToken, { foreignKey: 'user_id', sourceKey: 'user_id', onDelete: 'CASCADE' });
SingleUseToken.belongsTo(User, { foreignKey: 'user_id', targetKey: 'user_id', onDelete: 'CASCADE' });

// Friendships (Social Graph)
// Phase 87.1 (BINT-02, D-05): re-keyed onto Users.id via requester_uuid/addressee_uuid,
// each a protective FK ON DELETE CASCADE (deleting either endpoint removes the pair row).
// Default source/target key (Users.id) — no override needed.
User.hasMany(Friendship, { as: 'SentFriendRequests', foreignKey: 'requester_uuid', onDelete: 'CASCADE' });
User.hasMany(Friendship, { as: 'ReceivedFriendRequests', foreignKey: 'addressee_uuid', onDelete: 'CASCADE' });
Friendship.belongsTo(User, { as: 'Requester', foreignKey: 'requester_uuid', onDelete: 'CASCADE' });
Friendship.belongsTo(User, { as: 'Addressee', foreignKey: 'addressee_uuid', onDelete: 'CASCADE' });

// Group Invites
Group.hasMany(GroupInvite, { foreignKey: 'group_id' });
GroupInvite.belongsTo(Group, { foreignKey: 'group_id' });
// Phase 87.1 (BINT-02, D-04): re-keyed onto Users.id via invited_by_uuid, a NULLABLE
// protective FK ON DELETE SET NULL — a pending invite outlives its inviter's account.
// Default target key (Users.id) — no override needed.
User.hasMany(GroupInvite, { as: 'SentInvites', foreignKey: 'invited_by_uuid', onDelete: 'SET NULL' });
GroupInvite.belongsTo(User, { as: 'Inviter', foreignKey: 'invited_by_uuid', onDelete: 'SET NULL' });

// Event RSVPs (yes/no/maybe responses)
Event.hasMany(EventRsvp, { foreignKey: 'event_id' });
EventRsvp.belongsTo(Event, { foreignKey: 'event_id' });
// Phase 87.1 (BINT-02, D-02): re-keyed onto Users.id via user_uuid, protective FK
// ON DELETE CASCADE. Default source/target key (Users.id) — no override needed.
User.hasMany(EventRsvp, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });
EventRsvp.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });

// Event Brings (games users commit to bring)
Event.hasMany(EventBring, { foreignKey: 'event_id' });
EventBring.belongsTo(Event, { foreignKey: 'event_id' });
// Phase 87.1 (BINT-02, D-02): re-keyed onto Users.id via user_uuid, protective FK
// ON DELETE CASCADE. Default source/target key (Users.id) — no override needed.
User.hasMany(EventBring, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });
EventBring.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });
Game.hasMany(EventBring, { foreignKey: 'game_id' });
EventBring.belongsTo(Game, { foreignKey: 'game_id' });

// Event Ballot Options (game options for voting)
Event.hasMany(EventBallotOption, { foreignKey: 'event_id' });
EventBallotOption.belongsTo(Event, { foreignKey: 'event_id' });
Game.hasMany(EventBallotOption, { foreignKey: 'game_id' });
EventBallotOption.belongsTo(Game, { foreignKey: 'game_id' });

// Event Ballot Votes (per-user approval votes on ballot options)
EventBallotOption.hasMany(EventBallotVote, { foreignKey: 'option_id' });
EventBallotVote.belongsTo(EventBallotOption, { foreignKey: 'option_id' });
// Phase 87.1 (BINT-02, D-02): re-keyed onto Users.id via user_uuid, protective FK
// ON DELETE CASCADE. Default source/target key (Users.id) — no override needed.
User.hasMany(EventBallotVote, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });
EventBallotVote.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });

// Sent Notifications (outbound SMS log for inbound reply resolution)
Event.hasMany(SentNotification, { foreignKey: 'event_id' });
SentNotification.belongsTo(Event, { foreignKey: 'event_id' });
// Phase 87.1 (BINT-02, D-03): re-keyed onto Users.id via user_uuid, protective FK
// ON DELETE CASCADE. Default source/target key (Users.id) — no override needed.
User.hasMany(SentNotification, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });
SentNotification.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE' });


module.exports = {
  User,
  Group,
  Game,
  Event,
  EventParticipation,
  UserGroup,
  GameReview,
  UserGame,
  UserAvailability,
  GroupPromptSettings,
  AvailabilityPrompt,
  AvailabilityResponse,
  AvailabilitySuggestion,
  MagicToken,
  SingleUseToken,
  TokenAnalytics,
  EmailMetrics,
  Feedback,
  Friendship,
  GroupInvite,
  EventRsvp,
  EventBring,
  EventBallotOption,
  EventBallotVote,
  SentNotification,
  SchedulerRun,
  EventAuditLog,
  PendingAuth0Deletion,
  sequelize,
};