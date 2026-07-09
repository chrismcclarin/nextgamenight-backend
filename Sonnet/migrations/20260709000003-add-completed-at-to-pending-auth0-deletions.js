'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.2 / Plan 05 Task 2 (REQ-6 tombstone retention) — add the nullable
// completed_at column to PendingAuth0Deletions.
//
// Auth0 deletion does not revoke already-issued access tokens (~24h max TTL), so
// the marker row doubles as the tombstone the Users-create guards read. On Auth0
// deletion SUCCESS the worker now marks the row completed (completed_at = now,
// email nulled) instead of destroying it — an immediate hard-delete would reopen
// the JIT re-provision hole the moment the worker succeeds. The reconciliation
// sweep purges rows whose completed_at is older than the 24h retention window.
//
// Dual-write (RESEARCH Pitfall 3): this migration is the PROD source; the same
// column lives in models/PendingAuth0Deletion.js for sync()-built test/CI DBs.
// Idempotent: describeTable guard makes re-run a no-op (migrate-cli-replay CI job).
const TABLE = 'PendingAuth0Deletions';
const COLUMN = 'completed_at';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotency guard — skip if the column already exists (partial apply / replay).
    const table = await queryInterface.describeTable(TABLE).catch(() => null);
    if (!table) {
      // Table not created yet (out-of-order replay) — the create-table migration
      // (20260709000002) carries the full schema on fresh DBs going forward; but
      // since it predates this column, fail loudly rather than silently skipping.
      throw new Error(`[PAD] ${TABLE} does not exist — run 20260709000002 first.`);
    }
    if (table[COLUMN]) {
      console.log(`[PAD] ${TABLE}.${COLUMN} already exists, skipping.`);
      return;
    }

    await queryInterface.addColumn(TABLE, COLUMN, {
      type: Sequelize.DATE,
      allowNull: true,
    });
    console.log(`[PAD] Added ${TABLE}.${COLUMN} (tombstone retention — mark-completed instead of destroy).`);
  },

  async down(queryInterface) {
    const table = await queryInterface.describeTable(TABLE).catch(() => null);
    if (table && table[COLUMN]) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
