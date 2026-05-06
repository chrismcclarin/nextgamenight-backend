// models/PollResponse.js
// One row per (poll_id, user_id). Upserted by POST /api/polls/:id/responses.
// CRITICAL: user_id is STRING (Auth0 user_id), not UUID — same pattern as
// UserGroup, AvailabilityResponse, EventRsvp.
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PollResponse = sequelize.define('PollResponse', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  poll_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Polls',
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  user_id: {
    type: DataTypes.STRING, // Auth0 user_id
    allowNull: false,
    references: {
      model: 'Users',
      key: 'user_id',
    },
    onDelete: 'CASCADE',
  },
  // slot_data: JSONB array of { date, slot, available, preference? }.
  // Mirror shape used by AvailabilityResponse.time_slots so the same heatmap
  // aggregator can consume it.
  slot_data: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  submitted_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: true,
  indexes: [
    { fields: ['poll_id'] },
    {
      unique: true,
      fields: ['poll_id', 'user_id'],
      name: 'poll_responses_poll_user_unique',
    },
  ],
});

module.exports = PollResponse;
