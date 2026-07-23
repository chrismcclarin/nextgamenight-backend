'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.5 (BINT-02, BE PR-1 — D-01) — re-key AvailabilityResponses onto the internal
// UUID surrogate key `Users.id` with a real protective FK, ON DELETE CASCADE.
//
// Copies the prod-proven 87.1 sibling-column rekey master
// (migrations/20260703000001-rekey-usergroup-user-uuid.js). Adds a UUID FK column
// (`user_uuid`) alongside the retained `user_id` Auth0 string, backfills from Users,
// deletes+logs orphans in-transaction (CASCADE-faithful), enforces the FK, REBUILDS the
// (prompt_id, user_id) uniqueness onto (prompt_id, user_uuid), and adds a plain
// user_uuid index. The old `user_id` column is RETAINED (D-07 rollback net) and dropped
// only in the BE PR-2 contract migration (Plan 07).
//
// D-01 — ON DELETE CASCADE: a deleted user's responses are removed. Orphan pre-clean is
//   a DELETE (faithful to CASCADE), logged, run BEFORE the ADD CONSTRAINT.
//
// D-09 — idempotent: add-column guarded by describeTable, FK add guarded by a
//   pg_constraint conname check, indexes via CREATE ... IF NOT EXISTS / DROP ... IF EXISTS.
//
// DML + DDL run in ONE transaction: a mid-op failure rolls back cleanly.
const FK_NAME = 'availability_responses_user_uuid_fkey';
const OLD_UNIQUE_INDEX = 'availability_responses_prompt_user_unique';
const NEW_UNIQUE_INDEX = 'availability_responses_prompt_user_uuid_unique';
const UUID_INDEX = 'availability_responses_user_uuid';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMN — idempotent via describeTable.
      const table = await queryInterface.describeTable('AvailabilityResponses');
      if (!table.user_uuid) {
        await sequelize.query(
          `ALTER TABLE "AvailabilityResponses" ADD COLUMN user_uuid UUID`,
          { transaction: t }
        );
        console.log('[AR-UUID] column user_uuid added.');
      } else {
        console.log('[AR-UUID] column user_uuid already present, skipping add.');
      }

      // (1) BACKFILL from Users (Auth0 string → UUID PK).
      const [, backfillMeta] = await sequelize.query(
        `UPDATE "AvailabilityResponses" t SET user_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.user_id
            AND t.user_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[AR-UUID] backfilled rows: ${backfillMeta ? backfillMeta.rowCount : 0}`);

      // (2) ORPHAN PRE-CLEAN — DELETE rows with no matching Users.id (CASCADE, D-01).
      const orphans = await sequelize.query(
        `DELETE FROM "AvailabilityResponses" WHERE user_uuid IS NULL RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const deleted = Array.isArray(orphans) ? orphans.length : 0;
      console.log(`[AR-UUID] orphaned rows deleted: ${deleted}`);

      // (4) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "AvailabilityResponses"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[AR-UUID] constraint ${FK_NAME} added (ON DELETE CASCADE).`);
      } else {
        console.log(`[AR-UUID] constraint ${FK_NAME} already present, skipping.`);
      }

      // (5a) REBUILD UNIQUE INDEX — one response per (prompt, user) keyed on the UUID.
      //      Drop the old (prompt_id, user_id) unique, create the (prompt_id, user_uuid) one.
      await sequelize.query(
        `DROP INDEX IF EXISTS "${OLD_UNIQUE_INDEX}"`,
        { transaction: t }
      );
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "${NEW_UNIQUE_INDEX}"
           ON "AvailabilityResponses" (prompt_id, user_uuid)`,
        { transaction: t }
      );

      // (5b) PLAIN INDEX on the new column (mirrors the existing single-col user_id index).
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${UUID_INDEX}"
           ON "AvailabilityResponses" (user_uuid)`,
        { transaction: t }
      );

      // (6) RELAX RETAINED OLD COLUMN — MANDATORY (T-875-01). See header.
      await sequelize.query(
        `ALTER TABLE "AvailabilityResponses" ALTER COLUMN "user_id" DROP NOT NULL`,
        { transaction: t }
      );
      console.log('[AR-UUID] old column user_id relaxed to nullable (DROP NOT NULL).');
    });
  },

  async down(queryInterface) {
    // Drops the new FK, new indexes, and new column only.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "AvailabilityResponses" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "${NEW_UNIQUE_INDEX}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "${UUID_INDEX}"`
    );
    await sequelize.query(
      `ALTER TABLE "AvailabilityResponses" DROP COLUMN IF EXISTS user_uuid`
    );
  },
};
