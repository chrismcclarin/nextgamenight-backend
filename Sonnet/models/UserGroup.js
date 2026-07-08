// models/UserGroup.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');


const UserGroup = sequelize.define('UserGroup', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.STRING,
    allowNull: false,
    // Retained through the UUID re-key (D-07 rollback net). Removed from the model
    // in Plan 09, dropped from the DB in the D-08 follow-up PR.
  },
  user_uuid: {
    // Phase 87.1 (BINT-02, D-01): protective FK to the Users UUID PK, ON DELETE CASCADE.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000001 (prod via migrate:apply). allowNull is deliberately `true` during
    // waves 1-4 — nothing writes user_uuid until Plan 03's factory dual-write + the route
    // cutovers, and the test DB force-syncs from this model, so a NOT NULL column here would
    // break every row-creating test. Prod NOT NULL is enforced by the migration's SET NOT NULL;
    // Plan 09 tightens this to allowNull: false once all writers are cut over.
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  role: {
    type: DataTypes.ENUM('pending', 'member', 'admin', 'owner'),
    defaultValue: 'member',
  },
  status: {
    type: DataTypes.ENUM('invited', 'active', 'declined'),
    defaultValue: 'active',
    allowNull: false,
  },
  joined_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['user_id']
    },
    {
      fields: ['user_id', 'group_id'],
      unique: true
    },
    {
      // Composite covers single-column user_uuid lookups via its leading column
      // (no standalone user_uuid index — redundant, per adversarial review).
      fields: ['user_uuid', 'group_id'],
      unique: true
    },
    {
      fields: ['status']
    }
  ]
});


module.exports = UserGroup;