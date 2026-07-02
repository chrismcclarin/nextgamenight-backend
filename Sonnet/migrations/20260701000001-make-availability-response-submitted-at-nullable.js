// migrations/20260701000001-make-availability-response-submitted-at-nullable.js
// Phase 87 / BINT-01 (T-87-12): make AvailabilityResponses.submitted_at nullable.
//
// The reminderWorker's claim-before-send path persists a not-yet-submitted
// PLACEHOLDER row (submitted_at NULL) as its per-reminder claim record. The
// original schema declared submitted_at NOT NULL, which would reject that
// placeholder INSERT and — after moving the claim BEFORE the email — leave
// first-eligible-only-at-90% users never reminded. A placeholder is by
// definition unsubmitted, so NULL is the correct semantic. Every "responded"
// query already filters on `submitted_at IS NOT NULL`, so a NULL placeholder is
// excluded from consensus/response counts.
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('AvailabilityResponses', 'submitted_at', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    // Best-effort revert. NOTE: any placeholder rows with submitted_at NULL must
    // be removed first or this changeColumn will fail — that is the intended
    // safety behavior (reverting reintroduces the NOT NULL invariant).
    await queryInterface.changeColumn('AvailabilityResponses', 'submitted_at', {
      type: Sequelize.DATE,
      allowNull: false,
    });
  },
};
