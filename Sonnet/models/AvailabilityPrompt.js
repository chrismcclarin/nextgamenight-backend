// models/AvailabilityPrompt.js
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');

const AvailabilityPrompt = sequelize.define('AvailabilityPrompt', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: 'Groups',
      key: 'id',
    },
    onDelete: 'CASCADE',
    // Many prompts can exist for one group (over time)
  },
  game_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Games',
      key: 'id',
    },
    onDelete: 'SET NULL',
    // Optional - prompt may or may not be for a specific game
  },
  prompt_date: {
    type: DataTypes.DATE,  // TIMESTAMP WITH TIME ZONE
    allowNull: false,
    // When the prompt was sent out
  },
  deadline: {
    type: DataTypes.DATE,  // TIMESTAMP WITH TIME ZONE
    allowNull: false,
    // When responses close
  },
  status: {
    type: DataTypes.ENUM('pending', 'active', 'closed', 'converted'),
    allowNull: false,
    defaultValue: 'pending',
    // pending: created but not sent
    // active: sent and accepting responses
    // closed: deadline passed or manually closed
    // converted: became an event
  },
  week_identifier: {
    type: DataTypes.STRING,
    allowNull: false,
    // Format: '2026-W05' (ISO week) for deduplication
    // Prevents sending duplicate prompts for same week
  },
  created_by_settings_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'GroupPromptSettings',
      key: 'id',
    },
    onDelete: 'SET NULL',
    // Tracks which schedule config created this prompt (null if manual)
  },
  custom_message: {
    type: DataTypes.TEXT,
    allowNull: true,
    // Optional custom message included in the prompt email
  },
  blind_voting_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    // When true, heatmap hidden until user submits or deadline passes
  },
  auto_schedule_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    // When true, auto-creates event from best suggestion when deadline passes
  },
  created_by_user_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id',
    },
    onDelete: 'SET NULL',
    // Phase 71.2 / D-SCHEMA-04: NULL = legacy or auto-prompt (created_by_settings_id
    // discriminates per D-SCHEMA-01); NOT NULL = manual poll, populated from
    // dbUser.id (User.id UUID, NOT User.user_id Auth0 sub) at create time.
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['group_id']
    },
    {
      fields: ['status']
    },
    {
      fields: ['deadline']
    },
    {
      fields: ['created_by_user_id']
    },
    // Phase 71.2 history, kept because it is what makes the PREDICATES below load-bearing rather
    // than decorative: the legacy `availability_prompts_group_week_unique` UNIQUE index on
    // (group_id, week_identifier) was removed in migration
    // 20260507000005-restrict-week-uniqueness-to-auto.js and replaced by a PARTIAL unique index
    // scoped to AUTO prompts only, so that manual polls can stack within a week after close. The
    // "one open manual poll per group" cap is a second partial index (migration 20260507000004).
    //
    // DECISION Phase 88.4 F-34 / F-35 (D2a): both partial unique indexes are now DECLARED HERE as
    // well as in their migrations, OVER remaining migration-only.
    //
    // THE OLD COMMENT'S REASON WAS FALSE and is corrected rather than deleted, so the wrong
    // justification stops propagating: it said "Sequelize's model-level `indexes` array doesn't
    // support partial WHERE clauses, so both indexes are owned exclusively by their migrations and
    // we list nothing here for them." Sequelize 6 DOES support `where` on an index — already proven
    // in-repo by models/UserGroup.js:76-80 (Phase 88.2 D-01), and re-verified for these two shapes
    // against the installed 6.37.7.
    //
    // ITS WARNING, HOWEVER, WAS REAL, AND IS THE REASON THE `where` CLAUSES BELOW MUST NOT BE
    // DROPPED: "re-declaring them here would cause sync() to recreate the unscoped legacy index and
    // re-introduce the 71.2 bug." That is exactly right for an UNSCOPED re-declaration. Declaring
    // `fields: ['group_id', 'week_identifier'], unique: true` WITHOUT the predicate rebuilds the
    // legacy full unique index and breaks manual-poll stacking in every sync()-built database.
    // The predicate is what makes declaring these safe. Deleting a `where` here is not a cleanup —
    // it re-opens a closed bug AND reds the drift gate.
    {
      // `availability_prompts_one_open_manual` — migration 20260507000002:59.
      // One OPEN manual poll per group: manual means created_by_user_id IS NOT NULL, open means
      // status is pending or active.
      fields: ['group_id'],
      unique: true,
      where: {
        created_by_user_id: { [Op.ne]: null },
        status: { [Op.in]: ['pending', 'active'] }
      },
      name: 'availability_prompts_one_open_manual'
    },
    {
      // `availability_prompts_auto_group_week_unique` — migration 20260507000005:28.
      // One AUTO prompt per group per week: auto means created_by_user_id IS NULL. The
      // `week_identifier IS NOT NULL` arm is part of the migration's predicate and is NOT
      // redundant — without it the index would treat NULL weeks as a distinct group.
      fields: ['group_id', 'week_identifier'],
      unique: true,
      where: {
        created_by_user_id: null,
        week_identifier: { [Op.ne]: null }
      },
      name: 'availability_prompts_auto_group_week_unique'
    }
  ]
});

module.exports = AvailabilityPrompt;
