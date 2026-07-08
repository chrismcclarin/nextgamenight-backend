'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.1 (BINT-02, Part B — D-01) — re-key UserGroups onto the internal UUID
// surrogate key `Users.id` with a real protective FK, ON DELETE CASCADE.
//
// UserGroups is the central authz table. Today `user_id` holds the Auth0 string.
// This EXPAND migration adds a UUID FK column (`user_uuid`) alongside it, backfills
// from Users, and enforces the constraint in prod. The old `user_id` column is
// RETAINED (D-07 expand-contract rollback net) — it is DROP-COLUMN'd only in the
// D-08 follow-up PR, and removed from the Sequelize model only in Plan 09.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply`, tracked in SequelizeMeta);
// models/UserGroup.js is the sync()-built test-DB source. Both carry the FK.
// The model column is `allowNull: true` through waves 1-4 (nothing writes it until
// Plan 03's factory dual-write + the route cutovers); Plan 09 tightens the model to
// allowNull: false (app-level enforcement). The DB-level SET NOT NULL is DEFERRED to
// the D-08 follow-up migration (NOT enforced here) — see the step-(3) note below.
//
// D-01 — ON DELETE CASCADE: a deleted user's group memberships are removed.
//   Orphan pre-clean is a DELETE (faithful to CASCADE), logged, run BEFORE the
//   ADD CONSTRAINT so the ALTER cannot fail on pre-existing dirty data (T-87.1-02).
//
// D-09 — idempotent: add-column guarded by describeTable, FK add guarded by a
//   pg_constraint conname check, indexes via CREATE ... IF NOT EXISTS.
//
// DROP NOT NULL rationale (MANDATORY — T-87.1-03): `user_id` is NOT NULL in prod.
//   Once Plan 09 removes it from the model, Sequelize stops emitting it on INSERT,
//   so a UUID-only join-group write would hit a NOT NULL violation. Relaxing it to
//   nullable here (in the same expand migration) keeps every write working. CI
//   cannot catch this — the sync()-built test DB never has the old column.
//
// DML + DDL run in ONE transaction: a mid-op failure rolls back cleanly.
const FK_NAME = 'usergroups_user_uuid_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMN — idempotent via describeTable.
      const table = await queryInterface.describeTable('UserGroups');
      if (!table.user_uuid) {
        await sequelize.query(
          `ALTER TABLE "UserGroups" ADD COLUMN user_uuid UUID`,
          { transaction: t }
        );
        console.log('[UG-UUID] column user_uuid added.');
      } else {
        console.log('[UG-UUID] column user_uuid already present, skipping add.');
      }

      // (1) BACKFILL from Users (Auth0 string → UUID PK).
      const [, backfillMeta] = await sequelize.query(
        `UPDATE "UserGroups" t SET user_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.user_id
            AND t.user_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[UG-UUID] backfilled rows: ${backfillMeta ? backfillMeta.rowCount : 0}`);

      // (2) ORPHAN PRE-CLEAN — DELETE rows with no matching Users.id (CASCADE, D-01).
      const orphans = await sequelize.query(
        `DELETE FROM "UserGroups" WHERE user_uuid IS NULL RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const deleted = Array.isArray(orphans) ? orphans.length : 0;
      console.log(`[UG-UUID] orphaned rows deleted: ${deleted}`);

      // (3) DB-level SET NOT NULL on user_uuid is DELIBERATELY DEFERRED to the D-08
      //     follow-up migration (see .planning/todos). Running it here (pre-deploy,
      //     while old code that does NOT write user_uuid still serves traffic) would
      //     500 every UserGroups INSERT during the deploy window, and it breaks the
      //     D-07 app-rollback net for writes. App-level NOT NULL is enforced by the
      //     model's allowNull:false since Plan 09; the DB constraint ships in D-08
      //     only after the cutover deploy is verified live.

      // (4) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "UserGroups"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[UG-UUID] constraint ${FK_NAME} added (ON DELETE CASCADE).`);
      } else {
        console.log(`[UG-UUID] constraint ${FK_NAME} already present, skipping.`);
      }

      // (5) RECREATE INDEX — composite unique only; its leading column serves
      //     single-column lookups, so no standalone (user_uuid) index (redundant
      //     index removed per adversarial review, USER APPROVED 2026-07-04).
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "usergroups_user_uuid_group_id_uq"
           ON "UserGroups" (user_uuid, group_id)`,
        { transaction: t }
      );

      // (6) RELAX RETAINED OLD COLUMN — MANDATORY (T-87.1-03). See header.
      await sequelize.query(
        `ALTER TABLE "UserGroups" ALTER COLUMN "user_id" DROP NOT NULL`,
        { transaction: t }
      );
      console.log('[UG-UUID] old column user_id relaxed to nullable (DROP NOT NULL).');
    });
  },

  async down(queryInterface) {
    // Drops the new FK, new index, and new column only. Does NOT restore NOT NULL
    // on user_id — rows written after Plan 09 deploys may legitimately hold NULL.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "UserGroups" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "usergroups_user_uuid_group_id_uq"`
    );
    await sequelize.query(
      `ALTER TABLE "UserGroups" DROP COLUMN IF EXISTS user_uuid`
    );
  },
};
