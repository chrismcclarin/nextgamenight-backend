// models/EventBallotVote.js
// Ballot vote model: stores per-user approval votes linked to ballot options
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const EventBallotVote = sequelize.define('EventBallotVote', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  option_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'EventBallotOptions',
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  user_id: {
    type: DataTypes.STRING,
    allowNull: false,
    // Auth0 string ID (e.g., "google-oauth2|107459289778553956693")
    // Retained through the UUID re-key (D-07 rollback net). Removed from the model
    // in Plan 09, dropped from the DB in the D-08 follow-up PR.
  },
  user_uuid: {
    // Phase 87.1 (BINT-02, D-02): protective FK to the Users UUID PK, ON DELETE CASCADE.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000006 (prod via migrate:apply). allowNull is deliberately `true` during
    // waves 1-4 — nothing writes user_uuid until Plan 03's factory dual-write + the route
    // cutovers, and the test DB force-syncs from this model, so a NOT NULL column here would
    // break every row-creating test. Prod NOT NULL is enforced by the migration's SET NOT NULL;
    // Plan 09 tightens this to allowNull: false once all writers are cut over.
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['option_id'],
    },
    {
      fields: ['user_id'],
    },
    {
      fields: ['option_id', 'user_id'],
      unique: true, // one vote per option per user
    },
    {
      // Phase 87.1 (T-87.1-01): one vote per option per user on the UUID key.
      fields: ['option_id', 'user_uuid'],
      unique: true,
    },
  ],
});

module.exports = EventBallotVote;
