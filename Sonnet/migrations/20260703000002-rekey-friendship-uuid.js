'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.1 (BINT-02, Part B — D-05) — re-key Friendships onto the internal UUID
// surrogate key `Users.id` with real protective FKs on BOTH endpoints, each
// ON DELETE CASCADE.
//
// Friendships stores one row per pair; today `requester_id`/`addressee_id` hold
// Auth0 strings, with a LEAST/GREATEST functional unique index preventing duplicate
// pairs. This EXPAND migration adds `requester_uuid`/`addressee_uuid` UUID FK columns,
// backfills from Users, enforces the constraints in prod, and recreates the functional
// unique index on the UUID columns. The old string columns are RETAINED (D-07 rollback
// net) — DROP-COLUMN'd only in the D-08 follow-up PR, removed from the model in Plan 09.
//
// Schema dual-write (Pitfall 1): this migration is the PROD source (migrate:apply);
// models/Friendship.js is the sync()-built test-DB source. Both carry the FKs. The
// model columns are `allowNull: true` through waves 1-4 (nothing writes them until
// Plan 03's factory dual-write + route cutovers); Plan 09 tightens the model to
// allowNull: false (app-level enforcement). The DB-level SET NOT NULL is DEFERRED to
// the D-08 follow-up migration (NOT enforced here) — see the step-(3) note below.
//
// D-05 — ON DELETE CASCADE on BOTH endpoints: deleting either user removes the row.
//   Orphan pre-clean DELETEs any row where EITHER uuid is NULL (either endpoint
//   unmatched → both FKs CASCADE), logged, run BEFORE ADD CONSTRAINT (T-87.1-02).
//
// D-09 — idempotent: add-columns guarded by describeTable, FK adds guarded by
//   pg_constraint conname checks, indexes via CREATE ... IF NOT EXISTS.
//
// DROP NOT NULL rationale (MANDATORY — T-87.1-03): both old columns are NOT NULL in
//   prod. Once Plan 09 removes them from the model, Sequelize stops emitting them on
//   INSERT, so a UUID-only send-friend-request write would hit a NOT NULL violation.
//   Relaxing them to nullable here keeps every write working. CI cannot catch this —
//   the sync()-built test DB never has the old columns.
//
// The functional LEAST/GREATEST index is raw SQL here (not a model index) — the model
// does not declare it. DML + DDL run in ONE transaction.
const FK_REQUESTER = 'friendships_requester_uuid_fkey';
const FK_ADDRESSEE = 'friendships_addressee_uuid_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMNS — idempotent via describeTable.
      const table = await queryInterface.describeTable('Friendships');
      if (!table.requester_uuid) {
        await sequelize.query(
          `ALTER TABLE "Friendships" ADD COLUMN requester_uuid UUID`,
          { transaction: t }
        );
        console.log('[FR-UUID] column requester_uuid added.');
      } else {
        console.log('[FR-UUID] column requester_uuid already present, skipping add.');
      }
      if (!table.addressee_uuid) {
        await sequelize.query(
          `ALTER TABLE "Friendships" ADD COLUMN addressee_uuid UUID`,
          { transaction: t }
        );
        console.log('[FR-UUID] column addressee_uuid added.');
      } else {
        console.log('[FR-UUID] column addressee_uuid already present, skipping add.');
      }

      // (1) BACKFILL both endpoints from Users (Auth0 string → UUID PK).
      const [, reqMeta] = await sequelize.query(
        `UPDATE "Friendships" t SET requester_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.requester_id
            AND t.requester_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[FR-UUID] requester backfilled rows: ${reqMeta ? reqMeta.rowCount : 0}`);
      const [, addrMeta] = await sequelize.query(
        `UPDATE "Friendships" t SET addressee_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.addressee_id
            AND t.addressee_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[FR-UUID] addressee backfilled rows: ${addrMeta ? addrMeta.rowCount : 0}`);

      // (2) ORPHAN PRE-CLEAN — DELETE rows where EITHER endpoint is unmatched (CASCADE, D-05).
      const orphans = await sequelize.query(
        `DELETE FROM "Friendships"
          WHERE requester_uuid IS NULL OR addressee_uuid IS NULL
          RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const deleted = Array.isArray(orphans) ? orphans.length : 0;
      console.log(`[FR-UUID] orphaned rows deleted: ${deleted}`);

      // (3) DB-level SET NOT NULL on requester_uuid/addressee_uuid is DELIBERATELY
      //     DEFERRED to the D-08 follow-up migration (see .planning/todos). Running it
      //     here (pre-deploy, while old code that does NOT write the *_uuid columns
      //     still serves traffic) would 500 every Friendships INSERT during the deploy
      //     window, and it breaks the D-07 app-rollback net for writes. App-level NOT
      //     NULL is enforced by the model's allowNull:false since Plan 09; the DB
      //     constraint ships in D-08 only after the cutover deploy is verified live.

      // (4) GUARDED FK ADDS — both idempotent via pg_constraint existence checks.
      const reqExisting = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_REQUESTER }, type: QueryTypes.SELECT, transaction: t }
      );
      if (reqExisting.length === 0) {
        await sequelize.query(
          `ALTER TABLE "Friendships"
             ADD CONSTRAINT "${FK_REQUESTER}"
             FOREIGN KEY (requester_uuid) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[FR-UUID] constraint ${FK_REQUESTER} added (ON DELETE CASCADE).`);
      } else {
        console.log(`[FR-UUID] constraint ${FK_REQUESTER} already present, skipping.`);
      }
      const addrExisting = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_ADDRESSEE }, type: QueryTypes.SELECT, transaction: t }
      );
      if (addrExisting.length === 0) {
        await sequelize.query(
          `ALTER TABLE "Friendships"
             ADD CONSTRAINT "${FK_ADDRESSEE}"
             FOREIGN KEY (addressee_uuid) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[FR-UUID] constraint ${FK_ADDRESSEE} added (ON DELETE CASCADE).`);
      } else {
        console.log(`[FR-UUID] constraint ${FK_ADDRESSEE} already present, skipping.`);
      }

      // (5) RECREATE INDEXES — functional pair-unique on UUID + per-column indexes.
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "friendships_pair_unique_uuid"
           ON "Friendships" (LEAST(requester_uuid, addressee_uuid), GREATEST(requester_uuid, addressee_uuid))`,
        { transaction: t }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "friendships_requester_uuid_idx"
           ON "Friendships" (requester_uuid)`,
        { transaction: t }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "friendships_addressee_uuid_idx"
           ON "Friendships" (addressee_uuid)`,
        { transaction: t }
      );

      // (6) RELAX RETAINED OLD COLUMNS — MANDATORY (T-87.1-03). See header.
      await sequelize.query(
        `ALTER TABLE "Friendships" ALTER COLUMN "requester_id" DROP NOT NULL`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "Friendships" ALTER COLUMN "addressee_id" DROP NOT NULL`,
        { transaction: t }
      );
      console.log('[FR-UUID] old columns requester_id/addressee_id relaxed to nullable (DROP NOT NULL).');
    });
  },

  async down(queryInterface) {
    // Drops the new FKs, new indexes, and new columns only. Does NOT restore NOT NULL
    // on the old columns — rows written after Plan 09 deploys may legitimately hold NULL.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "Friendships" DROP CONSTRAINT IF EXISTS "${FK_REQUESTER}"`
    );
    await sequelize.query(
      `ALTER TABLE "Friendships" DROP CONSTRAINT IF EXISTS "${FK_ADDRESSEE}"`
    );
    await sequelize.query(`DROP INDEX IF EXISTS "friendships_pair_unique_uuid"`);
    await sequelize.query(`DROP INDEX IF EXISTS "friendships_requester_uuid_idx"`);
    await sequelize.query(`DROP INDEX IF EXISTS "friendships_addressee_uuid_idx"`);
    await sequelize.query(
      `ALTER TABLE "Friendships" DROP COLUMN IF EXISTS requester_uuid`
    );
    await sequelize.query(
      `ALTER TABLE "Friendships" DROP COLUMN IF EXISTS addressee_uuid`
    );
  },
};
