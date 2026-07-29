// services/groupRecoveryService.js
//
// Phase 88.2 / SPEC-REQ-1, SPEC-REQ-2, SPEC-REQ-9, D-02, D-03, D-04 — BOTH halves
// of the group recovery window: `softDeleteGroup` (the DELETE half) and
// `restoreGroupByToken` (the restore half), plus the module-level carve-out table
// below.
//
// Deleting a group no longer destroys anything. `softDeleteGroup` stamps ONE
// timestamp across `Groups`, `UserGroups` and `Events`, writes the recovery
// deadline onto the `Groups` row, and mints the single-use restore token inside
// the same transaction — so a committed delete always has a recovery path and a
// rolled-back one leaves nothing behind.
//
// =====================================================================
// THE paranoid:false CARVE-OUT TABLE — a CLOSED set of NINE entries
// =====================================================================
//
// Note on spelling: every reference in THIS comment block writes the flag as
// `paranoid:false` (no space) on purpose. The acceptance criteria for this file
// COUNT the spaced literal, and a header that spells it out a dozen times inflates
// the count it is meant to describe. The exact spaced literal is reserved for real
// code. (The counting commands also filter comment lines, so both defences have to
// fail before the census drifts.)
//
// Once Group / UserGroup / Event went paranoid (D-01), the paranoid clause IS the
// central hide filter for a soft-deleted group. Escaping it is therefore a
// deliberate, enumerated act. These are the only nine sites in the application
// permitted to do it:
//
//   #  Site                                                    File
//   1  Restore-preview handler — Group read                    routes/groups.js
//   2  Accept-ownership — Group re-read inside the lock        this file
//   3  Accept-ownership — UserGroup membership verification    this file
//   4  Restore — purge_after nulling update                    this file
//   5  Restore — AF-3 duplicate-membership scan (TWO reads)    this file
//   6  Purge sweep — candidate Group.findAll                   services/groupPurgeSweep.js
//   7  Purge sweep — per-group re-read inside the lock         services/groupPurgeSweep.js
//   8  Purge sweep — event-id gather                           services/groupPurgeSweep.js
//   9  acceptInviteTransactional — membership lookup           routes/invites.js
//  10  Purge sweep — nightly NULL-purge_after orphan census    services/groupPurgeSweep.js
//
// Entry #5 is TWO literal occurrences (the stamped scan and the live scan), so the
// ten entries are ELEVEN literal occurrences across four files:
//
//   services/groupRecoveryService.js   5   (#2, #3, #4, #5 x2)
//   services/groupPurgeSweep.js        4   (#6, #7, #8, #10)
//   routes/groups.js                   1   (#1)
//   routes/invites.js                  1   (#9)
//   ------------------------------------------------------------------
//   total                             11
//
// WHY #10 IS DIFFERENT IN KIND: it is a COUNT, not a row read — `Group.count`
// over soft-deleted rows with a NULL purge_after (the orphans the sweep's
// candidate query can never select, RESEARCH F-02). It surfaces zero content and
// zero PII; it exists so those orphans are Sentry-visible instead of silent
// forever. Added by the L-4 fix (owner-approved 2026-07-27); an earlier revision
// of this table omitted it, which read as an instruction to delete the census.
//
// WHY #3 EXISTS AT ALL. The accepter's own membership row is itself soft-deleted,
// so `getUserRoleInGroup` / `isActiveMember` (services/authorizationService.js)
// return null — exactly the choke point D-01 uses to deny everyone else. The
// natural implementation of "verify the caller holds an active membership" will
// therefore deny the ONE person who is legitimately entitled to accept, 100% of the
// time. See the D-02 marker at the read itself.
//
// WHY #9 IS DIFFERENT IN KIND, and must be labelled as such: it is a WRITE-PATH
// INTEGRITY read, not a soft-deleted-content read. It exists so
// `acceptInviteTransactional` cannot create a second LIVE UserGroup row alongside a
// stamped one — the state that permanently aborts a restore (AF-3). It discloses
// nothing; it prevents a duplicate.
//
// NOT A CARVE-OUT — NEEDS NO FLAG: `Model.restore` (`Event.restore` /
// `UserGroup.restore`) inherently skips the paranoid clause (sequelize/lib/model.js
// :1848-1885) and passes `options.where` through verbatim to bulkUpdate. It is
// recorded here as a FOOTNOTE precisely so nobody re-adds it to the numbered list —
// an earlier revision of this table did exactly that, which is how a five-entry
// flagged set came to be described as six and made every derived count wrong.
//
// Every other read path in the application must NOT escape the paranoid clause. A
// TWELFTH literal occurrence is a bug, not an addition — but reconcile against the
// per-file breakdown above before concluding that, because this list has been wrong
// before (it once said "six" while the code it specified had ten, and later said
// "ten" after the L-4 census made it eleven). Waves land in order: at the end of
// plan 07 the tree holds 7 (#1-#5 = six occurrences, plus #9); plan 08 adds three
// more (#6-#8); the L-4 census (#10) landed in the post-review fix batch.

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
const { lockGroupRow } = require('../utils/groupRowLock');

