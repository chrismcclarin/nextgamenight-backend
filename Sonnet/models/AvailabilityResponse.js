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
  // Phase 87.5 (BINT-02, BE PR-1 — D-01): user_uuid is the identity FK the model keys
  // on — a protective FK to the Users UUID PK, ON DELETE CASCADE. Ships in BOTH this
  // model (sync() builds the FK on the CI/test DB) AND migration 20260720000002 (prod).
  // allowNull:false — all writers key user_uuid after the Plan 02/03 consumer flips. The
  // old `user_id` Auth0-string column is RETAINED nullable as the D-07 rollback net
  // (dropped in the BE PR-2 contract migration, Plan 07).
  user_uuid: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Users',
      key: 'id',
    },
    onDelete: 'CASCADE',
    // Response deleted when user deleted
  },
  user_id: {
    type: DataTypes.STRING,
    allowNull: true, // RETAINED rollback net, relaxed to nullable (migration DROP NOT NULL)
    references: {
      model: 'Users',
      key: 'user_id',  // Auth0 string ID, not UUID
    },
    onDelete: 'CASCADE',
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
      fields: ['user_uuid']
    },
    {
      fields: ['user_id']
    },
    {
      // Phase 87.5: uniqueness re-keyed onto the UUID (migration 20260720000002 drops the
      // old (prompt_id, user_id) unique and builds this one).
      unique: true,
      fields: ['prompt_id', 'user_uuid'],
      name: 'availability_responses_prompt_user_uuid_unique'
    }
  ]
});

module.exports = AvailabilityResponse;
