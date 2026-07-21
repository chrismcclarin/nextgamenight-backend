'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.5 (BINT-02, BE PR-1 — D-01) — re-key UserAvailabilities onto the internal
// UUID surrogate key `Users.id` with a real protective FK, ON DELETE CASCADE.
//
// Copies the prod-proven 87.1 sibling-column rekey master
// (migrations/20260703000001-rekey-usergroup-user-uuid.js). Today `user_id` holds the
// Auth0 string. This EXPAND migration adds a UUID FK column (`user_uuid`) alongside it,
// backfills from Users, deletes+logs orphans in-transaction (CASCADE-faithful), and
// enforces the constraint in prod. The old `user_id` column is RETAINED (D-07
// expand-contract rollback net) — it is DROP-COLUMN'd only in the BE PR-2 contract
// migration (Plan 07) once the cutover is verified live.
//
// D-01 — ON DELETE CASCADE: a deleted user's availability rows are removed. Orphan
//   pre-clean is a DELETE (faithful to CASCADE), logged, run BEFORE the ADD CONSTRAINT
//   so the ALTER cannot fail on pre-existing dirty data (T-875-01-ORPHAN).
//
// D-09 — idempotent: add-column guarded by describeTable, FK add guarded by a
//   pg_constraint conname check, index via CREATE ... IF NOT EXISTS.
//
// DROP NOT NULL rationale (T-875-01): once the model stops emitting `user_id`, a
//   UUID-only write would hit a NOT NULL violation. Relaxing it here keeps every write
//   working during the expand-contract window.
//
// DML + DDL run in ONE transaction: a mid-op failure rolls back cleanly.
const FK_NAME = 'useravailabilities_user_uuid_fkey';
const UUID_INDEX = 'user_availabilities_user_uuid';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMN — idempotent via describeTable.
      const table = await queryInterface.describeTable('UserAvailabilities');
      if (!table.user_uuid) {
        await sequelize.query(
          `ALTER TABLE "UserAvailabilities" ADD COLUMN user_uuid UUID`,
          { transaction: t }
        );
        console.log('[UA-UUID] column user_uuid added.');
      } else {
        console.log('[UA-UUID] column user_uuid already present, skipping add.');
      }

      // (1) BACKFILL from Users (Auth0 string → UUID PK).
      const [, backfillMeta] = await sequelize.query(
        `UPDATE "UserAvailabilities" t SET user_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.user_id
            AND t.user_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[UA-UUID] backfilled rows: ${backfillMeta ? backfillMeta.rowCount : 0}`);

      // (2) ORPHAN PRE-CLEAN — DELETE rows with no matching Users.id (CASCADE, D-01).
      const orphans = await sequelize.query(
        `DELETE FROM "UserAvailabilities" WHERE user_uuid IS NULL RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const deleted = Array.isArray(orphans) ? orphans.length : 0;
      console.log(`[UA-UUID] orphaned rows deleted: ${deleted}`);

      // (4) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "UserAvailabilities"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[UA-UUID] constraint ${FK_NAME} added (ON DELETE CASCADE).`);
      } else {
        console.log(`[UA-UUID] constraint ${FK_NAME} already present, skipping.`);
      }

      // (5) RECREATE INDEX on the NEW column — single-col, mirrors the existing
      //     unnamed `user_id` index. Postgres does not auto-index the FK-referencing
      //     side, and every availability read keys on this column.
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${UUID_INDEX}"
           ON "UserAvailabilities" (user_uuid)`,
        { transaction: t }
      );

      // (6) RELAX RETAINED OLD COLUMN — MANDATORY (T-875-01). See header.
      await sequelize.query(
        `ALTER TABLE "UserAvailabilities" ALTER COLUMN "user_id" DROP NOT NULL`,
        { transaction: t }
      );
      console.log('[UA-UUID] old column user_id relaxed to nullable (DROP NOT NULL).');
    });
  },

  async down(queryInterface) {
    // Drops the new FK, new index, and new column only.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "UserAvailabilities" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "${UUID_INDEX}"`
    );
    await sequelize.query(
      `ALTER TABLE "UserAvailabilities" DROP COLUMN IF EXISTS user_uuid`
    );
  },
};
