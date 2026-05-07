'use strict';

/**
 * Adds `reminder_count` column to `AvailabilityResponses`.
 *
 * The column was added to `models/AvailabilityResponse.js` (per AUTO-03
 * "max 2 reminders per user per prompt") but no migration was ever shipped,
 * so the model and DB schema diverged. Any Sequelize SELECT including all
 * model columns errored with `column "reminder_count" does not exist` /
 * `column "last_reminded_at" does not exist` (the sibling column from
 * 20260208000003-add-response-last-reminded-at.js, which also hadn't run on
 * some envs).
 *
 * Surfaced 2026-05-07 when a magic-link availability submission 500'd in
 * dev. Fix is additive — defaults reminder_count to 0 for existing rows.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('AvailabilityResponses', 'reminder_count', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 0,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('AvailabilityResponses', 'reminder_count');
  },
};
