// migrations/20260228000001-create-group-invites-table.js
// Creates GroupInvites table for consent-based group membership invitations
//
// ---------------------------------------------------------------------------------------
// AMENDED by Phase 88.4 Plan 01 (SPEC R1) — 2026-07-29. Unquoted ENUM type name.
// ---------------------------------------------------------------------------------------
// WHAT CHANGED: the `status` column's raw type string gained double quotes —
// `'enum_GroupInvites_status'` became `'"enum_GroupInvites_status"'`. One pair of quotes.
//
// WHY: a raw-STRING `type:` is passed through into the DDL verbatim, so the unquoted form
// emitted `"status" enum_GroupInvites_status`, which PostgreSQL down-folds to
// `enum_groupinvites_status` and then cannot resolve:
//
//   ERROR: type "enum_groupinvites_status" does not exist
//
// The type is created (correctly quoted, mixed case) by the DO block a few lines below, so
// the column definition had to quote it too. Verified with this repo's own installed
// Sequelize 6.37.7 query generator: the quoted form emits
// `"status" "enum_GroupInvites_status"` and is otherwise byte-identical DDL.
//
// WHY IT WAS NEVER CAUGHT: Step 1's `describeTable('GroupInvites')` guard. In the sync() era
// this table already existed (sync() had built it from models/GroupInvite.js with a proper
// Sequelize ENUM), so the guard took the "already exists, skipping creation" branch on every
// database that has ever run this migration. The createTable branch below had NEVER executed
// anywhere until Phase 88.4 opened the from-empty path. Same class of latent defect as R-1.
//
// PROD IMPACT: none. Booked in prod's SequelizeMeta, so `migrate:apply` never re-runs it.
//
// REJECTED: switching to `DataTypes.ENUM('pending','accepted','declined')`. That is the more
// idiomatic Sequelize spelling, but it makes the query generator emit its OWN `CREATE TYPE`
// for the enum in addition to the DO block above, and it schema-qualifies the column type as
// `"public"."enum_GroupInvites_status"`. Two ways to create one type in one migration is worse
// than a correctly quoted reference to the one the migration already deliberately creates by
// hand. Do not "modernize" this to DataTypes.ENUM without deleting the DO block.
//
// DECISION Phase 88.4 R-1d: quote the existing raw type string OVER replacing it with
// DataTypes.ENUM — the DO block above is the deliberate type-creation mechanism here (it
// exists to be idempotent); DataTypes.ENUM would add a second, competing one and change the
// emitted DDL. The quotes are the whole fix.
// ---------------------------------------------------------------------------------------
const sequelize = require('../config/database');
const { DataTypes } = require('sequelize');

async function up() {
  const queryInterface = sequelize.getQueryInterface();

  // Step 1: Check if table already exists (idempotent)
  const tableExists = await queryInterface.describeTable('GroupInvites').catch(() => null);
  if (tableExists) {
    console.log('GroupInvites table already exists, skipping creation.');
  } else {
    // Step 2: Create ENUM type idempotently via raw SQL DO/EXCEPTION block
    // Same pattern as Phase 19 UserGroup status migration
    await sequelize.query(`
      DO $$
      BEGIN
        CREATE TYPE "enum_GroupInvites_status" AS ENUM ('pending', 'accepted', 'declined');
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // Step 3: Create GroupInvites table
    await queryInterface.createTable('GroupInvites', {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      group_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'Groups',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      invited_email: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      invited_by: {
        type: DataTypes.STRING,
        allowNull: false,
        // References Users.user_id (Auth0 string), not Users.id (UUID)
      },
      token: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      status: {
        // Phase 88.4 R-1d: QUOTED on purpose — a raw-string type goes into the DDL verbatim,
        // and unquoted PostgreSQL folds it to `enum_groupinvites_status`, which does not
        // exist. Do not remove these inner quotes.
        type: '"enum_GroupInvites_status"',
        defaultValue: 'pending',
        allowNull: false,
      },
      accepted_at: {
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
    console.log('Created GroupInvites table.');
  }

  // Step 4: Add partial unique index via raw SQL
  // Prevents duplicate pending invites to the same email+group (case-insensitive)
  // Allows re-inviting after a decline since the WHERE clause filters on status='pending'
  await sequelize.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "group_invites_pending_unique"
    ON "GroupInvites" ("group_id", LOWER("invited_email"))
    WHERE "status" = 'pending'
  `);
  console.log('Added partial unique index: group_invites_pending_unique');

  // Step 5: Add remaining indexes (idempotent with IF NOT EXISTS)
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "group_invites_token" ON "GroupInvites" ("token")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "group_invites_invited_email" ON "GroupInvites" ("invited_email")
  `);
  await sequelize.query(`
    CREATE INDEX IF NOT EXISTS "group_invites_status" ON "GroupInvites" ("status")
  `);
  console.log('Added indexes on token, invited_email, status.');
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.dropTable('GroupInvites');
  await sequelize.query('DROP TYPE IF EXISTS "enum_GroupInvites_status"');
  console.log('Dropped GroupInvites table and ENUM type.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
