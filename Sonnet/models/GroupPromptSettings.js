// models/GroupPromptSettings.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const GroupPromptSettings = sequelize.define('GroupPromptSettings', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
    unique: true, // One settings per group
    references: {
      model: 'Groups',
      key: 'id',
    },
    onDelete: 'CASCADE',
  },
  schedule_day_of_week: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: {
      min: 0,
      max: 6,
    },
    // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    // Nullable for one-time prompts (non-recurring)
  },
  schedule_time: {
    type: DataTypes.TIME,
    allowNull: true,
    // HH:MM:SS format
    // Nullable for manual/one-time prompts
  },
  schedule_timezone: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'UTC',
    // IANA timezone format (e.g., America/New_York)
    // Used to interpret schedule_time correctly
  },
  default_deadline_hours: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 72,
    validate: {
      min: 1,
    },
    // Hours from prompt creation to response deadline
  },
  default_token_expiry_hours: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 168, // 7 days
    validate: {
      min: 1,
    },
    // Hours until magic link expires
  },
  min_participants: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: {
      min: 1,
    },
    // Override game's min_players if set
    // Nullable means use game's min_players
  },
  is_active: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    // Can disable schedule without deleting settings
  },
  template_name: {
    type: DataTypes.STRING,
    allowNull: true,
    // Optional name for reusable templates (e.g., "Weekend Sessions")
  },
  template_config: {
    type: DataTypes.JSONB,
    allowNull: true,
    // Stores saved prompt configurations for reuse
    // Structure: { games: [uuid], customMessage: string, etc. }
  },
  created_by_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id',
    },
    onDelete: 'SET NULL',
    // Phase 71.2 / D-SCHEMA-06: NULL = legacy/pre-migration row (resolves to
    // group-owner fallback at runtime per D-ADAPT-05). NOT NULL = the user who
    // first set up scheduling for this group (set at POST /:group_id/prompt-settings/schedules
    // create time when the GroupPromptSettings row is first inserted).
  },
}, {
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['group_id']
    },
    {
      fields: ['is_active']
    },
    {
      fields: ['schedule_day_of_week', 'schedule_time']
    },
    {
      fields: ['created_by_user_id']
    }
  ]
});

module.exports = GroupPromptSettings;
