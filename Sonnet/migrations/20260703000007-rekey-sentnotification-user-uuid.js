'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.1 (BINT-02, Part B — D-03, PII cleanup) — re-key SentNotifications onto
// the internal UUID surrogate key `Users.id` with a real protective FK, ON DELETE
// CASCADE.
//
// SentNotifications logs outbound SMS (PII: phone + notification history). D-03:
// CASCADE so a deleted user's notification trail is purged with them. Today
// `user_id` holds the Auth0 string. This EXPAND migration adds a UUID FK column
// (`user_uuid`) alongside it, backfills from Users, and enforces the constraint in
// prod. The old `user_id` column is RETAINED (D-07 expand-contract rollback net) —
// DROP-COLUMN'd only in the D-08 follow-up PR, removed from the Sequelize model
// only in Plan 09.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (migrate:apply / SequelizeMeta); models/SentNotification.js is the
// sync()-built test-DB source. Both carry the FK. The model column is
// `allowNull: true` through waves 1-4 (nothing writes it until Plan 03's factory
// dual-write + route cutovers); prod NOT NULL is enforced HERE via SET NOT NULL.
//
// This is the SIMPLEST table: it has NO unique constraint on the user column.
//   The recreated index is a plain NON-unique (user_uuid, event_id) — audit lookup
//   of which notifications were sent for a user+event combo.
//
// D-09 — idempotent: add-column guarded by describeTable, FK guarded by pg_constraint
//   conname check, index via CREATE INDEX IF NOT EXISTS.
//
// DROP NOT NULL rationale (MANDATORY — T-87.1-03): `user_id` is NOT NULL in prod;
//   once Plan 09 removes it from the model Sequelize stops emitting it on INSERT,
//   so a UUID-only notification-record write would hit a NOT NULL violation.
//   Relaxing it here keeps every write working. CI can't catch this — sync()-built
//   test DB has no old column.
//
// DML + DDL run in ONE transaction: mid-op failure rolls back cleanly.
const FK_NAME = 'sentnotifications_user_uuid_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMN — idempotent via describeTable.
      const table = await queryInterface.describeTable('SentNotifications');
      if (!table.user_uuid) {
        await sequelize.query(
          `ALTER TABLE "SentNotifications" ADD COLUMN user_uuid UUID`,
          { transaction: t }
        );
        console.log('[SENTNOTIF-UUID] column user_uuid added.');
      } else {
        console.log('[SENTNOTIF-UUID] column user_uuid already present, skipping add.');
      }

      // (1) BACKFILL from Users (Auth0 string → UUID PK).
      const [, backfillMeta] = await sequelize.query(
        `UPDATE "SentNotifications" t SET user_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.user_id
            AND t.user_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[SENTNOTIF-UUID] backfilled rows: ${backfillMeta ? backfillMeta.rowCount : 0}`);

      // (2) ORPHAN PRE-CLEAN — DELETE rows with no matching Users.id (CASCADE + PII, D-03).
      const orphans = await sequelize.query(
        `DELETE FROM "SentNotifications" WHERE user_uuid IS NULL RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const deleted = Array.isArray(orphans) ? orphans.length : 0;
      console.log(`[SENTNOTIF-UUID] orphaned rows deleted: ${deleted}`);

      // (3) ENFORCE NOT NULL (prod authoritative constraint).
      await sequelize.query(
        `ALTER TABLE "SentNotifications" ALTER COLUMN user_uuid SET NOT NULL`,
        { transaction: t }
      );

      // (4) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "SentNotifications"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[SENTNOTIF-UUID] constraint ${FK_NAME} added (ON DELETE CASCADE).`);
      } else {
        console.log(`[SENTNOTIF-UUID] constraint ${FK_NAME} already present, skipping.`);
      }

      // (5) RECREATE INDEX on the UUID column — NON-unique (user_uuid, event_id).
      //     This table has NO unique user constraint (simplest table); audit lookup only.
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "sentnotifications_user_uuid_event_id_idx"
           ON "SentNotifications" (user_uuid, event_id)`,
        { transaction: t }
      );

      // (6) RELAX RETAINED OLD COLUMN — MANDATORY (T-87.1-03). See header.
      await sequelize.query(
        `ALTER TABLE "SentNotifications" ALTER COLUMN "user_id" DROP NOT NULL`,
        { transaction: t }
      );
      console.log('[SENTNOTIF-UUID] old column user_id relaxed to nullable (DROP NOT NULL).');
    });
  },

  async down(queryInterface) {
    // Drops new FK, new index, and new column only. Does NOT restore NOT NULL
    // on user_id — rows written after Plan 09 deploys may legitimately hold NULL.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "SentNotifications" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "sentnotifications_user_uuid_event_id_idx"`
    );
    await sequelize.query(
      `ALTER TABLE "SentNotifications" DROP COLUMN IF EXISTS user_uuid`
    );
  },
};
