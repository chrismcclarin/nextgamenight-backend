// migrations/20260507000002-add-availability-prompt-creator.js
//
// Phase 71.2 / Plan 01 — Adds AvailabilityPrompts.created_by_user_id (D-SCHEMA-04)
// and a partial unique index enforcing "one open manual poll per group" (D-ADAPT-02).
//
// Per D-SCHEMA-04: nullable UUID, FK Users.id, NO backfill. Existing rows stay NULL,
// which correctly reads as "auto-prompt or legacy" via the discriminator (rows where
// created_by_settings_id IS NOT NULL are auto-prompts; the rest are legacy).
//
// Per D-ADAPT-02 (Claude's Discretion in CONTEXT): we picked DB-level enforcement
// (partial unique index) over an application check because the codebase already
// has the partial-unique-index pattern (see 20260228000001-create-group-invites-table.js
// lines 80-88) and DB enforcement is race-free for free.
//
// Mirrors the executable-script shape used by other Phase 50+ migrations in this repo
// (the project does NOT use sequelize-cli; migrations run via `node migrations/<file>.js`).
const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

async function up() {
  const queryInterface = sequelize.getQueryInterface();

  // Step 1: Idempotency guard — only add the column if it doesn't already exist.
  // describeTable on PascalCase tables works on Postgres because Sequelize quotes them.
  const tableDesc = await queryInterface.describeTable('AvailabilityPrompts').catch(() => null);
  if (!tableDesc) {
    throw new Error('AvailabilityPrompts table not found — cannot add created_by_user_id.');
  }

  if (!tableDesc.created_by_user_id) {
    await queryInterface.addColumn('AvailabilityPrompts', 'created_by_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      // Per D-SCHEMA-04: NULL = legacy / auto-prompt (created_by_settings_id discriminates);
      // NOT NULL = manual poll, populated from dbUser.id at create time.
    });
    console.log('Added AvailabilityPrompts.created_by_user_id column.');
  } else {
    console.log('AvailabilityPrompts.created_by_user_id already exists, skipping addColumn.');
  }

  // Step 2: Index for query speed on the new FK column.
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "availability_prompts_created_by_user_idx"
    ON "AvailabilityPrompts" ("created_by_user_id")
  `);
  console.log('Added index availability_prompts_created_by_user_idx.');

  // Step 3: Partial unique index implementing D-ADAPT-02 — at most one open
  // manual poll per group. "Open" = status IN ('pending','active'); "manual" =
  // created_by_settings_id IS NULL. Auto-prompts (created_by_settings_id NOT NULL)
  // are unaffected, so a manual poll and an auto-prompt can coexist per group.
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "availability_prompts_one_open_manual"
    ON "AvailabilityPrompts" ("group_id")
    WHERE "created_by_settings_id" IS NULL AND "status" IN ('pending', 'active')
  `);
  console.log('Added partial unique index availability_prompts_one_open_manual (D-ADAPT-02).');
}

async function down() {
  // Reverse in opposite order.
  await sequelize.query('DROP INDEX IF EXISTS "availability_prompts_one_open_manual";');
  await sequelize.query('DROP INDEX IF EXISTS "availability_prompts_created_by_user_idx";');
  const queryInterface = sequelize.getQueryInterface();
  const tableDesc = await queryInterface.describeTable('AvailabilityPrompts').catch(() => null);
  if (tableDesc && tableDesc.created_by_user_id) {
    await queryInterface.removeColumn('AvailabilityPrompts', 'created_by_user_id');
    console.log('Removed AvailabilityPrompts.created_by_user_id column.');
  }
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
