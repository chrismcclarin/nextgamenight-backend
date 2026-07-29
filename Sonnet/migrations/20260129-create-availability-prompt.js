// migrations/20260129-create-availability-prompt.js
//
// ---------------------------------------------------------------------------------------
// AMENDED by Phase 88.4 Plan 01 (SPEC R1) — 2026-07-29. FORWARD-REFERENCE FIX.
// ---------------------------------------------------------------------------------------
// WHAT CHANGED: the `created_by_settings_id` FK to "GroupPromptSettings" is now added only
// when that table already exists; when it does not, the column is created bare and the FK is
// attached by its sibling `20260129-create-group-prompt-settings.js` (which creates the
// referenced table and runs immediately after this file). Nothing else changed. The two
// paths converge on the SAME constraint, with the same Postgres-default name
// `AvailabilityPrompts_created_by_settings_id_fkey` and the same ON DELETE SET NULL.
//
// WHY: this migration sorts BEFORE the migration that creates the table it references —
// `20260129-create-availability-prompt.js` < `20260129-create-group-prompt-settings.js`
// alphabetically. A forward reference. It was invisible for six months because in the sync()
// era `sequelize.sync()` had already built "GroupPromptSettings" from its model before any
// migration ran, so the FK resolved. On a genuinely empty database — the path Phase 88.4
// opened with the baseline migration — it is fatal:
//
//   ERROR: relation "GroupPromptSettings" does not exist
//
// A repo-wide census of the chain (every `references: { model }`, `references: 'X'`,
// `addConstraint({ references: { table } })` and raw `REFERENCES "X" (`, checked against the
// set of tables created by all earlier-sorting migrations) found this to be the ONLY forward
// reference in all 77 files. It is a one-off, not the first of a class.
//
// REJECTED: renaming/renumbering either file so they sort correctly. Both filenames have been
// booked in prod's `SequelizeMeta` since January 2026 — a rename makes prod see a brand-new
// migration and re-run it against a fully populated database. Filenames in this directory are
// immutable for that reason.
//
// PROD IMPACT: none. Booked since January 2026, so `migrate:apply` never re-runs it; the new
// branch is reachable only on a from-empty replay.
//
// DECISION Phase 88.4 R-1c: split the FK away from the createTable (add it from the sibling
// that creates the target) OVER renaming a migration file to fix the sort order — filenames
// are booked in prod's SequelizeMeta and are therefore immutable; renaming one trades a
// CI-only failure for a prod re-run. Do not "tidy" this by moving the `references` block back
// inline: that restores the from-empty failure.
// ---------------------------------------------------------------------------------------
'use strict';

// Phase 88.4: two-pronged missing-table detection. Sequelize 6 on Postgres does NOT raise
// SQLSTATE 42P01 from describeTable — the information_schema query succeeds with zero rows
// and query-interface.js throws a plain Error starting `No description found for`. 42P01 is
// checked as well because a raw-query probe WOULD raise it. Anything else rethrows.
async function tableExists(queryInterface, tableName) {
  try {
    await queryInterface.describeTable(tableName);
    return true;
  } catch (err) {
    const missingRelation =
      (typeof err.message === 'string' && err.message.startsWith('No description found for')) ||
      (err.original && err.original.code === '42P01') ||
      (err.parent && err.parent.code === '42P01');
    if (!missingRelation) throw err;
    return false;
  }
}

module.exports = {
  async up(queryInterface, Sequelize) {
    // Create ENUM type first
    await queryInterface.sequelize.query(`
      CREATE TYPE "enum_AvailabilityPrompts_status" AS ENUM ('pending', 'active', 'closed', 'converted');
    `);

    // Phase 88.4 forward-reference fix — see the header.
    const promptSettingsExists = await tableExists(queryInterface, 'GroupPromptSettings');
    const createdBySettingsId = {
      type: Sequelize.UUID,
      allowNull: true,
    };
    if (promptSettingsExists) {
      createdBySettingsId.references = { model: 'GroupPromptSettings', key: 'id' };
      createdBySettingsId.onDelete = 'SET NULL';
    } else {
      console.log(
        '[88.4-fwdref] "GroupPromptSettings" not created yet — creating AvailabilityPrompts.created_by_settings_id without its FK; 20260129-create-group-prompt-settings will attach it.'
      );
    }

    await queryInterface.createTable('AvailabilityPrompts', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      group_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'Groups',
          key: 'id',
        },
        onDelete: 'CASCADE',
      },
      game_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: {
          model: 'Games',
          key: 'id',
        },
        onDelete: 'SET NULL',
      },
      prompt_date: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      deadline: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM('pending', 'active', 'closed', 'converted'),
        allowNull: false,
        defaultValue: 'pending',
      },
      week_identifier: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      created_by_settings_id: createdBySettingsId,
      custom_message: {
        type: Sequelize.TEXT,
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
    await queryInterface.addIndex('AvailabilityPrompts', ['group_id']);
    await queryInterface.addIndex('AvailabilityPrompts', ['status']);
    await queryInterface.addIndex('AvailabilityPrompts', ['deadline']);
    await queryInterface.addIndex('AvailabilityPrompts', ['group_id', 'week_identifier'], {
      unique: true,
      name: 'availability_prompts_group_week_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('AvailabilityPrompts');
    // Drop ENUM type
    await queryInterface.sequelize.query(`
      DROP TYPE IF EXISTS "enum_AvailabilityPrompts_status";
    `);
  }
};
