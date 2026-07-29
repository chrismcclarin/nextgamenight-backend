// migrations/20260129-create-group-prompt-settings.js
//
// ---------------------------------------------------------------------------------------
// AMENDED by Phase 88.4 Plan 01 (SPEC R1) — 2026-07-29. Receives a DEFERRED FK.
// ---------------------------------------------------------------------------------------
// WHAT CHANGED: one idempotent block was appended to up() that attaches
// "AvailabilityPrompts".created_by_settings_id -> "GroupPromptSettings".id after this
// migration creates the target table. Nothing else changed.
//
// WHY: `20260129-create-availability-prompt.js` sorts BEFORE this file yet declares an FK to
// the table THIS file creates — a forward reference, fatal on a from-empty replay
// (`relation "GroupPromptSettings" does not exist`) and invisible in the sync() era because
// sync() had already built this table from its model. Renaming either file was rejected: both
// filenames are booked in prod's SequelizeMeta and are therefore immutable. So the sibling
// creates the column bare when the target is absent, and the FK lands here instead — same
// constraint, same Postgres-default name, same ON DELETE SET NULL, one migration later.
//
// PROD IMPACT: none. Booked since January 2026, so `migrate:apply` never re-runs it. The block
// is additionally idempotent (duplicate_object swallowed), so it is a no-op anywhere the FK
// already exists — which is prod and every sync-built database.
//
// DECISION Phase 88.4 R-1c: attach the deferred FK here OVER leaving the from-empty chain
// without it — a missing constraint would make the replayed schema differ from prod, and the
// entire point of Plans 04/05 is to diff those two and treat any difference as drift. An FK
// silently absent on one path is exactly the drift this phase exists to catch.
// ---------------------------------------------------------------------------------------
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('GroupPromptSettings', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      group_id: {
        type: Sequelize.UUID,
        allowNull: false,
        unique: true,
        references: {
          model: 'Groups',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      schedule_day_of_week: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      schedule_time: {
        type: Sequelize.TIME,
        allowNull: true,
      },
      schedule_timezone: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'UTC',
      },
      default_deadline_hours: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 72,
      },
      default_token_expiry_hours: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 168,
      },
      min_participants: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      template_name: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      template_config: {
        type: Sequelize.JSONB,
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

    // Create indexes
    await queryInterface.addIndex('GroupPromptSettings', ['group_id'], {
      unique: true,
      name: 'group_prompt_settings_group_id_unique'
    });
    await queryInterface.addIndex('GroupPromptSettings', ['is_active']);
    await queryInterface.addIndex('GroupPromptSettings', ['schedule_day_of_week', 'schedule_time']);

    // Phase 88.4 deferred FK — see the header. The constraint name is the Postgres default
    // that an inline Sequelize `references` would have produced, so the from-empty schema is
    // byte-identical to prod's. `duplicate_object` is swallowed (the house idiom from
    // 20260228000001-create-group-invites-table.js), making this a no-op wherever the FK
    // already exists.
    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        ALTER TABLE "AvailabilityPrompts"
          ADD CONSTRAINT "AvailabilityPrompts_created_by_settings_id_fkey"
          FOREIGN KEY ("created_by_settings_id")
          REFERENCES "GroupPromptSettings" ("id")
          ON DELETE SET NULL;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);
    console.log(
      '[88.4-fwdref] AvailabilityPrompts.created_by_settings_id -> GroupPromptSettings.id FK ensured.'
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('GroupPromptSettings');
  }
};
