// services/groupPurgeSweep.js
//
// Phase 88.2 / SPEC-REQ-10, D-04, D-05 — the daily purge sweep that permanently
// erases groups whose 30-day recovery window has closed.
//
// ONE PASS — DEADLINE PURGE: every `Groups` row carrying a non-NULL `purge_after`
// strictly in the past is destroyed, together with every row that hangs off it,
// inside a single per-group transaction. `purge_after` is stamped by
// `softDeleteGroup` (plan 06) and cleared by `restoreGroupByToken` (plan 07), so a
// group is a candidate here only if it was deliberately deleted and nobody claimed
// it back in time.
//
// THE NEVER-THROWS CONTRACT. Telemetry discipline mirrors
// services/pendingAuth0DeletionSweep.js: this function NEVER throws. The candidate
// selection and the whole loop sit inside an outer try/catch, and EVERY group is
// individually try/caught, so one bad row cannot starve the batch and the next
// nightly run retries it. The cron callback in server.js adds a third catch.
//
// BECAUSE IT NEVER THROWS, A STUCK GROUP IS INVISIBLE UNLESS WE MAKE IT LOUD. A
// bare `errors++` lets the same group fail every night forever while the sweep
// reports success. Per-group failures therefore go to Sentry AND to the
// `SchedulerRun` telemetry table, and the signal that matters is the SAME group id
// failing on CONSECUTIVE runs — that is a permanently-stuck purge still holding
// invitee email PII, not a transient. Per-group logs carry the group id ONLY: no
// group name, no member emails, no invitee emails (V7).
//
// DAILY, NOT HALF-HOURLY (D-05). The two shipped sweeps run every 30 minutes; this
// one runs once at 03:00 UTC. Purge timing is invisible to users — the group
// vanished at delete time — so a tighter cadence buys nothing and costs 48x the log
// noise and 48x the chances of colliding with a live restore acceptance.

const { Op } = require('sequelize');
const {
  Group,
  UserGroup,
  Event,
  EventParticipation,
  EventRsvp,
  EventBring,
  EventBallotOption,
  EventBallotVote,
  EventAuditLog,
  SentNotification,
  GameReview,
  GroupInvite,
  SingleUseToken,
  SchedulerRun,
  sequelize,
} = require('../models');
const { lockGroupRow } = require('../utils/groupRowLock');

// Lazy-load Sentry — same shape as services/schedulerHealthService.js and
// services/groupRecoveryService.js. Safe if @sentry/node is missing or SENTRY_DSN
// is unset (both are true in the Jest environment).
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[groupPurge] Sentry not available:', err.message);
  }
}

// DECISION Phase 88.2 MED-27: the sweep processes a BOUNDED batch per invocation,
// chosen OVER draining the entire backlog in one pass.
//
// Each candidate costs its own transaction holding a row-level write lock on the
// `Groups` row plus a dozen child deletes. Unbounded, a backlog — the scheduler down
// for a week, a bulk-stamping bug, or simply the first run after this ships — turns
// one 03:00 UTC invocation into an unbounded serial chain of locked write
// transactions contending with every in-flight `restoreGroupByToken` and
// `join-by-token` on the same rows.
//
// This is safe precisely because the sweep is idempotent and runs daily: the next
// run picks up the remainder, and the idempotency case in
// tests/services/groupPurgeSweep.test.js is what proves it. Ordering candidates
// oldest-deadline-first means nothing starves.
//
// RAISING this limit is safe. REMOVING it reintroduces the contention. And the
// saturation signal below is the only thing standing between "a bounded sweep" and
// "a bounded sweep that silently never finishes" — do not drop that either.
const PURGE_BATCH_LIMIT = 200;

/**
 * The job name this sweep's telemetry rows carry in `SchedulerRun`.
 *
 * NOT added to schedulerHealthService's SWEEP_JOBS: the zero-output anomaly
 * detector alerts when a historically-non-zero job goes silent, and a purge sweep
 * that purges nothing for weeks is the NORMAL, healthy state of a small install.
 * Degradation here is reported directly (below) rather than inferred from silence.
 */
const PURGE_JOB_NAME = 'group_purge';

/**
 * Record one run in `SchedulerRun`, the same table every registered scheduler
 * writes to.
 *
 * DECISION Phase 88.2-08: this writes the telemetry row DIRECTLY rather than
 * wrapping the sweep in `schedulerHealthService.recordRun`, chosen OVER routing
 * through that helper. `recordRun` populates its `error` column ONLY from an
 * exception the wrapped function throws, and it re-throws that exception. This
 * sweep's contract is that it never throws, so routing through it would mean
 * either (a) throwing a synthetic error purely to communicate a degradation —
 * which also zeroes the counts recordRun persists — or (b) never populating
 * `error` at all, which is the one field a stuck-purge investigation reads first.
 * The row SHAPE is kept identical to recordRun's so the two are directly
 * comparable; if that helper ever grows a non-throwing degradation channel, move
 * to it. Telemetry must never crash the sweep, hence the local try/catch.
 *
 * @param {Object} counters
 * @param {string[]} failedGroupIds
 * @param {number} durationMs
 */
