// services/groupRecoveryService.js
//
// Phase 88.2 / SPEC-REQ-1, SPEC-REQ-2, D-03, D-04 — the DELETE half of the group
// recovery window. Plan 88.2-07 adds the restore half (`restoreGroupByToken`) to
// this same file, together with the module-level `paranoid: false` carve-out table.
//
// Deleting a group no longer destroys anything. `softDeleteGroup` stamps ONE
// timestamp across `Groups`, `UserGroups` and `Events`, writes the recovery
// deadline onto the `Groups` row, and mints the single-use restore token inside
// the same transaction — so a committed delete always has a recovery path and a
// rolled-back one leaves nothing behind.

const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  Group,
  User,
  UserGroup,
  Event,
  SingleUseToken,
  sequelize,
} = require('../models');

/**
 * How long a soft-deleted group is held before the purge sweep erases it.
 *
 * SPEC-REQ-2 is satisfied by a module constant rather than an env var because the
 * deadline is STAMPED onto the row (`Groups.purge_after`) at delete time and every
 * consumer reads the column. An env var would be strictly worse: changing it after
 * a deadline had already been emailed to members would silently move a date those
 * members were told in writing.
 */
const RECOVERY_WINDOW_DAYS = 30;

// DECISION Phase 88.2 MED-23: the restore token deliberately outlives the group's
// own deadline by two days, chosen OVER `expires_at = purgeAfter` (which satisfies
// the SPEC's "token expiry >= 30 days" to the letter while leaving zero margin).
//
// Plan 07's acceptance checks BOTH `expires_at <= now` (-> invalid_token) and
// `purge_after <= now` (-> window_expired) against the app-server clock, while the
// emailed calendar date was rendered in the RECIPIENT's timezone. With no margin a
// member acting inside the final advertised day can trip the token check first and
// be refused with the indistinguishable "this restore link is no longer valid"
// instead of the honest "your window closed". The margin makes `purge_after` ALWAYS
// the binding constraint, so the refusal reason is always the true one.
//
// Collapsing these back to equal makes the failure message wrong for anyone acting
// near the boundary. It grants no extra recovery time — plan 07 refuses on
// `purge_after` independently of the token's own expiry.
const TOKEN_EXPIRY_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Typed sentinel thrown when the in-lock liveness re-check finds the group already
 * soft-deleted — i.e. a second DELETE committed between this call's `isOwner` gate
 * and its lock acquisition. The transaction rolls back cleanly: nothing is stamped,
 * no second token is minted, and no second email fanout happens.
 *
 * The route maps it to the SAME 403 an ordinary repeat delete already produces at
 * the `isOwner` gate (AF-15), so the two paths are indistinguishable to the caller.
 */
class GroupAlreadyDeletedError extends Error {
  constructor(groupId) {
    super(`Group ${groupId} is already soft-deleted`);
    this.name = 'GroupAlreadyDeletedError';
    this.code = 'group_already_deleted';
    this.groupId = groupId;
  }
}

/**
 * Soft-delete a group: stamp it and its children with one timestamp, record the
 * recovery deadline, and mint the restore token.
 *
 * @param {string} groupId - Groups.id (UUID)
 * @param {Object} [options]
 * @param {string} [options.excludeUserUuid] - Users.id (UUID) of the deleting owner,
 *   dropped from `recipients` (SPEC-REQ-8 requires 0 emails to the deleter).
 * @returns {Promise<{deletedAt: Date, purgeAfter: Date, nonce: string,
 *   recipients: Array<{user_uuid: string, user_id: string, email: string,
 *   username: string, timezone: string}>}>}
 * @throws {GroupAlreadyDeletedError} if the group was already stamped by a racing delete.
 */
