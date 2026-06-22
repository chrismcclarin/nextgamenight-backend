// models/User.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  username: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  user_id: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  google_calendar_token: {
    type: DataTypes.TEXT,
    allowNull: true,
    // Note: In production, consider encrypting this field
  },
  google_calendar_refresh_token: {
    type: DataTypes.TEXT,
    allowNull: true,
    // Note: In production, consider encrypting this field
  },
  google_calendar_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  email_notifications_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    allowNull: false,
  },
  timezone: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: null,
    // IANA timezone format (e.g., America/New_York, Europe/London)
    // Used for displaying times in user's preferred timezone.
    // null = never set (sentinel for Phase 78 friendly-UX). 'UTC' is reserved
    // for users actually in UTC; detection-failed signups also land as null.
  },
  tutorial_version: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  phone: {
    type: DataTypes.STRING(20),
    allowNull: true,
    defaultValue: null,
    validate: {
      isE164(value) {
        if (value && !/^\+[1-9]\d{1,14}$/.test(value)) {
          throw new Error('Phone number must be in E.164 format (e.g., +14155552671)');
        }
      },
    },
  },
  sms_enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Platform-admin entitlement (D-02 / BSEC-02). DB-only, in the sms_enabled
  // mold: never written by code, never serialized, never settable via
  // ...req.body. Seeded true for the operator's own row by the migration;
  // defaults false (fail-safe). Read via .unscoped() + explicit attributes in
  // requirePlatformAdmin. Distinct from group-level UserGroup.role (owner/admin).
  is_platform_admin: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  phone_verified: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Timestamp of welcome/opt-in confirmation SMS. Null = not yet sent.
  // Used to ensure CTIA-required welcome message fires exactly once per user.
  sms_welcome_sent_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  // Shape: { [type]: { email: bool, sms: bool } } -- null = use defaults
  // null = use defaults (email on, sms off). Populated via PATCH
  // /users/:id/notification-preferences. Phase 61: do not backfill or
  // force-flip; preserve user choice exactly. New users default to
  // reminder.email=true via the null-prefs resolver in
  // services/notificationService.js (getPreference).
  notification_preferences: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: null,
  },
}, {
  timestamps: true,
  indexes: [
    {
      fields: ['user_id']
    }
  ]
});

module.exports = User;