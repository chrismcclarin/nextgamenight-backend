// models/EventAuditLog.js
// Internal audit log for event deletes. One row per event delete, regardless
// of whether cancellation emails were sent. Lets support answer
// "where did my event go?" by looking up the actor + timing flags + snapshot.
//
// Write-only structured-log table -- no associations defined intentionally
// (the parent event/group rows may be destroyed; we keep the orphan log).
// (Phase 61, MAIL-05)
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const EventAuditLog = sequelize.define('EventAuditLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  event_id: {
    type: DataTypes.UUID,
    allowNull: false,
    // No FK reference -- event row gets destroyed in the same request.
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
    // No FK reference -- same reason.
  },
  actor_user_id: {
    type: DataTypes.STRING,
    allowNull: false,
    // 87.5 write-forward (Req 9): records the caller's Users.id UUID, not the
    // Auth0 sub. Column type stays STRING (UUID values fit; no migration/backfill
    // needed — the table is empty in prod, so it's 100%-UUID from the first row).
    // Deliberately carries NO FK so audit rows survive account deletion (the
    // retention design also enumerated in accountDeletionService's SURVIVING
    // EXCEPTIONS block).
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false,
    // Currently only 'delete'. Reserved for future actions like 'force_cancel'.
  },
  was_after_start: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    // true if Date.now() >= event.start_date.getTime() at delete time.
  },
  was_within_15min_grace: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    // true if was_after_start && now < start + 15min.
  },
  suppressed_email: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    // true if cancellation emails were skipped due to timing (now > start + 15min).
  },
  event_snapshot: {
    type: DataTypes.JSONB,
    allowNull: false,
    // Self-contained snapshot: { id, group_id, game_id, start_date,
    //                            duration_minutes, location, comments }
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'EventAuditLogs',
  timestamps: false, // created_at serves as the timestamp; no updated_at.
  indexes: [
    {
      // Support: list recent deletes for a group
      fields: ['group_id', 'created_at'],
    },
    {
      // Support: look up audit row by event_id
      fields: ['event_id'],
    },
  ],
});

module.exports = EventAuditLog;
