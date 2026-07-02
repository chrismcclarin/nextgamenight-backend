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
//   2. GUARDED FK ADD (DDL): only ADD CONSTRAINT if pg_constraint has no
//      `eventparticipations_user_id_fkey` yet — so a re-run (or a constraint
//      already built by an earlier partial apply / by sync on a shared DB) is a
//      no-op. `Users.id` is the PK → already UNIQUE, so no extra unique step.
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

      // (2) GUARDED FK ADD — idempotent via pg_constraint existence check.
      const existing = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
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
        console.log(`[EP-FK] constraint ${FK_NAME} already present, skipping.`);
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "EventParticipations" DROP CONSTRAINT IF EXISTS "${FK_NAME}"`
    );
  },
};
