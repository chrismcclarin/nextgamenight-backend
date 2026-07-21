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
//   - user.id       (UUID surrogate PK)  -> UserGame, GameReview,
//                                            EventBallotOption.created_by_uuid
//                                            (Phase 87.5 PR-1 rekey — the creator scrub
//                                            + SET NULL FK both key on the UUID now)
//   - user.user_id  (Auth0 sub string)   -> MagicToken, SingleUseToken,
//                                            both JSONB scrubs
//
//   MIXED KEYSPACE (the scrub matches on BOTH keys — neither arm is dead code):
//   - Feedback.user_id -> historical rows are Auth0-sub-keyed (pre-87.5); NEW rows
//                         submitted while logged in are Users.id-UUID-keyed once Plan 11
//                         flips FeedbackForm.js to send self.id. The anonymize scrub's
//                         Op.or therefore matches sub OR uuid OR email so BOTH row shapes
//                         are anonymized on deletion (a sub-only match would leak every
//                         post-Plan-11 UUID-keyed feedback row of a deleted user).
//
// SURVIVING EXCEPTIONS (completeness-by-enumeration — these are INTENTIONALLY NOT
// touched, per SPEC out-of-scope):
//   - EventAuditLog.actor_user_id (Users.id UUID going forward — 87.5 write-forward,
//     Req 9; column type stays STRING but records the caller's UUID, no backfill as
//     the table was empty in prod) — deliberately NO FK so audit rows survive account
//     deletion; legitimate-interest audit trail, SPEC-accepted exception. This column
//     is untouched by the deletion flow — only its keyspace description changed.
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
  GroupInvite,
  GameReview,
  UserGame,
  MagicToken,
  SingleUseToken,
  Feedback,
  EventBallotOption,
  GroupPromptSettings,
  PendingAuth0Deletion,
  sequelize,
} = require('../models');
const googleCalendarService = require('./googleCalendarService');
const auth0Service = require('./auth0Service');
const emailService = require('./emailService');

