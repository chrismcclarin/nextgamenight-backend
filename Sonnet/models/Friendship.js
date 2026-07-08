// models/Friendship.js
// Social graph model: tracks friend requests and friendships between users.
// One-row model: one row per friendship pair (requester sends, addressee receives).
// LEAST/GREATEST compound unique index in migration prevents duplicate pairs.
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Friendship = sequelize.define('Friendship', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  requester_id: {
    type: DataTypes.STRING,
    allowNull: false,
    // Auth0 user_id of the user who sent the friend request.
    // Retained through the UUID re-key (D-07 rollback net); removed from the model
    // in Plan 09, dropped from the DB in the D-08 follow-up PR.
  },
  addressee_id: {
    type: DataTypes.STRING,
    allowNull: false,
    // Auth0 user_id of the user who received the friend request.
    // Retained through the UUID re-key (D-07 rollback net); removed in Plan 09 / D-08.
  },
  // Phase 87.1 (BINT-02, D-05): protective FKs to the Users UUID PK on BOTH endpoints,
  // ON DELETE CASCADE. Ship in BOTH this model (sync() builds the FKs on the CI/test DB)
  // AND migration 20260703000002 (prod via migrate:apply). allowNull is deliberately `true`
  // through waves 1-4 — nothing writes these until Plan 03's factory dual-write + the route
  // cutovers, and the test DB force-syncs from this model, so NOT NULL here would break every
  // friendship-creating test. Prod NOT NULL is enforced by the migration's SET NOT NULL;
  // Plan 09 tightens to allowNull: false. The LEAST/GREATEST functional pair-unique index is
  // raw SQL in the migration (Sequelize can't express it), so it is NOT declared here.
  requester_uuid: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
  addressee_uuid: {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
  status: {
    type: DataTypes.ENUM('pending', 'accepted', 'declined', 'blocked'),
    defaultValue: 'pending',
    allowNull: false,
  },
}, {
  timestamps: true,
  indexes: [
    { fields: ['requester_id'] },
    { fields: ['addressee_id'] },
    { fields: ['status'] },
  ],
});

module.exports = Friendship;
