'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.1 (BINT-02, Part B — D-02) — re-key EventBallotVotes onto the internal
// UUID surrogate key `Users.id` with a real protective FK, ON DELETE CASCADE.
//
// Today `user_id` holds the Auth0 string. This EXPAND migration adds a UUID FK
// column (`user_uuid`) alongside it, backfills from Users, and enforces the
// constraint in prod. The old `user_id` column is RETAINED (D-07 expand-contract
// rollback net) — DROP-COLUMN'd only in the D-08 follow-up PR, removed from the
// Sequelize model only in Plan 09.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (migrate:apply / SequelizeMeta); models/EventBallotVote.js is the
// sync()-built test-DB source. Both carry the FK. The model column is
// `allowNull: true` through waves 1-4 (nothing writes it until Plan 03's factory
// dual-write + route cutovers); Plan 09 tightens the model to allowNull: false
// (app-level enforcement). The DB-level SET NOT NULL is DEFERRED to the D-08
// follow-up migration (NOT enforced here) — see the step-(3) note below.
//
// D-02 — ON DELETE CASCADE: a deleted user's ballot votes are removed. Orphan
//   pre-clean DELETE runs BEFORE ADD CONSTRAINT (T-87.1-02).
//
// T-87.1-01 — recreate the composite UNIQUE (option_id, user_uuid) on the UUID
//   column so the one-vote-per-option-per-user invariant holds on the new key.
//
// D-09 — idempotent: add-column guarded by describeTable, FK guarded by pg_constraint
//   conname check, indexes via CREATE ... IF NOT EXISTS.
//
// DROP NOT NULL rationale (MANDATORY — T-87.1-03): `user_id` is NOT NULL in prod;
//   once Plan 09 removes it from the model Sequelize stops emitting it on INSERT,
//   so a UUID-only ballot-vote write would hit a NOT NULL violation. Relaxing it
//   here keeps every write working. CI can't catch this — sync()-built test DB has
//   no old column.
//
// DML + DDL run in ONE transaction: mid-op failure rolls back cleanly.
const FK_NAME = 'eventballotvotes_user_uuid_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (0) GUARDED ADD COLUMN — idempotent via describeTable.
      const table = await queryInterface.describeTable('EventBallotVotes');
      if (!table.user_uuid) {
        await sequelize.query(
          `ALTER TABLE "EventBallotVotes" ADD COLUMN user_uuid UUID`,
          { transaction: t }
        );
        console.log('[BALLOTVOTE-UUID] column user_uuid added.');
      } else {
        console.log('[BALLOTVOTE-UUID] column user_uuid already present, skipping add.');
      }

      // (1) BACKFILL from Users (Auth0 string → UUID PK).
      const [, backfillMeta] = await sequelize.query(
        `UPDATE "EventBallotVotes" t SET user_uuid = u.id
           FROM "Users" u
          WHERE u.user_id = t.user_id
            AND t.user_uuid IS NULL`,
        { transaction: t }
      );
      console.log(`[BALLOTVOTE-UUID] backfilled rows: ${backfillMeta ? backfillMeta.rowCount : 0}`);

      // (2) ORPHAN PRE-CLEAN — DELETE rows with no matching Users.id (CASCADE, D-02).
      const orphans = await sequelize.query(
        `DELETE FROM "EventBallotVotes" WHERE user_uuid IS NULL RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const deleted = Array.isArray(orphans) ? orphans.length : 0;
      console.log(`[BALLOTVOTE-UUID] orphaned rows deleted: ${deleted}`);

      // (3) DB-level SET NOT NULL on user_uuid is DELIBERATELY DEFERRED to the D-08
      //     follow-up migration (see .planning/todos). Running it here (pre-deploy,
      //     while old code that does NOT write user_uuid still serves traffic) would
      //     500 every EventBallotVotes INSERT during the deploy window, and it breaks
      //     the D-07 app-rollback net for writes. App-level NOT NULL is enforced by the
      //     model's allowNull:false since Plan 09; the DB constraint ships in D-08
      //     only after the cutover deploy is verified live.

      // (4) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );
      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "EventBallotVotes"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (user_uuid) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[BALLOTVOTE-UUID] constraint ${FK_NAME} added (ON DELETE CASCADE).`);
      } else {
        console.log(`[BALLOTVOTE-UUID] constraint ${FK_NAME} already present, skipping.`);
      }

      // (5) RECREATE INDEXES on the UUID column — composite UNIQUE (T-87.1-01,
      //     one vote per option per user) + standalone (user_uuid).
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "eventballotvotes_option_id_user_uuid_uq"
           ON "EventBallotVotes" (option_id, user_uuid)`,
        { transaction: t }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "eventballotvotes_user_uuid_idx"
           ON "EventBallotVotes" (user_uuid)`,
        { transaction: t }
      );

      // (6) RELAX RETAINED OLD COLUMN — MANDATORY (T-87.1-03). See header.
      await sequelize.query(
        `ALTER TABLE "EventBallotVotes" ALTER COLUMN "user_id" DROP NOT NULL`,
        { transaction: t }
      );
      console.log('[BALLOTVOTE-UUID] old column user_id relaxed to nullable (DROP NOT NULL).');
    });
  },

  async down(queryInterface) {
    // Drops new FK, new indexes, and new column only. Does NOT restore NOT NULL
    // on user_id — rows written after Plan 09 deploys may legitimately hold NULL.
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "EventBallotVotes" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "eventballotvotes_option_id_user_uuid_uq"`
    );
    await sequelize.query(
      `DROP INDEX IF EXISTS "eventballotvotes_user_uuid_idx"`
    );
    await sequelize.query(
      `ALTER TABLE "EventBallotVotes" DROP COLUMN IF EXISTS user_uuid`
    );
  },
};
