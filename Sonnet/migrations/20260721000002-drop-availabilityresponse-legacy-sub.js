'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.5 (BINT-02, BE PR-2 — D-01/D-04 contract) — DROP the retained legacy
// `AvailabilityResponses.user_id` Auth0-string column. Contraction half of the
// expand-contract rekey begun in Plan 01
// (20260720000002-rekey-availabilityresponse-user-uuid.js), which added `user_uuid`
// alongside the retained `user_id` D-07 rollback net and rebuilt the uniqueness onto
// (prompt_id, user_uuid). This removes the net once the PR-1 cutover is verified live.
//
// Same shape as the UserAvailabilities contract-drop (residue re-backfill → orphan
// delete-and-log → SET NOT NULL → DROP COLUMN, one transaction), PLUS: drop the obsolete
// `(prompt_id, user_id)` unique index if it still exists (Plan 01's rekey replaced it with
// `(prompt_id, user_uuid)`; guarded IF EXISTS so it is a no-op on the sync-built replay
// schema where it never existed).
//
// See 20260721000001-drop-useravailability-legacy-sub.js for the full residue-backfill /
// SET NOT NULL rationale (identical CASCADE disposition).
//
// D-09 — idempotent: describeTable guards, guarded SET NOT NULL, DROP INDEX / DROP COLUMN IF EXISTS.
const OLD_UNIQUE_INDEX = 'availability_responses_prompt_user_unique';
const UUID_INDEX = 'availability_responses_user_uuid';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      const table = await queryInterface.describeTable('AvailabilityResponses');

      // (1) RESIDUE RE-BACKFILL — close the PR-1 deploy-window gap (see sibling header).
      if (table.user_id) {
        // (0) DEDUPE deploy-window duplicates BEFORE the re-backfill (WR-05).
        // Constraint this guards: during the PR-1 deploy window, old-bundle writes
        // land with user_uuid = NULL while the OLD (prompt_id, user_id) unique was
        // already dropped by 20260720000002 — and NULL user_uuid never collides on
        // the NEW (prompt_id, user_uuid) unique. So a deploy-window double-submit
        // can create two NULL-uuid rows for the same (prompt_id, user_id); the
        // re-backfill below would then set BOTH to the same UUID and violate the
        // (prompt_id, user_uuid) unique, rolling back the whole PR-2 transaction.
        // Keep only the newest row per (prompt_id, user_id) among NULL-uuid rows.
        // The id tiebreaker (UUID PK, orderable in Postgres) guarantees exactly one
        // survivor even when two duplicates share an identical updatedAt.
        const [, dedupeMeta] = await sequelize.query(
          `DELETE FROM "AvailabilityResponses" a
             USING "AvailabilityResponses" b
            WHERE a.user_uuid IS NULL AND b.user_uuid IS NULL
              AND a.prompt_id = b.prompt_id AND a.user_id = b.user_id
              AND (a."updatedAt" < b."updatedAt"
                   OR (a."updatedAt" = b."updatedAt" AND a.id < b.id))`,
          { transaction: t }
        );
        console.log(
          `[AR-DROP] deploy-window duplicate NULL-uuid rows deleted: ${dedupeMeta ? dedupeMeta.rowCount : 0}`
        );

        const [, backfillMeta] = await sequelize.query(
          `UPDATE "AvailabilityResponses" t SET user_uuid = u.id
             FROM "Users" u
            WHERE u.user_id = t.user_id
              AND t.user_uuid IS NULL`,
          { transaction: t }
        );
        console.log(
          `[AR-DROP] residue re-backfill rows: ${backfillMeta ? backfillMeta.rowCount : 0}`
        );

        // (2) ORPHAN DELETE-AND-LOG — CASCADE table.
        const orphans = await sequelize.query(
          `DELETE FROM "AvailabilityResponses" WHERE user_uuid IS NULL RETURNING id`,
          { type: QueryTypes.SELECT, transaction: t }
        );
        const deletedIds = Array.isArray(orphans) ? orphans.map((r) => r.id) : [];
        console.log(
          `[AR-DROP] residue orphans deleted: ${deletedIds.length}` +
            (deletedIds.length ? ` (ids: ${deletedIds.join(', ')})` : '')
        );
      } else {
        console.log('[AR-DROP] legacy user_id already absent — skipping residue backfill/orphan pass.');
      }

      // (3) DROP the obsolete (prompt_id, user_id) unique index if it survives (guarded).
      await sequelize.query(
        `DROP INDEX IF EXISTS "${OLD_UNIQUE_INDEX}"`,
        { transaction: t }
      );

      // (4) SET NOT NULL on user_uuid (residual-NULL guarded).
      const [{ n }] = await sequelize.query(
        `SELECT COUNT(*)::int AS n FROM "AvailabilityResponses" WHERE user_uuid IS NULL`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      if (n > 0) {
        throw new Error(
          `[AR-DROP] refusing SET NOT NULL on AvailabilityResponses.user_uuid: ${n} residual NULL ` +
            `row(s) remain after the residue re-backfill + orphan delete.`
        );
      }
      await sequelize.query(
        `ALTER TABLE "AvailabilityResponses" ALTER COLUMN user_uuid SET NOT NULL`,
        { transaction: t }
      );
      console.log('[AR-DROP] user_uuid SET NOT NULL.');

      // (5) DROP the legacy column (destructive, last).
      await sequelize.query(
        `ALTER TABLE "AvailabilityResponses" DROP COLUMN IF EXISTS "user_id"`,
        { transaction: t }
      );
      console.log('[AR-DROP] legacy column user_id DROPPED.');

      // Defensive: ensure the new user_uuid index survives (Plan 01 created it; no-op if present).
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${UUID_INDEX}" ON "AvailabilityResponses" (user_uuid)`,
        { transaction: t }
      );
    });
  },

  async down(queryInterface) {
    // Best-effort reverse: re-add the legacy column as nullable VARCHAR (SHAPE only) and
    // relax user_uuid back to nullable. The old (prompt_id, user_id) unique is NOT
    // recreated (the data to enforce it against is gone).
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (t) => {
      await sequelize.query(
        `ALTER TABLE "AvailabilityResponses" ADD COLUMN IF NOT EXISTS "user_id" VARCHAR`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "AvailabilityResponses" ALTER COLUMN user_uuid DROP NOT NULL`,
        { transaction: t }
      );
    });
  },
};