async function softDeleteGroup(groupId, { excludeUserUuid } = {}) {
  // DECISION Phase 88.2 D-03: the roster is read HERE, before the transaction, and
  // mapped to PLAIN OBJECTS rather than model instances — chosen OVER reading it
  // inside or after the delete transaction. Once `UserGroup` is stamped this exact
  // query is paranoid-filtered and returns ZERO rows, so a roster read placed after
  // the transaction dispatches zero emails and nothing fails (88.2-RESEARCH.md
  // Pitfall 5). Plain objects mean the dispatch path structurally cannot re-query
  // the now-hidden group. Moving this read below the transaction is not a
  // reordering — it silently deletes the notice this phase exists to send.
  //
  // DECISION Phase 88.2 MED-3: the role predicate below is CONSISTENCY HARDENING,
  // chosen OVER status-only filtering to match the in-repo "confirmed members"
  // precedent at routes/groups.js (the group-members read). It is NOT a security
  // fix and NOT a patched vulnerability. A claim that unapproved join-requesters
  // could be emailed the restore link was raised and REFUTED by all three skeptics
  // in 88.2-PLAN-REVIEW-RAW.json on verified grounds: no code path writes the
  // pending role (every membership creation site writes owner/member), the
  // role-change endpoint hard-validates the same three values, rejection destroys
  // the row outright, and the auto-promotion scheduler promotes any surviving
  // pending row to member within 24h. The pending workflow has been frozen since
  // Phase 36. Check that refutation before re-raising it as an escalation.
  //
  // The withContactInfo scope is MANDATORY, not decorative: User's defaultScope
  // strips `email` (BSEC-01), so without it every recipient carries an undefined
  // address and is silently skipped — the same trap workers/promptWorker.js
  // documents at its own member include.
  const memberships = await UserGroup.findAll({
    where: {
      group_id: groupId,
      status: 'active',
      role: { [Op.in]: ['member', 'admin', 'owner'] },
    },
    include: [{ model: User.scope('withContactInfo'), required: true }],
  });

  const recipients = memberships
    .filter((m) => m.user_uuid !== excludeUserUuid)
    .map((m) => ({
      user_uuid: m.user_uuid,
      // The Auth0 sub. REQUIRED and NOT redundant with user_uuid: the dispatcher's
      // Management API backfill (services/groupOwnershipOfferService.js) keys on the
      // sub, not on the Users.id UUID. Dropping this field fails SILENTLY —
      // getUserById(undefined) rejects, the backfill's catch degrades exactly as
      // designed, and every synthetic-address member lands in `unreachable` with
      // plausible-looking counters and no error. `user_uuid` is what excludeUserUuid
      // compares against; `user_id` is what the lookup needs. Both are load-bearing.
      user_id: m.User.user_id,
      email: m.User.email,
      username: m.User.username,
      timezone: m.User.timezone,
    }));

  // ONE timestamp for all three models. See the F-05 marker below.
  const deletedAt = new Date();
  const purgeAfter = new Date(deletedAt.getTime() + RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const tokenExpiresAt = new Date(purgeAfter.getTime() + TOKEN_EXPIRY_MARGIN_MS);
  // Same nonce idiom as the group invite token (routes/groups.js).
  const nonce = crypto.randomBytes(32).toString('hex');

  // DECISION Phase 88.2 F-05: every write below uses `Model.update` with the ONE
  // explicitly-computed JS Date above, chosen OVER the obvious
  // `Event.destroy()` / `UserGroup.destroy()` / `group.destroy()` trio.
  //
  // `Model.destroy` calls `Utils.now()` once per invocation, so three calls produce
  // three timestamps milliseconds apart. Postgres keeps millisecond precision, and
  // plan 07's restore matches child rows on `deletedAt === stamp` precisely so it
  // does NOT resurrect rows that were already absent before the delete. Three
  // different stamps therefore match nothing and the restore silently brings back
  // an empty group. Converting this back to the destroy trio for tidiness breaks
  // restore with no test outside this phase going red.
  //
  // Three properties of this shape, each verified against Sequelize 6.37.7 and each
  // load-bearing: (1) `Model.update` applies `_paranoidClause`, so it stamps only
  // currently-live rows — already-stamped rows keep their original timestamp and are
  // correctly NOT resurrected; (2) `deletedAt` is a real rawAttribute once
  // `paranoid: true`, so it survives the `options.fields` intersection; (3) the
  // silent flag on each update suppresses the automatic `updatedAt` bump, so
  // SPEC-REQ-9's "row sets identical before and after" assertion is not tripped.
  //
  // Nothing here destroys anything. GameReview, GroupInvite and EventParticipation
  // rows stay physically present (SPEC-REQ-1 requires all six table counts
  // unchanged) and become unreachable because the group, its memberships and its
  // events are hidden — the readers gate on isActiveMember, which now denies via the
  // paranoid UserGroup choke point in services/authorizationService.js.
  await sequelize.transaction(async (t) => {
    // DECISION Phase 88.2 D-04: this row lock is the THIRD side of a guard plans 07
    // (restore) and 08 (purge) take on the same row, and all three must keep the
    // identical `SELECT id FROM "Groups" WHERE id = :id FOR UPDATE` form in the same
    // first-statement position. It serializes this delete against a concurrent
    // restore, a concurrent purge and a concurrent second delete, so exactly one of
    // them stamps, mints a token and fans out a roster.
    //
    // What it does NOT do, and this matters more than what it does: it does NOT
    // close the POST /groups/join-by-token race. The precedent at
    // services/accountDeletionService.js:100-107 says the lock makes a concurrent
    // join "wait until the deletion transaction decides" — that refuses the join
    // ONLY because account deletion DESTROYS the Groups row, so the waiting join
    // fails its FK check. A soft delete leaves the row in place, so the instant this
    // transaction commits the join's FOR KEY SHARE check re-evaluates against a row
    // that still exists, succeeds, and commits a LIVE membership on a hidden group.
    // The lock changes the timing, not the outcome. That race is closed by the
    // group-liveness gate on join-by-token (plan 04 Task 4), not here — do not
    // re-add a claim that this lock covers it.
    await sequelize.query('SELECT id FROM "Groups" WHERE id = :id FOR UPDATE', {
      replacements: { id: groupId },
      type: sequelize.QueryTypes.SELECT,
      transaction: t,
    });

    // In-lock liveness re-check. Group is paranoid, so an already-stamped row
    // resolves to null. Belt-and-braces rather than the primary guard: the paranoid
    // clause on the three updates below already prevents a double-stamp. What the
    // sentinel actually prevents is the SECOND token mint and the SECOND email
    // fanout, neither of which the paranoid clause touches.
    const stillLive = await Group.findByPk(groupId, { transaction: t });
    if (!stillLive) {
      throw new GroupAlreadyDeletedError(groupId);
    }

    await Event.update(
      { deletedAt },
      { where: { group_id: groupId }, transaction: t, silent: true }
    );

    await UserGroup.update(
      { deletedAt },
      { where: { group_id: groupId }, transaction: t, silent: true }
    );

    await Group.update(
      { deletedAt, purge_after: purgeAfter },
      { where: { id: groupId }, transaction: t, silent: true }
    );

    // MED #10 (owner decision): revoke every PRIOR restore token for this group
    // before minting the new one. delete -> restore -> delete-again is ordinary (an
    // owner deletes, a member reclaims the group, the new owner later deletes it).
    //
    // Without this, the first delete's token is left at 'used' with an expiry 32 days
    // out, and AF-9 deliberately removed the status predicate from BOTH plan 07's
    // preview and its step 1 so a consumed token can still be READ. A member
    // following the OLD email would then be shown a working recovery offer — token
    // found, not revoked, not expired, group deleted, deadline in the future — and
    // refused with 410 only after they accepted, with nothing pointing at the newer
    // link they also received.
    //
    // The predicate targets everything not already revoked, NOT just active rows:
    // the 'used' row is the whole case. `used_at` is preserved, so the audit trail
    // survives. This is the pattern models/SingleUseToken.js already documents —
    // 'revoked' means "sibling consumed, or superseded by a resend", and a re-delete
    // is a resend. It lands on the single_use_tokens_group_purpose_status index.
    //
    // It must be INSIDE this transaction and BEFORE the create: a rollback has to
    // take the revocation with it, or a failed second delete would leave the first
    // token dead and the group unrecoverable by anyone.
    await SingleUseToken.update(
      { status: 'revoked' },
      {
        where: {
          group_id: groupId,
          purpose: 'group_restore',
          status: { [Op.ne]: 'revoked' },
        },
        transaction: t,
      }
    );

    // Minted INSIDE the transaction, never after it. A token minted post-commit
    // leaves a window in which a group is deleted with no recovery path at all, and
    // a rolled-back transaction must take the token with it.
    await SingleUseToken.create(
      {
        nonce,
        purpose: 'group_restore',
        group_id: groupId,
        // D-02: NULL on purpose — an account deletion destroys tokens by user_id,
        // which would otherwise take the group's only recovery path with it.
        user_id: null,
        status: 'active',
        expires_at: tokenExpiresAt,
      },
      { transaction: t }
    );
  });

  return { deletedAt, purgeAfter, nonce, recipients };
}

module.exports = {
  RECOVERY_WINDOW_DAYS,
  TOKEN_EXPIRY_MARGIN_MS,
  GroupAlreadyDeletedError,
  softDeleteGroup,
};
