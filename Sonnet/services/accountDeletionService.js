// services/accountDeletionService.js
// Phase 87.2 (D-01) — the account-deletion orchestration pipeline (SPEC Req 1-8).
//
// This service is the ONLY home for deletion orchestration (D-01). routes/users.js
// (plan 87.2-05) stays a thin handler that resolves the caller from req.user.user_id
// and delegates here. It composes three verified in-repo idioms into the fixed
// Google -> DB txn -> Auth0 order:
//   - best-effort-never-throws + lazy-queue-require  (services/gcalCleanupService.js)
//   - capture-before-destroy                          (Pitfall 2 — read tokens/email/ids
//                                                       BEFORE User.destroy fires CASCADE)
//   - one managed transaction (all-or-nothing DB)     (Phase 87 B3 precedent)
//
// KEYSPACE DISCIPLINE (RESEARCH Pitfall 1 — the top defect risk): user surfaces split
// across TWO keyspaces. Use the correct key per surface EXACTLY:
//   - user.id       (UUID surrogate PK)  -> UserGame, GameReview
//   - user.user_id  (Auth0 sub string)   -> MagicToken, SingleUseToken,
//                                            EventBallotOption.created_by, Feedback,
//                                            both JSONB scrubs
//
// SURVIVING EXCEPTIONS (completeness-by-enumeration — these are INTENTIONALLY NOT
// touched, per SPEC out-of-scope):
//   - EventAuditLog.actor_user_id (Auth0 string, no FK) — legitimate-interest audit
//     trail; SPEC-accepted exception.
//   - EmailMetrics.email_hash — SHA-256-hashed, no direct user link; SPEC-accepted.
//   - TokenAnalytics (token_id/jti + ip + user_agent, NO user key) — once this user's
//     MagicToken rows are hard-deleted (below), the jti->user join path is severed, so
//     the remaining rows are unlinkable security telemetry (same character as the
//     EventAuditLog exception). No code touches TokenAnalytics.
//
// All FK-covered surfaces (UserGroup, Friendship, EventRsvp, EventBring,
// EventBallotVote, SentNotification, EventParticipation, UserAvailability,
// AvailabilityResponse, GroupInvite, AvailabilityPrompt, GroupPromptSettings, and the
// new Event.winner_id/picked_by_id SET NULL FKs from plan 87.2-01) fire automatically
// on User.destroy via the 87.1 CASCADE / SET NULL graph — no explicit code needed here.

const { Op } = require('sequelize');
const {
  User,
  Group,
  Event,
  EventParticipation,
  UserGroup,
  GameReview,
  UserGame,
  MagicToken,
  SingleUseToken,
  Feedback,
  EventBallotOption,
  AvailabilitySuggestion,
  PendingAuth0Deletion,
  sequelize,
} = require('../models');

// NOTE (Pitfall 4): the auth0CleanupQueue is required LAZILY inside deleteAccount's
// enqueue path (added in Task 2), never at module top — the queues/index.js getter
// opens Redis on property access, so a module-top destructure would connect Redis at
// import time and force every suite importing this service to need Redis.

/**
 * Shared owner-gate helper (D-10). Both the pre-flight GET /users/me/deletion-blockers
 * and the authoritative DELETE /users/me call this ONE function so the gate cannot drift.
 * It is ALSO re-run as the first statement inside the deletion transaction (Task 2,
 * Step 3) to close the TOCTOU window (T-87.2-11).
 *
 * Predicate: a group the user OWNS (UserGroup.role='owner') is a blocker iff it has >= 1
 * OTHER UserGroup row of ANY status (incl. pending/invited/declined). Sole-member owned
 * groups (zero other rows) are NOT blockers — they are auto-delete targets.
 *
 * Wire shape: [{ id, name, memberCount }] where memberCount is the TOTAL UserGroup row
 * count for the group (any status, INCLUDING the owner's own row) — the FE renders this
 * as the group's member count. (Returning the other-count here would render every
 * blocked group off-by-one.)
 *
 * @param {string} userUuid - the caller's Users.id (UUID)
 * @param {{ transaction?: import('sequelize').Transaction }} [options]
 * @returns {Promise<Array<{ id: string, name: string|null, memberCount: number }>>}
 */
