'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.2 (D-02 / SPEC-REQ-9) — extend `single_use_tokens` so it can carry the
// group-restore acceptance link.
//
// Three DDL facts:
//   1. `group_restore` added to the `enum_single_use_tokens_purpose` PG ENUM type
//      (created by migrations/20260618000002-create-single-use-tokens.js:16-20).
//   2. `group_id` uuid, nullable, NO foreign key.
//   3. `user_id` relaxed to nullable — a group_restore row identifies the GROUP and
//      carries no user identity.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the PROD
// source (runs under `migrate:apply`, tracked in SequelizeMeta); its sync()-built
// counterpart is `models/SingleUseToken.js`, which states all three facts identically
// (purpose ENUM at its `purpose` attribute, `group_id` immediately after `event_id`,
// `user_id: allowNull: true`). Change one, change the other — the Jest/CI database is
// built by `sequelize.sync({ force: true })` in tests/globalSetup.js:113 and never by
// this file, so a divergence here is invisible until prod.
//
// NON-TRANSACTIONAL: `ALTER TYPE ... ADD VALUE` is deliberately NOT wrapped in an
// explicit transaction, and the new value is NOT used anywhere in this migration.
// Postgres 12+ permits ADD VALUE inside a transaction block but forbids *using* the
// new value in that same transaction. Target is Postgres 16 (see
// periodictabletopbackend_v2/.github/workflows/ci.yml `image: postgres:16`). Same
// shape as the in-repo precedent migrations/20260322000001-add-pending-role-to-usergroups.js:9-11,
// whose header records the same constraint. `down()` therefore cannot remove the
// value and logs instead, mirroring that migration.
//
// DECISION Phase 88.2 D-02 — two non-obvious choices, both deliberate:
//
//   (a) NO FOREIGN KEY on `group_id`, chosen OVER an `ON DELETE CASCADE` FK to
//       `Groups`. The FK would have auto-cleaned restore tokens when a group row is
//       finally purged; it was rejected to keep this table's shape uniform with the
//       sibling `event_id` column, which has no FK either (models/SingleUseToken.js —
//       `event_id`, "RSVP target event; null for oauth_state"). The consequence is
//       intentional and load-bearing: plan 08's purge sweep deletes
//       `single_use_tokens WHERE group_id = :id` EXPLICITLY, exactly as it must for
//       `GroupInvite` (see 88.2-CASCADE-AUDIT.md — GroupInvites turned out to have no
//       FK to Groups in the migration-built database at all). Removing that explicit
//       delete on the assumption that a cascade covers it will ORPHAN tokens pointing
//       at a group that no longer exists. Adding the FK later is a decision, not a
//       cleanup.
//
//   (b) `user_id` RELAXED TO NULLABLE, chosen OVER stuffing the deleting owner's Auth0
//       sub into it to satisfy the existing NOT NULL. This is correctness, not
//       tidiness: services/accountDeletionService.js:273 and
//       services/pendingAuth0DeletionSweep.js:187 both run
//       `SingleUseToken.destroy({ where: { user_id: sub } })`. Under D-04 an owner may
//       delete their group and then delete their account — with a sub in `user_id`
//       that sequence would silently destroy the restore token and leave the group
//       permanently unclaimable by any remaining member. Pinned by a test in
//       tests/routes/singleUseToken.test.js.

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // 1. ENUM value. Idempotent via IF NOT EXISTS. Deliberately no { transaction }.
    await sequelize.query(
      `ALTER TYPE "enum_single_use_tokens_purpose" ADD VALUE IF NOT EXISTS 'group_restore';`
    );

    // 2. group_id — nullable UUID (post-87.5 UUID convention), no FK by design (see
    //    DECISION (a) above). Uniform with the sibling `event_id`.
    await sequelize.query(
      `ALTER TABLE "single_use_tokens" ADD COLUMN IF NOT EXISTS "group_id" uuid;`
    );

    // 3. user_id nullable — group_restore rows leave it NULL (see DECISION (b) above).
    //    DROP NOT NULL is a no-op if already nullable, so this is re-run safe.
    await sequelize.query(
      `ALTER TABLE "single_use_tokens" ALTER COLUMN "user_id" DROP NOT NULL;`
    );

    // 4. Index serving plan 08's purge delete (`where: { group_id }` alone) and
    //    plan 07's sibling revocation (group_id + purpose + status). group_id LEADS:
    //    Postgres will not use this index for a predicate that does not constrain the
    //    leading column, and single_use_tokens accumulates every OAuth state nonce and
    //    every RSVP magic link, so a group_id-only sequential scan would run inside the
    //    purge transaction already holding SELECT ... FOR UPDATE on the Groups row.
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS "single_use_tokens_group_purpose_status" ON "single_use_tokens" ("group_id", "purpose", "status");`
    );

    console.log(
      '[88.2] single_use_tokens: group_restore ENUM value added, group_id column added, user_id relaxed to nullable.'
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.query(
      `DROP INDEX IF EXISTS "single_use_tokens_group_purpose_status";`
    );
    await sequelize.query(
      `ALTER TABLE "single_use_tokens" DROP COLUMN IF EXISTS "group_id";`
    );

    // Restore NOT NULL on user_id ONLY if no NULL rows remain — the ALTER would fail
    // outright otherwise, taking the whole down() with it. Any surviving group_restore
    // row legitimately has a NULL user_id, so skipping is the correct behavior, not a
    // failure.
    const [nullRows] = await sequelize.query(
      `SELECT COUNT(*)::int AS n FROM "single_use_tokens" WHERE "user_id" IS NULL;`
    );
    const nullCount = nullRows && nullRows[0] ? Number(nullRows[0].n) : 0;
    if (nullCount === 0) {
      await sequelize.query(
        `ALTER TABLE "single_use_tokens" ALTER COLUMN "user_id" SET NOT NULL;`
      );
    } else {
      console.log(
        `[88.2] SKIPPED user_id SET NOT NULL — ${nullCount} row(s) still have a NULL user_id (group_restore tokens). Delete or re-key them first if the NOT NULL is genuinely wanted.`
      );
    }

    // PostgreSQL cannot remove an individual ENUM value without recreating the type.
    // Leaving 'group_restore' in enum_single_use_tokens_purpose is harmless — an unused
    // value has no side effects. Same disposition as
    // migrations/20260322000001-add-pending-role-to-usergroups.js down().
    console.log(
      "[88.2] NOTE: 'group_restore' remains in enum_single_use_tokens_purpose (PostgreSQL cannot remove ENUM values easily)."
    );
  },
};
