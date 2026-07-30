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
  user_uuid: {
    // Phase 87.1 (BINT-02, D-02): protective FK to the Users UUID PK, ON DELETE CASCADE.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000006 (prod via migrate:apply). Plan 09 cutover: the old Auth0-string
    // `user_id` column has been removed from this model (D-08 static drop-safety proof;
    // the physical DB column is retained as the D-07 rollback net and dropped in the
    // D-08 follow-up PR). allowNull is now `false` — all writers key user_uuid, so the
    // sync()-built test DB enforces NOT NULL to match the prod migration's SET NOT NULL.
    type: DataTypes.UUID,
    allowNull: false,
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
      // Phase 87.1 (T-87.1-01): one vote per option per user on the UUID key.
      fields: ['option_id', 'user_uuid'],
      unique: true,
    },
    {
      // DECISION Phase 88.4 F-29 (D2a): declared model-side to match migration
      // 20260703000006:109, which prod already has. NOT redundant with the composite above: that
      // one LEADS on option_id, so it cannot serve a `user_uuid`-only lookup. These per-user
      // indexes exist so account-deletion sweeps do not table-scan, and without this entry the
      // sync()-built test DB exercised a DIFFERENT query plan from prod. Dual-declared; the
      // explicit name keeps sync() and the migration byte-identical.
      fields: ['user_uuid'],
      name: 'eventballotvotes_user_uuid_idx',
    },
  ],
});

module.exports = EventBallotVote;