async function getDeletionBlockers(userUuid, options = {}) {
  const { transaction } = options;

  const ownedRows = await UserGroup.findAll({
    where: { user_uuid: userUuid, role: 'owner' },
    attributes: ['group_id'],
    transaction,
  });

  const blockers = [];
  for (const row of ownedRows) {
    const groupId = row.group_id;
    // Other-members predicate: ANY UserGroup row (any status) that is not the owner's.
    const otherCount = await UserGroup.count({
      where: { group_id: groupId, user_uuid: { [Op.ne]: userUuid } },
      transaction,
    });
    if (otherCount >= 1) {
      // memberCount = TOTAL rows (incl. the owner) — the value the FE displays.
      const memberCount = await UserGroup.count({
        where: { group_id: groupId },
        transaction,
      });
      const group = await Group.findByPk(groupId, {
        attributes: ['id', 'name'],
        transaction,
      });
      blockers.push({
        id: groupId,
        name: group ? group.name : null,
        memberCount,
      });
    }
  }

  return blockers;
}

/**
 * In-transaction disposition function (SPEC Req 3). Given a fully-loaded user (email
 * populated via the withContactInfo scope — see deleteAccount Step 0) and an open
 * transaction, deletes/anonymizes every no-FK user surface using the correct keyspace,
 * auto-deletes sole-member owned groups (replicated group-delete semantics, in-txn),
 * inserts the durable PendingAuth0Deletion marker, then destroys the user (firing the
 * 87.1 CASCADE / SET NULL graph).
 *
 * EVERY write passes { transaction: t } so the whole disposition is all-or-nothing.
 *
 * @param {import('sequelize').Model} user - loaded Users row (id, user_id, email set)
 * @param {import('sequelize').Transaction} t - the open managed transaction
 */
