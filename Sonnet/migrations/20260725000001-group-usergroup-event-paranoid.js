'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.2 (SPEC-REQ-1 / SPEC-REQ-3 / SPEC-REQ-9, D-01) — turn on Sequelize
// `paranoid` soft-delete for exactly three models: Group, UserGroup, Event.
//
// This migration lands the PROD half of that schema: a nullable `deletedAt`
// timestamp on each of the three tables, a `purge_after` timestamp on Groups
// (written at delete time, read by the plan-08 purge sweep), and — critically —
// the UserGroups composite unique index rebuilt as a PARTIAL index so that a
// soft-deleted membership row no longer occupies the unique slot.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply`, tracked in SequelizeMeta);
// models/Group.js, models/UserGroup.js and models/Event.js are the sync()-built
// test/CI-DB source. Both carry the identical partial-index predicate — the model
// form `where: { deletedAt: null }` and the DDL form `WHERE "deletedAt" IS NULL`
// were verified byte-for-byte identical by running the project's own installed
// Sequelize 6.37.7 query generator against a replica of models/UserGroup.js.
// If you change the predicate in one place, change it in the other.
//
// Column name is `deletedAt` (camelCase, double-quoted), NOT `deleted_at`: none
// of the three models sets `underscored`, so Sequelize's `_timestampAttributes
// .deletedAt` resolves to 'deletedAt' and its own CREATE TABLE would emit
// "deletedAt" TIMESTAMP WITH TIME ZONE. Matching it is what keeps prod and the
// sync-built CI DB on the same physical column.
//
// No backfill: NULL `deletedAt` means live, which is already correct for every
// pre-existing row.
//
// ---------------------------------------------------------------------------
// DEPLOY-TIME LOCK WINDOW — read before running this in prod (MED #32)
// ---------------------------------------------------------------------------
// The index swap below (`CREATE UNIQUE INDEX` without CONCURRENTLY) takes an
// ACCESS EXCLUSIVE lock on "UserGroups" for its duration, blocking every read
// AND write on that table. "UserGroups" is on the hot path of essentially every
// authenticated request (getUserRoleInGroup / isActiveMember,
// services/authorizationService.js:35-46), so this window is a WHOLE-APP stall,
// not one endpoint's. At this table's current size it is very likely sub-second,
// and that is the accepted trade — but it is recorded here as a decision rather
// than something discovered mid-deploy.
//
// CONCURRENTLY was REJECTED: it cannot run inside a transaction, and this
// migration deliberately runs as one so the column adds and the index swap land
// atomically (a half-applied state would leave a live full unique index against
// a paranoid model — i.e. every re-join hard-failing). Splitting the index swap
// into a separate non-transactional migration would additionally require
// creating the new index under a temporary name BEFORE dropping the old one and
// then renaming — three extra steps plus a window in which both indexes exist —
// to save a sub-second stall.
//
// ESCAPE HATCH: if "UserGroups" ever grows large enough for the stall to matter,
// the fix is the split-migration form described above. It is NOT "drop the
// transaction" — atomicity here is what prevents the broken intermediate state.
// ---------------------------------------------------------------------------
//
// Idempotent throughout (IF NOT EXISTS / IF EXISTS on every statement), matching
// the D-09 convention from 20260703000001.

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      // (1) Paranoid columns. Nullable by definition — NULL means "live".
      await sequelize.query(
        `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP WITH TIME ZONE`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "Groups" ADD COLUMN IF NOT EXISTS "purge_after" TIMESTAMP WITH TIME ZONE`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "UserGroups" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP WITH TIME ZONE`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "Events" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP WITH TIME ZONE`,
        { transaction: t }
      );
      console.log('[88.2-paranoid] deletedAt columns + Groups.purge_after ensured.');

      // (2) Drop BOTH historical names of the (user_uuid, group_id) unique index.
      //
      //     `usergroups_user_uuid_group_id_uq` is the migration-created name
      //     (20260703000001:99-106). `user_groups_user_uuid_group_id` is the name
      //     sync() auto-generates from the snake-cased table plus the fields, so it
      //     is what any DB built from the model before this phase carries.
      //
      //     Both names were observed COEXISTING on the same table in the local dev
      //     database during the Phase 88.2 cascade audit (see
      //     .planning/phases/88.2-.../88.2-CASCADE-AUDIT.md § 3) — a DB that has been
      //     both sync()'d and migrated ends up with two redundant unique indexes on
      //     the same columns. Dropping only one would leave a FULL unique index
      //     behind and silently defeat the partial index below.
      await sequelize.query(
        `DROP INDEX IF EXISTS "usergroups_user_uuid_group_id_uq"`,
        { transaction: t }
      );
      await sequelize.query(
        `DROP INDEX IF EXISTS "user_groups_user_uuid_group_id"`,
        { transaction: t }
      );

      // (3) Recreate it PARTIAL. This is the D-01 landmine defuser: a user whose
      //     UserGroups row is soft-deleted must be able to re-join via
      //     POST /groups/join-by-token (routes/groups.js:614-710) without hitting a
      //     unique-constraint violation. Predicate is identical to the model's
      //     `where: { deletedAt: null }`.
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "usergroups_user_uuid_group_id_uq"
           ON "UserGroups" ("user_uuid", "group_id")
         WHERE "deletedAt" IS NULL`,
        { transaction: t }
      );

      // (4) The purge sweep scans Groups by purge_after; index it.
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "groups_purge_after" ON "Groups" ("purge_after")`,
        { transaction: t }
      );
      console.log('[88.2-paranoid] partial unique index + groups_purge_after ensured.');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      // Restore the FULL unique index. NOTE: this will fail if any duplicate
      // (user_uuid, group_id) pairs exist because rows were soft-deleted and then
      // re-created while the partial index was live. That is the correct failure —
      // rolling back to a full unique index is only safe once those soft-deleted
      // rows are hard-deleted.
      await sequelize.query(
        `DROP INDEX IF EXISTS "usergroups_user_uuid_group_id_uq"`,
        { transaction: t }
      );
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS "usergroups_user_uuid_group_id_uq"
           ON "UserGroups" ("user_uuid", "group_id")`,
        { transaction: t }
      );

      await sequelize.query(`DROP INDEX IF EXISTS "groups_purge_after"`, { transaction: t });

      await sequelize.query(
        `ALTER TABLE "Events" DROP COLUMN IF EXISTS "deletedAt"`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "UserGroups" DROP COLUMN IF EXISTS "deletedAt"`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "Groups" DROP COLUMN IF EXISTS "purge_after"`,
        { transaction: t }
      );
      await sequelize.query(
        `ALTER TABLE "Groups" DROP COLUMN IF EXISTS "deletedAt"`,
        { transaction: t }
      );
    });
  },
};
