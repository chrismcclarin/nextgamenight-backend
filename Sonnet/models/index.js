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


// ---------------------------------------------------------------------------------------
// DECISION Phase 88.4 D1a (88.4-DRIFT-CENSUS.md § 4.3, RC-1 — findings F-01…F-23):
// `onUpdate: 'NO ACTION'` is declared EXPLICITLY on 23 associations below, OVER converging the
// other way by rebuilding 23 foreign keys on production.
//
// THE DRIFT. Before this, `onUpdate` appeared ZERO times anywhere under `models/` — across all 27
// models and all 84 association calls here. Sequelize 6.37.7 therefore applied its UNCONDITIONAL
// default (`node_modules/sequelize/lib/associations/has-many.js:106` and `belongs-to.js:80` are
// both `onUpdate = onUpdate || "CASCADE"`), while the migrations that created the same FKs specify
// only `onDelete` and so get Postgres's `NO ACTION`. That single omission is 23 of the day-one
// census's 43 findings: every sync()-built database (the BE Jest DB, the FE e2e DB) carried
// `ON UPDATE CASCADE` on FKs that prod carries as `NO ACTION`.
//
// WHY MODEL-SIDE. Converging migration-side would mean dropping and recreating 23 FKs on prod,
// taking ACCESS EXCLUSIVE locks across 18 tables plus revalidation scans, to change a clause that
// only ever fires when a PARENT KEY VALUE IS UPDATED — and every parent here is an immutable UUID
// primary key or `Users.user_id` (the Auth0 subject), neither of which is rewritten in normal
// operation. The owner was shown that cost and declined it. Editing these lines changes NOTHING
// about production: it makes the test databases honest about the shape prod already has.
//
// F-20 WAS BROKEN OUT AND THE EXCEPTION WAS DECLINED (D1b). `MagicTokens.user_id -> Users(user_id)`
// is one of only two rows whose parent key is the Auth0 subject rather than an immutable UUID, so
// it is one of only two where ON UPDATE could ever fire. The owner was offered `CASCADE` there and
// chose `NO ACTION` with the rest: an UPDATE that fails loudly beats one that propagates silently,
// and any future account-linking feature needs a deliberate migration anyway, which can set the
// action then.
//
// ONLY THESE 23 — DO NOT "FINISH THE JOB" BY ADDING `onUpdate` TO THE OTHER ~61 ASSOCIATIONS.
// This asymmetry is deliberate and load-bearing, and it is the thing a future reader is most likely
// to mistake for an oversight. Six FK declarations in the migration chain DO specify
// `onUpdate: 'CASCADE'` (20260310000001:48,58,103; 20260308000001:71; 20260228000001:78;
// 20260329100001:35), and every FK created by the baseline migration inherits `ON UPDATE CASCADE`
// too because the baseline was captured from a pg_dump of a sync()-built database. All of those
// already AGREE with Sequelize's CASCADE default and produce zero findings — census § 4.1 proves it
// as a controlled experiment: every FK whose migration omits `onUpdate` drifts, every FK whose
// migration specifies it does not. Adding `NO ACTION` to those would CREATE new drift where there
// is none today, and Plan 09 arms the gate on this being zero. Each site below names its census
// finding ID so the mapping is checkable rather than asserted.
//
// DECLARED ON BOTH SIDES of each pair, matching how `onDelete` is already declared throughout this
// file — and the mechanism is FIRST-WRITER-WINS, not last, which is worth stating because it is the
// opposite of the intuitive reading. `hasMany` and `belongsTo` both build a `newAttributes` object,
// hand it to `Helpers.addForeignKeyConstraints`, and then merge it with
// `Utils.mergeDefaults(target.rawAttributes, newAttributes)` (`has-many.js` / `belongs-to.js`,
// `_injectAttributes`). `mergeDefaults` only fills in fields that are MISSING — it does not
// overwrite. So whichever of the two association calls runs FIRST sets the FK action, and the second
// is a silent no-op. Declaring the same value on both sides is therefore what makes the emitted DDL
// independent of the order of the lines in this file; it is not duplication.
//
// THE ONE PLACE THAT RULE BITES, AND WHY F-23 IS DECLARED IN models/UserGroup.js INSTEAD.
// `UserGroups.user_uuid` is also written by the two `belongsToMany` calls above, which run BEFORE
// the `UserGroup.belongsTo(User, ...)` / `User.hasMany(UserGroup, ...)` pair below and win under
// first-writer-wins — so an `onUpdate` set only on that pair is ignored, and the FK still emits
// `ON UPDATE CASCADE`. Verified empirically, not read off the source: tracing every writer of
// `UserGroup.rawAttributes.user_uuid.onUpdate` while requiring this barrel shows exactly three
// writes, all `CASCADE`, all from `belongsToMany`'s `Object.assign`, and none from the pair below.
// The fix is an ATTRIBUTE-level `onUpdate: 'NO ACTION'` in `models/UserGroup.js`, which
// `belongsToMany` deliberately reads through (`belongs-to-many.js:233`:
// `sourceAttribute.onUpdate = this.options.onUpdate || through.rawAttributes[fk].onUpdate`, and
// `:243` the same for the otherKey). The pair below keeps its declaration anyway, so the intent is
// visible where `onDelete` is.
//
// Every claim above about which associations converge was checked by rebuilding the sync side
// against a real Postgres and re-running the differ, NOT by reading the library: the first pass
// took 43 findings to 21, and it was the differ that reported F-23 still drifting and sent us to
// look for the belongsToMany interaction.
// ---------------------------------------------------------------------------------------

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
// 88.4 F-23 (D1a): onUpdate NO ACTION. These two lines run AFTER the belongsToMany pair above,
// which also writes UserGroups.user_uuid's FK options — so they are what the emitted DDL uses.
// The belongsToMany is deliberately left alone: it also governs UserGroups.group_id, which agrees
// with prod today and would start drifting if NO ACTION were added there.
UserGroup.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
User.hasMany(UserGroup, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });

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
// 88.4 F-22 (D1a): onUpdate NO ACTION.
User.hasMany(UserAvailability, { foreignKey: 'user_uuid', sourceKey: 'id', onUpdate: 'NO ACTION' });
UserAvailability.belongsTo(User, { foreignKey: 'user_uuid', targetKey: 'id', onUpdate: 'NO ACTION' });

