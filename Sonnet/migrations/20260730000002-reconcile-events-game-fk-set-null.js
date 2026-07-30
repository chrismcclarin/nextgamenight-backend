'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.4 Plan 08 — converge `Events.game_id -> Games.id` from ON DELETE CASCADE to
// ON DELETE SET NULL on production. Closes census finding F-40
// (88.4-DRIFT-CENSUS.md § 4.4, root cause RC-4) under owner decision D4a (2026-07-30).
//
// THE HIGHEST-CONSEQUENCE FINDING IN THE DAY-ONE CENSUS, and the only one with real data
// consequences. In every migration-built database — PRODUCTION INCLUDED — deleting a Game
// DELETES EVERY EVENT THAT REFERENCED IT, destroying group play history. The models intend the
// opposite: null the pointer and KEEP the Event.
//
// SCHEMA DUAL-WRITE (the rule this phase enforces). This migration is the PROD source: it runs
// under `migrate:apply` -> `npx sequelize-cli db:migrate` and is tracked in SequelizeMeta. The
// sync/CI source is the MODELS — models/index.js:86-87 (`Game.hasMany(Event, { foreignKey:
// 'game_id' })`, no explicit onDelete) over models/Event.js:16-19 (`allowNull: true`), which makes
// `node_modules/sequelize/lib/associations/has-many.js:105` yield SET NULL. The models are already
// correct, so PROD is the side being fixed and no model edit accompanies this file. IF YOU CHANGE
// ONE SIDE, CHANGE THE OTHER. Phase 88.4 is the phase that finally ENFORCES that rule mechanically
// via the `migrate-cli-replay` job.
//
// HOW THE TWO SIDES DIVERGED (RC-4) — a model attribute changed and no migration followed:
//   1. The baseline migration faithfully captured `ON DELETE CASCADE` at :329, because at the
//      capture commit `git show a8570366^:Sonnet/models/Event.js:18` was `allowNull: false`, and
//      Sequelize derives a hasMany's ON DELETE from the child attribute's nullability
//      (`target.allowNull ? "SET NULL" : "CASCADE"`).
//   2. 20260227000002-make-event-game-id-nullable.js:18-21 then made the column nullable with
//      `changeColumn` — which alters NOT NULL and DOES NOT TOUCH THE FK'S ACTION.
//   3. models/Event.js:18 became `allowNull: true`, flipping Sequelize's derived action to
//      SET NULL — on the sync side only.
// This is the same class Phase 88.2's hand-run cascade audit caught once by hand. The gate now
// catches it by construction.
//
// ============================================================================================
// EXPOSURE TODAY: A LANDMINE, NOT AN ACTIVE FIRE — measured for the sign-off, and it changed the
// urgency without changing the decision.
//
//   - There is NO API route that deletes a Game: `grep -n 'router.delete' routes/games.js`
//     returns nothing.
//   - The ONLY `Game.destroy` in the codebase is `scripts/seed-sample-data.js:173`, a dev seed
//     script — and it deletes Events itself at :171 (`Event.destroy({ where: {}, force: true })`)
//     BEFORE touching Games, so the cascade never fires there and the ordering is unaffected by
//     this change either way.
//
// So the cascade is not firing in production today. The decision was made on FUTURE exposure: the
// day anyone adds an admin "delete this bad BGG import" affordance — an entirely plausible feature —
// that button silently destroys group play history for every group that ever scheduled the game,
// with no warning and no recovery. Fixing it now costs one migration. Fixing it afterwards costs
// data that cannot be recovered.
//
// The owner was offered both alternatives and DECLINED BOTH: (a) changing the MODELS to CASCADE,
// i.e. declaring "deleting a Game should delete its Events" as intended behaviour; (b) allowlisting
// the difference so the gate ignores it forever.
// ============================================================================================
//
// NO ORPHAN SCAN IS NEEDED, and this is a real argument rather than an omission. SET NULL is
// strictly WEAKER than CASCADE: both require every non-NULL `game_id` to reference a live Games
// row, so any row that satisfies the constraint being dropped already satisfies the one being
// added. There is no data state that can fail this ALTER. (Contrast 20260730000003, which ADDS a
// brand-new FK to a column that never had one and therefore MUST count orphans first.)
//
// The for-the-record BLAST-RADIUS measurement the sign-off asked for — how many Events currently
// reference each deletable Game, i.e. the magnitude of today's CASCADE behaviour — is a read-only
// prod query and is deliberately NOT run from inside a migration. Reproduce it read-only:
//   SELECT e.game_id, g.name, count(*) AS events_that_would_be_destroyed
//     FROM "Events" e JOIN "Games" g ON g.id = e.game_id
//    WHERE e.game_id IS NOT NULL
//    GROUP BY e.game_id, g.name
//    ORDER BY 3 DESC;
// It informs nothing about the safety of this migration (see the paragraph above); it records what
// the old behaviour was risking. The total is logged below from the pre-deploy connection so the
// Railway log carries it too.
//
// ============================================================================================
// LOCK COST, and why this uses the two-step NOT VALID form.
//
// Postgres cannot alter an FK's action in place — `ALTER TABLE ... ALTER CONSTRAINT` supports only
// deferrability — so DROP + ADD is unavoidable. A plain `ADD CONSTRAINT` holds ACCESS EXCLUSIVE on
// "Events" while it SCANS EVERY ROW to validate, blocking all reads and writes for the duration.
//
// The row counts that would justify a plain add are a production fact this file cannot measure, so
// it does NOT ASSUME they are small. It takes the shape that is correct at ANY size:
//   STEP 1 (transactional): DROP CONSTRAINT + ADD CONSTRAINT ... NOT VALID. No scan, so the
//           ACCESS EXCLUSIVE lock is held only for the catalog update — milliseconds regardless of
//           table size.
//   STEP 2 (separate transaction): VALIDATE CONSTRAINT, which takes only SHARE UPDATE EXCLUSIVE
//           and lets concurrent reads AND writes proceed while it scans.
//
// DECISION Phase 88.4: STEP 2 IS DELIBERATELY OUTSIDE THE TRANSACTION, which is a considered
// deviation from this plan's "wrap up() in sequelize.transaction" rule rather than an oversight.
// Keeping VALIDATE inside would hold STEP 1's ACCESS EXCLUSIVE lock until commit and throw away the
// entire benefit of NOT VALID — the two-step form would become a plain add with extra words. The
// intermediate committed state is SAFE, which is what makes the split legitimate: a NOT VALID
// foreign key still fully enforces referential integrity on every INSERT and UPDATE from the moment
// it is created; `NOT VALID` only means pre-existing rows have not been re-checked. And those rows
// were already checked, by the CASCADE constraint they satisfied a few statements earlier. So the
// worst case of a failure between the steps is an FK marked unvalidated that is in fact valid —
// re-running `up()` completes it, and STEP 2 is idempotent (`convalidated` is probed first).
// Merging the two steps back into one transaction is a decision, not a cleanup.
//
// CONSUMER SWEEP (mandatory for any FK change — an FK changes DELETE semantics, not just
// validation). `grep -rn` for Game deletion across Sonnet/services/, Sonnet/workers/,
// Sonnet/routes/, Sonnet/schedulers/ and Sonnet/queues/ yields exactly ONE hit, plus one in
// scripts/:
//   - scripts/seed-sample-data.js:173 `Game.destroy({ where: {} })` — CHILD-FIRST: :171 already
//     ran `Event.destroy({ where: {}, force: true })`, so by the time Games are deleted there are
//     no Events left to cascade OR to null. Verified unaffected in both directions.
//   - routes/games.js has NO `router.delete` at all, so no request path can reach this.
//   - routes/userGames.js:131 `userGame.destroy()` deletes a UserGame (an ownership row), NOT a
//     Game. Different table, no FK to Events. Unaffected.
// Explicitly checked by name, because this plan names it: services/pendingAuth0DeletionSweep.js
// :185-187 is a PARENT-FIRST delete, but its parent is a Users row, not a Game — it does not touch
// Games or Events.game_id and is unaffected by this FK. (It IS relevant to 20260730000003; the
// analysis lives there.)
// NOTHING BREAKS, so no code fix ships with this migration. Note the direction of the change makes
// a break structurally unlikely: SET NULL RELAXES delete ordering rather than restricting it — a
// parent delete that was legal under CASCADE stays legal, it just leaves the child behind. The
// sweep was still run rather than argued, because "structurally unlikely" is not "checked".

