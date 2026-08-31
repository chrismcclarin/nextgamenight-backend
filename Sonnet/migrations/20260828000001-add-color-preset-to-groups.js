'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.3.1 / Plan 02 Task 1 (SPEC Req 5, CONTEXT D-01) — add the nullable
// color_preset column to Groups.
//
// A group's colour is stored as a preset ID (the word 'blue'), not a hex, so a
// palette re-tune is a frontend-only edit with no data migration. NULL means
// "no preset" — either the group is uncoloured, or it carries a legacy/custom
// #rrggbb in background_color, which stays a supported path (D-01).
//
// STRING, not ENUM: adding a ninth preset to a Postgres ENUM needs a
// NON-TRANSACTIONAL `ALTER TYPE ... ADD VALUE` whose down() can only log — the
// cost is on the record at 20260322000001-add-pending-role-to-usergroups.js:3-4,15-18.
// With STRING the allowlist lives in middleware/validators.js (sourced from
// utils/groupColourPresets.js) and a ninth preset is a one-line validator edit.
//
// SCHEMA ONLY — the data remap is deliberately a SEPARATE migration
// (20260828000002-remap-group-colours-to-presets.js, plan 88.3.1-05), following
// the house precedent 20260820000001 + 20260820000002. Two reasons:
//   1. down() semantics stay clean and single-purpose. THIS migration's down()
//      drops a column; the remap's down() restores hexes. Fused into one file,
//      down() would have to do both in the right order or corrupt the data.
//   2. A migration test's afterAll can restore the CURRENT schema by re-running
//      only this up(). That is the rekey cross-suite-poisoning lesson
//      (tests/migrations/rekey.test.js, fixed 2026-07-29): a replay test that
//      leaves an older schema behind poisons every suite that runs after it.
//
// Dual-write (RESEARCH Pitfall 3): this migration is the PROD source; the same
// column lives in models/Group.js for sync()-built test/CI DBs.
// Idempotent: describeTable guard makes re-run a no-op (migrate-cli-replay CI job).
const TABLE = 'Groups';
const COLUMN = 'color_preset';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotency guard — skip if the column already exists (partial apply / replay).
    const table = await queryInterface.describeTable(TABLE).catch(() => null);
    if (!table) {
      throw new Error(`[88.3.1] ${TABLE} does not exist — run the base schema migrations first.`);
    }
    if (table[COLUMN]) {
      console.log(`[88.3.1] ${TABLE}.${COLUMN} already exists, skipping.`);
      return;
    }

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.STRING,
      allowNull: true,
    });
    console.log(`[88.3.1] Added ${TABLE}.${COLUMN} (group colour stored as a preset id, not a hex).`);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE).catch(() => null);
    if (table && table[COLUMN]) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
