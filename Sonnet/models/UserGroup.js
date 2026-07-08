// models/UserGroup.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');


const UserGroup = sequelize.define('UserGroup', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_uuid: {
    // Phase 87.1 (BINT-02, D-01): protective FK to the Users UUID PK, ON DELETE CASCADE.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000001 (prod via migrate:apply). Plan 09 cutover: the old Auth0-string
    // `user_id` column has been removed from this model (D-08 static drop-safety proof;
    // the physical DB column is retained as the D-07 rollback net and dropped in the
    // D-08 follow-up PR). allowNull is now `false` — all writers key user_uuid, so the
    // sync()-built test DB enforces NOT NULL to match the prod migration's SET NOT NULL.
    type: DataTypes.UUID,
    allowNull: false,
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