// Group Prompt Settings (One-to-One)
// 88.4 F-17 (D1a): onUpdate NO ACTION.
Group.hasOne(GroupPromptSettings, { foreignKey: 'group_id', onUpdate: 'NO ACTION' });
GroupPromptSettings.belongsTo(Group, { foreignKey: 'group_id', onUpdate: 'NO ACTION' });

// Availability Prompts (One-to-Many from Group)
// 88.4 F-02 (D1a): onUpdate NO ACTION.
Group.hasMany(AvailabilityPrompt, { foreignKey: 'group_id', onUpdate: 'NO ACTION' });
AvailabilityPrompt.belongsTo(Group, { foreignKey: 'group_id', onUpdate: 'NO ACTION' });

// Availability Prompts (Many-to-One from Game, optional)
// 88.4 F-01 (D1a): onUpdate NO ACTION.
Game.hasMany(AvailabilityPrompt, { foreignKey: 'game_id', onUpdate: 'NO ACTION' });
AvailabilityPrompt.belongsTo(Game, { foreignKey: 'game_id', onUpdate: 'NO ACTION' });

// Availability Prompts (Many-to-One from GroupPromptSettings, optional)
// 88.4 F-04 (D1a): onUpdate NO ACTION. Prod's copy of this FK is the deferred one appended by
// migration 20260129-create-group-prompt-settings.js (the Plan 01 R-1c forward-reference repair).
GroupPromptSettings.hasMany(AvailabilityPrompt, { foreignKey: 'created_by_settings_id', onUpdate: 'NO ACTION' });
AvailabilityPrompt.belongsTo(GroupPromptSettings, { foreignKey: 'created_by_settings_id', onUpdate: 'NO ACTION' });

