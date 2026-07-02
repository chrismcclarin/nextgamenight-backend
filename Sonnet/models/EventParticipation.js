// models/EventParticipation.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');


const EventParticipation = sequelize.define('EventParticipation', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  event_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false,
    // Phase 87 (BINT-02, D-01/D-02/D-06): protective FK to the Users UUID PK.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB so the
    // rejection + cascade tests are verifiable) AND migration 20260701000002
    // (prod via migrate:apply). ON DELETE CASCADE mirrors the hand-rolled cascade
    // helpers (D-02: additive backstop, helpers left untouched).
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
  score: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
  },
  faction: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  is_new_player: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  placement: {
    type: DataTypes.INTEGER,
    allowNull: true, // 1st, 2nd, 3rd place, etc.
  },
  is_guest: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  google_calendar_event_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['event_id']
    },
    {
      fields: ['event_id', 'user_id'],
      unique: true
    }
  ]
});


module.exports = EventParticipation;