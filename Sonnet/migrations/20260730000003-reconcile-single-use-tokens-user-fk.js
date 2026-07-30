'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.4 Plan 08 — add the missing `single_use_tokens.user_id -> Users.user_id` foreign key
// (ON UPDATE CASCADE, ON DELETE CASCADE) to production. Closes census finding F-41 / pre-verified
// cross-check C-2 (88.4-DRIFT-CENSUS.md § 4.4) under owner decision D5a (2026-07-30).
//
// SCHEMA DUAL-WRITE (the rule this phase enforces). This migration is the PROD source: it runs
// under `migrate:apply` -> `npx sequelize-cli db:migrate` and is tracked in SequelizeMeta. The
// sync/CI source is the MODELS — models/index.js:211-212 declares the association with an EXPLICIT
// `onDelete: 'CASCADE'` and `sourceKey`/`targetKey: 'user_id'`; the column is
// models/SingleUseToken.js:32-50. The models have declared this FK all along and prod has NEVER had
// it: `20260618000002-create-single-use-tokens.js:49-53` declares `user_id` with no `references` at
// all. models/index.js:205-208 says so in as many words ("Prod has NO foreign key on this column").
// So the MIGRATION side is the one being fixed and no model edit accompanies this file. IF YOU
// CHANGE ONE SIDE, CHANGE THE OTHER. Phase 88.4 is the phase that finally ENFORCES that rule
// mechanically, via the `migrate-cli-replay` job.
//
// WHY ADD IT RATHER THAN DROP IT FROM THE MODELS. That alternative was put to the owner and
// declined: without the FK, production keeps accumulating token rows pointing at users who no
// longer exist. Those rows are unredeemable (every consumer resolves the user), so they are pure
// residue — and residue that carries an Auth0 subject identifier.
//
// ============================================================================================
// ORPHAN PRECLEAN — MEASURED, NOT ASSUMED, AND THE MIGRATION REFUSES RATHER THAN GUESSES.
//
// Unlike 20260730000002 (which converges an EXISTING constraint to a weaker action and therefore
// cannot fail on data), this migration ADDS a foreign key to a column that has never had one. On a
// populated production table, `ADD CONSTRAINT` FAILS OUTRIGHT on the first orphan row — a
// mid-deploy failure. The count must be MEASURED.
//
// Reproduce read-only, against any database (this is the query `up()` runs):
//   SELECT count(*) FROM single_use_tokens t
//    WHERE t.user_id IS NOT NULL
//      AND NOT EXISTS (SELECT 1 FROM "Users" u WHERE u.user_id = t.user_id);
//
// `up()` runs it BEFORE the ADD CONSTRAINT and logs the count either way, so the Railway pre-deploy
// log records what production actually contained.
//
// DECISION Phase 88.4 D5a: on a NON-ZERO count this migration ABORTS with the count and the two
// sanctioned remedies named, OVER silently nulling or silently deleting the rows.
//
// The owner's disposition sanctions "nulled or deleted, never assumed NOT NULL" but did NOT choose
// between them, and the choice is NOT a detail — it has a wrong answer:
//   * NULLING is actively harmful here. `user_id` is DELIBERATELY nullable (Phase 88.2 D-02,
//     models/SingleUseToken.js:32-50) so that `group_restore` rows can leave it NULL — they
//     identify a GROUP, not a user. Nulling an orphan therefore makes it INDISTINGUISHABLE from a
//     legitimate group-restore token. models/index.js:196-201 documents that exact hazard for the
//     SET NULL variant of this FK.
//   * DELETING is almost certainly right — an orphaned single-use token can never be legitimately
//     redeemed — but it is row destruction on production, and this plan's rule is that rows are
//     never silently deleted.
// So the count decides whether a decision is needed at all, and the owner makes it if it is. An
// abort here is a failed pre-deploy with a precise message, which is recoverable; a wrong silent
// preclean is not. If the measured count is 0 (the expected case — see below), this branch never
// fires and the migration applies cleanly.
//
// EXPECTED TO BE ZERO, from the code rather than from optimism — recorded so a non-zero count is
// read as the surprise it would be, not shrugged off. Both writers keep the column consistent:
//   - routes/googleAuth.js:95 inserts `user_id` only AFTER `User.findOrCreate` at :58-62 has
//     guaranteed the Users row exists.
//   - services/groupRecoveryService.js:345-352 inserts `user_id: null` explicitly (D-02).
// And two paths already delete tokens by user: services/accountDeletionService.js:286 (before the
// user, in the same transaction) and services/pendingAuth0DeletionSweep.js:187. The plausible source
// of an orphan is a historical hard delete that predates those sweeps.
// ============================================================================================
//
// ============================================================================================
// CONSUMER SWEEP — MANDATORY, because adding an FK changes DELETE SEMANTICS, not just validation,
// and that breakage lives in SERVICE CODE where the drift differ cannot see it. `grep -rn` for
// `SingleUseToken` / `single_use_tokens` across Sonnet/services/, Sonnet/workers/,
// Sonnet/schedulers/, Sonnet/queues/ and Sonnet/routes/, looking specifically for multi-step delete
// sequences and any `destroy()` on the PARENT row. Five call sites; each with its VERIFIED
// post-change behaviour:
//
//  1. services/pendingAuth0DeletionSweep.js:180-187 — THE PARENT-FIRST DELETE this plan names
//     explicitly. `ghost.destroy()` removes the Users row at :180, and only THEN
//     `SingleUseToken.destroy({ where: { user_id: sub } })` runs at :187.
//     VERIFIED BEHAVIOUR: this FK is ON DELETE **CASCADE**, so the Users delete cascades the token
//     rows away and the explicit delete at :187 becomes a harmless NO-OP. The sweep still succeeds.
//     Had the action been RESTRICT or NO ACTION, this ordering would FAIL — which is a concrete
//     reason the CASCADE the models already declare is the right action to enshrine, not merely the
//     convenient one.
//     The one real consequence is a comment that becomes false: :184-185 says these are "Sub-keyed
//     no-FK rows ... a bare User.destroy fires only the FK graph and would leave these". After this
//     migration that is no longer true of SingleUseToken. The comment is corrected in the SAME
//     commit as this migration — an unfixed consumer is the cross-repo failure mode the
//     consumer-sweep rule exists to prevent, and a comment that lies to the next reader counts.
//     The `destroy` call itself is deliberately LEFT IN PLACE: it is load-bearing on any database
//     that does not yet have this FK (i.e. before this migration lands), it is cheap, and
//     tests/routes/singleUseToken.test.js pins related behaviour.
//  2. services/accountDeletionService.js:286 — CHILD-FIRST: destroys tokens by `user_id` at :286,
//     inside the same transaction, and only destroys the user at :417. VERIFIED unaffected: the
//     explicit delete simply does the work slightly before the cascade would have.
//  3. services/groupPurgeSweep.js:316 — `SingleUseToken.destroy({ where: { group_id } })`. Keyed on
//     GROUP, not user; the ci.yml SPEC-REQ-10 gate requires this line to exist. VERIFIED
//     unaffected — this FK is on `user_id` and group_restore rows carry `user_id: NULL`.
//  4. services/groupRecoveryService.js:330/345/414/517/692 — update/create/read/consume. The only
//     INSERT (:345) sets `user_id: null` explicitly, and NULL is exempt from FK checking, so no
//     write path can be rejected by the new constraint. VERIFIED unaffected.
//  5. routes/googleAuth.js:95 — the other INSERT. `User.findOrCreate` at :58-62 runs first in the
//     same function, so the parent row is guaranteed present. VERIFIED unaffected.
//
// NOTHING BREAKS. Only the stale comment in (1) needed a change, and it ships alongside.
// ============================================================================================
//
// ============================================================================================
// LOCK COST. `ADD CONSTRAINT` on an FK takes ACCESS EXCLUSIVE on the child table and SCANS EVERY
// ROW to validate it, blocking reads and writes for the duration. The row counts that would justify
// a plain single-step add are a production fact this file cannot measure, so it does NOT ASSUME they
// are small — it takes the shape that is correct at ANY size:
//   STEP 1 (transactional): orphan measurement + `ADD CONSTRAINT ... NOT VALID`. No scan, so the
//           ACCESS EXCLUSIVE lock is held only for the catalog update.
//   STEP 2 (separate transaction): `VALIDATE CONSTRAINT`, under SHARE UPDATE EXCLUSIVE, which lets
//           concurrent reads AND WRITES proceed during the scan.
// `single_use_tokens` is a high-churn table (an oauth_state row per login attempt), so blocking its
// writes for a full scan is exactly the cost worth avoiding.
//
// DECISION Phase 88.4: STEP 2 IS DELIBERATELY OUTSIDE THE TRANSACTION — a considered deviation from
// this plan's "wrap up() in sequelize.transaction" rule, not an oversight. Keeping VALIDATE inside
// would hold STEP 1's ACCESS EXCLUSIVE lock until commit and discard the whole benefit of NOT
// VALID. The intermediate committed state is SAFE, which is what makes the split legitimate: a NOT
// VALID foreign key FULLY enforces referential integrity on every INSERT and UPDATE from creation;
// `NOT VALID` only means pre-existing rows were not re-checked — and STEP 1 just proved there are no
// violating pre-existing rows by measuring the orphan count as zero. So the worst case of a failure
// between the steps is a constraint marked unvalidated that is in fact valid; re-running `up()`
// completes it, and STEP 2 is idempotent (`convalidated` is probed first). Merging the steps back
// into one transaction is a decision, not a cleanup.
// ============================================================================================