// Phase 71.2 / D-SCHEMA-05: AvailabilityPrompt creator (manual polls only).
// Used by Plan 03's UI to render "Started by [creator name]" via the Creator association.
// User.id is UUID, so this association uses the default FK (no sourceKey/targetKey override).
// 88.4 F-03 (D1a): onUpdate NO ACTION. One-sided association — there is no hasMany counterpart,
// so this single line is the whole declaration.
AvailabilityPrompt.belongsTo(User, { as: 'Creator', foreignKey: 'created_by_user_id', onDelete: 'SET NULL', onUpdate: 'NO ACTION' });

// Phase 71.2 / D-SCHEMA-06: GroupPromptSettings creator (the user who first set up scheduling).
// Used by Plan 02's recipient resolution: settings.created_by_user_id || group owner.
// 88.4 F-18 (D1a): onUpdate NO ACTION. One-sided association, as with F-03 above.
GroupPromptSettings.belongsTo(User, { as: 'Creator', foreignKey: 'created_by_user_id', onDelete: 'SET NULL', onUpdate: 'NO ACTION' });

// Availability Responses (One-to-Many from Prompt)
// 88.4 F-05 (D1a): onUpdate NO ACTION.
AvailabilityPrompt.hasMany(AvailabilityResponse, { foreignKey: 'prompt_id', onUpdate: 'NO ACTION' });
AvailabilityResponse.belongsTo(AvailabilityPrompt, { foreignKey: 'prompt_id', onUpdate: 'NO ACTION' });

// Availability Responses (Many-to-One from User)
// Phase 87.5 (BINT-02, D-01): re-keyed onto Users.id via user_uuid (UUID PK), the
// protective FK ON DELETE CASCADE. Default UUID key — no STRING sourceKey/targetKey.
// 88.4 F-06 (D1a): onUpdate NO ACTION.
User.hasMany(AvailabilityResponse, { foreignKey: 'user_uuid', sourceKey: 'id', onUpdate: 'NO ACTION' });
AvailabilityResponse.belongsTo(User, { foreignKey: 'user_uuid', targetKey: 'id', onUpdate: 'NO ACTION' });

// Availability Suggestions (One-to-Many from Prompt)
// 88.4 F-07 (D1a): onUpdate NO ACTION.
AvailabilityPrompt.hasMany(AvailabilitySuggestion, { foreignKey: 'prompt_id', onUpdate: 'NO ACTION' });
AvailabilitySuggestion.belongsTo(AvailabilityPrompt, { foreignKey: 'prompt_id', onUpdate: 'NO ACTION' });

// Availability Suggestions (Many-to-One from Event, optional)
// Note: alias 'ConvertedEvent' to distinguish from other Event associations
// 88.4 F-08 (D1a): onUpdate NO ACTION.
Event.hasMany(AvailabilitySuggestion, { as: 'ConvertedSuggestions', foreignKey: 'converted_to_event_id', onUpdate: 'NO ACTION' });
AvailabilitySuggestion.belongsTo(Event, { as: 'ConvertedEvent', foreignKey: 'converted_to_event_id', onUpdate: 'NO ACTION' });

// Magic Tokens (One-to-Many from User)
// Note: Uses sourceKey/targetKey because user_id is STRING (Auth0 ID), not UUID
// 88.4 F-20 (D1b): onUpdate NO ACTION — the CASCADE exception for this Auth0-subject parent was
// offered to the owner and DECLINED. This is one of only two FKs in the schema whose parent key is
// mutable in principle (Users.user_id, not a UUID PK), so it is one of only two where ON UPDATE
// could ever fire. NO ACTION makes such an UPDATE fail loudly rather than propagate silently; a
// future account-linking feature needs a deliberate migration anyway and can set the action then.
User.hasMany(MagicToken, { foreignKey: 'user_id', sourceKey: 'user_id', onUpdate: 'NO ACTION' });
MagicToken.belongsTo(User, { foreignKey: 'user_id', targetKey: 'user_id', onUpdate: 'NO ACTION' });

