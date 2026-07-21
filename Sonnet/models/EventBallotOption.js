// models/EventBallotOption.js
// Ballot option model: stores game options for an event ballot
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const EventBallotOption = sequelize.define('EventBallotOption', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  event_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Events',
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  game_id: {
    type: DataTypes.UUID,
    allowNull: true, // null for free-text game entries not in the system
    references: {
      model: 'Games',
      key: 'id',
    },
  },
  game_name: {
    type: DataTypes.STRING,
    allowNull: false, // always stores the display name regardless of game_id
  },
  display_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // Phase 87.5 (BINT-02, BE PR-1 — D-01): created_by_uuid is the creator FK the model
  // keys on — a NULLABLE protective FK to the Users UUID PK, ON DELETE SET NULL. Ships in
  // BOTH this model (sync() builds the FK on the CI/test DB) AND migration 20260720000003
  // (prod). SET NULL because the creator is a soft attribution, not an ownership key: a
  // deleted creator's ballot options survive with a NULL creator (fall through to
  // owner/admin-only authz). The old `created_by` Auth0-string column is RETAINED as the
  // D-07 rollback net (dropped in the BE PR-2 contract migration, Plan 07).
  created_by_uuid: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id',
    },
    onDelete: 'SET NULL',
  },
  // Phase 87 (BINT-01, D-05): RETAINED legacy Auth0 sub of the ballot's creator. Kept as
  // the D-07 rollback net during the expand-contract window; readers/writers key
  // created_by_uuid after the Plan 04 flip. NULLABLE with NO backfill — legacy rows stay
  // NULL and fall through to owner/admin-only replace/wipe authz.
  created_by: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['event_id'],
    },
    {
      fields: ['event_id', 'game_name'],
      unique: true, // prevent duplicate game names on the same ballot
    },
    {
      // Phase 87.5: Postgres does not auto-index the FK-referencing side; the SET NULL
      // cascade + the accountDeletionService creator scrub (Plan 04) both key on this.
      fields: ['created_by_uuid'],
    },
  ],
});

module.exports = EventBallotOption;
