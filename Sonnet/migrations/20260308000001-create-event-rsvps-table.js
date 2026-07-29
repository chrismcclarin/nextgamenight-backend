// migrations/20260308000001-create-event-rsvps-table.js
// Creates EventRsvps table for event RSVP responses (yes/no/maybe with optional note)
//
// ---------------------------------------------------------------------------------------
// AMENDED by Phase 88.4 Plan 01 (SPEC R1) — 2026-07-29. Unquoted ENUM type name.
// ---------------------------------------------------------------------------------------
// Identical defect and identical fix to 20260228000001-create-group-invites-table.js: the
// `status` column's raw-STRING type went into the DDL verbatim and unquoted, so PostgreSQL
// down-folded the mixed-case name and could not resolve it:
//
//   ERROR: type "enum_eventrsvps_status" does not exist
//
// The type IS created, correctly quoted, by the DO block above. One pair of quotes on the
// column's type string is the whole fix.
//
// Never caught because Step 1's `describeTable('EventRsvps')` guard took the "already exists"
// branch on every database that has run this migration (sync() had built the table from
// models/EventRsvp.js first). The createTable branch had never executed anywhere until Phase
// 88.4 opened the from-empty replay path.
//
// PROD IMPACT: none — booked in prod's SequelizeMeta, never re-run.
//
// A census of the whole chain found exactly two migrations with this defect (this one and
// 20260228000001). `20260618000002-create-single-use-tokens.js:55,75` uses the same raw-string
// form but its type names are ALL LOWERCASE (`enum_single_use_tokens_purpose`/`_status`), so
// unquoted down-folding is a no-op there and it is correct as written — do not "fix" it.
// `20260227000004-create-friendships-table.js:46` already carried the quoted form, which is
// the in-repo precedent this amendment follows.
//
// DECISION Phase 88.4 R-1d: quote the existing raw type string OVER switching to
// DataTypes.ENUM — the DO block above is this migration's deliberate, idempotent
// type-creation mechanism; DataTypes.ENUM would emit a second competing CREATE TYPE and
// schema-qualify the column type. See the fuller rationale in 20260228000001.
// ---------------------------------------------------------------------------------------
const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

async function up() {
  const queryInterface = sequelize.getQueryInterface();

  // Step 1: Check if table already exists (idempotent)
  const tableExists = await queryInterface.describeTable('EventRsvps').catch(() => null);
  if (tableExists) {
    console.log('EventRsvps table already exists, skipping creation.');
  } else {
    // Step 2: Create ENUM type idempotently via raw SQL DO/EXCEPTION block
    await sequelize.query(`
      DO $$
      BEGIN
        CREATE TYPE "enum_EventRsvps_status" AS ENUM ('yes', 'no', 'maybe');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // Step 3: Create EventRsvps table
    await queryInterface.createTable('EventRsvps', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      event_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'Events',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: DataTypes.STRING,
        allowNull: false,
        // Auth0 string ID, not UUID -- matches UserGroup pattern
      },
      status: {
        // Phase 88.4 R-1d: QUOTED on purpose — an unquoted raw-string type folds to
        // `enum_eventrsvps_status`, which does not exist. Do not remove these inner quotes.
        type: '"enum_EventRsvps_status"',
        allowNull: false,
      },
      note: {
        type: DataTypes.TEXT,
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
    console.log('Created EventRsvps table.');
  }

  // Step 4: Add indexes (idempotent with IF NOT EXISTS)
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "event_rsvps_event_id" ON "EventRsvps" ("event_id")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "event_rsvps_user_id" ON "EventRsvps" ("user_id")
  `);
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "event_rsvps_event_user_unique"
    ON "EventRsvps" ("event_id", "user_id")
  `);
  console.log('Added indexes on event_id, user_id, and unique compound [event_id, user_id].');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.dropTable('EventRsvps');
  await sequelize.query('DROP TYPE IF EXISTS "enum_EventRsvps_status"');
  console.log('Dropped EventRsvps table and ENUM type.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
