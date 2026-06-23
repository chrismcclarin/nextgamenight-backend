'use strict';

// D-04 / BSEC-03 — dedicated single_use_tokens table backing the OAuth state
// nonce + single-use RSVP. Uses the sequelize-cli `up(queryInterface, Sequelize)`
// signature because prod runs `npm run migrate:apply` (sequelize-cli db:migrate);
// the self-invoking createTable style is a no-op under that runner.
//
// ENUM idempotency: a partial-failure re-run must not throw "type already exists",
// so CREATE TYPE is guarded by a pg_type existence check and down() drops the types.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Idempotent ENUM creation (guard against partial re-run).
    await queryInterface.sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_single_use_tokens_purpose') THEN
          CREATE TYPE "enum_single_use_tokens_purpose" AS ENUM('oauth_state', 'rsvp');
        END IF;
      END $$;
    `);
    await queryInterface.sequelize.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'enum_single_use_tokens_status') THEN
          CREATE TYPE "enum_single_use_tokens_status" AS ENUM('active', 'used', 'revoked');
        END IF;
      END $$;
    `);

    // 2. Create the table (skip if it already exists — idempotent re-run).
    const tableExists = await queryInterface
      .describeTable('single_use_tokens')
      .then(() => true)
      .catch(() => false);

    if (!tableExists) {
      await queryInterface.createTable('single_use_tokens', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
          allowNull: false,
        },
        nonce: {
          type: Sequelize.STRING,
          allowNull: false,
          unique: true,
        },
        user_id: {
          // Auth0 string ID, NOT a UUID.
          type: Sequelize.STRING,
          allowNull: false,
        },
        purpose: {
          type: 'enum_single_use_tokens_purpose',
          allowNull: false,
        },
        event_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        email_batch_id: {
          type: Sequelize.UUID,
          allowNull: true,
        },
        rsvp_status: {
          type: Sequelize.STRING,
          allowNull: true,
        },
        frontend_url: {
          type: Sequelize.STRING,
          allowNull: true,
        },
        status: {
          type: 'enum_single_use_tokens_status',
          allowNull: false,
          defaultValue: 'active',
        },
        expires_at: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        used_at: {
          type: Sequelize.DATE,
          allowNull: true,
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
      });
    }

    // 3. Indexes (separate CREATE INDEX IF NOT EXISTS so re-run is safe).
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "single_use_tokens_nonce_unique" ON "single_use_tokens" ("nonce");`
    );
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "single_use_tokens_status_expires_at" ON "single_use_tokens" ("status", "expires_at");`
    );
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "single_use_tokens_email_batch_id" ON "single_use_tokens" ("email_batch_id");`
    );
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS "single_use_tokens_purpose_user_event_status" ON "single_use_tokens" ("purpose", "user_id", "event_id", "status");`
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('single_use_tokens');
    // Drop the ENUM types so a clean re-run does not collide.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_single_use_tokens_status";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_single_use_tokens_purpose";');
  },
};
