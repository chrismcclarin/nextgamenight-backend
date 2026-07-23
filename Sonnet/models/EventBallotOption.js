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
  // owner/admin-only authz). The old `created_by` Auth0-string attribute has been REMOVED
  // from this model (BE PR-2 cutover, Plan 07): its physical DB column is dropped by
  // migration 20260721000003, so leaving the attribute declared would make Sequelize's
  // default attribute enumeration SELECT the dropped column and 500 every read. Mirrors
  // the 87.1 UserGroup cutover.
  created_by_uuid: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id',
    },
    onDelete: 'SET NULL',
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
