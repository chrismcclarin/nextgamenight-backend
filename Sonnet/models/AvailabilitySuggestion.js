// models/AvailabilitySuggestion.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AvailabilitySuggestion = sequelize.define('AvailabilitySuggestion', {
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
    // Suggestions deleted when prompt deleted
  },
  suggested_start: {
    type: DataTypes.DATE,  // TIMESTAMP WITH TIME ZONE
    allowNull: false,
    // Start of suggested time slot (UTC)
  },
  suggested_end: {
    type: DataTypes.DATE,  // TIMESTAMP WITH TIME ZONE
    allowNull: false,
    // End of suggested time slot (UTC)
  },
  participant_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 0,
    },
    // How many users are available during this slot
  },
  participant_user_ids: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
    // Array of user_id strings for users available in this slot
    // Denormalized for quick access without joins
  },
  preferred_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    validate: {
      min: 0,
    },
    // How many users marked this as 'preferred' vs 'if-need-be'
  },
  meets_minimum: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    // Does this slot meet the game's/prompt's min_participants threshold?
  },
  score: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    // Ranking score: higher = better suggestion
    // Algorithm: participant_count * 1.0 + preferred_count * 0.5
    // Suggestions with meets_minimum=true are boosted
  },
  converted_to_event_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'Events',
      key: 'id',
    },
    onDelete: 'SET NULL',
    // When this suggestion becomes an event, track which one
    // Null until/unless suggestion is converted
  },
  tentative_calendar_event_ids: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null,
    // Maps user_id to Google Calendar event ID for tentative holds
    // Format: {"user_id_1": "calendar_event_id_1", ...}
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['prompt_id']
    },
    {
      fields: ['meets_minimum']
    },
    {
      fields: ['score']
    },
    {
      fields: ['suggested_start', 'suggested_end']
    },
    {
      // DECISION Phase 88.4 F-33 (D2a): the GIN index prod already has (migration
      // 20260208000001:19) is declared model-side, OVER allowlisting it as inexpressible.
      // VERIFIED against the installed Sequelize 6.37.7 rather than assumed: this declaration
      // emits
      //   CREATE INDEX "idx_suggestion_participant_ids_gin"
      //     ON "AvailabilitySuggestions" USING gin ("participant_user_ids" jsonb_path_ops)
      // which is byte-identical to the migration's definition. `using` + a per-field `operator`
      // (the opclass) are both supported — see query-generator.js:445-448 and :486.
      //
      // The access method IS part of a non-unique index's identity (D-04), so a btree here would
      // NOT match: if you change `using`, change the migration in the same commit or the drift gate
      // goes red. Dual-declared; explicit name keeps sync() and the migration identical.
      fields: [{ name: 'participant_user_ids', operator: 'jsonb_path_ops' }],
      using: 'gin',
      name: 'idx_suggestion_participant_ids_gin'
    }
  ]
});

module.exports = AvailabilitySuggestion;
