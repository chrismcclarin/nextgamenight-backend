// models/Poll.js
// Member-created availability poll (POLL-01).
// Mirrors AvailabilityPrompt's shape but with poll-specific fields:
//   - status: 'open' | 'closed'
//   - close_reason: 'manual' | 'deadline' | 'consensus' (nullable until close)
//   - closed_notification_dismissed_at: D-POLL-CREATE-07 cross-device dismissal
//   - one-open-per-group enforced via partial unique index in migration 20260506000001
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Poll = sequelize.define('Poll', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Groups',
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  created_by_user_id: {
    type: DataTypes.STRING, // Auth0 user_id
    allowNull: false,
    references: {
      model: 'Users',
      key: 'user_id',
    },
    onDelete: 'CASCADE',
  },
  status: {
    type: DataTypes.ENUM('open', 'closed'),
    allowNull: false,
    defaultValue: 'open',
  },
  date_window_start: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  date_window_end: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  response_deadline: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  opened_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  closed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  close_reason: {
    type: DataTypes.ENUM('manual', 'deadline', 'consensus'),
    allowNull: true,
  },
  // D-POLL-CREATE-07 cross-device dismissal — creator-only setter via
  // POST /api/polls/:id/dismiss-notification. Plan 71-05 bell reads this column.
  closed_notification_dismissed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [
    { fields: ['group_id'] },
    { fields: ['status'] },
    { fields: ['response_deadline'] },
    // NOTE: the one-open-per-group partial unique index is created in the migration
    // because Sequelize.addIndex doesn't support `WHERE` clauses on partial indexes.
  ],
});

module.exports = Poll;