async function recordPurgeRun(counters, failedGroupIds, durationMs) {
  const degraded = counters.errors > 0 || counters.batch_saturated;
  try {
    await SchedulerRun.create({
      job_name: PURGE_JOB_NAME,
      sent_count: counters.purged,
      skipped_count: counters.skipped_restored,
      // Group ids only — never a name, never an address (V7).
      error: degraded
        ? `group purge degraded: ${JSON.stringify({ ...counters, failed_group_ids: failedGroupIds })}`.slice(0, 4000)
        : null,
      duration_ms: durationMs,
      ran_at: new Date(),
    });
  } catch (persistErr) {
    console.error('[groupPurge] Failed to persist SchedulerRun row:', persistErr.message);
  }
}

/**
 * Report a degradation to Sentry. Best-effort and individually guarded — a
 * telemetry failure must never surface as a purge failure.
 *
 * @param {string} message
 * @param {Object} context - group ids and counters ONLY (V7).
 */
function reportToSentry(message, context) {
  if (!Sentry) return;
  try {
    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      scope.setTag('phase', '88.2');
      scope.setTag('scheduler_job', PURGE_JOB_NAME);
      scope.setContext('group_purge', context);
      Sentry.captureMessage(message);
    });
  } catch (sentryErr) {
    console.error('[groupPurge] Sentry capture failed:', sentryErr.message);
  }
}

/**
 * Purge one group and everything that hangs off it, inside one transaction.
 *
 * @param {string} groupId
 * @returns {Promise<'purged'|'skipped'>}
 */
