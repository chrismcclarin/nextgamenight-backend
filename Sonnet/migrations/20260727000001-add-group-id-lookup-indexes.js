'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.2 code-review M-1 + L-9 (perf) — two plain NON-unique lookup indexes.
//
// M-1: 20260725000001 rebuilt `usergroups_user_uuid_group_id_uq` as a PARTIAL
// unique index (WHERE "deletedAt" IS NULL). Correct for the D-01 re-join path,
// but it left two whole query classes with no usable index on "UserGroups":
//   - `paranoid: false` membership lookups (they must see soft-deleted rows,
//     which the partial index does not contain) — these run on EVERY invite
//     accept, inside the shared FOR UPDATE lock (utils/groupRowLock.js);
//   - every group_id-leading query: roster reads, member counts, and the purge
//     sweep's destroys — the surviving unique index leads on user_uuid.
// Both were sequential scans while holding the lock. The fix is a plain
// (group_id, user_uuid) btree with NO predicate: it serves group_id-leading
// queries directly and, because it is not partial, covers paranoid:false
// lookups too.
//
// L-9: the purge sweep's `GroupInvite.destroy({ where: { group_id } })` had no
// group_id index on "GroupInvites" (token/email/status are indexed; group_id
// only appears inside the partial-unique pending-invite index, which a plain
// group_id lookup cannot use). Same fix, sibling table.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source; models/UserGroup.js and models/GroupInvite.js declare the same
// two indexes (same explicit names) for the sync()-built test/CI DB. If you
// change one side, change the other.
//
// Lock note: plain CREATE INDEX (without CONCURRENTLY) takes SHARE lock —
// writes block for the build, reads do not. At current table sizes this is
// sub-second; the 20260725000001 header's escape-hatch reasoning applies here
// too if that ever changes.
//
// Idempotent throughout (IF NOT EXISTS / IF EXISTS), matching the D-09
// convention from 20260703000001.

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "usergroups_group_id_user_uuid"
           ON "UserGroups" ("group_id", "user_uuid")`,
        { transaction: t }
      );
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS "group_invites_group_id"
           ON "GroupInvites" ("group_id")`,
        { transaction: t }
      );
      console.log('[88.2-M1-L9] group_id lookup indexes ensured.');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      await sequelize.query(
        `DROP INDEX IF EXISTS "group_invites_group_id"`,
        { transaction: t }
      );
      await sequelize.query(
        `DROP INDEX IF EXISTS "usergroups_group_id_user_uuid"`,
        { transaction: t }
      );
    });
  },
};
