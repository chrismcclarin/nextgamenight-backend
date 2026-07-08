// models/SentNotification.js
// Tracks outbound SMS notifications for inbound reply-to-event resolution.
// When a user replies to an SMS, the webhook queries this table by phone number
// (ordered by sent_at DESC) to find the most recent event they were notified about.
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SentNotification = sequelize.define('SentNotification', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_uuid: {
    // Phase 87.1 (BINT-02, D-03, PII cleanup): protective FK to the Users UUID PK,
    // ON DELETE CASCADE — a deleted user's SMS notification trail is purged with them.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000007 (prod via migrate:apply). Plan 09 cutover: the old Auth0-string
    // `user_id` column has been removed from this model (D-08 static drop-safety proof;
    // the physical DB column is retained as the D-07 rollback net and dropped in the
    // D-08 follow-up PR). allowNull is now `false` — all writers key user_uuid, so the
    // sync()-built test DB enforces NOT NULL to match the prod migration's SET NOT NULL.
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
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
  phone: {
    type: DataTypes.STRING(20),
    allowNull: false,
    // E.164 format for reverse lookup by inbound webhook
  },
  channel: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'sms',
  },
  notification_type: {
    type: DataTypes.STRING(50),
    allowNull: false,
    // e.g. 'event_created', 'event_updated', 'reminder'
  },
  twilio_sid: {
    type: DataTypes.STRING,
    allowNull: true,
    // Twilio message SID from smsService.send() response
  },
  sent_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: false, // sent_at serves as the timestamp
  indexes: [
    {
      // Primary lookup for inbound webhook: find most recent event by phone
      fields: ['phone', 'sent_at'],
    },
    {
      // Phase 87.1: audit lookup on the UUID key. NON-unique — this table has no
      // one-per-user constraint (simplest table); a user may be notified repeatedly.
      fields: ['user_uuid', 'event_id'],
    },
    {
      // CASCADE cleanup performance
      fields: ['event_id'],
    },
  ],
});

module.exports = SentNotification;
