'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88 plan 88-34 (WI-B1, walk MAJOR M4) — flip the `Events.status` column DEFAULT from
// 'completed' to 'scheduled' on production.
//
// SCHEMA DUAL-WRITE (the Phase 88.4 rule): this migration is the PROD source; the sync/CI source
// is models/Event.js `status.defaultValue`. Both halves ship in the SAME commit so the
// `migrate-cli-replay` drift gate — which diffs a sync()-built schema against a migrated one —
// stays green. IF YOU CHANGE ONE SIDE, CHANGE THE OTHER.
//
// WHY: the baseline captured `DEFAULT 'completed'` (baseline migration :177) back when Events
// were purely a play-history record. The app has since grown scheduling (RSVP, ballots, the
// availability poll -> event path), and a row that omits status is one whose outcome nobody has
// decided yet. 'completed' meant such a row was born as history and was invisible to
// UpcomingEventsCard, which filters to scheduled/in_progress.
//
// This migration changes the DEFAULT only — no existing row is touched here. The data repair for
// rows already mis-stamped lives in the companion backfill 20260820000002, kept separate so a
// schema rollback does not undo a data repair (and vice versa).
module.exports = {
  async up(queryInterface) {
    // Idempotent by construction: setting a default that is already set is a no-op in Postgres.
    await queryInterface.sequelize.query(
      `ALTER TABLE "Events" ALTER COLUMN "status" SET DEFAULT 'scheduled'::"enum_Events_status";`
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE "Events" ALTER COLUMN "status" SET DEFAULT 'completed'::"enum_Events_status";`
    );
  },
};
