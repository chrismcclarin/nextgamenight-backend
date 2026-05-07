// migrations/20260507000003-add-group-prompt-settings-creator.js
//
// Phase 71.2 / Plan 01 — D-SCHEMA-06: adds GroupPromptSettings.created_by_user_id.
//
// Required to honor D-ADAPT-05 literally — auto-prompt close-notification recipient
// must resolve to the schedule creator. Existing rows backfill as NULL; runtime
// resolution rule for auto-prompts is `settings.created_by_user_id || group owner`,
// which keeps legacy rows working via the group-owner fallback.
//
// Implementation note: GroupPromptSettings is currently a one-row-per-group table
// where individual schedules live inside template_config.schedules (JSONB array).
// This column therefore tracks "the user who FIRST set up scheduling for this group"
// — which matches the D-ADAPT-05 intent for the common case (a single schedule owner)
// and falls back to group owner via the runtime rule for edge cases. If per-schedule
// creator-tracking is needed later, the per-schedule object inside template_config.schedules
// can also gain a created_by_user_id key without a schema change. (Documented in SUMMARY.md.)
//
// Mirrors the executable-script migration shape used by other Phase 50+ migrations.
const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

async function up() {
  const queryInterface = sequelize.getQueryInterface();

  const tableDesc = await queryInterface.describeTable('GroupPromptSettings').catch(() => null);
  if (!tableDesc) {
    throw new Error('GroupPromptSettings table not found — cannot add created_by_user_id.');
  }

  if (!tableDesc.created_by_user_id) {
    await queryInterface.addColumn('GroupPromptSettings', 'created_by_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      // Per D-SCHEMA-06: NULL = legacy / pre-migration row (resolves to group-owner
      // fallback at runtime per D-ADAPT-05). NOT NULL = the user who created the
      // first schedule for this group (set at POST /group-prompt-settings/schedules
      // create time when the GroupPromptSettings row is first inserted).
    });
    console.log('Added GroupPromptSettings.created_by_user_id column.');
  } else {
    console.log('GroupPromptSettings.created_by_user_id already exists, skipping addColumn.');
  }

  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "group_prompt_settings_created_by_user_idx"
    ON "GroupPromptSettings" ("created_by_user_id")
  `);
  console.log('Added index group_prompt_settings_created_by_user_idx.');
}

async function down() {
  await sequelize.query('DROP INDEX IF EXISTS "group_prompt_settings_created_by_user_idx";');
  const queryInterface = sequelize.getQueryInterface();
  const tableDesc = await queryInterface.describeTable('GroupPromptSettings').catch(() => null);
  if (tableDesc && tableDesc.created_by_user_id) {
    await queryInterface.removeColumn('GroupPromptSettings', 'created_by_user_id');
    console.log('Removed GroupPromptSettings.created_by_user_id column.');
  }
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
