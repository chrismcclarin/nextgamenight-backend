// models/Event.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');


const Event = sequelize.define('Event', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  game_id: {
    type: DataTypes.UUID,
    allowNull: true,
  },
  start_date: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  duration_minutes: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  winner_id: {
    type: DataTypes.UUID,
    allowNull: true, // references User.id
    // Phase 87.2 (REQ-3/REQ-6, T-87.2-01): protective FK ON DELETE SET NULL so
    // hard-deleting a member winner nulls the pointer instead of RESTRICT-erroring
    // or dangling. Dual-write with migration 20260709000001 (sync()-built test/CI
    // DBs read this; prod reads the migration). winner_name is NOT touched — the
    // custom-participant display text survives (write paths set winner_id XOR
    // winner_name). Member-winner display is intentionally lost on SET NULL.
    references: { model: 'Users', key: 'id' },
    onDelete: 'SET NULL',
  },
  picked_by_id: {
    type: DataTypes.UUID,
    allowNull: true, // references User.id
    // Phase 87.2 (REQ-3/REQ-6, T-87.2-01): protective FK ON DELETE SET NULL —
    // same rationale as winner_id. picked_by_name display text is untouched.
    references: { model: 'Users', key: 'id' },
    onDelete: 'SET NULL',
  },
  winner_name: {
    type: DataTypes.STRING,
    allowNull: true, // For custom participants (non-group members) who won
  },
  picked_by_name: {
    type: DataTypes.STRING,
    allowNull: true, // For custom participants (non-group members) who picked the game
  },
  custom_participants: {
    type: DataTypes.JSONB,
    allowNull: true, // Array of { username, score, faction, is_new_player, placement }
    defaultValue: [],
  },
  is_group_win: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  comments: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('scheduled', 'in_progress', 'completed', 'cancelled'),
    defaultValue: 'completed',
  },
  rsvp_deadline: {
    type: DataTypes.DATE,
    allowNull: true, // required only when ballot exists, enforced at API level
  },
  ballot_status: {
    type: DataTypes.ENUM('open', 'closed'),
    allowNull: true,
    defaultValue: null, // null = no ballot on this event
  },
  invite_token: {
    type: DataTypes.STRING(64),
    allowNull: true,
    unique: true,
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['group_id']
    },
    {
      fields: ['group_id', 'start_date']
    }
  ]
});


module.exports = Event;