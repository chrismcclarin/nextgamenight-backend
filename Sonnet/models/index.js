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
User.belongsToMany(Group, {
  through: UserGroup,
  foreignKey: 'user_uuid' // UUID FK column in UserGroup that references Users.id
});
Group.belongsToMany(User, {
  through: UserGroup,
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
User.hasMany(UserAvailability, { foreignKey: 'user_id', sourceKey: 'user_id' });
UserAvailability.belongsTo(User, { foreignKey: 'user_id', targetKey: 'user_id' });

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
// Note: Uses sourceKey/targetKey because user_id is STRING (Auth0 ID), not UUID
User.hasMany(AvailabilityResponse, { foreignKey: 'user_id', sourceKey: 'user_id' });
AvailabilityResponse.belongsTo(User, { foreignKey: 'user_id', targetKey: 'user_id' });

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
User.hasMany(SingleUseToken, { foreignKey: 'user_id', sourceKey: 'user_id' });
SingleUseToken.belongsTo(User, { foreignKey: 'user_id', targetKey: 'user_id' });

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