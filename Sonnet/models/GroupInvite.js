// models/GroupInvite.js
// Stores group membership invitations with token-based acceptance flow
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const GroupInvite = sequelize.define('GroupInvite', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  invited_email: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  invited_by: {
    type: DataTypes.STRING,
    allowNull: false,
    // Auth0 user_id of the inviter.
    // Retained through the UUID re-key (D-07 rollback net); removed from the model
    // in Plan 09, dropped from the DB in the D-08 follow-up PR.
  },
  invited_by_uuid: {
    // Phase 87.1 (BINT-02, D-04): NULLABLE protective FK to the Users UUID PK,
    // ON DELETE SET NULL — a pending invite outlives its inviter's account. Ships in
    // BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000003 (prod via migrate:apply). SET NULL precedent: models/index.js:126
    // (created_by_user_id). Stays nullable permanently (no Plan 09 tightening — SET NULL
    // requires nullability).
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'Users', key: 'id' },
    onDelete: 'SET NULL',
  },
  token: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  status: {
    type: DataTypes.ENUM('pending', 'accepted', 'declined'),
    defaultValue: 'pending',
    allowNull: false,
  },
  accepted_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  timestamps: true,
  indexes: [
    // Token lookup (unique is already on the column definition)
    {
      fields: ['token'],
    },
    // Email lookup for pending invites
    {
      fields: ['invited_email'],
    },
    // Status filtering
    {
      fields: ['status'],
    },
    // Partial unique index on (group_id, LOWER(invited_email)) WHERE status='pending'
    // is handled in the migration via raw SQL since Sequelize doesn't support partial indexes
  ],
});

module.exports = GroupInvite;