// Lazy-load Sentry — same shape as services/schedulerHealthService.js. Safe if
// @sentry/node is missing or SENTRY_DSN is unset (both are true in the Jest env).
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[groupRecovery] Sentry not available:', err.message);
  }
}

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
  // ONE timestamp for all three models. See the F-05 marker below.
  const deletedAt = new Date();
  const purgeAfter = new Date(deletedAt.getTime() + RECOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const tokenExpiresAt = new Date(purgeAfter.getTime() + TOKEN_EXPIRY_MARGIN_MS);
  // Same nonce idiom as the group invite token (routes/groups.js).
  const nonce = crypto.randomBytes(32).toString('hex');

  // Populated inside the transaction — the roster read holds the row lock (L-1).
  let recipients;

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
    // (restore) and 08 (purge) take on the same row. All sides call the shared
    // utils/groupRowLock.js helper (WR-01 extraction) in the same first-statement
    // position — the one query lives in one place, so the sides cannot drift
    // apart textually. It serializes this delete against a concurrent
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
    await lockGroupRow(groupId, t);

    // In-lock liveness re-check. Group is paranoid, so an already-stamped row
    // resolves to null. Belt-and-braces rather than the primary guard: the paranoid
    // clause on the three updates below already prevents a double-stamp. What the
    // sentinel actually prevents is the SECOND token mint and the SECOND email
    // fanout, neither of which the paranoid clause touches.
    const stillLive = await Group.findByPk(groupId, { transaction: t });
    if (!stillLive) {
      throw new GroupAlreadyDeletedError(groupId);
    }

    // DECISION Phase 88.2 D-03 (amended by code-review L-1, owner-approved
    // 2026-07-27): the roster is read HERE — inside the transaction, after the
    // row lock, BEFORE the stamps — and mapped to PLAIN OBJECTS rather than
    // model instances. Chosen OVER two alternatives:
    //   (a) before the transaction (the original D-03 placement): a member
    //       joining or leaving in the read→lock gap gets the wrong disposition —
    //       stamped but unemailed, or emailed after leaving (L-1);
    //   (b) after the stamps: once `UserGroup` is stamped this exact query is
    //       paranoid-filtered and returns ZERO rows, so it dispatches zero
    //       emails and nothing fails (88.2-RESEARCH.md Pitfall 5). Moving this
    //       read below the stamps is not a reordering — it silently deletes the
    //       notice this phase exists to send.
    // Plain objects mean the dispatch path structurally cannot re-query the
    // now-hidden group.
    //
    // DECISION Phase 88.2 MED-3: the role predicate below is CONSISTENCY
    // HARDENING, chosen OVER status-only filtering to match the in-repo
    // "confirmed members" precedent at routes/groups.js (the group-members
    // read). It is NOT a security fix and NOT a patched vulnerability. A claim
    // that unapproved join-requesters could be emailed the restore link was
    // raised and REFUTED by all three skeptics in 88.2-PLAN-REVIEW-RAW.json on
    // verified grounds: no code path writes the pending role (every membership
    // creation site writes owner/member), the role-change endpoint
    // hard-validates the same three values, rejection destroys the row
    // outright, and the auto-promotion scheduler promotes any surviving pending
    // row to member within 24h. The pending workflow has been frozen since
    // Phase 36. Check that refutation before re-raising it as an escalation.
    //
    // The withContactInfo scope is MANDATORY, not decorative: User's
    // defaultScope strips `email` (BSEC-01), so without it every recipient
    // carries an undefined address and is silently skipped — the same trap
    // workers/promptWorker.js documents at its own member include.
    const memberships = await UserGroup.findAll({
      where: {
        group_id: groupId,
        status: 'active',
        role: { [Op.in]: ['member', 'admin', 'owner'] },
      },
      include: [{ model: User.scope('withContactInfo'), required: true }],
      transaction: t,
    });

    recipients = memberships
      .filter((m) => m.user_uuid !== excludeUserUuid)
      .map((m) => ({
        user_uuid: m.user_uuid,
        // The Auth0 sub. `user_uuid` is what excludeUserUuid compares against;
        // `user_id` is the Auth0-sub identity some downstream consumers key on.
        // (The dispatcher's Management API backfill that once made this field
        // load-bearing was removed by NIX-AUTH0, 2026-07-27 — see
        // services/groupOwnershipOfferService.js.)
        user_id: m.User.user_id,
        email: m.User.email,
        username: m.User.username,
        timezone: m.User.timezone,
      }));

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

/**
 * Restore a soft-deleted group from an emailed restore link (SPEC-REQ-9 / D-04).
 *
 * The token identifies the GROUP; the session identifies the PERSON. A forwarded or
 * leaked link is therefore worthless to anyone who does not already hold a
 * membership row stamped by this exact deletion.
 *
 * Returns RESULT CODES, never HTTP statuses — the route owns that mapping:
 *   { ok: true,  groupId, groupName }
 *   { ok: false, code: 'not_a_member' }
 *   { ok: false, code: 'invalid_token' }
 *   { ok: false, code: 'window_expired' }
 *   { ok: false, code: 'already_used' }
 *   { ok: false, code: 'already_restored', groupId, groupName }
 *
 * AF-9 / MED #20 — `already_restored` is the ONLY failure branch carrying the group
 * id and name, and it carries them deliberately: the route maps it to 409 and the
 * frontend redirects the caller into the now-live group with that id. A bare
 * `{ ok: false, code }` would leave the redirect silently dead while every test
 * still passed. The other failure codes stay bare on purpose — disclosing a group
 * name to a non-member or an expired-link holder is exactly what the
 * indistinguishable-failure discipline protects.
 *
 * @param {string} nonce - the `group_restore` token nonce from the emailed link.
 * @param {string} actorAuth0Sub - `req.user.user_id` (the Auth0 sub) of the accepter.
 * @returns {Promise<{ok: true, groupId: string, groupName: string} |
 *   {ok: false, code: string, groupId?: string, groupName?: string}>}
 */
async function restoreGroupByToken(nonce, actorAuth0Sub) {
  // Resolve the actor OUTSIDE the transaction — nothing below can proceed without a
  // Users row, and a missing one can never be a legitimate accepter (unlike
  // join-by-token, this path deliberately does not auto-provision).
  const actor = await User.findOne({ where: { user_id: actorAuth0Sub } });
  if (!actor) {
    return { ok: false, code: 'not_a_member' };
  }

  return sequelize.transaction(async (t) => {
    // --- 1. Load the token, WITHOUT a status predicate -----------------------
    //
    // AF-9: do NOT filter on `status: 'active'` here. Plan 06 mints ONE nonce and
    // fans the SAME link to every remaining member, so after the winner consumes it
    // the token is 'used' for everybody else. With an active-only predicate a
    // genuine concurrent loser finds nothing and gets `invalid_token` -> 410, and
    // the `already_restored` -> 409 branch below (plus the frontend's whole 409
    // state and its group_id redirect) becomes dead code in production. Letting a
    // consumed token through to step 3 is what makes that state reachable: the
    // in-lock re-read sees a live group and answers `already_restored` BEFORE the
    // consume in step 5 ever runs. A consumed token whose group is still
    // soft-deleted (winner consumed, then rolled back) still falls through to
    // step 5 -> null -> `already_used`, unchanged.
    const token = await SingleUseToken.findOne({
      where: { nonce, purpose: 'group_restore' },
      transaction: t,
    });
    if (!token || token.status === 'revoked') {
      return { ok: false, code: 'invalid_token' };
    }
    if (token.expires_at <= new Date()) {
      return { ok: false, code: 'window_expired' };
    }

    // --- 2. Take the lock ----------------------------------------------------
    //
    // DECISION Phase 88.2 D-04: the single-winner guard is a `SELECT ... FOR UPDATE`
    // on the GROUPS ROW, chosen OVER an application-level "is anyone else restoring"
    // flag. The database serializes this; the application cannot. It is the same
    // shared helper (utils/groupRowLock.js), in the same first-position-of-the-
    // transaction form, that `softDeleteGroup` above takes and that plan 08's
    // purge sweep MUST take.
    //
    // Two accepters racing is benign — the loser's re-read in step 3 sees a live
    // group and gets `already_restored`. An acceptance racing THE PURGE is not:
    // without the purge taking this same lock and re-checking inside it, an
    // acceptance can report success over data that is already half-deleted. That
    // makes this the single highest-consequence correctness requirement in the
    // phase. If the purge sweep's lock is ever removed, this one stops protecting
    // anything — the two sides are one guard, not two.
    //
    // Raw query (inside the shared helper) rather than `findByPk({ lock })`: it
    // is the house style (services/accountDeletionService.js), it is what D-04
    // cites, and it is not subject to the paranoid clause at all — which matters
    // here, because the row we need to lock is by definition already stamped.
    await lockGroupRow(token.group_id, t);

    // --- 3. Carve-out #2 — re-read the group INSIDE the lock -----------------
    //
    // Three DISJOINT branches, evaluated in this order. The order and the explicit
    // null guard on `purge_after` are both load-bearing (see the preview handler in
    // routes/groups.js, which pins the identical ordering for the identical reason).
    const group = await Group.findByPk(token.group_id, { paranoid: false, transaction: t });

    // (a) No row: the group was PURGED — its recovery window ran out and its data is
    //     gone. `window_expired` is the honest code; `already_restored` would tell
    //     the caller their group is back and hand the frontend a redirect into a
    //     group that no longer exists. This is precisely the race D-04 exists to
    //     make safe, so getting the code right here is the point.
    if (!group) {
      return { ok: false, code: 'window_expired' };
    }
    // (b) Live row: somebody already restored it (or won the concurrent race).
    if (group.deletedAt === null) {
      return { ok: false, code: 'already_restored', groupId: group.id, groupName: group.name };
    }
    // (c) Deadline gone. The `== null` arm is written explicitly rather than relying
    //     on `null <= new Date()` coercing to true: a soft-deleted group with a NULL
    //     purge_after is the uncollectable orphan RESEARCH F-02 describes and IS
    //     genuinely unrecoverable, so `window_expired` is the right answer — but
    //     leaning on coercion for it is how the preview's ordering bug happened one
    //     branch away. State the intent.
    if (group.purge_after == null || group.purge_after <= new Date()) {
      return { ok: false, code: 'window_expired' };
    }

    // THE stamp. Every match below uses this exact value — see the F-05 marker.
    const stamp = group.deletedAt;

    // --- 4. Carve-out #3 — verify membership ---------------------------------
    //
    // DECISION Phase 88.2 D-02: this read escapes the paranoid clause, chosen OVER
    // `isActiveMember` / `getUserRoleInGroup`. Those are paranoid-filtered BY DESIGN
    // — that filtering is the choke point D-01 relies on to deny every OTHER caller
    // — so using them here denies the legitimate accepter 100% of the time. The
    // additional `deletedAt: stamp` predicate is what preserves the authorization
    // property the normal helpers would have provided: a member removed BEFORE this
    // deletion carries an older stamp (or no row at all) and cannot claim the group.
    // Dropping that predicate turns this into "anyone who was ever a member".
    //
    // The `role` predicate mirrors the roster query in `softDeleteGroup` above and is
    // CONSISTENCY HARDENING, not a security fix (see that function's MED-3 marker for
    // the full reasoning and the skeptic refutation). Keeping the two queries
    // identical is the actual point: the set of people emailed the offer and the set
    // allowed to accept it must be the same set, or the phase promises a recovery
    // path to someone it will then refuse.
    const membership = await UserGroup.findOne({
      where: {
        user_uuid: actor.id,
        group_id: group.id,
        status: 'active',
        role: { [Op.in]: ['member', 'admin', 'owner'] },
        deletedAt: stamp,
      },
      paranoid: false,
      transaction: t,
    });
    if (!membership) {
      return { ok: false, code: 'not_a_member' };
    }

    // --- 5. Consume the token INSIDE this transaction ------------------------
    //
    // Consuming outside the transaction means a rollback burns the token permanently
    // and the group becomes unclaimable by anyone (RESEARCH F-12 / Pitfall 9). Plan
    // 02 added the `transaction` pass-through for exactly this call.
    const consumed = await SingleUseToken.consumeByNonce(nonce, { transaction: t });
    if (!consumed) {
      return { ok: false, code: 'already_used' };
    }

    // --- 6. Restore the children, matched on THIS deletion's stamp -----------
    //
    // DECISION Phase 88.2 F-05: children are matched on `deletedAt === stamp`, chosen
    // OVER restoring on `{ group_id }` alone. Restoring on group_id alone resurrects
    // rows that were ALREADY soft-deleted before this deletion — a member removed
    // last month reappears on the roster, and SPEC-REQ-9's "no row is resurrected
    // that was already absent before the delete" is silently violated. This only
    // works because `softDeleteGroup` stamps ONE explicitly-computed timestamp:
    // three `.destroy()` calls would give three millisecond-apart timestamps and this
    // match would find nothing at all.
    //
    // `Model.restore` passes `options.where` through verbatim to bulkUpdate and does
    // NOT apply the paranoid clause — which is exactly the primitive needed here, and
    // is why it is a footnote in the header's table rather than a numbered carve-out.
    await Event.restore({ where: { group_id: group.id, deletedAt: stamp }, transaction: t });

    // --- 6a. Carve-out #5 — the AF-3 duplicate-membership guard --------------
    //
    // DECISION Phase 88.2 AF-3: a stamped row whose (user_uuid, group_id) pair
    // ALREADY holds a live row is HARD-DELETED here, chosen OVER two alternatives:
    //   (a) letting the un-stamp violate the partial unique index
    //       `usergroups_user_uuid_group_id_uq` (WHERE "deletedAt" IS NULL) and abort
    //       the whole transaction. Because the token is consumed in-transaction the
    //       rollback un-burns it, so every retry fails IDENTICALLY and the group is
    //       unrecoverable until it is purged at day 30 while its members are actively
    //       trying to save it. That is the worst outcome this phase can produce.
    //   (b) skipping the stamped row instead of deleting it, which leaves it
    //       invisible forever and the restored roster permanently short by one.
    //
    // THIS IS A REAL, NAMED EXCEPTION TO SPEC-REQ-9. That requirement's acceptance is
    // "before-delete and after-acceptance row sets are IDENTICAL except the two role
    // changes". On this branch a row id disappears and a role may differ, so equality
    // does NOT hold. The exception is reachable ONLY when plan 04's AF-3 gate on the
    // invite-accept path has already failed — it is defence in depth, not the fix,
    // and its existence is not an argument for weakening that gate.
    //
    // The set is NOT restricted to bystanders — the ACCEPTER can be in it, and
    // frequently will be: the state is constructed by a post-delete invite acceptance
    // by whoever then follows the restore link. `membership` (step 4) is that same
    // stamped row, so it can be destroyed right here. That is why step 8's promote
    // keys on identity and never on `membership.id`.
    const stampedRows = await UserGroup.findAll({
      where: { group_id: group.id, deletedAt: stamp },
      paranoid: false,
      transaction: t,
    });
    const liveRows = await UserGroup.findAll({
      where: { group_id: group.id, deletedAt: null },
      paranoid: false,
      transaction: t,
    });
    const liveByUuid = new Map(liveRows.map((r) => [r.user_uuid, r]));
    const dupes = stampedRows.filter((r) => liveByUuid.has(r.user_uuid));

    if (dupes.length > 0) {
      // Reaching this branch means something upstream is already broken, so it must
      // be LOUD. The CONSOLE payload carries each discarded row's role and joined_at
      // because THIS BRANCH SILENTLY DEMOTES PEOPLE: the surviving live row was
      // created by a post-delete join, so it is role 'member' with a fresh
      // joined_at, while the stamped row being destroyed may have been 'admin' with
      // the group's original join date. Once the stamped row is gone nothing else
      // records that it happened — this server-side log line is the only repair
      // instruction an operator will have.
      //
      // Code-review M-4 (owner-approved 2026-07-27): Sentry gets group_id + count
      // ONLY — the per-user tuples (user_uuid, roles, join dates) stay in the
      // server-side console.warn. Same ids-only telemetry discipline the purge
      // sweep enforces (V7); the Sentry event is the pager, the log is the detail.
      //
      // Deliberately a straight drop-and-shout: no logic copies the higher role onto
      // the live row. A silent auto-repair here would mask the very leak this warning
      // exists to surface. Record the discarded values, alert, let a human decide.
      const discarded = dupes.map((d) => ({
        user_uuid: d.user_uuid,
        stamped_role: d.role,
        stamped_joined_at: d.joined_at,
        live_role: liveByUuid.get(d.user_uuid).role,
      }));
      console.warn(
        `[groupRecovery] AF-3 duplicate membership rows discarded during restore of group ${group.id}:`,
        JSON.stringify(discarded)
      );
      if (Sentry) {
        try {
          Sentry.withScope((scope) => {
            scope.setLevel('warning');
            scope.setTag('phase', '88.2');
            scope.setTag('guard', 'AF-3');
            scope.setContext('group_restore_duplicate_memberships', {
              group_id: group.id,
              discarded_count: dupes.length,
            });
            Sentry.captureMessage(
              `AF-3 gate leaked: ${dupes.length} duplicate UserGroup row(s) discarded restoring group ${group.id}`
            );
          });
        } catch (sentryErr) {
          console.error('[groupRecovery] Sentry capture failed:', sentryErr.message);
        }
      }

      const dupeIds = dupes.map((d) => d.id);
      // `force: true` FIRST, on the `.destroy(` line itself — the CI gate that
      // catches force-less destroys on the three paranoid models is LINE-SCOPED, so
      // wrapping this call reds the gate on correct code. Never loosen the gate to
      // accommodate formatting.
      await UserGroup.destroy({ force: true, where: { id: { [Op.in]: dupeIds } }, transaction: t });
    }

    await UserGroup.restore({ where: { group_id: group.id, deletedAt: stamp }, transaction: t });

    // --- 7. Restore the group itself and clear its deadline ------------------
    await Group.restore({ where: { id: group.id }, transaction: t });
    // Carve-out #4. `silent: true` keeps updatedAt untouched so SPEC-REQ-9's
    // before/after row-set equality assertion is not tripped by this write.
    await Group.update(
      { purge_after: null },
      { where: { id: group.id }, transaction: t, paranoid: false, silent: true }
    );

    // --- 8. Swap roles: DEMOTE first, then PROMOTE BY IDENTITY ----------------
    //
    // Demote-before-promote is deliberate and handles the case where the accepter IS
    // the prior owner (they still hold a restorable owner row and could follow a
    // forwarded link): demote-then-promote leaves them owner, whereas
    // promote-then-demote would leave the group with NO owner at all.
    await UserGroup.update(
      { role: 'member' },
      { where: { group_id: group.id, role: 'owner' }, transaction: t, silent: true }
    );

    // The promote is keyed on IDENTITY — (user_uuid, group_id) — and NEVER on
    // `membership.id`. This is a distinct bug from the ordering one above and it is
    // the one that actually loses the owner: `membership` is specifically the
    // accepter's STAMPED row, and step 6a can hard-delete exactly that row. A promote
    // keyed on `membership.id` would then match ZERO rows, `Model.update` would
    // return [0] and raise nothing, the transaction would COMMIT, the route would
    // answer 200 { success: true } — and the restored group would have no owner row
    // at all: nobody could delete it, transfer ownership, reset the invite token or
    // manage members, with no admin repair path. Keying on identity targets whichever
    // row now represents the actor (the surviving live row if 6a dropped the stamped
    // dupe, the just-restored stamped row if it did not), so the promote is correct
    // independent of which literal row id survived.
    const [promotedCount] = await UserGroup.update(
      { role: 'owner' },
      { where: { user_uuid: actor.id, group_id: group.id }, transaction: t, silent: true }
    );

    // A silent no-op must never reach the commit. Throwing rolls the whole restore
    // back — and because the token was consumed in THIS transaction (step 5) the
    // rollback un-burns it, so the accepter can simply retry rather than being left
    // with a restored, ownerless, unrepairable group.
    if (promotedCount !== 1) {
      throw new Error(
        `Group restore aborted: promote of user ${actor.id} in group ${group.id} affected ${promotedCount} rows, expected exactly 1`
      );
    }

    // --- 9. Revoke sibling restore tokens ------------------------------------
    // One nonce is shared by the whole roster, but a re-issue or an earlier delete
    // can leave other active rows pointing at this group. They must not survive a
    // completed restore.
    //
    // `status: 'active'` here is NOT the AF-9 anti-pattern the two LOOKUP queries
    // forbid — it is a write predicate, and it is the correct one: the token this
    // restore just consumed is already 'used', and flipping it to 'revoked' would
    // destroy the audit distinction between "consumed" and "superseded". Only
    // still-offerable siblings need revoking. (`softDeleteGroup`'s revocation uses
    // `[Op.ne]: 'revoked'` instead, because there the 'used' row IS the case — see
    // its MED-10 comment.)
    await SingleUseToken.update(
      { status: 'revoked' },
      {
        where: {
          group_id: group.id,
          purpose: 'group_restore',
          status: 'active',
        },
        transaction: t,
        silent: true,
      }
    );

    return { ok: true, groupId: group.id, groupName: group.name };
  });
}

module.exports = {
  RECOVERY_WINDOW_DAYS,
  TOKEN_EXPIRY_MARGIN_MS,
  GroupAlreadyDeletedError,
  softDeleteGroup,
  restoreGroupByToken,
};
