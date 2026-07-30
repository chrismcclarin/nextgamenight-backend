'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.2 (REQ-3/REQ-6, T-87.2-01) — add Event's protective foreign keys on
// `winner_id` and `picked_by_id` → `Users.id` (the UUID PK) with ON DELETE
// SET NULL.
//
// WHY SET NULL (not CASCADE): winner_id/picked_by_id point at a member who won or
// picked the game for a *shared* group event. Hard-deleting that user must NOT
// destroy the whole event row (that would erase another group's history —
// T-87.2-01). SET NULL nulls only the pointer; the sibling display-name columns
// (winner_name / picked_by_name) are untouched so custom-participant display text
// survives. Member-winner display is intentionally lost (hard-delete semantics,
// no display-name backfill).
//
// Schema dual-write (RESEARCH Pitfall 3 — model/migration drift): this migration
// is the PROD source (runs under `migrate:apply` → `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); models/Event.js is the sync()-built test/CI-DB
// source. Both MUST carry the FK or the integrity test (plan 87.2-06) cannot
// exercise SET NULL on a sync()-built DB.
//
// Idempotent + safe on dirty prod data (T-87.2-02, template: 20260701000002):
//   1. ORPHAN PRECLEAN (DML): NULL any Events.winner_id / picked_by_id whose value
//      has no matching Users.id BEFORE the ADD CONSTRAINT, or the ALTER would fail
//      on existing orphans. Null-out (not delete) is faithful to the SET NULL
//      semantics we are enshrining. Logs the count for each column.
//   2. GUARDED FK ADD (DDL): only ADD CONSTRAINT if pg_constraint has no matching
//      conname yet — so a re-run (or a constraint already built by an earlier
//      partial apply / by sync on a shared DB) is a no-op.
//
// DML + DDL run in ONE transaction: a mid-op failure rolls back cleanly.
const WINNER_FK_NAME = 'events_winner_id_fkey';
const PICKER_FK_NAME = 'events_picked_by_id_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (1) ORPHAN PRECLEAN — null out pointers referencing a non-existent user
      // so the ADD CONSTRAINT below cannot fail on pre-existing dirty data.
      const winnerOrphans = await sequelize.query(
        `UPDATE "Events"
           SET winner_id = NULL
         WHERE winner_id IS NOT NULL
           AND winner_id NOT IN (SELECT id FROM "Users")
         RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const winnerCleaned = Array.isArray(winnerOrphans) ? winnerOrphans.length : 0;
      console.log(`[EVENT-FK] winner_id orphans nulled: ${winnerCleaned}`);

      const pickerOrphans = await sequelize.query(
        `UPDATE "Events"
           SET picked_by_id = NULL
         WHERE picked_by_id IS NOT NULL
           AND picked_by_id NOT IN (SELECT id FROM "Users")
         RETURNING id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const pickerCleaned = Array.isArray(pickerOrphans) ? pickerOrphans.length : 0;
      console.log(`[EVENT-FK] picked_by_id orphans nulled: ${pickerCleaned}`);

      // (2) GUARDED FK ADD.
      //
      // DECISION Phase 88.4 RC-2 (88.4-DRIFT-CENSUS.md § 4.2, findings F-37/F-38/F-39): the guard
      // probes STRUCTURE — an existing `contype='f'` on (this column -> the same parent table) under
      // ANY NAME — over the `conname = :name` check it used to be. The name check is kept as a
      // second arm so the intent is still explicit.
      //
      // WHY: this migration's original `conname`-only guard IS the root cause of three of the
      // day-one census's findings. The constraint that already existed on these tables was created
      // by `sync()` in the pre-migration era and is CamelCase
      // (`EventParticipations_user_id_fkey`, `Events_winner_id_fkey`, `Events_picked_by_id_fkey`);
      // this file probes for a LOWERCASE name, found nothing, and added a SECOND, functionally
      // redundant foreign key on the same column — with no error, on every database where the
      // CamelCase one was present. The from-empty replay reproduces it exactly: 9 FKs across the two
      // tables where there should be 6.
      //
      // Editing this file does NOT fix prod (the filename is already booked in prod's
      // SequelizeMeta, so it will never run there again) — migration
      // 20260730000001-reconcile-duplicate-constraints.js drops the duplicates prod is carrying.
      // This change fixes the FROM-EMPTY REPLAY and every future dev/CI database, which is what the
      // drift gate actually compares. Both halves are needed; neither substitutes for the other.
      // Reverting this to a name-only probe re-creates the duplicates and reds the gate.
      const addFk = async (fkName, column) => {
        const existing = await sequelize.query(
          `SELECT 1
             FROM pg_constraint c
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f'
              AND c.conrelid  = to_regclass('"Events"')
              AND c.confrelid = to_regclass('"Users"')
              AND array_length(c.conkey, 1) = 1
              AND a.attname = :column
            UNION ALL
           SELECT 1 FROM pg_constraint WHERE conname = :name`,
          { replacements: { name: fkName, column }, type: QueryTypes.SELECT, transaction: t }
        );
        if (existing.length === 0) {
          await sequelize.query(
            `ALTER TABLE "Events"
               ADD CONSTRAINT "${fkName}"
               FOREIGN KEY (${column}) REFERENCES "Users"(id) ON DELETE SET NULL`,
            { transaction: t }
          );
          console.log(`[EVENT-FK] constraint ${fkName} added (ON DELETE SET NULL).`);
        } else {
          console.log(
            `[EVENT-FK] an equivalent FK on Events.${column} -> Users already exists ` +
              `(any name); skipping ${fkName}.`
          );
        }
      };

      await addFk(WINNER_FK_NAME, 'winner_id');
      await addFk(PICKER_FK_NAME, 'picked_by_id');
    });
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    await sequelize.query(
      `ALTER TABLE "Events" DROP CONSTRAINT IF EXISTS "${WINNER_FK_NAME}"`
    );
    await sequelize.query(
      `ALTER TABLE "Events" DROP CONSTRAINT IF EXISTS "${PICKER_FK_NAME}"`
    );
  },
};
