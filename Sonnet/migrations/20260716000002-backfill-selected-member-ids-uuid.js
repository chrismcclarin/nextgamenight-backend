'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.4 (BINT-02, Plan 04 — D-06) — app-level backfill of the long-lived,
// NESTED GroupPromptSettings.template_config.schedules[].selected_member_ids JSONB
// keyspace from Auth0 subs to Users.id UUIDs.
//
// WHY APP-LEVEL (not raw nested-JSONB path SQL): selected_member_ids lives nested
// inside a variable-length schedules[] array inside the template_config JSONB blob.
// jsonb_set path surgery over that shape is brittle (D-06 rejects it). Instead we
// SELECT each row, walk its schedules array in JS, remap each entry sub→UUID via a
// Users lookup, and write the WHOLE recomputed template_config back with a single
// parameterized UPDATE. The JSONB transform is JS; only the row read + write are SQL.
//
// DEPENDENCY-FREE (MANDATORY — matches the Plan 03 sister migration
// 20260716000001): a migration must NEVER import app code (models, utils, isUuid)
// — app code can move/rename/change and would break a historical replay. So DB
// access is raw queryInterface SQL (NOT the GroupPromptSettings/User models) and
// the UUID-shape test is the INLINE regex literal below, NOT an import of
// utils/resolveTargetUser.isUuid.
//
// IDEMPOTENT: an entry that is already UUID-shaped is left untouched; a re-run
// finds no sub-shaped entries in a swept row and writes nothing.
//
// ORPHAN DROP + LOG (D-08 / T14): a sub with no matching Users row (a departed
// member) drops out of the array. up() logs two COUNTS ONLY — converted (sub→UUID
// remaps) and dropped (unresolvable orphan subs) — NEVER raw subs. Plan 07's PR-1
// deploy-log gate requires BOTH 87.4 migrations to report their drop counts, so the
// logging line is load-bearing for that gate.
//
// down(): IRREVERSIBLE data migration (the sub→UUID remap is one-way and orphan
// subs were dropped). Documented no-op.

// INLINE UUID shape test (mirrors utils/resolveTargetUser.isUuid — deliberately
// NOT imported, so a future refactor of app code can't break this replay).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    let convertedCount = 0;
    let droppedCount = 0;

    await sequelize.transaction(async (t) => {
      const rows = await sequelize.query(
        'SELECT id, template_config FROM "GroupPromptSettings"',
        { type: QueryTypes.SELECT, transaction: t }
      );

      for (const row of rows) {
        const templateConfig = row.template_config || {};
        const schedules = Array.isArray(templateConfig.schedules)
          ? templateConfig.schedules
          : [];
        let changed = false;

        for (const sched of schedules) {
          const ids = Array.isArray(sched.selected_member_ids)
            ? sched.selected_member_ids
            : [];
          if (ids.length === 0) continue;

          const subs = ids.filter((v) => !isUuid(v));
          if (subs.length === 0) continue; // already all UUID — idempotent skip

          // Resolve the sub-shaped entries to Users.id via a Users join.
          const users = await sequelize.query(
            'SELECT id, user_id FROM "Users" WHERE user_id IN (:subs)',
            { type: QueryTypes.SELECT, replacements: { subs }, transaction: t }
          );
          const map = new Map(users.map((u) => [u.user_id, u.id]));

          // Remap: UUID entries untouched; sub entries → Users.id; orphan subs
          // (no Users row) resolve to undefined and are dropped by filter(Boolean).
          const remapped = ids
            .map((v) => (isUuid(v) ? v : map.get(v)))
            .filter(Boolean);

          // Count-only accounting (no raw subs) for the deploy-log gate.
          const convertedHere = subs.filter((s) => map.has(s)).length;
          convertedCount += convertedHere;
          droppedCount += subs.length - convertedHere;

          sched.selected_member_ids = remapped;
          changed = true;
        }

        if (changed) {
          await sequelize.query(
            'UPDATE "GroupPromptSettings" SET template_config = CAST(:tc AS jsonb) WHERE id = :id',
            {
              replacements: {
                tc: JSON.stringify({ ...templateConfig, schedules }),
                id: row.id,
              },
              transaction: t,
            }
          );
        }
      }
    });

    // COUNTS ONLY — never raw Auth0 subs (T14). Load-bearing for Plan 07's PR-1
    // deploy-log gate (BOTH 87.4 migrations must report their drop counts).
    console.log(
      `[20260716000002-backfill-selected-member-ids-uuid] selected_member_ids backfill complete: ` +
        `converted=${convertedCount} sub->UUID, dropped=${droppedCount} unresolvable orphan sub(s)`
    );
  },

  async down() {
    // IRREVERSIBLE data migration: the sub->UUID remap is one-way and orphan subs
    // were dropped, so the pre-backfill keyspace is not restorable. Documented no-op.
  },
};