const { QueryTypes } = require('sequelize');

const FK_NAME = 'Events_game_id_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // ---- STEP 0: for-the-record blast-radius measurement (read-only). Logged so the Railway
    // ---- pre-deploy log records what production actually contained at the moment of the change.
    const [radius] = await sequelize.query(
      `SELECT count(*)::int                       AS events_with_a_game,
              count(DISTINCT e.game_id)::int      AS distinct_games_referenced
         FROM "Events" e
        WHERE e.game_id IS NOT NULL`,
      { type: QueryTypes.SELECT }
    );
    console.log(
      `[88.4-reconcile] F-40 blast radius of the OLD behaviour: ${radius.events_with_a_game} ` +
        `Event row(s) reference ${radius.distinct_games_referenced} distinct Game(s). Under the ` +
        `ON DELETE CASCADE being removed here, deleting those games would have DESTROYED those ` +
        `Events; after this migration their game_id is set to NULL and the Events survive.`
    );

    // ---- STEP 1 (transactional): swap the constraint. Atomic — a failure cannot leave "Events"
    // ---- without a foreign key.
    await sequelize.transaction(async (t) => {
      const before = await sequelize.query(
        `SELECT c.conname, c.confdeltype, c.confupdtype, c.convalidated
           FROM pg_constraint c
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND c.conrelid  = to_regclass('"Events"')
            AND c.confrelid = to_regclass('"Games"')
            AND array_length(c.conkey, 1) = 1
            AND a.attname = 'game_id'`,
        { type: QueryTypes.SELECT, transaction: t }
      );

      // Idempotent: `confdeltype = 'n'` is SET NULL (see the catalog legend in
      // scripts/ci/schema-drift-diff.js:55). Already converged => nothing to do.
      if (before.length > 0 && before.every((r) => r.confdeltype === 'n')) {
        console.log(
          `[88.4-reconcile] F-40: Events.game_id -> Games already ON DELETE SET NULL ` +
            `(${before.map((r) => r.conname).join(', ')}); skipping the swap.`
        );
        return;
      }
      if (before.length === 0) {
        // No FK at all on this column. Refuse to invent one: this migration's job is to change an
        // action, and a database in this state has a different problem that a silent ADD would mask.
        throw new Error(
          '[88.4-reconcile] F-40: no foreign key found on Events.game_id -> Games. Refusing to ' +
            'create one here — this migration converges an existing action from CASCADE to SET ' +
            'NULL, and a missing FK is a different (larger) problem that must be diagnosed, not ' +
            'papered over.'
        );
      }

      // Drop EVERY equivalent FK on this column, by name, whatever it is called. Pinned
      // structurally rather than to `FK_NAME` because a name is a drift axis in its own right
      // (D-04) and this repo has observed the same object under a lowercase alias (RC-2).
      for (const row of before) {
        await sequelize.query(
          `ALTER TABLE "Events" DROP CONSTRAINT IF EXISTS "${row.conname}"`,
          { transaction: t }
        );
        console.log(
          `[88.4-reconcile] F-40: dropped "${row.conname}" (ON DELETE ` +
            `${row.confdeltype === 'c' ? 'CASCADE' : row.confdeltype}).`
        );
      }

      // Re-add under the name the models emit, so both sides agree on the name too. ON UPDATE
      // CASCADE is PRESERVED deliberately: both sides already carry it (it is not part of this
      // finding), so changing it would manufacture new drift. `ADD CONSTRAINT` has no
      // `IF NOT EXISTS`, which is what the probe above is for.
      await sequelize.query(
        `ALTER TABLE "Events"
           ADD CONSTRAINT "${FK_NAME}"
           FOREIGN KEY (game_id) REFERENCES "Games"(id)
           ON UPDATE CASCADE ON DELETE SET NULL
           NOT VALID`,
        { transaction: t }
      );
      console.log(
        `[88.4-reconcile] F-40: added "${FK_NAME}" ON UPDATE CASCADE ON DELETE SET NULL (NOT ` +
          `VALID; validated in step 2 under a weaker lock). Play history now survives a Game delete.`
      );
    });

    // ---- STEP 2 (separate transaction, deliberately — see the LOCK COST note in the header):
    // ---- promote the constraint to validated under SHARE UPDATE EXCLUSIVE.
    const pending = await sequelize.query(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_attribute a
           ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f'
          AND c.conrelid  = to_regclass('"Events"')
          AND c.confrelid = to_regclass('"Games"')
          AND array_length(c.conkey, 1) = 1
          AND a.attname = 'game_id'
          AND NOT c.convalidated`,
      { type: QueryTypes.SELECT }
    );
    for (const row of pending) {
      await sequelize.query(`ALTER TABLE "Events" VALIDATE CONSTRAINT "${row.conname}"`);
      console.log(`[88.4-reconcile] F-40: validated "${row.conname}".`);
    }
    if (pending.length === 0) {
      console.log('[88.4-reconcile] F-40: nothing to validate (already validated).');
    }
  },

  async down(queryInterface) {
    // A REAL down(): restores ON DELETE CASCADE, the state prod was in before this migration.
    //
    // Read the warning, because this direction is the DANGEROUS one: running this makes deleting a
    // Game destroy every Event that referenced it again. It exists so the schema change is
    // reversible, not because reverting is advisable. Same two-step + probe shape as up().
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      const existing = await sequelize.query(
        `SELECT c.conname, c.confdeltype
           FROM pg_constraint c
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND c.conrelid  = to_regclass('"Events"')
            AND c.confrelid = to_regclass('"Games"')
            AND array_length(c.conkey, 1) = 1
            AND a.attname = 'game_id'`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length > 0 && existing.every((r) => r.confdeltype === 'c')) {
        console.log('[88.4-reconcile] down: Events.game_id already ON DELETE CASCADE; skipping.');
        return;
      }
      for (const row of existing) {
        await sequelize.query(
          `ALTER TABLE "Events" DROP CONSTRAINT IF EXISTS "${row.conname}"`,
          { transaction: t }
        );
      }
      await sequelize.query(
        `ALTER TABLE "Events"
           ADD CONSTRAINT "${FK_NAME}"
           FOREIGN KEY (game_id) REFERENCES "Games"(id)
           ON UPDATE CASCADE ON DELETE CASCADE
           NOT VALID`,
        { transaction: t }
      );
      console.log(
        `[88.4-reconcile] down: restored "${FK_NAME}" ON DELETE CASCADE. WARNING: deleting a Game ` +
          `now destroys every Event that referenced it.`
      );
    });

    const pending = await sequelize.query(
      `SELECT c.conname FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.conrelid = to_regclass('"Events"')
          AND c.confrelid = to_regclass('"Games"') AND array_length(c.conkey, 1) = 1
          AND a.attname = 'game_id' AND NOT c.convalidated`,
      { type: QueryTypes.SELECT }
    );
    for (const row of pending) {
      await sequelize.query(`ALTER TABLE "Events" VALIDATE CONSTRAINT "${row.conname}"`);
    }
  },
};