async function applyDispositions(user, t) {
  const uuid = user.id; // UUID surrogate PK
  const sub = user.user_id; // Auth0 sub string
  const email = user.email; // captured via withContactInfo scope (Step 0)

  // 1. SOLE-MEMBER OWNED GROUP AUTO-DELETE (Pitfall 8).
  //    For each owned group whose ONLY UserGroup row (any status) is the owner's,
  //    replicate routes/groups.js:721-742 group-delete IN-TXN. Never call the route
  //    (it is non-transactional). Groups with other members were already rejected by
  //    the owner gate (Step 1 + the in-txn re-check in Step 3), so they never reach here.
  const ownedRows = await UserGroup.findAll({
    where: { user_uuid: uuid, role: 'owner' },
    attributes: ['group_id'],
    transaction: t,
  });
  for (const row of ownedRows) {
    const groupId = row.group_id;
    const otherCount = await UserGroup.count({
      where: { group_id: groupId, user_uuid: { [Op.ne]: uuid } },
      transaction: t,
    });
    if (otherCount === 0) {
      const events = await Event.findAll({
        where: { group_id: groupId },
        attributes: ['id'],
        transaction: t,
      });
      const eventIds = events.map((e) => e.id);
      if (eventIds.length > 0) {
        await EventParticipation.destroy({
          where: { event_id: { [Op.in]: eventIds } },
          transaction: t,
        });
      }
      await Event.destroy({ where: { group_id: groupId }, transaction: t });
      await GameReview.destroy({ where: { group_id: groupId }, transaction: t });
      await UserGroup.destroy({ where: { group_id: groupId }, transaction: t });
      await Group.destroy({ where: { id: groupId }, transaction: t });
    }
  }

  // 2. DELETE rows.
  //    UUID keyspace:
  await UserGame.destroy({ where: { user_id: uuid }, transaction: t });
  //    GameReview by author — HARD delete (D-18 supersedes the 87.1 soft-delete note).
  await GameReview.destroy({ where: { user_id: uuid }, transaction: t });
  //    Auth0-sub keyspace:
  await MagicToken.destroy({ where: { user_id: sub }, transaction: t });
  await SingleUseToken.destroy({ where: { user_id: sub }, transaction: t });

  // 3. ANONYMIZE Feedback — null both keys, KEEP the feedback text (Open Question 1:
  //    match user_id OR user_email so rows submitted logged-out-with-email are covered).
  await Feedback.update(
    { user_id: null, user_email: null },
    { where: { [Op.or]: [{ user_id: sub }, { user_email: email }] }, transaction: t }
  );

  // 4. EventBallotOption.created_by -> NULL (Auth0 sub).
  await EventBallotOption.update(
    { created_by: null },
    { where: { created_by: sub }, transaction: t }
  );

  // 5. JSONB SCRUBS (raw query, jsonb `-` operator; atomic, no read-modify-write race).
  //    5a. participant_user_ids: remove the sub element AND recompute the denormalized
  //        derived columns in the SAME UPDATE (Pitfall 6) so a now-below-minimum slot
  //        cannot keep ranking as viable:
  //          - participant_count = new array length
  //          - meets_minimum via the prompt's threshold. NOTE: min_participants is NOT a
  //            column on AvailabilityPrompts — the real threshold is the prompt's Game
  //            min_players (default 2), derived at aggregation time in
  //            heatmapService.js:51-54. We replicate that here via LEFT JOIN "Games" +
  //            COALESCE(g.min_players, 2) (game_id is nullable for game-optional prompts).
  //          - score per heatmapService calculateScore(): participant_count*1.0 +
  //            preferred_count*0.5. The model comment mentions a meets_minimum "boost"
  //            but calculateScore applies none, so we match the real formula (no boost).
  //        preferred_count has NO persisted per-user array and is NOT derivable post-hoc
  //        — it is accepted stale-by-one until the next regeneration (documented here).
  await sequelize.query(
    `UPDATE "AvailabilitySuggestions" AS s
        SET participant_user_ids = s.participant_user_ids - :sub,
            participant_count = jsonb_array_length(s.participant_user_ids - :sub),
            meets_minimum = (jsonb_array_length(s.participant_user_ids - :sub) >= COALESCE(g.min_players, 2)),
            score = (jsonb_array_length(s.participant_user_ids - :sub) * 1.0 + s.preferred_count * 0.5)
       FROM "AvailabilityPrompts" AS ap
       LEFT JOIN "Games" AS g ON g.id = ap.game_id
      WHERE ap.id = s.prompt_id
        AND s.participant_user_ids ? :sub`,
    { replacements: { sub }, transaction: t }
  );
  //    5b. tentative_calendar_event_ids: remove the sub key (the gcal hold VALUE was
  //        already read + deleted pre-txn in Step 2 of deleteAccount).
  await sequelize.query(
    `UPDATE "AvailabilitySuggestions"
        SET tentative_calendar_event_ids = tentative_calendar_event_ids - :sub
      WHERE tentative_calendar_event_ids ? :sub`,
    { replacements: { sub }, transaction: t }
  );

  // 6. INSERT the durable PendingAuth0Deletion marker (D-08 backstop) — BEFORE the
  //    User.destroy, inside the same transaction, so it commits atomically with the
  //    deletion. No tokens are stored (email is ops context only).
  await PendingAuth0Deletion.create(
    { auth0_sub: sub, email },
    { transaction: t }
  );

  // 7. Destroy the Users row — fires the 87.1 CASCADE / SET NULL graph (incl. the new
  //    Event.winner_id/picked_by_id SET NULL FKs from plan 87.2-01).
  await user.destroy({ transaction: t });
}

module.exports = {
  getDeletionBlockers,
  applyDispositions,
};