// Default external-lane budgets (D-03 / T-87.2-14). Every external call is bounded so
// deleteAccount's worst-case wall-clock stays under the FE BFF proxy's 30s abort
// (periodictabletop .../api/[...path]/route.ts PROXY_TIMEOUT_MS=30000). Worst case is
// ~googleMs + auth0Ms + emailMs ≈ 20s. Overridable ONLY for deterministic fast tests
// (see the slow-externals case); production callers use these defaults.
const DEFAULT_BUDGETS = { googleMs: 10000, auth0Ms: 5000, emailMs: 5000 };

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
 * LOCKING (T-87.2-11): when called with a transaction, every read takes row locks that
 * are held for the REMAINDER of that transaction:
 *   - the owner's UserGroup rows (FOR UPDATE via Sequelize lock),
 *   - each owned group's parent Groups row (raw SELECT ... FOR UPDATE) — this is what
 *     blocks a concurrent join-by-token: its UserGroup INSERT must take FOR KEY SHARE
 *     on the referenced Groups row for the FK check, which conflicts with our
 *     FOR UPDATE, so the join waits until the deletion transaction decides,
 *   - each owned group's membership rows (raw SELECT ... FOR UPDATE), from which both
 *     counts are derived, so concurrent updates to existing membership rows serialize
 *     behind this transaction too.
 * Without a transaction (the pre-flight GET) all reads are plain lock-free SELECTs.
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
    // In-txn: hold FOR UPDATE on the owner's own membership rows (see LOCKING above).
    ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}),
  });

  // In-txn: lock every owned group's parent Groups row FOR UPDATE. A concurrent
  // join-by-token INSERT needs FOR KEY SHARE on that row for its FK check, which
  // conflicts with FOR UPDATE — the join blocks until this transaction decides.
  // If the deletion commits (sole-member group destroyed) the join then fails its
  // FK check; if it rolls back (blocked) the join proceeds normally.
  if (transaction && ownedRows.length > 0) {
    await sequelize.query(
      'SELECT id FROM "Groups" WHERE id IN (:groupIds) FOR UPDATE',
      {
        replacements: { groupIds: ownedRows.map((r) => r.group_id) },
        type: sequelize.QueryTypes.SELECT,
        transaction,
      }
    );
  }

  const blockers = [];
  for (const row of ownedRows) {
    const groupId = row.group_id;
    // Other-members predicate: ANY UserGroup row (any status) that is not the owner's.
    let otherCount;
    let memberCount = null;
    if (transaction) {
      // In-txn: lock the group's ENTIRE membership row set FOR UPDATE and derive
      // both counts from the one locked read, so the rows the decision was based
      // on cannot be mutated by another transaction until this one decides.
      // (FOR UPDATE cannot ride an aggregate, hence rows-then-count.)
      const memberRows = await sequelize.query(
        'SELECT user_uuid FROM "UserGroups" WHERE group_id = :groupId FOR UPDATE',
        {
          replacements: { groupId },
          type: sequelize.QueryTypes.SELECT,
          transaction,
        }
      );
      otherCount = memberRows.filter((m) => m.user_uuid !== userUuid).length;
      // memberCount = TOTAL rows (incl. the owner) — the value the FE displays.
      memberCount = memberRows.length;
    } else {
      otherCount = await UserGroup.count({
        where: { group_id: groupId, user_uuid: { [Op.ne]: userUuid } },
      });
    }
    if (otherCount >= 1) {
      if (memberCount === null) {
        // memberCount = TOTAL rows (incl. the owner) — the value the FE displays.
        memberCount = await UserGroup.count({
          where: { group_id: groupId },
        });
      }
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

  // M-2 (87.4-review): capture the deleting user's group_ids UP FRONT — before Step 1
  // can auto-delete sole-member owned groups (which destroys their UserGroup rows) and
  // before the User.destroy CASCADE (Step 7) removes the rest. The 5c GroupPromptSettings
  // scrub is scoped to these group_ids so it takes a FOR UPDATE lock ONLY on this user's
  // groups' settings rows, never every settings row app-wide (which would stall all
  // schedule edits site-wide for the deletion txn). A UUID can only legitimately appear
  // in a group's schedule selected_member_ids if the user is (was) a member of that group.
  const userGroupRows = await UserGroup.findAll({
    where: { user_uuid: uuid },
    attributes: ['group_id'],
    transaction: t,
  });
  const userGroupIds = [...new Set(userGroupRows.map((r) => r.group_id))];

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
      // GroupInvite.group_id has NO FK — without this, pending invites for the
      // auto-deleted group would survive as orphans carrying invitee email PII.
      await GroupInvite.destroy({ where: { group_id: groupId }, transaction: t });
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
  //    Phase 87.5 (MIXED keyspace): Feedback.user_id holds the Auth0 sub on historical
  //    rows but the Users.id UUID on rows submitted logged-in after Plan 11 flips
  //    FeedbackForm.js to send self.id. Match sub OR uuid OR email so a deleted user's
  //    post-Plan-11 feedback is anonymized too — a sub-only predicate would leave those
  //    UUID-keyed rows un-scrubbed. Both id arms are intentional (see keyspace block).
  await Feedback.update(
    { user_id: null, user_email: null },
    { where: { [Op.or]: [{ user_id: sub }, { user_id: uuid }, { user_email: email }] }, transaction: t }
  );

  // 4. EventBallotOption.created_by_uuid -> NULL (Users.id UUID; Phase 87.5 PR-1 rekey).
  //    Keep the explicit update for clarity — the new SET NULL FK is the safety net; both
  //    fire on User.destroy. NULL-creator rows (incl. legacy) stay NULL (owner/admin-only).
  await EventBallotOption.update(
    { created_by_uuid: null },
    { where: { created_by_uuid: uuid }, transaction: t }
  );

  // 5. JSONB SCRUBS.
  //    5a. participant_user_ids (raw query, jsonb `-` operator; atomic, no
  //        read-modify-write race): remove the deleting user's element AND recompute the
  //        denormalized derived columns in the SAME UPDATE (Pitfall 6) so a now-below-
  //        minimum slot cannot keep ranking as viable:
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
  //        KEYSPACE (Phase 87.4 Plan 03 / D-05, Pitfall 7): participant_user_ids stores
  //        Users.id UUIDs at steady state (writer + all readers flipped). But during the
  //        PR-1 expand/contract deploy window a suggestion row can still hold the deleting
  //        user's Auth0 SUB (a residue row written by an old bundle, not yet re-swept by
  //        Plan 11's migration). M-1 (87.4-review): chain BOTH shapes (`- :uuid - :sub`)
  //        and widen the guard to `(? :uuid OR ? :sub)` so a deploy-window sub residue is
  //        also scrubbed and its count/score recomputed — jsonb `-` is a no-op when the
  //        key is absent, so removing the sub from a pure-UUID row (or vice-versa) is
  //        harmless. The recompute formula is keyspace-agnostic (count-based) and unchanged.
  await sequelize.query(
    `UPDATE "AvailabilitySuggestions" AS s
        SET participant_user_ids = s.participant_user_ids - :uuid - :sub,
            participant_count = jsonb_array_length(s.participant_user_ids - :uuid - :sub),
            meets_minimum = (jsonb_array_length(s.participant_user_ids - :uuid - :sub) >= COALESCE(g.min_players, 2)),
            score = (jsonb_array_length(s.participant_user_ids - :uuid - :sub) * 1.0 + s.preferred_count * 0.5)
       FROM "AvailabilityPrompts" AS ap
       LEFT JOIN "Games" AS g ON g.id = ap.game_id
      WHERE ap.id = s.prompt_id
        AND (s.participant_user_ids ? :uuid OR s.participant_user_ids ? :sub)`,
    { replacements: { uuid, sub }, transaction: t }
  );
  //    5b. tentative_calendar_event_ids: remove the sub key (the gcal hold VALUE was
  //        already read + deleted pre-txn in Step 2 of deleteAccount). STAYS sub-keyed
  //        (out of scope, Anti-Pattern A1) — this map pairs with the still-sub-keyed
  //        Google Calendar hold ids, so it is deliberately NOT re-keyed to the UUID.
  await sequelize.query(
    `UPDATE "AvailabilitySuggestions"
        SET tentative_calendar_event_ids = tentative_calendar_event_ids - :sub
      WHERE tentative_calendar_event_ids ? :sub`,
    { replacements: { sub }, transaction: t }
  );
  //    5c. selected_member_ids scrub (Phase 87.4 Plan 06 / D-09 debt fold-in). The
  //        deleting user's UUID can appear in the nested
  //        GroupPromptSettings.template_config.schedules[].selected_member_ids arrays
  //        (backfilled to Users.id UUIDs by Plan 04). GroupPromptSettings survives the
  //        deletion (created_by_user_id is SET NULL, not CASCADE), so without an explicit
  //        scrub the deleted user's UUID lingers in these arrays (T-874-06-D09,
  //        privacy/integrity). This is a NESTED-JSONB array-of-objects mutation, so it is
  //        an app-level read-modify-write (raw nested-path SQL rejected as brittle — same
  //        shape as the Plan 04 backfill), NOT a top-level jsonb `-` operator.
  //        RACE (T-874-06-RACE, Pitfall / T8): the same GroupPromptSettings rows are
  //        read-modify-written by the schedule PATCH/POST handlers
  //        (routes/groupPromptSettings.js:305-338) under a FOR UPDATE row lock. The scrub
  //        therefore runs INSIDE the deletion transaction `t` and takes the SAME row-level
  //        lock (lock: t.LOCK.UPDATE) on the settings rows, holding it across read->write
  //        for the remainder of the transaction. A concurrent schedule edit blocks behind
  //        this lock and cannot commit a re-added UUID between the scrub's read and write.
  //        M-2 (87.4-review): scope the lock to the deleting user's groups (captured
  //        up front) — an unscoped findAll FOR UPDATE would lock EVERY GroupPromptSettings
  //        row app-wide for the rest of the deletion txn, stalling all schedule edits
  //        site-wide. An empty group set skips the query entirely.
  const promptSettingsRows = userGroupIds.length === 0
    ? []
    : await GroupPromptSettings.findAll({
        where: { group_id: { [Op.in]: userGroupIds } },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
  for (const settings of promptSettingsRows) {
    const schedules = settings.template_config && settings.template_config.schedules;
    if (!Array.isArray(schedules)) continue;
    let changed = false;
    const updatedSchedules = schedules.map((s) => {
      if (!s || !Array.isArray(s.selected_member_ids)) return s;
      // M-1 belt-and-braces (87.4-review): scrub BOTH shapes. Steady state stores the
      // UUID (Plan 04 backfill), but a deploy-window residue could hold the sub. A stale
      // tab can also PATCH either shape back post-scrub — this is hardening, not the
      // closure point (Plan 11's re-sweep + normalization is authoritative).
      if (!s.selected_member_ids.includes(uuid) && !s.selected_member_ids.includes(sub)) return s;
      changed = true;
      return {
        ...s,
        selected_member_ids: s.selected_member_ids.filter((id) => id !== uuid && id !== sub),
      };
    });
    if (changed) {
      await settings.update(
        { template_config: { ...settings.template_config, schedules: updatedSchedules } },
        { transaction: t }
      );
    }
  }

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

/**
 * Race a promise against a timeout so a single hung external call cannot stall the
 * request. The timer is unref'd + cleared so it never keeps the event loop alive.
 * @param {Promise<any>} promise
 * @param {number} ms - budget in milliseconds
 * @param {string} label - for the timeout error message
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Step 2 — best-effort Google cleanup under ONE aggregate deadline (never throws).
 * Reads the user's RSVP calendar-event ids + tentative-hold ids BEFORE the DB txn
 * (Pitfall 2), deletes them, and revokes the OAuth grant. Each external call races the
 * REMAINING budget (a between-calls deadline check alone cannot bound a single hung
 * call — the googleapis client sets no timeout). Once the budget is spent, remaining
 * calendar deletes are SKIPPED and the skipped count is logged (best-effort remnants by
 * design, D-03). Skips entirely when the user has no Google tokens.
 *
 * @param {{ id: string, sub: string, accessToken: string|null, refreshToken: string|null }} captured
 * @param {number} budgetMs
 */
async function runGoogleCleanup(captured, budgetMs) {
  const { id, sub, accessToken, refreshToken } = captured;
  if (!accessToken && !refreshToken) return; // no grant to clean up

  const deadline = Date.now() + budgetMs;
  let currentAccessToken = accessToken;
  let skipped = 0;

  try {
    // a. RSVP calendar events on the user's own calendar (keyed by UUID).
    const participations = await EventParticipation.findAll({
      where: { user_id: id },
      attributes: ['id', 'google_calendar_event_id'],
    });
    for (const p of participations) {
      if (!p.google_calendar_event_id) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { skipped++; continue; }
      try {
        const res = await withTimeout(
          googleCalendarService.deleteCalendarEventForUser(
            p.google_calendar_event_id,
            currentAccessToken,
            refreshToken
          ),
          remaining,
          'gcal event delete'
        );
        // Adopt a refreshed access token for the rest of the batch (googleCalendarService
        // :292-298 idiom) so at most ONE refresh happens per deletion instead of N.
        if (res && res._new_access_token) currentAccessToken = res._new_access_token;
      } catch (err) {
        console.error('[accountDeletion] gcal event delete failed (non-fatal):', err.message);
      }
    }

    // b. Tentative holds — read the gcal ids stored under this sub across suggestions
    //    (parameterized jsonb `?` — safe + scalable), then batch-delete them.
    const remainingForHoldsRead = deadline - Date.now();
    if (remainingForHoldsRead > 0) {
      let holdIds = [];
      try {
        const rows = await sequelize.query(
          `SELECT tentative_calendar_event_ids AS map
             FROM "AvailabilitySuggestions"
            WHERE tentative_calendar_event_ids ? :sub`,
          { replacements: { sub }, type: sequelize.QueryTypes.SELECT }
        );
        holdIds = rows
          .map((r) => r && r.map && r.map[sub])
          .filter(Boolean);
      } catch (readErr) {
        console.error('[accountDeletion] tentative-hold read failed (non-fatal):', readErr.message);
      }
      if (holdIds.length > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          skipped += holdIds.length;
        } else {
          try {
            await withTimeout(
              googleCalendarService.deleteTentativeHolds(holdIds, currentAccessToken, refreshToken),
              remaining,
              'gcal tentative-hold delete'
            );
          } catch (err) {
            console.error('[accountDeletion] tentative-hold delete failed (non-fatal):', err.message);
          }
        }
      }
    }

    // c. Revoke the OAuth grant (prefer refresh token — kills the whole grant).
    const remainingForRevoke = deadline - Date.now();
    if (remainingForRevoke <= 0) {
      skipped++;
    } else {
      try {
        await withTimeout(
          googleCalendarService.revokeGoogleAccess(currentAccessToken, refreshToken),
          remainingForRevoke,
          'google revoke'
        );
      } catch (err) {
        console.error('[accountDeletion] google revoke failed (non-fatal):', err.message);
      }
    }
  } catch (err) {
    // Whole step is best-effort — never blocks the deletion (SPEC Req 4).
    console.error('[accountDeletion] Google cleanup step failed (non-fatal):', err.message);
  }

  if (skipped > 0) {
    console.warn(`[accountDeletion] Google cleanup skipped ${skipped} remnant call(s) past the ~${budgetMs}ms budget (best-effort).`);
  }
}

/**
 * The self-serve deletion pipeline (SPEC Req 1-8). Orchestrates, in the FIXED order,
 * capture -> Google cleanup -> DB transaction -> post-commit Auth0 delete -> notice
 * email. Every external lane is budgeted so the whole call resolves in <30s worst case
 * (target <20s) even when every external dependency hangs.
 *
 * @param {{ userId: string }} args - userId = req.user.user_id (the Auth0 sub; the ONLY
 *   trusted identity, never a param — SPEC Req 1).
 * @param {{ budgets?: { googleMs?: number, auth0Ms?: number, emailMs?: number } }} [overrides]
 *   Budget overrides for deterministic fast tests only; production uses DEFAULT_BUDGETS.
 * @returns {Promise<{ status: 'deleted' } | { status: 'not_found' } | { status: 'blocked', groups: Array }>}
 */
async function deleteAccount({ userId }, overrides = {}) {
  const sub = userId;
  const budgets = { ...DEFAULT_BUDGETS, ...(overrides.budgets || {}) };

  // Step 0 — load with PII (email) via the withContactInfo scope. The defaultScope
  // strips email/phone (models/User.js ~114); a plain findOne leaves user.email
  // undefined, silently breaking the REQ-8 notice email, the Feedback user_email
  // anonymize predicate, and the PendingAuth0Deletion.email marker. Capture the tokens
  // + email in memory NOW (Pitfall 2 — they are gone after User.destroy).
  const user = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
  if (!user) {
    return { status: 'not_found' }; // repeat-delete is 404/410, not an error (REQ-6c)
  }
  const captured = {
    id: user.id,
    sub: user.user_id,
    email: user.email,
    accessToken: user.google_calendar_token,
    refreshToken: user.google_calendar_refresh_token,
  };

  // Step 1 — fast-fail owner gate (UX-fast rejection; the authoritative check is the
  // in-txn re-run in Step 3).
  const blockers = await getDeletionBlockers(captured.id);
  if (blockers.length) {
    return { status: 'blocked', groups: blockers };
  }

  // Step 2 — Google cleanup (best-effort, aggregate budget, never throws).
  await runGoogleCleanup(captured, budgets.googleMs);

  // Step 3 — DB transaction (all-or-nothing). Its FIRST statement re-runs the owner gate
  // INSIDE the txn (T-87.2-11): up to ~10s of Google cleanup separates Step 1 from here,
  // and a member joining an owned group in that window would otherwise strand a populated
  // group with no owner. The re-check takes row locks held for the remainder of the
  // transaction (owner's UserGroup rows, each owned group's membership rows, and each
  // owned group's parent Groups row — all FOR UPDATE; see getDeletionBlockers LOCKING).
  // The Groups-row lock is what serializes a concurrent join-by-token: its INSERT's FK
  // check (FOR KEY SHARE on the Groups row) conflicts with our FOR UPDATE and blocks
  // until this transaction decides. A non-empty re-check rolls back and deletes nothing.
  const OWNER_RECHECK_SENTINEL = 'OWNER_GATE_RECHECK_BLOCKED';
  let txnOutcome;
  try {
    txnOutcome = await sequelize.transaction(async (t) => {
      const recheck = await getDeletionBlockers(captured.id, { transaction: t });
      if (recheck.length) {
        const abort = new Error(OWNER_RECHECK_SENTINEL);
        abort._blockedGroups = recheck;
        throw abort; // rollback — nothing deleted
      }
      await applyDispositions(user, t);
      return { committed: true };
    });
  } catch (err) {
    if (err && err.message === OWNER_RECHECK_SENTINEL) {
      // Blocked at the in-txn re-check: Step 2 already ran, so if the user had a
      // Google grant their RSVP calendar events were deleted and the OAuth grant
      // revoked — on an account that now SURVIVES. Surface it (google_access_revoked
      // is a pinned contract key the FE reads off the 409 envelope) so the user can
      // be told to reconnect Google Calendar. The pre-flight/Step-1 blocked path
      // never sets this key (nothing has run there).
      const googleAccessRevoked = !!(captured.accessToken || captured.refreshToken);
      if (googleAccessRevoked) {
        console.warn(
          `[accountDeletion] Owner-gate re-check blocked deletion for ${captured.sub} AFTER Google cleanup already ran — calendar events deleted and OAuth grant revoked on a surviving account.`
        );
      }
      return {
        status: 'blocked',
        groups: err._blockedGroups,
        ...(googleAccessRevoked ? { google_access_revoked: true } : {}),
      };
    }
    // Real DB failure: nothing was committed; surface a retryable (500-mappable) error.
    throw err;
  }

  // Step 4 — post-commit Auth0 delete: a SINGLE attempt (no in-request retries — the
  // durable queue + marker + sweep own all retrying, D-08). On success mark the marker
  // COMPLETED (never destroy it) — it is the tombstone that closes the ~24h
  // orphaned-token window; plan 87.2-05 owns its retention + purge. On the first failure
  // enqueue the durable job (lazy require) and leave the marker PENDING for the sweep.
  try {
    await withTimeout(auth0Service.deleteUser(captured.sub), budgets.auth0Ms, 'auth0 delete');
    try {
      const marker = await PendingAuth0Deletion.findOne({ where: { auth0_sub: captured.sub } });
      // Null the email at completion — same PII invariant the worker
      // (workers/auth0CleanupWorker.js) and sweep (pendingAuth0DeletionSweep.js)
      // honor: a completed tombstone must not retain the deleted user's email
      // for the ~24h retention window.
      if (marker) await marker.update({ completed_at: new Date(), email: null });
    } catch (markerErr) {
      // Marker bookkeeping is best-effort; the deletion already committed.
      console.error('[accountDeletion] Failed to mark Auth0 marker completed (non-fatal):', markerErr.message);
    }
  } catch (auth0Err) {
    console.error('[accountDeletion] In-request Auth0 delete failed; enqueuing durable retry:', auth0Err.message);
    try {
      // Lazy require (Pitfall 4) — never destructure the queue at module top.
      const { auth0CleanupQueue } = require('../queues');
      await auth0CleanupQueue.add(
        'cleanup',
        { sub: captured.sub }, // sub ONLY — no tokens ever enter Redis (T-87.2-12)
        { jobId: `auth0-cleanup-${captured.sub}` }
      );
    } catch (enqueueErr) {
      // Redis down at enqueue time must NOT fail the response — the committed marker +
      // sweep are the backstop.
      console.error('[accountDeletion] Failed to enqueue auth0 cleanup (non-fatal):', enqueueErr.message);
    }
  }

  // Step 5 — best-effort, time-boxed notice email (REQ-8). Failure OR timeout is logged
  // and NEVER alters the { status: 'deleted' } outcome.
  try {
    await withTimeout(
      emailService.send({
        to: captured.email,
        subject: 'Your Nextgamenight account has been deleted',
        emailType: 'account_deleted',
        html: `<p>Your Nextgamenight account and associated data have been deleted as requested.</p>
<p>If you did not request this, please contact us right away — but note the account can no longer be signed into.</p>
<p>Thanks for playing.<br/>— The Nextgamenight team</p>`,
        text: 'Your Nextgamenight account and associated data have been deleted as requested. If you did not request this, please contact us right away — but note the account can no longer be signed into. Thanks for playing. — The Nextgamenight team',
      }),
      budgets.emailMs,
      'notice email'
    );
  } catch (emailErr) {
    console.error('[accountDeletion] Notice email failed/timed out (non-fatal):', emailErr.message);
  }

  return { status: 'deleted' };
}

module.exports = {
  getDeletionBlockers,
  applyDispositions,
  deleteAccount,
};
