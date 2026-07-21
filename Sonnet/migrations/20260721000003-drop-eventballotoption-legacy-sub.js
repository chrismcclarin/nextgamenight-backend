'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.5 (BINT-02, BE PR-2 — D-01/D-04 contract) — DROP the retained legacy
// `EventBallotOptions.created_by` Auth0-string column. Contraction half of the
// expand-contract rekey begun in Plan 01
// (20260720000003-rekey-eventballotoption-created-by-uuid.js), which added the nullable
// `created_by_uuid` (ON DELETE SET NULL) alongside the retained `created_by` D-07
// rollback net. This removes the net once the PR-1 cutover is verified live.
//
// SET NULL / no-delete variant — DIFFERENT from the two availability contract-drops:
//   - RESIDUE RE-BACKFILL still runs (close the PR-1 deploy-window gap): resolve any row
//     written sub-keyed during the deploy window via a Users join.
//   - NO orphan DELETE: unlike the CASCADE availability tables, a NULL creator is a
//     LEGITIMATE, supported state (the 3 prod NULL-creator rows + any sub-orphan). Rows
//     that do not resolve are LEFT with created_by_uuid NULL, consistent with Plan 01's
//     no-delete rule.
//   - NO not-null tightening: `created_by_uuid` is nullable BY DESIGN and always will be
//     (the two availability contract-drops tighten their user_uuid; this one deliberately
//     does not).
//
// One guarded transaction — residue re-backfill FIRST, then DROP COLUMN last.
//
// D-09 — idempotent: describeTable guard, DROP COLUMN IF EXISTS.
const UUID_INDEX = 'event_ballot_options_created_by_uuid';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      const table = await queryInterface.describeTable('EventBallotOptions');

      // (1) RESIDUE RE-BACKFILL — close the PR-1 deploy-window gap. Rows whose created_by
      //     is NULL or matches no Users.id are LEFT NULL (SET NULL disposition, no delete).
      if (table.created_by) {
        const [, backfillMeta] = await sequelize.query(
          `UPDATE "EventBallotOptions" t SET created_by_uuid = u.id
             FROM "Users" u
            WHERE u.user_id = t.created_by
              AND t.created_by_uuid IS NULL`,
          { transaction: t }
        );
        console.log(
          `[EBO-DROP] residue re-backfill rows: ${backfillMeta ? backfillMeta.rowCount : 0}`
        );
      } else {
        console.log('[EBO-DROP] legacy created_by already absent — skipping residue backfill.');
      }

      // (2) NO orphan delete and NO not-null tightening — NULL-creator rows are a supported state.

      // (3) DROP the legacy column (destructive, last).
      await sequelize.query(
        `ALTER TABLE "EventBallotOptions" DROP COLUMN IF EXISTS "created_by"`,
        { transaction: t }
      );
      console.log('[EBO-DROP] legacy column created_by DROPPED.');

      // Defensive: ensure the new created_by_uuid index survives (Plan 01 created it; no-op if present).
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${UUID_INDEX}" ON "EventBallotOptions" (created_by_uuid)`,
        { transaction: t }
      );
    });
  },

  async down(queryInterface) {
    // Best-effort reverse: re-add the legacy column as nullable VARCHAR (SHAPE only, no
    // data). No not-null tightening to relax — created_by_uuid was always nullable.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "EventBallotOptions" ADD COLUMN IF NOT EXISTS "created_by" VARCHAR`
    );
  },
};
