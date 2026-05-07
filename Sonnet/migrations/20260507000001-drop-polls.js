// migrations/20260507000001-drop-polls.js
// Forward-drop the parallel Polls + PollResponses tables introduced by Phase
// 71-04 (commit 4adbf90) and the poll_created notification-prefs backfill from
// Phase 71-04 (commit 4adbf90 / migration 20260506000002).
//
// The 71-04 + 71-05 work was a scope-inflated implementation of the 2026-05-01
// todo, which asked for a small extension to the existing AvailabilityPrompt
// system, NOT a parallel data model. Per user redirect on 2026-05-07 we are
// scrapping the parallel Polls system; POLL-01 will be rebuilt as a small
// extension to the existing AvailabilityPrompt flow in a follow-up round.
//
// History note: rather than rewriting git history, we forward-revert via NEW
// commits and a NEW migration. If anyone ever wants to bring this back, the
// original creation migration can be reconstructed from `git show 4adbf90`,
// and the down() function below also recreates the schema.
//
// Mirrors the executable-script shape used by other Phase 50+ migrations.
const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

async function up() {
  const queryInterface = sequelize.getQueryInterface();

  // Reverse the JSONB backfill from migration 20260506000002.
  // For each user with explicit notification_preferences, remove the
  // poll_created key. NULL prefs rows are left alone (they read defaults
  // from notificationService.getPreference at read time).
  await sequelize.query(`
    UPDATE "Users"
    SET notification_preferences = notification_preferences - 'poll_created'
    WHERE notification_preferences IS NOT NULL
      AND notification_preferences ? 'poll_created';
  `);
  console.log('Removed poll_created prefs key from existing rows.');

  // Drop PollResponses first — has FK to Polls.
  await sequelize.query('DROP INDEX IF EXISTS "poll_responses_poll_user_unique";');
  await sequelize.query('DROP INDEX IF EXISTS "poll_responses_poll_id_idx";');
  await queryInterface.dropTable('PollResponses').catch(() => {});
  console.log('Dropped PollResponses table.');

  // Drop the partial unique index defensively before the table — Postgres
  // SHOULD drop it with the table, but spec requires belt-and-suspenders.
  await sequelize.query('DROP INDEX IF EXISTS "polls_one_open_per_group_idx";');
  await sequelize.query('DROP INDEX IF EXISTS "polls_deadline_idx";');
  await sequelize.query('DROP INDEX IF EXISTS "polls_status_idx";');
  await sequelize.query('DROP INDEX IF EXISTS "polls_group_id_idx";');
  await queryInterface.dropTable('Polls').catch(() => {});
  // Drop the ENUM types Sequelize created for the dropped Polls columns.
  await sequelize.query('DROP TYPE IF EXISTS "enum_Polls_status";');
  await sequelize.query('DROP TYPE IF EXISTS "enum_Polls_close_reason";');
  console.log('Dropped Polls table + indexes + ENUM types.');
}

async function down() {
  // Re-create the schema as it existed in commit 4adbf90 so down + up is a
  // round-trip no-op for anyone who needs to walk migrations backward. NOTE:
  // running this down() will NOT restore the Sequelize models or the routes
  // — those files are also deleted. This recreates the tables only.
  const queryInterface = sequelize.getQueryInterface();

  // ----- Polls table -----
  const pollsExists = await queryInterface.describeTable('Polls').catch(() => null);
  if (!pollsExists) {
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
      date_window_start: { type: DataTypes.DATEONLY, allowNull: false },
      date_window_end: { type: DataTypes.DATEONLY, allowNull: false },
      response_deadline: { type: DataTypes.DATE, allowNull: false },
      opened_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      closed_at: { type: DataTypes.DATE, allowNull: true },
      close_reason: { type: DataTypes.ENUM('manual', 'deadline', 'consensus'), allowNull: true },
      closed_notification_dismissed_at: { type: DataTypes.DATE, allowNull: true },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    });
  }

  await sequelize.query(`CREATE INDEX IF NOT EXISTS "polls_group_id_idx" ON "Polls" ("group_id");`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS "polls_status_idx" ON "Polls" ("status");`);
  await sequelize.query(`CREATE INDEX IF NOT EXISTS "polls_deadline_idx" ON "Polls" ("response_deadline");`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "polls_one_open_per_group_idx" ON "Polls" ("group_id") WHERE status = 'open';`);

  // ----- PollResponses table -----
  const responsesExists = await queryInterface.describeTable('PollResponses').catch(() => null);
  if (!responsesExists) {
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
        type: DataTypes.STRING,
        allowNull: false,
        references: { model: 'Users', key: 'user_id' },
        onDelete: 'CASCADE',
      },
      slot_data: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
      submitted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    });
  }
  await sequelize.query(`CREATE INDEX IF NOT EXISTS "poll_responses_poll_id_idx" ON "PollResponses" ("poll_id");`);
  await sequelize.query(`CREATE UNIQUE INDEX IF NOT EXISTS "poll_responses_poll_user_unique" ON "PollResponses" ("poll_id", "user_id");`);

  // Re-backfill the JSONB key (matches migration 20260506000002).
  await sequelize.query(`
    UPDATE "Users"
    SET notification_preferences = jsonb_set(
      notification_preferences,
      '{poll_created}',
      '{"email": true, "sms": false}'::jsonb,
      true
    )
    WHERE notification_preferences IS NOT NULL
      AND NOT (notification_preferences ? 'poll_created');
  `);
  console.log('Re-created Polls + PollResponses tables and re-backfilled poll_created prefs.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
