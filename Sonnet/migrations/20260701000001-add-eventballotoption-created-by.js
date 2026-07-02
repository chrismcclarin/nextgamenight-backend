'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87 (BINT-01, D-05, D-06) — add the NULLABLE `created_by` column to
// EventBallotOptions so the ballot route can enforce creator-based replace/wipe
// authorization. Schema dual-write: this migration is the prod source (runs
// under `migrate:apply` → `npx sequelize-cli db:migrate`, tracked in
// SequelizeMeta); models/EventBallotOption.js is the sync()-built test-DB
// source. Both MUST carry the column (Pitfall 1 — model/migration drift).
//
// D-05: NULLABLE, NO backfill. Legacy rows stay created_by=NULL and are
// replace/wipe-able only by owner/admin (isCreator is false when created_by is
// NULL). D-06: idempotent guarded — describeTable + column-absent check so a
// re-run (or a column already present from an earlier partial apply) is a
// no-op, and the DDL is transaction-wrapped so a mid-op failure rolls back
// cleanly.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (t) => {
      const table = await queryInterface.describeTable('EventBallotOptions');
      if (!table.created_by) {
        await queryInterface.addColumn(
          'EventBallotOptions',
          'created_by',
          {
            type: Sequelize.STRING,
            allowNull: true,
          },
          { transaction: t }
        );
        console.log('Added created_by column to EventBallotOptions.');
      } else {
        console.log('created_by column already exists on EventBallotOptions, skipping.');
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (t) => {
      const table = await queryInterface.describeTable('EventBallotOptions');
      if (table.created_by) {
        await queryInterface.removeColumn('EventBallotOptions', 'created_by', { transaction: t });
      }
    });
  },
};
