// tests/integration/accountDeletion.integrity.test.js
// Phase 87.2 / Plan 06 (REQ-3) — the proof-of-completeness artifact.
//
// This is a REAL-POSTGRES integration test. It mocks ONLY the external boundaries
// (Google client, Auth0 deleteUser, emailService, the Redis queue) so every DB
// disposition — CASCADE graph, SET NULL FKs, explicit DELETE/ANONYMIZE cleanups,
// and the JSONB scrubs — runs for real against Postgres. It seeds a target user
// with a row on EVERY user-referencing surface in the RESEARCH disposition table,
// asserts each row EXISTS before deletion (guarding the false-green keyspace bug —
// Pitfall 1: assert seeded-THEN-gone, never merely gone), runs deleteAccount, then
// asserts every disposition, a control user's total isolation, and the two SPEC
// Req 2 scenarios (Test C group-survival, Test A blocked-run-deletes-nothing).
//
// RUN ALONE (shared test-DB force-sync gotcha — RESEARCH Pitfall 5):
//   npm test -- tests/integration/accountDeletion.integrity.test.js --forceExit --testTimeout=25000
// It runs under the DEFAULT jest config (jest.config.js) so it inherits the
// globalSetup schema build + the per-test TRUNCATE in tests/setup.js. The default
// config ignores ONLY the Redis ring file, not this DB test (see jest.config.js).

// ---------------------------------------------------------------------------
// External-boundary mocks (models stay REAL). Declared before requiring the
// service so its top-level requires resolve to these doubles.
// ---------------------------------------------------------------------------
const mockDeleteCalEvent = jest.fn().mockResolvedValue({ deleted: true });
const mockDeleteHolds = jest.fn().mockResolvedValue({ deleted: 0, failed: 0 });
const mockRevoke = jest.fn().mockResolvedValue({ revoked: true });
const mockDeleteUser = jest.fn().mockResolvedValue({ deleted: true });
const mockEmailSend = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../services/googleCalendarService', () => ({
  deleteCalendarEventForUser: (...a) => mockDeleteCalEvent(...a),
  deleteTentativeHolds: (...a) => mockDeleteHolds(...a),
  revokeGoogleAccess: (...a) => mockRevoke(...a),
}));
jest.mock('../../services/auth0Service', () => ({
  deleteUser: (...a) => mockDeleteUser(...a),
}));
jest.mock('../../services/emailService', () => ({
  send: (...a) => mockEmailSend(...a),
}));
// Manual mock at queues/__mocks__/index.js — stub auth0CleanupQueue.add (only hit
// on an Auth0 failure, which this suite does not exercise). Keeps Redis out.
jest.mock('../../queues');

const {
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
  Feedback,
  Friendship,
  GroupInvite,
  EventRsvp,
  EventBring,
  EventBallotOption,
  EventBallotVote,
  SentNotification,
} = require('../../models');

const {
  makeUser,
  makeGroup,
  addToGroup,
  makeEventRsvp,
  makeEventBring,
  makeEventBallotVote,
  makeSentNotification,
  makeGroupInvite,
  makeFriendship,
  makeUserGame,
  makeGameReview,
  makeMagicToken,
  makeSingleUseToken,
  makeFeedback,
  makeEventBallotOption,
  makeAvailabilitySuggestion,
} = require('../factories');

const { deleteAccount } = require('../../services/accountDeletionService');

