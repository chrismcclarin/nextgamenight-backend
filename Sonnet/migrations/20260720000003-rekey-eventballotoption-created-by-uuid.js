'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.5 (BINT-02, BE PR-1 — D-01) — re-key EventBallotOptions.created_by onto the
// internal UUID surrogate key `Users.id` with a protective FK, ON DELETE SET NULL.
//
// Copies the 87.1 sibling-column rekey master (20260703000001) but with the SET NULL /
// no-delete variant: the creator is a soft attribution, NOT an ownership key. Adds a
// nullable UUID FK column (`created_by_uuid`) alongside the retained `created_by` Auth0
// string, backfills from Users, and enforces the FK. The old `created_by` column is
// RETAINED (D-07 rollback net) and dropped only in the BE PR-2 contract migration
// (Plan 07). `created_by` is already nullable, so there is no DROP NOT NULL relax step.
//
// D-01 — ON DELETE SET NULL: a deleted creator's ballot options survive with a NULL
//   creator (fall through to owner/admin-only authz). CRITICAL: unlike the CASCADE
//   rekeys, this migration does NOT delete unmatched rows — the 3 prod NULL-creator rows
//   and any sub-orphans must survive with created_by_uuid left NULL (T-875-01-ORPHAN).
//
// Index: Postgres does not auto-index the referencing side of a FK. The SET NULL cascade
//   and the accountDeletionService creator scrub (Plan 04) both key lookups on this
//   column, so a plain (non-unique) index is added. No unique index on the creator.
//
// D-09 — idempotent: add-column guarded by describeTable, FK add guarded by a
//   pg_constraint conname check, index via CREATE ... IF NOT EXISTS.
//
// DML + DDL run in ONE transaction: a mid-op failure rolls back cleanly.
const FK_NAME = 'eventballotoptions_created_by_uuid_fkey';
const UUID_INDEX = 'event_ballot_options_created_by_uuid';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMN — idempotent via describeTable.
      const table = await queryInterface.describeTable('EventBallotOptions');
      if (!table.created_by_uuid) {
        await sequelize.query(
          `ALTER TABLE "EventBallotOptions" ADD COLUMN created_by_uuid UUID`,
          { transaction: t }
        );
        console.log('[EBO-UUID] column created_by_uuid added.');
      } else {
        console.log('[EBO-UUID] column created_by_uuid already present, skipping add.');
      }

      // (1) BACKFILL from Users (Auth0 string → UUID PK). Rows whose created_by is NULL
      //     or matches no Users.id are LEFT NULL — no delete (SET NULL disposition).
      const [, backfillMeta] = await sequelize.query(
        `UPDATE "EventBallotOptions" t SET created_by_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.created_by
            AND t.created_by_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[EBO-UUID] backfilled rows: ${backfillMeta ? backfillMeta.rowCount : 0}`);

      // (2) NO ORPHAN DELETE — the 3 prod NULL-creator rows and any sub-orphans survive
      //     with created_by_uuid NULL (SET NULL, D-01). Deliberately no DELETE here.

      // (4) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "EventBallotOptions"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (created_by_uuid) REFERENCES "Users"(id) ON DELETE SET NULL`,
          { transaction: t }
        );
        console.log(`[EBO-UUID] constraint ${FK_NAME} added (ON DELETE SET NULL).`);
      } else {
        console.log(`[EBO-UUID] constraint ${FK_NAME} already present, skipping.`);
      }

      // (5) PLAIN (non-unique) INDEX on the new FK column — Postgres does not auto-index
      //     the referencing side; SET NULL cascade + creator scrub both key on it.
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "${UUID_INDEX}"
           ON "EventBallotOptions" (created_by_uuid)`,
        { transaction: t }
      );

      // (6) NO RELAX STEP — created_by is already nullable.
    });
  },

  async down(queryInterface) {
    // Drops the new FK, new index, and new column only.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "EventBallotOptions" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "${UUID_INDEX}"`
    );
    await sequelize.query(
      `ALTER TABLE "EventBallotOptions" DROP COLUMN IF EXISTS created_by_uuid`
    );
  },
};
