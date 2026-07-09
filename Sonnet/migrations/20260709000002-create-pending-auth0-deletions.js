'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.2 (REQ-6, D-08) — create the PendingAuth0Deletions marker table.
//
// This is the PROD source (runs under `migrate:apply` → `npx sequelize-cli
// db:migrate`, tracked in SequelizeMeta); models/PendingAuth0Deletion.js is the
// sync()-built test/CI-DB source. Both MUST carry the identical schema.
//
// The row must OUTLIVE the hard-deleted Users row (D-08), so there is intentionally
// NO foreign key to Users. auth0_sub is UNIQUE (natural dedupe — one pending
// deletion per subject). Idempotent: describeTable guard makes re-run a no-op
// (T-87.2-02, repo migrate-cli-replay CI job).
const TABLE = 'PendingAuth0Deletions';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Idempotency guard — skip if the table already exists (partial apply / replay).
    const exists = await queryInterface.describeTable(TABLE).catch(() => null);
    if (exists) {
      console.log(`[PAD] ${TABLE} already exists, skipping creation.`);
      return;
    }

    await queryInterface.createTable(TABLE, {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      auth0_sub: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true, // natural dedupe — one pending deletion per Auth0 subject
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      attempts: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      last_attempt_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
      },
    });
    console.log(`[PAD] Created ${TABLE} table (no Users FK — must outlive the deleted user).`);
  },

  async down(queryInterface) {
    await queryInterface.dropTable(TABLE);
  },
};