// Small local seeders for the models the shared factory does not cover.
async function makeGame(overrides = {}) {
  return Game.create({ name: `Game ${Date.now()}-${Math.random()}`, bgg_id: null, min_players: 2, ...overrides });
}
async function makeEvent(group, overrides = {}) {
  return Event.create({ group_id: group.id, start_date: new Date(), status: 'completed', ...overrides });
}
async function makeEventParticipation(event, user, overrides = {}) {
  return EventParticipation.create({ event_id: event.id, user_id: user.id, is_guest: false, ...overrides });
}
async function makeUserAvailability(user, overrides = {}) {
  return UserAvailability.create({
    user_uuid: user.id, // Phase 87.5 (D-04): re-keyed FK -> Users.id, CASCADE
    type: 'recurring_pattern',
    pattern_data: { dayOfWeek: 3, startTime: '18:00', endTime: '22:00', timezone: 'UTC' },
    start_date: '2026-01-01',
    ...overrides,
  });
}
async function makePrompt(group, overrides = {}) {
  const n = Math.random().toString(36).slice(2);
  return AvailabilityPrompt.create({
    group_id: group.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 72 * 3600 * 1000),
    status: 'closed', // avoid the one-open-manual partial unique index
    week_identifier: `2026-W05-${n}`,
    ...overrides,
  });
}
async function makeAvailabilityResponse(prompt, user, overrides = {}) {
  return AvailabilityResponse.create({
    prompt_id: prompt.id,
    user_uuid: user.id, // Phase 87.5 (D-04): re-keyed FK -> Users.id, CASCADE
    time_slots: [{ start: '2026-01-01T18:00:00Z', end: '2026-01-01T22:00:00Z', preference: 'preferred' }],
    user_timezone: 'UTC',
    submitted_at: new Date(),
    ...overrides,
  });
}
async function makeGroupPromptSettings(group, creator, overrides = {}) {
  return GroupPromptSettings.create({
    group_id: group.id,
    created_by_user_id: creator.id, // UUID keyspace, SET NULL on delete
    ...overrides,
  });
}

