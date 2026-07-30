'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87 (BINT-02, D-01/D-02/D-06) — add EventParticipation's protective
// foreign key on `user_id` → `Users.id` (the UUID PK) with ON DELETE CASCADE.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` → `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); models/EventParticipation.js is the sync()-built
// test-DB source. Both MUST carry the FK.
//
// D-06 — idempotent + safe on dirty prod data:
//   1. ORPHAN PRECLEAN (DML): DELETE any EventParticipation whose user_id has no
//      matching Users.id BEFORE the ADD CONSTRAINT, or the ALTER would fail on
//      existing orphans. DELETE (not null-out/reassign) is faithful to the
//      ON DELETE CASCADE semantics we are enshrining (D-06). Logs the count.
//      Precedent: migrations/20260227000005-data-audit-and-cleanup.js:60-70.
//   2. GUARDED FK ADD (DDL): only ADD CONSTRAINT if no equivalent FK already exists
//      on (user_id -> Users) under ANY NAME — so a re-run, an earlier partial apply,
//      or a constraint built by sync() on a shared DB is all a no-op. `Users.id` is
//      the PK → already UNIQUE, so no extra unique step.
//      HARDENED IN PHASE 88.4: this was a `conname`-only probe, which is exactly why
//      census findings F-37/F-38/F-39 exist. See the DECISION marker at the guard.
//
// DML + DDL run in ONE transaction: a mid-op failure rolls back cleanly and
// leaves no half-cleaned / half-constrained state.
//
// SCOPE: EventParticipation protective FK ONLY (phase 87 B4). The 7 Group-B
// user FKs, keyspace unification, and account deletion are DEFERRED (→87.1/87.2).
const FK_NAME = 'eventparticipations_user_id_fkey';

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (1) ORPHAN PRECLEAN — remove rows referencing a non-existent user so the
      // ADD CONSTRAINT below cannot fail on pre-existing dirty data.
      const orphans = await sequelize.query(
        `DELETE FROM "EventParticipations" ep
         WHERE NOT EXISTS (SELECT 1 FROM "Users" u WHERE u.id = ep.user_id)
         RETURNING ep.id`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const deleted = Array.isArray(orphans) ? orphans.length : 0;
      console.log(`[EP-FK] orphaned rows deleted: ${deleted}`);

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
      const existing = await sequelize.query(
        `SELECT 1
           FROM pg_constraint c
           JOIN pg_attribute a
             ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
          WHERE c.contype = 'f'
            AND c.conrelid  = to_regclass('"EventParticipations"')
            AND c.confrelid = to_regclass('"Users"')
            AND array_length(c.conkey, 1) = 1
            AND a.attname = 'user_id'
          UNION ALL
         SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: FK_NAME }, type: QueryTypes.SELECT, transaction: t }
      );

      if (existing.length === 0) {
        await sequelize.query(
          `ALTER TABLE "EventParticipations"
             ADD CONSTRAINT "${FK_NAME}"
             FOREIGN KEY (user_id) REFERENCES "Users"(id) ON DELETE CASCADE`,
          { transaction: t }
        );
        console.log(`[EP-FK] constraint ${FK_NAME} added (ON DELETE CASCADE).`);
      } else {
        console.log(
          `[EP-FK] an equivalent FK on EventParticipations.user_id -> Users already exists ` +
            `(any name); skipping ${FK_NAME}.`
        );
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "EventParticipations" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
  },
};