// Magic Tokens (One-to-Many from AvailabilityPrompt)
// 88.4 F-19 (D1a): onUpdate NO ACTION.
AvailabilityPrompt.hasMany(MagicToken, { foreignKey: 'prompt_id', onUpdate: 'NO ACTION' });
MagicToken.belongsTo(AvailabilityPrompt, { foreignKey: 'prompt_id', onUpdate: 'NO ACTION' });

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
// 88.4 F-14 / F-15 (D1a): onUpdate NO ACTION on BOTH endpoints.
User.hasMany(Friendship, { as: 'SentFriendRequests', foreignKey: 'requester_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
User.hasMany(Friendship, { as: 'ReceivedFriendRequests', foreignKey: 'addressee_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
Friendship.belongsTo(User, { as: 'Requester', foreignKey: 'requester_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
Friendship.belongsTo(User, { as: 'Addressee', foreignKey: 'addressee_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });

// Group Invites
Group.hasMany(GroupInvite, { foreignKey: 'group_id' });
GroupInvite.belongsTo(Group, { foreignKey: 'group_id' });
// Phase 87.1 (BINT-02, D-04): re-keyed onto Users.id via invited_by_uuid, a NULLABLE
// protective FK ON DELETE SET NULL — a pending invite outlives its inviter's account.
// Default target key (Users.id) — no override needed.
// 88.4 F-16 (D1a): onUpdate NO ACTION. NOTE the contrast with the GroupInvites -> Groups FK
// declared just above, which is deliberately left alone: migration 20260228000001:78 is one of the
// SIX in the whole chain that specify `onUpdate: 'CASCADE'`, so that FK already agrees with
// Sequelize's default and produces no finding (census § 4.1, C-7).
User.hasMany(GroupInvite, { as: 'SentInvites', foreignKey: 'invited_by_uuid', onDelete: 'SET NULL', onUpdate: 'NO ACTION' });
GroupInvite.belongsTo(User, { as: 'Inviter', foreignKey: 'invited_by_uuid', onDelete: 'SET NULL', onUpdate: 'NO ACTION' });

// Event RSVPs (yes/no/maybe responses)
Event.hasMany(EventRsvp, { foreignKey: 'event_id' });
EventRsvp.belongsTo(Event, { foreignKey: 'event_id' });
// Phase 87.1 (BINT-02, D-02): re-keyed onto Users.id via user_uuid, protective FK
// ON DELETE CASCADE. Default source/target key (Users.id) — no override needed.
// 88.4 F-13 (D1a): onUpdate NO ACTION.
User.hasMany(EventRsvp, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
EventRsvp.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });

// Event Brings (games users commit to bring)
// 88.4 F-10 (D1a): onUpdate NO ACTION.
Event.hasMany(EventBring, { foreignKey: 'event_id', onUpdate: 'NO ACTION' });
EventBring.belongsTo(Event, { foreignKey: 'event_id', onUpdate: 'NO ACTION' });
// Phase 87.1 (BINT-02, D-02): re-keyed onto Users.id via user_uuid, protective FK
// ON DELETE CASCADE. Default source/target key (Users.id) — no override needed.
// 88.4 F-12 (D1a): onUpdate NO ACTION.
User.hasMany(EventBring, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
EventBring.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
// 88.4 F-11 (D1a): onUpdate NO ACTION.
Game.hasMany(EventBring, { foreignKey: 'game_id', onUpdate: 'NO ACTION' });
EventBring.belongsTo(Game, { foreignKey: 'game_id', onUpdate: 'NO ACTION' });

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
// 88.4 F-09 (D1a): onUpdate NO ACTION.
User.hasMany(EventBallotVote, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
EventBallotVote.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });

// Sent Notifications (outbound SMS log for inbound reply resolution)
Event.hasMany(SentNotification, { foreignKey: 'event_id' });
SentNotification.belongsTo(Event, { foreignKey: 'event_id' });
// Phase 87.1 (BINT-02, D-03): re-keyed onto Users.id via user_uuid, protective FK
// ON DELETE CASCADE. Default source/target key (Users.id) — no override needed.
// 88.4 F-21 (D1a): onUpdate NO ACTION. The SentNotifications -> Events FK just above is
// deliberately untouched: migration 20260329100001:35 specifies onUpdate CASCADE (census § 4.1).
User.hasMany(SentNotification, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });
SentNotification.belongsTo(User, { foreignKey: 'user_uuid', onDelete: 'CASCADE', onUpdate: 'NO ACTION' });


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