async function purgeOneGroup(groupId) {
  return sequelize.transaction(async (t) => {
    // DECISION Phase 88.2 D-04: the FIRST statement of this transaction is the same
    // row-level `FOR UPDATE` lock on the `Groups` row that `softDeleteGroup` (plan
    // 06) and `restoreGroupByToken` (plan 07) take — the identical shared helper
    // (utils/groupRowLock.js, WR-01 extraction) in the identical first-statement
    // position. It is chosen OVER an
    // application-level "is anyone restoring this group" flag: the database can
    // serialize this, the application cannot.
    //
    // Two accepters racing each other is benign — the loser's in-lock re-read sees a
    // live group and is told the group is already restored. AN ACCEPTANCE RACING
    // THIS PURGE IS NOT. Without this lock and the re-check immediately below, an
    // acceptance can return success over a group this transaction is halfway through
    // destroying, leaving a member owning rows that are being deleted underneath
    // them. That makes the pair the single highest-consequence correctness
    // requirement in the phase.
    //
    // The two sides are ONE guard, not two: removing it from either side silently
    // disarms both. The matching marker lives in services/groupRecoveryService.js.
    await lockGroupRow(groupId, t);

    // Carve-out #7 — re-read INSIDE the lock. This is the half of D-04 that makes a
    // concurrent acceptance safe: between candidate selection and lock acquisition a
    // member may have restored the group (clearing deletedAt and nulling
    // purge_after), or another sweep worker may have purged it outright.
    const group = await Group.findByPk(groupId, { paranoid: false, transaction: t });
    if (!group) {
      // Already gone — somebody else purged it. Idempotent, not an error.
      return 'skipped';
    }
    if (group.deletedAt === null) {
      // Restored between selection and the lock.
      return 'skipped';
    }
    // Mirrors PASS 3's explicit non-NULL guard in
    // services/pendingAuth0DeletionSweep.js. SQL already makes `NULL < x` false, so
    // a NULL-deadline row can never be SELECTED as a candidate — but state it here
    // too. A soft-deleted group with a NULL purge_after means something went wrong
    // upstream (RESEARCH F-02's uncollectable orphan), and silently destroying it is
    // the worst possible response to that.
    if (group.purge_after == null || group.purge_after > new Date()) {
      return 'skipped';
    }

    // --- Children, deleted EXPLICITLY and in FK-safe order --------------------
    //
    // Nothing below relies on `ON DELETE CASCADE`. The authoritative, live,
    // per-environment disposition of every FK involved is recorded in
    // 88.2-CASCADE-AUDIT.md — consult that document, never a model file, a
    // migration's declaration or a code comment. All three have been wrong about
    // this schema, each in a different direction.
    //
    // The order reproduces the hard-delete sequence the app used before this phase
    // (routes/groups.js's pre-88.2 DELETE handler) and its in-transaction replica in
    // services/accountDeletionService.js, so a purge removes exactly what a delete
    // always removed.

    // Carve-out #8 — the event-id gather MUST escape the paranoid clause: these
    // event rows were stamped by the soft delete, so a default-scoped read returns
    // an empty list and every Event-scoped child below silently survives.
    const events = await Event.findAll({
      where: { group_id: groupId },
      attributes: ['id'],
      paranoid: false,
      transaction: t,
    });
    const eventIds = events.map((e) => e.id);

    if (eventIds.length > 0) {
      // EventBallotVote is keyed on `option_id`, NOT on event_id — models/
      // EventBallotVote.js has no event id column at all. It therefore has to be
      // gathered from the ballot OPTIONS and deleted BEFORE them: delete the options
      // first and the votes are stranded with no way left to find them.
      const ballotOptions = await EventBallotOption.findAll({
        where: { event_id: { [Op.in]: eventIds } },
        attributes: ['id'],
        transaction: t,
      });
      const optionIds = ballotOptions.map((o) => o.id);
      if (optionIds.length > 0) {
        await EventBallotVote.destroy({ where: { option_id: { [Op.in]: optionIds } }, transaction: t });
      }
      await EventBallotOption.destroy({ where: { event_id: { [Op.in]: eventIds } }, transaction: t });
      await EventParticipation.destroy({ where: { event_id: { [Op.in]: eventIds } }, transaction: t });
      await EventRsvp.destroy({ where: { event_id: { [Op.in]: eventIds } }, transaction: t });
      await EventBring.destroy({ where: { event_id: { [Op.in]: eventIds } }, transaction: t });
      // Carries recipient PHONE NUMBERS. Measured CASCADE from Events in every
      // environment; deleted here anyway for the same reason as its five siblings —
      // "the DDL says CASCADE" and "this database has CASCADE" are different claims,
      // and 88.2-CASCADE-AUDIT.md exists because they diverged.
      await SentNotification.destroy({ where: { event_id: { [Op.in]: eventIds } }, transaction: t });
    }

    // DECISION Phase 88.2-08: audit rows for this group are DESTROYED by the purge,
    // chosen OVER the Phase 61 / MAIL-05 retention intent recorded in
    // models/EventAuditLog.js ("we keep the orphan log") and re-stated in
    // services/accountDeletionService.js's SURVIVING EXCEPTIONS block. That intent
    // is scoped to a SINGLE-EVENT delete and to account deletion, where the log is
    // the only remaining answer to "where did my event go?" and the group still
    // exists to ask the question about. A purge is the terminal erasure of the whole
    // group at the end of an advertised recovery window: there is no group left to
    // support, and `event_snapshot` is a JSONB copy of the group's event data that
    // would otherwise outlive every other trace of it. Reinstating retention here is
    // a data-protection decision, not a cleanup.
    //
    // Keyed on `group_id`, NOT on the gathered event ids. The audit measured ZERO
    // foreign keys on this table in either environment, so nothing cascades it and an
    // FK-only audit cannot see it — and `routes/events.js` force-destroys single
    // events, so a row whose event was already hard-deleted has no surviving Events
    // row to be gathered from. Keying on the group collects those too; keying on
    // event ids would leave them as permanent orphans holding a group snapshot.
    await EventAuditLog.destroy({ where: { group_id: groupId }, transaction: t });

    await Event.destroy({ where: { group_id: groupId }, force: true, transaction: t });
    await GameReview.destroy({ where: { group_id: groupId }, transaction: t });

    // DECISION Phase 88.2 D-05: the two explicit deletes immediately below were
    // chosen OVER relying on `ON DELETE CASCADE`, and are correct independent of any
    // FK's cascade disposition.
    //
    // Invite rows carry INVITEE EMAIL PII, so a skipped delete is a data-protection
    // defect, not untidiness. The restore tokens are group-scoped and outlive the
    // deadline by design (plan 06's expiry margin), so they must be collected here
    // or they linger pointing at nothing.
    //
    // THE AUTHORITATIVE FK DISPOSITION FOR THIS DATABASE IS RECORDED IN
    // 88.2-CASCADE-AUDIT.md — consult it, not this comment. Note that the sync-built
    // test database has a CASCADE FK on every NOT NULL `group_id` (Sequelize's
    // `belongsTo` adds one), so REMOVING THESE TWO LINES LEAVES CI GREEN REGARDLESS:
    // the integration assertion cannot distinguish a correct purge from a database
    // cascading on its own. The CI grep gate named
    //   "Grep gate - purge sweep must delete GroupInvite + SingleUseToken explicitly"
    // is the real control. This file is grep-asserted to name each of those two
    // deletes exactly once, so do not repeat the call literals in prose here.
    //
    // Write NO claim about whether the invites table has an FK to `Groups`, in
    // either direction. A claim sourced from a code comment was wrong; a claim
    // sourced from a migration's declaration was ALSO wrong (that migration is
    // skip-if-exists, so declaring the FK never created it). Only a live
    // `pg_constraint` query settles it, and the environments measured disagree.
    await GroupInvite.destroy({ where: { group_id: groupId }, transaction: t });
    await SingleUseToken.destroy({ where: { group_id: groupId }, transaction: t });

    // DECISION Phase 88.2-08: AvailabilityPrompts, GroupPromptSettings and the
    // prompt-scoped chain (AvailabilityResponses / AvailabilitySuggestions /
    // MagicTokens) are LEFT TO THEIR CASCADE, chosen OVER extending this list to
    // cover them. That is the plan's Branch A boundary: 88.2-CASCADE-AUDIT.md § 6 is
    // derived from a MIGRATION-built database, so its conclusion is authoritative,
    // and the only tables it names as not-cascading are the invites table and the
    // audit log — both handled explicitly above.
    //
    // On the audit's one open question: `AvailabilitySuggestions -> Events` is SET
    // NULL, and the nulled column is `converted_to_event_id` (there is no `event_id`
    // on that model). Those rows do NOT survive attached to nothing, which is what
    // the carry-forward assumed — measured 2026-07-27 against both local databases,
    // `AvailabilitySuggestions -> AvailabilityPrompts` is CASCADE and
    // `AvailabilityPrompts -> Groups` is CASCADE in all three environments including
    // prod, so the whole prompt chain goes when the group row goes. The SET NULL is
    // transient.
    //
    // The residual, stated rather than hidden: that chain is protected by cascades
    // measured in two local databases and (for the prompt-to-group hop only) in
    // prod, whereas everything above is protected by an explicit statement. See
    // 88.2-08-SUMMARY.md, which recommends an owner for it.

    await UserGroup.destroy({ where: { group_id: groupId }, force: true, transaction: t });
    await Group.destroy({ where: { id: groupId }, force: true, transaction: t });

    return 'purged';
  });
}

