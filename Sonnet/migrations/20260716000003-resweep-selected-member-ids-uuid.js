'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.4 (BINT-02, Plan 11 — PR-2) — idempotent RE-SWEEP of the nested
// GroupPromptSettings.template_config.schedules[].selected_member_ids JSONB keyspace
// from Auth0 subs to Users.id UUIDs.
//
// WHY A SECOND SWEEP: Plan 04's backfill (20260716000002) converted the stored
// keyspace to UUIDs at the PR-1 deploy. But groupPromptSettings.js's members[].user_id
// emission did NOT flip to UUID until PR-2 (this plan's Task 1) — so for the whole
// PR-1 -> PR-2 window the FE kept reading members[].user_id as an Auth0 sub and writing
// sub-shaped entries back into selected_member_ids. Any admin who saved a schedule in
// that window re-introduced sub residue AFTER the one-shot Plan 04 backfill ran. This
// re-sweep is a second, idempotent pass of the IDENTICAL conversion logic, shipped in
// the SAME deploy as the Task 1 fanout contract (which filters sub residue through
// isUuid) and the Task 1 write-path normalization (which self-heals future stale-tab
// saves) — so the shape filter never has to permanently mask un-repaired data.
//
// This REUSES Plan 04's app-level backfill mechanism (SELECT row -> walk schedules[] in
// JS -> Users-join remap -> whole-template_config write). It is NOT new bespoke logic.
//
// DEPENDENCY-FREE (MANDATORY — matches the Plan 03/04 sister migrations): a migration
// must NEVER import app code (models, utils, isUuid) — app code can move/rename/change
// and would break a historical replay. DB access is raw queryInterface SQL and the
// UUID-shape test is the INLINE regex literal below, NOT an import of
// utils/resolveTargetUser.isUuid.
//
// IDEMPOTENT: an entry already UUID-shaped is left untouched; a re-run over
// already-converted rows finds no sub-shaped entries and writes nothing.
//
// ORPHAN DROP + LOG: a sub with no matching Users row (a departed member) drops out of
// the array. up() logs two COUNTS ONLY — converted (sub->UUID remaps) and dropped
// (unresolvable orphan subs) — NEVER raw subs.
//
// down(): IRREVERSIBLE data migration (the sub->UUID remap is one-way and orphan subs
// were dropped). Documented no-op.

// INLINE UUID shape test (mirrors utils/resolveTargetUser.isUuid — deliberately NOT
// imported, so a future refactor of app code can't break this replay).
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

          // Remap: UUID entries untouched; sub entries -> Users.id; orphan subs
          // (no Users row) resolve to undefined and are dropped by filter(Boolean).
          const remapped = ids
            .map((v) => (isUuid(v) ? v : map.get(v)))
            .filter(Boolean);

          // Count-only accounting (no raw subs).
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

    // COUNTS ONLY — never raw Auth0 subs. Closes the PR-1 -> PR-2 residue window.
    console.log(
      `[20260716000003-resweep-selected-member-ids-uuid] selected_member_ids re-sweep complete: ` +
        `converted=${convertedCount} sub->UUID, dropped=${droppedCount} unresolvable orphan sub(s)`
    );
  },

  async down() {
    // IRREVERSIBLE data migration: the sub->UUID remap is one-way and orphan subs were
    // dropped, so the pre-sweep keyspace is not restorable. Documented no-op.
  },
};
