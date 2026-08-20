'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88 plan 88-34 (WI-B1, walk MAJOR M4) — one-time data repair for prod rows already
// mis-stamped by the pre-fix create path.
//
// THE BUG THIS REPAIRS: routes/events.js POST /events hardcoded `status: 'completed'` on EVERY
// created event, including future-dated ones. The Phase 88 UAT walk surfaced the symptom — an
// event created for next Saturday never appears in Upcoming Events, because
// UpcomingEventsCard filters to scheduled/in_progress. routes/groups.js's leave-group cascade
// documents the same data-hygiene bug from the other side (it deliberately refuses a status
// filter because of it).
//
// IDEMPOTENT BY CONSTRUCTION: the WHERE clause is the exact negation of the post-condition, so a
// second run matches zero rows. Safe to replay (Phase 88.4 migrate-cli-replay), safe to re-run by
// hand against prod, safe on a database that already has zero affected rows. Test-pinned in
// tests/routes/events.test.js ("backfill idempotency" — second run changes 0 rows).
//
// SCOPE, deliberately narrow: `status = 'completed'` ONLY. 'cancelled' and 'in_progress' are
// operator/lifecycle states that a data repair has no authority to overwrite — a future event
// that was explicitly cancelled must STAY cancelled.
//
// DOWN IS A NO-OP, on purpose: this is a data repair, not reversible schema. There is no record
// of which rows were wrong before, and re-stamping future events 'completed' would deliberately
// re-introduce M4. A rollback of the accompanying default-flip migration (20260820000001) does
// not need this undone.
const BACKFILL_SQL = `
  UPDATE "Events"
     SET status = 'scheduled'
   WHERE start_date > NOW()
     AND status = 'completed';
`;

module.exports = {
  async up(queryInterface) {
    const [, metadata] = await queryInterface.sequelize.query(BACKFILL_SQL);
    const repaired = metadata && typeof metadata.rowCount === 'number' ? metadata.rowCount : 0;
    console.log(`[88-34/WI-B1] future-dated events re-stamped 'scheduled': ${repaired}`);
  },

  async down() {
    // Intentional no-op — see the header. Re-stamping future events 'completed' would
    // deliberately re-create the M4 defect this migration exists to repair.
  },
};
