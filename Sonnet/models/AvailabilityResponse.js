// models/AvailabilityResponse.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AvailabilityResponse = sequelize.define('AvailabilityResponse', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  prompt_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'AvailabilityPrompts',
      key: 'id',
    },
    onDelete: 'CASCADE',
    // Response deleted when prompt deleted
  },
  user_id: {
    type: DataTypes.STRING,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'user_id',  // Auth0 string ID, not UUID
    },
    onDelete: 'CASCADE',
    // Response deleted when user deleted
  },
  time_slots: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
    // Array of availability slots:
    // [{ start: ISO8601, end: ISO8601, preference: 'preferred'|'if-need-be' }]
  },
  user_timezone: {
    type: DataTypes.STRING,
    allowNull: false,
    // IANA timezone at time of submission (e.g., 'America/New_York')
    // Preserved for display purposes even if user changes timezone later
  },
  submitted_at: {
    type: DataTypes.DATE,  // TIMESTAMP WITH TIME ZONE
    allowNull: true,
    // When the user submitted their response (NULL = not yet submitted).
    // Different from createdAt if user updates response.
    // Phase 87 / BINT-01: reminderWorker persists a not-yet-submitted PLACEHOLDER
    // row (submitted_at NULL) as its claim-before-send record. This column MUST be
    // nullable for that placeholder to persist; every "responded" query already
    // filters on `submitted_at != null`, so a NULL placeholder is correctly
    // excluded from consensus/response counts. See migration
    // 20260701000001-make-availability-response-submitted-at-nullable.js.
  },
  magic_token_used: {
    type: DataTypes.STRING,
    allowNull: true,
    // Audit field: which token was used to submit (if any)
    // Null if submitted via authenticated session
  },
  last_reminded_at: {
    type: DataTypes.DATE,
    allowNull: true,
    // Timestamp of last reminder email sent to this user for this prompt
  },
  reminder_count: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
    // Number of reminder emails sent to this user for this prompt
    // Max 2 per AUTO-03 requirement
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['prompt_id']
    },
    {
      fields: ['user_id']
    },
    {
      unique: true,
      fields: ['prompt_id', 'user_id'],
      name: 'availability_responses_prompt_user_unique'
    }
  ]
});

module.exports = AvailabilityResponse;
