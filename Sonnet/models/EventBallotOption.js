// models/EventBallotOption.js
// Ballot option model: stores game options for an event ballot
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const EventBallotOption = sequelize.define('EventBallotOption', {
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
  game_id: {
    type: DataTypes.UUID,
    allowNull: true, // null for free-text game entries not in the system
    references: {
      model: 'Games',
      key: 'id',
    },
  },
  game_name: {
    type: DataTypes.STRING,
    allowNull: false, // always stores the display name regardless of game_id
  },
  display_order: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // Phase 87 (BINT-01, D-05): Auth0 sub of the ballot's creator, stamped at
  // creation time (POST /events materialization or the ballot.js option route).
  // NULLABLE with NO backfill — legacy rows created before this column stay
  // NULL and fall through to owner/admin-only replace/wipe authz. Matches the
  // user_id string convention on EventRsvp/EventBallotVote.
  created_by: {
    type: DataTypes.STRING,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['event_id'],
    },
    {
      fields: ['event_id', 'game_name'],
      unique: true, // prevent duplicate game names on the same ballot
    },
  ],
});

module.exports = EventBallotOption;
