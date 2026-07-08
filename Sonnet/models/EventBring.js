// models/EventBring.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const EventBring = sequelize.define('EventBring', {
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
  user_uuid: {
    // Phase 87.1 (BINT-02, D-02): protective FK to the Users UUID PK, ON DELETE CASCADE.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000005 (prod via migrate:apply). Plan 09 cutover: the old Auth0-string
    // `user_id` column has been removed from this model (D-08 static drop-safety proof;
    // the physical DB column is retained as the D-07 rollback net and dropped in the
    // D-08 follow-up PR). allowNull is now `false` — all writers key user_uuid, so the
    // sync()-built test DB enforces NOT NULL to match the prod migration's SET NOT NULL.
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
  game_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Games',
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['event_id'],
    },
    {
      // Phase 87.1 (T-87.1-01): one bring per user per game per event on the UUID key.
      fields: ['event_id', 'user_uuid', 'game_id'],
      unique: true,
    },
  ],
});

module.exports = EventBring;
