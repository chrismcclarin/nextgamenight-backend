// models/UserAvailability.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UserAvailability = sequelize.define('UserAvailability', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  // Phase 87.5 (BINT-02, BE PR-1 — D-01): user_uuid is the identity FK the model keys
  // on — a protective FK to the Users UUID PK, ON DELETE CASCADE. Ships in BOTH this
  // model (sync() builds the FK on the CI/test DB) AND migration 20260720000001 (prod via
  // migrate:apply). allowNull:false — all writers key user_uuid after the Plan 02/03
  // consumer flips. The old `user_id` Auth0-string column is RETAINED nullable as the
  // D-07 rollback net (physical DB column dropped in the BE PR-2 contract migration,
  // Plan 07) so sync() builds the true post-migration schema the replay job expects.
  user_uuid: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  user_id: {
    type: DataTypes.STRING,
    allowNull: true, // RETAINED rollback net, relaxed to nullable (migration DROP NOT NULL)
    references: {
      model: 'Users',
      key: 'user_id',
    },
    onDelete: 'CASCADE',
  },
  type: {
    type: DataTypes.ENUM('recurring_pattern', 'specific_override'),
    allowNull: false,
  },
  pattern_data: {
    type: DataTypes.JSONB,
    allowNull: false,
    // For recurring: { dayOfWeek: 0-6, startTime: "HH:MM", endTime: "HH:MM", timezone: "string" }
    // For specific: { date: "YYYY-MM-DD", startTime: "HH:MM", endTime: "HH:MM", isAvailable: boolean }
  },
  start_date: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  end_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  is_available: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    // true = free, false = busy (for specific overrides)
    // null for recurring patterns (they define available time)
  },
  timezone: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'UTC',
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['user_uuid']
    },
    {
      fields: ['user_id']
    },
    {
      fields: ['type']
    },
    {
      fields: ['start_date', 'end_date']
    }
  ]
});

module.exports = UserAvailability;

