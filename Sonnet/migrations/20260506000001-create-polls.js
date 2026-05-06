// migrations/20260506000001-create-polls.js
// Creates Polls + PollResponses tables for member-created availability polls (POLL-01).
// CRITICAL: includes a Postgres PARTIAL UNIQUE INDEX enforcing one open poll per
// group at a time (D-POLL-CREATE-10). Sequelize's addIndex doesn't support partial
// indexes natively, so we use raw SQL.
//
// Mirrors the executable-script shape used by other Phase 50+ migrations
// (see 20260501000001-create-scheduler-runs.js).
const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

async function up() {
  const queryInterface = sequelize.getQueryInterface();

  // ----- Polls table -----
  const pollsExists = await queryInterface.describeTable('Polls').catch(() => null);
  if (pollsExists) {
    console.log('Polls table already exists, skipping creation.');
  } else {
    await queryInterface.createTable('Polls', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      group_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'Groups', key: 'id' },
        onDelete: 'CASCADE',
      },
      created_by_user_id: {
        // STRING — Auth0 user_id, mirrors UserGroup.user_id pattern
        type: DataTypes.STRING,
        allowNull: false,
        references: { model: 'Users', key: 'user_id' },
        onDelete: 'CASCADE',
      },
      status: {
        type: DataTypes.ENUM('open', 'closed'),
        allowNull: false,
        defaultValue: 'open',
      },
      date_window_start: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      date_window_end: {
        type: DataTypes.DATEONLY,
        allowNull: false,
      },
      response_deadline: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      opened_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      closed_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      close_reason: {
        type: DataTypes.ENUM('manual', 'deadline', 'consensus'),
        allowNull: true,
      },
      // D-POLL-CREATE-07 cross-device dismissal — server-side state so a creator
      // who dismisses on desktop doesn't see the CTA again on mobile.
      closed_notification_dismissed_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });
    console.log('Created Polls table.');
  }

  // Indexes — non-unique
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS "polls_group_id_idx" ON "Polls" ("group_id");`
  );
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS "polls_status_idx" ON "Polls" ("status");`
  );
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS "polls_deadline_idx" ON "Polls" ("response_deadline");`
  );

  // CRITICAL — D-POLL-CREATE-10 one-open-per-group partial unique index.
  // Postgres-only. Sequelize.addIndex doesn't support partial indexes natively.
  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "polls_one_open_per_group_idx"
       ON "Polls" ("group_id") WHERE status = 'open';`
  );
  console.log('Created Polls indexes (incl. partial unique one-open-per-group).');

  // ----- PollResponses table -----
  const responsesExists = await queryInterface.describeTable('PollResponses').catch(() => null);
  if (responsesExists) {
    console.log('PollResponses table already exists, skipping creation.');
  } else {
    await queryInterface.createTable('PollResponses', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      poll_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'Polls', key: 'id' },
        onDelete: 'CASCADE',
      },
      user_id: {
        // STRING — Auth0 user_id
        type: DataTypes.STRING,
        allowNull: false,
        references: { model: 'Users', key: 'user_id' },
        onDelete: 'CASCADE',
      },
      // slot_data: JSONB array of { date, slot, available, preference? }
      // Mirror shape used by UserAvailability/AvailabilityResponse.time_slots so
      // the same heatmap aggregator can consume it.
      slot_data: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      submitted_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    });
    console.log('Created PollResponses table.');
  }

  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS "poll_responses_poll_id_idx" ON "PollResponses" ("poll_id");`
  );
  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "poll_responses_poll_user_unique"
       ON "PollResponses" ("poll_id", "user_id");`
  );
  console.log('Created PollResponses indexes (incl. unique poll_id+user_id).');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await sequelize.query('DROP INDEX IF EXISTS "poll_responses_poll_user_unique";');
  await sequelize.query('DROP INDEX IF EXISTS "poll_responses_poll_id_idx";');
  await queryInterface.dropTable('PollResponses').catch(() => {});

  await sequelize.query('DROP INDEX IF EXISTS "polls_one_open_per_group_idx";');
  await sequelize.query('DROP INDEX IF EXISTS "polls_deadline_idx";');
  await sequelize.query('DROP INDEX IF EXISTS "polls_status_idx";');
  await sequelize.query('DROP INDEX IF EXISTS "polls_group_id_idx";');
  await queryInterface.dropTable('Polls').catch(() => {});
  await sequelize.query('DROP TYPE IF EXISTS "enum_Polls_status";');
  await sequelize.query('DROP TYPE IF EXISTS "enum_Polls_close_reason";');
  console.log('Dropped Polls + PollResponses tables and enums.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