describe('accountDeletion integrity — full disposition table on real Postgres (REQ-3)', () => {
  // Clear call counts between tests (implementations from mockResolvedValue survive
  // clearAllMocks) so Test A can assert the external lanes were never touched.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('seed every surface -> delete target -> assert each disposition + control isolation + Test C', async () => {
    // -------------------------------------------------------------------
    // SEED
    // -------------------------------------------------------------------
    const target = await makeUser({ google_calendar_token: 'at', google_calendar_refresh_token: 'rt' });
    const control = await makeUser();
    const bystander = await makeUser(); // third party for a control<->bystander friendship

    const game = await makeGame();

    // controlGroup: control OWNS it, target is a plain MEMBER (SPEC Req 2 Test C —
    // survives target's deletion). All survivable rows hang off THIS group so the
    // target's own-group auto-delete never erases them.
    const controlGroup = await makeGroup();
    await addToGroup(control, controlGroup, 'owner');
    const targetMembership = await addToGroup(target, controlGroup, 'member');

    // soloGroup: target OWNS it as the sole member -> auto-deleted by applyDispositions.
    const soloGroup = await makeGroup();
    const soloOwnerRow = await addToGroup(target, soloGroup, 'owner');
    const soloEvent = await makeEvent(soloGroup); // proves the replicated group-delete cascade

    // Events under controlGroup (survive; used for SET NULL + CASCADE assertions).
    // Kitchen-sink custom-participant event: winner/picker are NON-members (names set,
    // ids NULL — the app-realistic XOR the write paths produce).
    const customEvent = await makeEvent(controlGroup, {
      game_id: game.id,
      winner_id: null,
      picked_by_id: null,
      winner_name: 'Custom Winner',
      picked_by_name: 'Custom Picker',
    });
    // Member-winner event: target is winner + picker (ids set, names NULL).
    const memberWinnerEvent = await makeEvent(controlGroup, {
      game_id: game.id,
      winner_id: target.id,
      picked_by_id: target.id,
      winner_name: null,
      picked_by_name: null,
    });

    // A controlGroup prompt created BY the target (created_by_user_id -> SET NULL).
    const prompt = await makePrompt(controlGroup, { created_by_user_id: target.id });
    const promptSettings = await makeGroupPromptSettings(controlGroup, target); // created_by -> SET NULL

    // --- CASCADE-graph surfaces for the target (seeded-then-gone) ---
    const tParticipation = await makeEventParticipation(customEvent, target, { google_calendar_event_id: 'gcal-evt-target' });
    const tRsvp = await makeEventRsvp(customEvent, target);
    const tBring = await makeEventBring(customEvent, target, game);
    const tBallotOption = await makeEventBallotOption(customEvent, target); // created_by_uuid -> SET NULL (survives)
    const tBallotVote = await makeEventBallotVote(tBallotOption, target); // CASCADE (gone)
    const tSentNotif = await makeSentNotification(customEvent, target);
    const tAvailability = await makeUserAvailability(target); // Auth0-sub CASCADE
    const tResponse = await makeAvailabilityResponse(prompt, target); // Auth0-sub CASCADE
    const tFriendship = await makeFriendship(target, control, { status: 'accepted' }); // CASCADE

    // --- SET NULL surfaces for the target (row survives, pointer nulled) ---
    const tGroupInvite = await makeGroupInvite(controlGroup, target, { status: 'pending' }); // invited_by_uuid -> NULL

    // --- explicit DELETE surfaces for the target (Auth0-sub + UUID keyspaces) ---
    const tUserGame = await makeUserGame(target, game); // UUID DELETE
    const tGameReview = await makeGameReview(target, controlGroup, game); // UUID DELETE
    const tMagicToken = await makeMagicToken(target, prompt); // sub DELETE
    const tSingleUse = await makeSingleUseToken(target); // sub DELETE

    // --- ANONYMIZE surfaces for the target ---
    const tFeedback = await makeFeedback(target); // user_id=sub + user_email=email
    const tFeedbackEmailOnly = await makeFeedback(target, { user_id: null }); // email-ONLY row
    // tBallotOption above is the created_by_uuid creator scrub (SET NULL) surface (Phase 87.5 PR-1).

    // --- JSONB-scrub surface for the target ---
    const tSuggestion = await makeAvailabilitySuggestion(prompt, target); // [target.sub] + { target.sub: gcalId }

    // -------------------------------------------------------------------
    // CONTROL rows on every surface (must be UNTOUCHED post-deletion).
    // -------------------------------------------------------------------
    const cParticipation = await makeEventParticipation(customEvent, control);
    const cRsvp = await makeEventRsvp(customEvent, control);
    const cBring = await makeEventBring(customEvent, control, game);
    const cBallotOption = await makeEventBallotOption(customEvent, control);
    const cBallotVote = await makeEventBallotVote(cBallotOption, control);
    const cSentNotif = await makeSentNotification(customEvent, control);
    const cAvailability = await makeUserAvailability(control);
    const cResponse = await makeAvailabilityResponse(prompt, control);
    const cFriendship = await makeFriendship(control, bystander, { status: 'accepted' });
    const cGroupInvite = await makeGroupInvite(controlGroup, control, { status: 'pending' });
    const cUserGame = await makeUserGame(control, game);
    const cGameReview = await makeGameReview(control, controlGroup, game);
    const cMagicToken = await makeMagicToken(control, prompt);
    const cSingleUse = await makeSingleUseToken(control);
    const cFeedback = await makeFeedback(control);
    const cSuggestion = await makeAvailabilitySuggestion(prompt, control);

    // -------------------------------------------------------------------
    // PRE-DELETE existence assertions (guard against the false-green keyspace bug
    // — Pitfall 1: every surface MUST have a live row before we delete).
    // -------------------------------------------------------------------
    expect(await UserGroup.findByPk(targetMembership.id)).not.toBeNull();
    expect(await UserGroup.findByPk(soloOwnerRow.id)).not.toBeNull();
    expect(await Group.findByPk(soloGroup.id)).not.toBeNull();
    expect(await Event.findByPk(soloEvent.id)).not.toBeNull();
    expect(await EventParticipation.findByPk(tParticipation.id)).not.toBeNull();
    expect(await EventRsvp.findByPk(tRsvp.id)).not.toBeNull();
    expect(await EventBring.findByPk(tBring.id)).not.toBeNull();
    expect(await EventBallotOption.findByPk(tBallotOption.id)).not.toBeNull();
    expect(await EventBallotVote.findByPk(tBallotVote.id)).not.toBeNull();
    expect(await SentNotification.findByPk(tSentNotif.id)).not.toBeNull();
    expect(await UserAvailability.findByPk(tAvailability.id)).not.toBeNull();
    expect(await AvailabilityResponse.findByPk(tResponse.id)).not.toBeNull();
    expect(await Friendship.findByPk(tFriendship.id)).not.toBeNull();
    expect(await GroupInvite.findByPk(tGroupInvite.id)).not.toBeNull();
    expect(await UserGame.findByPk(tUserGame.id)).not.toBeNull();
    expect(await GameReview.findByPk(tGameReview.id)).not.toBeNull();
    expect(await MagicToken.findByPk(tMagicToken.id)).not.toBeNull();
    expect(await SingleUseToken.findByPk(tSingleUse.id)).not.toBeNull();
    expect(await Feedback.findByPk(tFeedback.id)).not.toBeNull();
    expect(await Feedback.findByPk(tFeedbackEmailOnly.id)).not.toBeNull();
    expect(await AvailabilitySuggestion.findByPk(tSuggestion.id)).not.toBeNull();
    // Winner/picker pointers present before deletion.
    const preMemberWinner = await Event.findByPk(memberWinnerEvent.id);
    expect(preMemberWinner.winner_id).toBe(target.id);
    expect(preMemberWinner.picked_by_id).toBe(target.id);

    // -------------------------------------------------------------------
    // DELETE
    // -------------------------------------------------------------------
    const result = await deleteAccount({ userId: target.user_id });
    expect(result).toEqual({ status: 'deleted' });
    // The user row itself is gone (CASCADE root).
    expect(await User.unscoped().findByPk(target.id)).toBeNull();

    // -------------------------------------------------------------------
    // POST-DELETE assertions — DELETE surfaces have ZERO target rows.
    // -------------------------------------------------------------------
    expect(await UserGame.count({ where: { user_id: target.id } })).toBe(0);
    expect(await GameReview.count({ where: { user_id: target.id } })).toBe(0);
    expect(await MagicToken.count({ where: { user_id: target.user_id } })).toBe(0);
    expect(await SingleUseToken.count({ where: { user_id: target.user_id } })).toBe(0);

    // CASCADE surfaces gone.
    expect(await UserGroup.findByPk(targetMembership.id)).toBeNull();
    expect(await EventParticipation.findByPk(tParticipation.id)).toBeNull();
    expect(await EventRsvp.findByPk(tRsvp.id)).toBeNull();
    expect(await EventBring.findByPk(tBring.id)).toBeNull();
    expect(await EventBallotVote.findByPk(tBallotVote.id)).toBeNull();
    expect(await SentNotification.findByPk(tSentNotif.id)).toBeNull();
    expect(await UserAvailability.findByPk(tAvailability.id)).toBeNull();
    expect(await AvailabilityResponse.findByPk(tResponse.id)).toBeNull();
    expect(await Friendship.findByPk(tFriendship.id)).toBeNull();

    // SET NULL surfaces retain the row with the pointer nulled.
    const invAfter = await GroupInvite.findByPk(tGroupInvite.id);
    expect(invAfter).not.toBeNull();
    expect(invAfter.invited_by_uuid).toBeNull();

    const promptAfter = await AvailabilityPrompt.findByPk(prompt.id);
    expect(promptAfter).not.toBeNull();
    expect(promptAfter.created_by_user_id).toBeNull();

    const settingsAfter = await GroupPromptSettings.findByPk(promptSettings.id);
    expect(settingsAfter).not.toBeNull();
    expect(settingsAfter.created_by_user_id).toBeNull();

    const ballotAfter = await EventBallotOption.findByPk(tBallotOption.id);
    expect(ballotAfter).not.toBeNull();
    expect(ballotAfter.created_by_uuid).toBeNull(); // creator scrub (UUID) + SET NULL FK -> NULL

    // Member-winner event: pointers nulled, NO display text (hard-delete semantics).
    const memberWinnerAfter = await Event.findByPk(memberWinnerEvent.id);
    expect(memberWinnerAfter).not.toBeNull();
    expect(memberWinnerAfter.winner_id).toBeNull();
    expect(memberWinnerAfter.picked_by_id).toBeNull();
    expect(memberWinnerAfter.winner_name).toBeNull();
    expect(memberWinnerAfter.picked_by_name).toBeNull();

    // Custom-participant event: display text SURVIVES.
    const customAfter = await Event.findByPk(customEvent.id);
    expect(customAfter).not.toBeNull();
    expect(customAfter.winner_name).toBe('Custom Winner');
    expect(customAfter.picked_by_name).toBe('Custom Picker');

    // Feedback anonymized — both keys null, text kept — INCLUDING the email-only row
    // (proves the pipeline loaded the email past defaultScope via withContactInfo).
    const fbAfter = await Feedback.findByPk(tFeedback.id);
    expect(fbAfter).not.toBeNull();
    expect(fbAfter.user_id).toBeNull();
    expect(fbAfter.user_email).toBeNull();
    expect(fbAfter.description).toBe('Something to keep after anonymization.');
    const fbEmailOnlyAfter = await Feedback.findByPk(tFeedbackEmailOnly.id);
    expect(fbEmailOnlyAfter).not.toBeNull();
    expect(fbEmailOnlyAfter.user_id).toBeNull();
    expect(fbEmailOnlyAfter.user_email).toBeNull();
    // No target-keyed Feedback rows remain by either key.
    expect(await Feedback.count({ where: { user_id: target.user_id } })).toBe(0);
    expect(await Feedback.count({ where: { user_email: target.email } })).toBe(0);

    // JSONB scrub — target UUID removed from participant_user_ids (Plan 03 flip: the
    // column now holds Users.id UUIDs, so the 5a surgery removes target.id), count
    // recomputed. tentative_calendar_event_ids stays sub-keyed (5b), target sub removed.
    const suggAfter = await AvailabilitySuggestion.findByPk(tSuggestion.id);
    expect(suggAfter).not.toBeNull();
    expect(suggAfter.participant_user_ids).not.toContain(target.id);
    expect(suggAfter.participant_user_ids).not.toContain(target.user_id);
    expect(suggAfter.participant_user_ids).toEqual([]);
    expect(suggAfter.participant_count).toBe(0);
    expect(Object.keys(suggAfter.tentative_calendar_event_ids || {})).not.toContain(target.user_id);

    // sole-member owned group + its event are GONE (replicated group-delete).
    expect(await Group.findByPk(soloGroup.id)).toBeNull();
    expect(await Event.findByPk(soloEvent.id)).toBeNull();
    expect(await UserGroup.findByPk(soloOwnerRow.id)).toBeNull();

    // -------------------------------------------------------------------
    // SPEC Req 2 Test C — group SURVIVES a non-owner member's deletion.
    // -------------------------------------------------------------------
    expect(await Group.findByPk(controlGroup.id)).not.toBeNull();
    const controlOwnerRow = await UserGroup.findOne({
      where: { user_uuid: control.id, group_id: controlGroup.id, role: 'owner' },
    });
    expect(controlOwnerRow).not.toBeNull();
    // ONLY the target's membership row on controlGroup is gone.
    expect(
      await UserGroup.count({ where: { user_uuid: target.id, group_id: controlGroup.id } })
    ).toBe(0);

    // -------------------------------------------------------------------
    // CONTROL user's data on EVERY surface is completely untouched.
    // -------------------------------------------------------------------
    expect(await User.unscoped().findByPk(control.id)).not.toBeNull();
    expect(await EventParticipation.findByPk(cParticipation.id)).not.toBeNull();
    expect(await EventRsvp.findByPk(cRsvp.id)).not.toBeNull();
    expect(await EventBring.findByPk(cBring.id)).not.toBeNull();
    expect(await EventBallotVote.findByPk(cBallotVote.id)).not.toBeNull();
    expect(await SentNotification.findByPk(cSentNotif.id)).not.toBeNull();
    expect(await UserAvailability.findByPk(cAvailability.id)).not.toBeNull();
    expect(await AvailabilityResponse.findByPk(cResponse.id)).not.toBeNull();
    expect(await Friendship.findByPk(cFriendship.id)).not.toBeNull();
    expect(await UserGame.findByPk(cUserGame.id)).not.toBeNull();
    expect(await GameReview.findByPk(cGameReview.id)).not.toBeNull();
    expect(await MagicToken.findByPk(cMagicToken.id)).not.toBeNull();
    expect(await SingleUseToken.findByPk(cSingleUse.id)).not.toBeNull();
    // control's creator / inviter pointers keep control's identifiers. The operative
    // creator key is created_by_uuid (Phase 87.5) — it must survive the target's
    // deletion for the control. (The legacy created_by sub column + attribute were dropped
    // in the Phase 87.5 PR-2 contract cutover, so there is no sub column to assert.)
    const cBallotAfter = await EventBallotOption.findByPk(cBallotOption.id);
    expect(cBallotAfter.created_by_uuid).toBe(control.id);
    const cInviteAfter = await GroupInvite.findByPk(cGroupInvite.id);
    expect(cInviteAfter.invited_by_uuid).toBe(control.id);
    // control's Feedback untouched (keys intact).
    const cFbAfter = await Feedback.findByPk(cFeedback.id);
    expect(cFbAfter.user_id).toBe(control.user_id);
    expect(cFbAfter.user_email).toBe(control.email);
    // control's suggestion untouched (still holds control's UUID — Plan 03 flip).
    const cSuggAfter = await AvailabilitySuggestion.findByPk(cSuggestion.id);
    expect(cSuggAfter.participant_user_ids).toContain(control.id);
    expect(cSuggAfter.participant_count).toBe(1);

    // External boundaries were exercised (target had Google tokens) but never blocked.
    expect(mockRevoke).toHaveBeenCalled();
    expect(mockDeleteUser).toHaveBeenCalledTimes(1);
    expect(mockEmailSend).toHaveBeenCalledTimes(1);
  });

  test('SPEC Req 2 Test A — blocked run (target owns a populated group) deletes NOTHING', async () => {
    // Fresh target that OWNS a group with the control user as another active member.
    const target2 = await makeUser();
    const control2 = await makeUser();
    const game = await makeGame();

    const ownedGroup = await makeGroup();
    await addToGroup(target2, ownedGroup, 'owner');
    await addToGroup(control2, ownedGroup, 'member'); // another active member -> blocker

    // Seed target2 rows on representative deletion surfaces so we can prove NONE move.
    const t2UserGame = await makeUserGame(target2, game);
    const t2GameReview = await makeGameReview(target2, ownedGroup, game);
    const t2Feedback = await makeFeedback(target2);
    const t2Availability = await makeUserAvailability(target2);
    const t2Event = await makeEvent(ownedGroup, { game_id: game.id, winner_id: target2.id, winner_name: null });

    // Snapshot per-table row counts across the full model registry BEFORE the run.
    const models = [
      User, Group, Game, Event, EventParticipation, UserGroup, GameReview, UserGame,
      UserAvailability, GroupPromptSettings, AvailabilityPrompt, AvailabilityResponse,
      AvailabilitySuggestion, MagicToken, SingleUseToken, Feedback, Friendship,
      GroupInvite, EventRsvp, EventBring, EventBallotOption, EventBallotVote, SentNotification,
    ];
    const before = {};
    for (const m of models) before[m.name] = await m.count();

    // Run the deletion — it must be BLOCKED (owner of a populated group).
    const result = await deleteAccount({ userId: target2.user_id });
    expect(result.status).toBe('blocked');
    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.groups.some((g) => g.id === ownedGroup.id)).toBe(true);

    // Every per-table count is IDENTICAL — nothing was deleted.
    for (const m of models) {
      expect(await m.count()).toBe(before[m.name]);
    }

    // Every seeded row is still present and unchanged.
    expect(await User.unscoped().findByPk(target2.id)).not.toBeNull();
    expect(await UserGame.findByPk(t2UserGame.id)).not.toBeNull();
    expect(await GameReview.findByPk(t2GameReview.id)).not.toBeNull();
    const fb = await Feedback.findByPk(t2Feedback.id);
    expect(fb.user_id).toBe(target2.user_id); // NOT anonymized
    expect(fb.user_email).toBe(target2.email);
    expect(await UserAvailability.findByPk(t2Availability.id)).not.toBeNull();
    const ev = await Event.findByPk(t2Event.id);
    expect(ev.winner_id).toBe(target2.id); // pointer NOT nulled
    expect(await Group.findByPk(ownedGroup.id)).not.toBeNull();

    // No external side effects fired on a blocked run.
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  test('Phase 87.4 D-09 — deletion scrubs the UUID from participant_user_ids AND selected_member_ids; a second member survives with correct counts', async () => {
    // A group the target does NOT own (so target is freely deletable). Both the target
    // and a second member appear in a shared suggestion + a shared prompt-settings
    // schedule, so we can prove the scrub removes ONLY the target's UUID.
    const owner = await makeUser();
    const target = await makeUser();
    const secondMember = await makeUser();

    const group = await makeGroup();
    await addToGroup(owner, group, 'owner');
    await addToGroup(target, group, 'member');
    await addToGroup(secondMember, group, 'member');

    const prompt = await makePrompt(group);

    // Multi-member suggestion: participant_user_ids holds BOTH members' Users.id UUIDs
    // (Plan 03 flip). participant_count = 2 to match.
    const suggestion = await makeAvailabilitySuggestion(prompt, target, {
      participant_user_ids: [target.id, secondMember.id],
      participant_count: 2,
    });

    // GroupPromptSettings with a schedule whose selected_member_ids lists both members'
    // UUIDs (Plan 04 backfill shape).
    const settings = await makeGroupPromptSettings(group, owner, {
      template_config: {
        schedules: [
          {
            id: 'sched-d09',
            is_active: true,
            selected_member_ids: [target.id, secondMember.id],
          },
          {
            id: 'sched-empty',
            is_active: true,
            selected_member_ids: [], // untouched control schedule
          },
        ],
      },
    });

    // Pre-delete: both UUIDs present in both keyspaces.
    const suggBefore = await AvailabilitySuggestion.findByPk(suggestion.id);
    expect(suggBefore.participant_user_ids).toEqual(
      expect.arrayContaining([target.id, secondMember.id])
    );
    const settingsBefore = await GroupPromptSettings.findByPk(settings.id);
    expect(settingsBefore.template_config.schedules[0].selected_member_ids).toEqual(
      expect.arrayContaining([target.id, secondMember.id])
    );

    // DELETE the target.
    const result = await deleteAccount({ userId: target.user_id });
    expect(result).toEqual({ status: 'deleted' });

    // participant_user_ids: target UUID gone, second member survives, count recomputed.
    const suggAfter = await AvailabilitySuggestion.findByPk(suggestion.id);
    expect(suggAfter.participant_user_ids).not.toContain(target.id);
    expect(suggAfter.participant_user_ids).toContain(secondMember.id);
    expect(suggAfter.participant_user_ids).toEqual([secondMember.id]);
    expect(suggAfter.participant_count).toBe(1);

    // selected_member_ids: target UUID gone from the schedule, second member survives.
    const settingsAfter = await GroupPromptSettings.findByPk(settings.id);
    const scrubbed = settingsAfter.template_config.schedules.find((s) => s.id === 'sched-d09');
    expect(scrubbed.selected_member_ids).not.toContain(target.id);
    expect(scrubbed.selected_member_ids).toContain(secondMember.id);
    expect(scrubbed.selected_member_ids).toEqual([secondMember.id]);
    // The unrelated empty schedule is preserved intact (no collateral change).
    const untouched = settingsAfter.template_config.schedules.find((s) => s.id === 'sched-empty');
    expect(untouched).toBeTruthy();
    expect(untouched.selected_member_ids).toEqual([]);
  });
});
