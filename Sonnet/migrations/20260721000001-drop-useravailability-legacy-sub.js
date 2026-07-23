'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.5 (BINT-02, BE PR-2 — D-01/D-04 contract) — DROP the retained legacy
// `UserAvailabilities.user_id` Auth0-string column. This is the contraction half of the
// expand-contract rekey: Plan 01's expand migration
// (20260720000001-rekey-useravailability-user-uuid.js) added `user_uuid` alongside the
// retained `user_id` as the D-07 rollback net; this migration removes that net once the
// PR-1 cutover is verified live in prod (D-01 — BE PR-2 runs after PR-1 verified).
//
// Ordered per the D-08 finalize idiom (20260720000004): residue re-backfill + orphan
// handling FIRST, then SET NOT NULL (non-destructive tightening), then DROP COLUMN
// (irreversible removal of the rollback net) LAST. One guarded transaction — a mid-op
// failure rolls back cleanly.
//
// RESIDUE RE-BACKFILL (necessary, NOT redundant with Plan 01's one-time backfill):
//   old code paths from before BE PR-1's deploy can still write sub-keyed rows during the
//   PR-1 deploy window (rolling deploy / in-flight requests hitting old code against the
//   new schema). Such rows land between Plan 01's backfill and this contract-drop with
//   `user_uuid` still NULL. Without a second Users-join pass they are silently and
//   permanently orphaned the instant `user_id` is dropped (no data left to backfill from).
//
// ORPHAN HANDLING (CASCADE table): after the residue re-backfill, any row still
//   unresolved (`user_uuid IS NULL`) is DELETEd and its ids logged — faithful to the
//   ON DELETE CASCADE disposition, mirroring Plan 01's orphan pre-clean.
//
// SET NOT NULL (closes a gap the fresh rekey left open): Plan 01's model declares
//   `user_uuid` allowNull:false, but the DB column was deliberately left nullable at
//   rekey time (87.1 D-07 rollback-net pattern) and the D-08 finalize (20260720000004)
//   only tightened the 7 pre-existing 87.1 columns — NOT this fresh one. This migration
//   is where the DB column is finally tightened, guarded by a residual-NULL assert.
//
// D-09 — idempotent: describeTable guards, guarded SET NOT NULL, DROP COLUMN IF EXISTS.
const UUID_INDEX = 'user_availabilities_user_uuid';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      const table = await queryInterface.describeTable('UserAvailabilities');

      // (1) RESIDUE RE-BACKFILL — close the PR-1 deploy-window gap (see header).
      //     Guarded on the legacy column still existing (idempotent re-run safety).
      if (table.user_id) {
        const [, backfillMeta] = await sequelize.query(
          `UPDATE "UserAvailabilities" t SET user_uuid = u.id
             FROM "Users" u
            WHERE u.user_id = t.user_id
              AND t.user_uuid IS NULL`,
          { transaction: t }
        );
        console.log(
          `[UA-DROP] residue re-backfill rows: ${backfillMeta ? backfillMeta.rowCount : 0}`
        );

        // (2) ORPHAN DELETE-AND-LOG — CASCADE table: any still-unresolved row is deleted.
        const orphans = await sequelize.query(
          `DELETE FROM "UserAvailabilities" WHERE user_uuid IS NULL RETURNING id`,
          { type: QueryTypes.SELECT, transaction: t }
        );
        const deletedIds = Array.isArray(orphans) ? orphans.map((r) => r.id) : [];
        console.log(
          `[UA-DROP] residue orphans deleted: ${deletedIds.length}` +
            (deletedIds.length ? ` (ids: ${deletedIds.join(', ')})` : '')
        );
      } else {
        console.log('[UA-DROP] legacy user_id already absent — skipping residue backfill/orphan pass.');
      }

      // (3) SET NOT NULL on user_uuid (residual-NULL guarded), mirroring the D-08 finalize.
      const [{ n }] = await sequelize.query(
        `SELECT COUNT(*)::int AS n FROM "UserAvailabilities" WHERE user_uuid IS NULL`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      if (n > 0) {
        throw new Error(
          `[UA-DROP] refusing SET NOT NULL on UserAvailabilities.user_uuid: ${n} residual NULL ` +
            `row(s) remain after the residue re-backfill + orphan delete.`
        );
      }
      await sequelize.query(
        `ALTER TABLE "UserAvailabilities" ALTER COLUMN user_uuid SET NOT NULL`,
        { transaction: t }
      );
      console.log('[UA-DROP] user_uuid SET NOT NULL.');

      // (4) DROP the legacy column (destructive, last). Postgres auto-drops the old
      //     unnamed user_id index with the column.
      await sequelize.query(
        `ALTER TABLE "UserAvailabilities" DROP COLUMN IF EXISTS "user_id"`,
        { transaction: t }
      );
      console.log('[UA-DROP] legacy column user_id DROPPED.');

      // Defensive: ensure the new user_uuid index survives (Plan 01 created it; no-op if present).
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${UUID_INDEX}" ON "UserAvailabilities" (user_uuid)`,
        { transaction: t }
      );
    });
  },

  async down(queryInterface) {
    // Best-effort reverse: re-add the legacy column as nullable VARCHAR (SHAPE only, no
    // data) and relax user_uuid back to nullable.
    const sequelize = queryInterface.sequelize;
    await sequelize.transaction(async (t) => {
      await sequelize.query(
        `ALTER TABLE "UserAvailabilities" ADD COLUMN IF NOT EXISTS "user_id" VARCHAR`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "UserAvailabilities" ALTER COLUMN user_uuid DROP NOT NULL`,
        { transaction: t }
      );
    });
  },
};
