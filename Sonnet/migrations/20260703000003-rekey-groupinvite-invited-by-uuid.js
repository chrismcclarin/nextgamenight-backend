'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.1 (BINT-02, Part B — D-04) — re-key GroupInvites' inviter reference onto
// the internal UUID surrogate key `Users.id` with a NULLABLE protective FK,
// ON DELETE SET NULL.
//
// GroupInvites is the sole SET NULL case: a pending invite outlives the inviter's
// account. Today `invited_by` holds the Auth0 string. This EXPAND migration adds a
// NULLABLE `invited_by_uuid` UUID FK column, backfills from Users, and enforces the
// SET NULL constraint in prod. Unmatched inviters are left NULL (NO orphan delete —
// that IS the SET NULL disposition, D-04). The old `invited_by` column is RETAINED
// (D-07 rollback net) — DROP-COLUMN'd only in the D-08 follow-up PR, removed from the
// model in Plan 09.
//
// Schema dual-write (Pitfall 1): this migration is the PROD source (migrate:apply);
// models/GroupInvite.js is the sync()-built test-DB source. Both carry the FK. The
// model column is already nullable (SET NULL), so no transitional allowNull juggling
// is needed here — but the SET NULL FK precedent is models/index.js:126
// (created_by_user_id, D-SCHEMA-05).
//
// D-04 — ON DELETE SET NULL: deleting the inviter nulls the reference, preserving the
//   invite. The new column stays nullable (no not-null enforcement) and no orphan
//   rows are deleted.
//
// D-09 — idempotent: add-column guarded by describeTable, FK add guarded by a
//   pg_constraint conname check, index via CREATE ... IF NOT EXISTS.
//
// DROP NOT NULL rationale (MANDATORY — T-87.1-03): `invited_by` is NOT NULL in prod.
//   Once Plan 09 removes it from the model, Sequelize stops emitting it on INSERT, so
//   a send-group-invite write would hit a NOT NULL violation. Relaxing it to nullable
//   here keeps every write working. CI cannot catch this — the sync()-built test DB
//   never has the old column. DML + DDL run in ONE transaction.
const FK_NAME = 'groupinvites_invited_by_uuid_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMN (NULLABLE) — idempotent via describeTable.
      const table = await queryInterface.describeTable('GroupInvites');
      if (!table.invited_by_uuid) {
        await sequelize.query(
          `ALTER TABLE "GroupInvites" ADD COLUMN invited_by_uuid UUID`,
          { transaction: t }
        );
        console.log('[GI-UUID] column invited_by_uuid added.');
      } else {
        console.log('[GI-UUID] column invited_by_uuid already present, skipping add.');
      }

      // (1) BACKFILL from Users (Auth0 string → UUID PK).
      const [, backfillMeta] = await sequelize.query(
        `UPDATE "GroupInvites" t SET invited_by_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.invited_by
            AND t.invited_by_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[GI-UUID] backfilled rows: ${backfillMeta ? backfillMeta.rowCount : 0}`);

      // (2) NO ORPHAN DELETE — leave unmatched invited_by_uuid NULL (SET NULL, D-04).
      const nulls = await sequelize.query(
        `SELECT COUNT(*)::int AS n FROM "GroupInvites" WHERE invited_by_uuid IS NULL`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const nullCount = nulls && nulls[0] ? nulls[0].n : 0;
      console.log(`[GI-UUID] rows left with NULL invited_by_uuid (unmatched inviter, preserved): ${nullCount}`);

      // (3) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "GroupInvites"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (invited_by_uuid) REFERENCES "Users"(id) ON DELETE SET NULL`,
          { transaction: t }
        );
        console.log(`[GI-UUID] constraint ${FK_NAME} added (ON DELETE SET NULL).`);
      } else {
        console.log(`[GI-UUID] constraint ${FK_NAME} already present, skipping.`);
      }

      // (4) INDEX — plain (non-unique) index on the new FK column, mirroring the other
      //     re-keyed tables (USER APPROVED 2026-07-04). NO new unique index — the
      //     partial-unique on (group_id, LOWER(invited_email)) WHERE status='pending'
      //     is untouched.
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "groupinvites_invited_by_uuid_idx"
           ON "GroupInvites" (invited_by_uuid)`,
        { transaction: t }
      );

      // (5) RELAX RETAINED OLD COLUMN — MANDATORY (T-87.1-03). See header.
      await sequelize.query(
        `ALTER TABLE "GroupInvites" ALTER COLUMN "invited_by" DROP NOT NULL`,
        { transaction: t }
      );
      console.log('[GI-UUID] old column invited_by relaxed to nullable (DROP NOT NULL).');
    });
  },

  async down(queryInterface) {
    // Drops the new FK, new index, and new column only. Does NOT restore NOT NULL on
    // invited_by — rows written after Plan 09 deploys may legitimately hold NULL.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "GroupInvites" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "groupinvites_invited_by_uuid_idx"`
    );
    await sequelize.query(
      `ALTER TABLE "GroupInvites" DROP COLUMN IF EXISTS invited_by_uuid`
    );
  },
};
