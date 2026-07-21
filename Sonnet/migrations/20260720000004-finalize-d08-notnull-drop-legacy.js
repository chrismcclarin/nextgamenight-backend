'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.5 (BINT-02, BE PR-1 — D-08 finalize) — the deferred D-08 contract step for the
// SEVEN Phase-87.1 UUID re-key tables. See
// .planning/todos/pending/2026-07-07-d08-contract-pr-set-not-null-then-drop-columns.md.
//
// The 87.1 expand migrations (20260703000001..07) deferred both the DB-level SET NOT NULL
// on the *_uuid columns and the DROP of the retained legacy Auth0-string columns, because
// running them pre-deploy (while old code that did not write *_uuid still served traffic)
// would have 500'd every INSERT during the deploy window. That hazard EXPIRED 2026-07-08
// (D-03): the cutover deploy is live, all writers key *_uuid, and no NULL *_uuid rows
// remain. This finalize rides inline with BE PR-1.
//
// Ordered per D-05: SET NOT NULL first (non-destructive tightening), DROP COLUMN last
// (irreversible removal of the rollback net). One guarded transaction — a mid-op failure
// rolls back cleanly.
//
// SCOPE: this file touches ONLY the seven 87.1 tables listed below. It does NOT touch the
// three fresh 87.5 re-key tables added earlier in this plan — their retained legacy
// columns drop in the separate BE PR-2 contract migration (Plan 07).
//
// GroupInvites.invited_by_uuid stays NULLABLE (D-04 SET NULL disposition) — it is NOT in
// the SET NOT NULL list, but its legacy `invited_by` column IS dropped.
//
// Residual-NULL guard: each SET NOT NULL first asserts zero NULLs remain in the target
// column, so the migration is safe and self-documenting rather than throwing an opaque
// constraint-violation deep in the ALTER.

// [table, column] — the 7 non-nullable 87.1 *_uuid columns to tighten.
const SET_NOT_NULL = [
  ['UserGroups', 'user_uuid'],
  ['Friendships', 'requester_uuid'],
  ['Friendships', 'addressee_uuid'],
  ['EventRsvps', 'user_uuid'],
  ['EventBrings', 'user_uuid'],
  ['EventBallotVotes', 'user_uuid'],
  ['SentNotifications', 'user_uuid'],
];

// [table, column] — the 8 retained 87.1 legacy sub string columns to drop.
const DROP_LEGACY = [
  ['UserGroups', 'user_id'],
  ['Friendships', 'requester_id'],
  ['Friendships', 'addressee_id'],
  ['GroupInvites', 'invited_by'],
  ['EventRsvps', 'user_id'],
  ['EventBrings', 'user_id'],
  ['EventBallotVotes', 'user_id'],
  ['SentNotifications', 'user_id'],
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // Step A — SET NOT NULL on the 7 *_uuid columns (each guarded by a residual-NULL assert).
      for (const [table, col] of SET_NOT_NULL) {
        const [{ n }] = await sequelize.query(
          `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${col}" IS NULL`,
          { type: QueryTypes.SELECT, transaction: t }
        );
        if (n > 0) {
          throw new Error(
            `[D08] refusing SET NOT NULL on "${table}"."${col}": ${n} residual NULL row(s) remain ` +
              `(the cutover backfill must be complete before this finalize runs).`
          );
        }
        await sequelize.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${col}" SET NOT NULL`,
          { transaction: t }
        );
        console.log(`[D08] ${table}.${col} SET NOT NULL.`);
      }

      // Step B — DROP the 8 retained legacy sub string columns (destructive, last).
      for (const [table, col] of DROP_LEGACY) {
        await sequelize.query(
          `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${col}"`,
          { transaction: t }
        );
        console.log(`[D08] ${table}.${col} DROP COLUMN.`);
      }
    });
  },

  async down(queryInterface) {
    // Best-effort reverse (mirror the master's DROP-then-re-add idiom): re-add the 8
    // dropped legacy columns as nullable VARCHAR and relax the 7 *_uuid columns back to
    // nullable. The re-added columns are empty — this restores SHAPE, not data.
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      // Reverse Step B — re-add the legacy columns (nullable VARCHAR).
      for (const [table, col] of DROP_LEGACY) {
        await sequelize.query(
          `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" VARCHAR`,
          { transaction: t }
        );
      }
      // Reverse Step A — relax the *_uuid columns back to nullable.
      for (const [table, col] of SET_NOT_NULL) {
        await sequelize.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${col}" DROP NOT NULL`,
          { transaction: t }
        );
      }
    });
  },
};