const { QueryTypes } = require('sequelize');

const FK_NAME = 'single_use_tokens_user_id_fkey';

// Structural probe: does an equivalent FK already exist on (user_id -> Users) under ANY NAME?
// `ADD CONSTRAINT` has no `IF NOT EXISTS`, and a `conname`-only probe is the exact defect that
// produced census findings F-37/F-38/F-39 (root cause RC-2) — a name miss silently adds a SECOND
// redundant FK with no error. Never guard an ADD CONSTRAINT on a name alone in this repo.
const EQUIVALENT_FK_SQL = `
  SELECT c.conname, c.convalidated
    FROM pg_constraint c
    JOIN pg_attribute a
      ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.contype = 'f'
     AND c.conrelid  = to_regclass('single_use_tokens')
     AND c.confrelid = to_regclass('"Users"')
     AND array_length(c.conkey, 1) = 1
     AND a.attname = 'user_id'
`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // ---- STEP 1 (transactional): measure, then add NOT VALID.
    await sequelize.transaction(async (t) => {
      const existing = await sequelize.query(EQUIVALENT_FK_SQL, {
        type: QueryTypes.SELECT,
        transaction: t,
      });
      if (existing.length > 0) {
        console.log(
          `[88.4-reconcile] F-41: an equivalent FK on single_use_tokens.user_id -> Users already ` +
            `exists (${existing.map((r) => r.conname).join(', ')}); skipping the ADD.`
        );
        return;
      }

      // MEASURED ORPHAN COUNT — logged unconditionally, so the pre-deploy log records production's
      // actual state whether or not the count is zero.
      const [orphans] = await sequelize.query(
        `SELECT count(*)::int AS orphan_count
           FROM single_use_tokens t
          WHERE t.user_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "Users" u WHERE u.user_id = t.user_id)`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const orphanCount = orphans.orphan_count;
      console.log(`[88.4-reconcile] F-41: measured orphan count = ${orphanCount}.`);

      if (orphanCount > 0) {
        // Deliberately NOT auto-handled. See the ORPHAN PRECLEAN block in the header: the owner's
        // disposition sanctions nulling OR deleting and did not choose, and nulling is actively
        // harmful here (it would make an orphan indistinguishable from a legitimate group_restore
        // token). The transaction rolls back, so nothing is left half-done.
        throw new Error(
          `[88.4-reconcile] F-41 ABORTING: ${orphanCount} single_use_tokens row(s) reference a ` +
            `user_id with no matching Users.user_id, so ADD CONSTRAINT would fail. This is NOT ` +
            `auto-handled by design — the owner's D5a disposition sanctions nulling OR deleting ` +
            `the orphans and did not choose between them, and the two are NOT equivalent: NULLING ` +
            `makes an orphan indistinguishable from a legitimate group_restore token (Phase 88.2 ` +
            `D-02, models/SingleUseToken.js:32-50), while DELETING destroys rows on production. ` +
            `An orphaned single-use token is unredeemable, so DELETE is the likely answer — but it ` +
            `is the owner's call. Take the count above back to the owner, add the chosen preclean ` +
            `to this migration, and re-run. Nothing has been changed; this transaction rolled back.`
        );
      }

      // Actions match models/index.js:211-212 exactly. ON DELETE CASCADE is the EXPLICIT
      // declaration there (Phase 88.2 D-02), not an inferred default — see that marker for why
      // inference is unstable on this nullable column. ON UPDATE CASCADE matches what the sync side
      // emits for this FK (census F-41's sync def), so it is what converges the two sides. Note
      // this is the ONE new FK in the phase that intentionally carries ON UPDATE CASCADE rather
      // than NO ACTION: the 23 RC-1 findings converged the MODELS down to prod's NO ACTION, whereas
      // here prod has no FK at all and must be built to match the model as declared.
      await sequelize.query(
        `ALTER TABLE single_use_tokens
           ADD CONSTRAINT "${FK_NAME}"
           FOREIGN KEY (user_id) REFERENCES "Users"(user_id)
           ON UPDATE CASCADE ON DELETE CASCADE
           NOT VALID`,
        { transaction: t }
      );
      console.log(
        `[88.4-reconcile] F-41: added "${FK_NAME}" -> Users(user_id) ON UPDATE CASCADE ON DELETE ` +
          `CASCADE (NOT VALID; validated in step 2 under a weaker lock). group_restore rows keep ` +
          `user_id NULL and are unaffected — NULL is exempt from FK checking.`
      );
    });

    // ---- STEP 2 (separate transaction, deliberately — see the LOCK COST note in the header).
    const pending = await sequelize.query(`${EQUIVALENT_FK_SQL} AND NOT c.convalidated`, {
      type: QueryTypes.SELECT,
    });
    for (const row of pending) {
      await sequelize.query(
        `ALTER TABLE single_use_tokens VALIDATE CONSTRAINT "${row.conname}"`
      );
      console.log(`[88.4-reconcile] F-41: validated "${row.conname}".`);
    }
    if (pending.length === 0) {
      console.log('[88.4-reconcile] F-41: nothing to validate (already validated).');
    }
  },

  async down(queryInterface) {
    // A REAL down(): removes the FK, restoring prod's pre-88.4 state (no foreign key on this
    // column). Row data is untouched — dropping an FK never deletes rows.
    //
    // Pinned STRUCTURALLY rather than to FK_NAME, for the same reason the ADD is: a name is itself
    // a drift axis (D-04) and this repo has observed the same object under a differently-cased
    // alias (RC-2). Dropping only the exact name would silently leave an equivalent FK behind and
    // make down() a partial no-op.
    const sequelize = queryInterface.sequelize;
    const existing = await sequelize.query(EQUIVALENT_FK_SQL, { type: QueryTypes.SELECT });
    if (existing.length === 0) {
      console.log(
        '[88.4-reconcile] down: no equivalent FK on single_use_tokens.user_id -> Users; nothing ' +
          'to drop.'
      );
      return;
    }
    for (const row of existing) {
      await sequelize.query(
        `ALTER TABLE single_use_tokens DROP CONSTRAINT IF EXISTS "${row.conname}"`
      );
      console.log(`[88.4-reconcile] down: dropped "${row.conname}".`);
    }
  },
};