/**
 * Run one purge sweep. Returns counters (used by tests + the completion log).
 * NEVER throws.
 *
 * @param {Object} [options]
 * @param {number} [options.limit] - batch size override. Defaults to
 *   PURGE_BATCH_LIMIT; tests inject a small value to exercise saturation without
 *   seeding hundreds of rows on the shared test Postgres.
 * @returns {Promise<{candidates: number, purged: number, skipped_restored: number,
 *   errors: number, batch_saturated: boolean}>}
 */
async function runGroupPurgeSweep(options = {}) {
  const startedAt = Date.now();
  const batchLimit = Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : PURGE_BATCH_LIMIT;

  const counters = {
    candidates: 0,
    purged: 0,
    skipped_restored: 0,
    errors: 0,
    batch_saturated: false,
  };
  const failedGroupIds = [];

  try {
    // Carve-out #6 — without escaping the paranoid clause this query cannot see a
    // soft-deleted group AT ALL and the sweep silently purges nothing, forever.
    const candidates = await Group.findAll({
      where: { purge_after: { [Op.ne]: null, [Op.lt]: new Date() } },
      attributes: ['id'],
      paranoid: false,
      order: [['purge_after', 'ASC']],
      limit: batchLimit,
    });

    counters.candidates = candidates.length;
    counters.batch_saturated = counters.candidates === batchLimit;

    for (const candidate of candidates) {
      const groupId = candidate.id;
      try {
        const outcome = await purgeOneGroup(groupId);
        if (outcome === 'purged') {
          counters.purged++;
        } else {
          counters.skipped_restored++;
        }
      } catch (groupErr) {
        counters.errors++;
        failedGroupIds.push(groupId);
        // Group id ONLY (V7).
        console.error(`[groupPurge] Purge failed for group ${groupId} (non-fatal):`, groupErr.message);
        reportToSentry(
          `Group purge failed for group ${groupId}`,
          { group_id: groupId, error: groupErr.message }
        );
      }
    }
  } catch (sweepErr) {
    console.error('[groupPurge] sweep failed (non-fatal):', sweepErr.message);
  }

  if (counters.batch_saturated) {
    // A persistent backlog otherwise looks exactly like a normal run, forever.
    console.warn(
      `[groupPurge] BATCH SATURATED: ${counters.candidates} candidates == the batch limit; a backlog remains for the next run.`
    );
    reportToSentry('Group purge sweep batch saturated', { ...counters, batch_limit: batchLimit });
  }

  await recordPurgeRun(counters, failedGroupIds, Date.now() - startedAt);

  // Conditional exactly as services/pendingAuth0DeletionSweep.js emits its own —
  // this is why the shipped sweeps are not log noise at every interval.
  if (counters.candidates > 0) {
    console.log('[groupPurge] Sweep completed:', JSON.stringify(counters));
  }

  return counters;
}

module.exports = { runGroupPurgeSweep };
