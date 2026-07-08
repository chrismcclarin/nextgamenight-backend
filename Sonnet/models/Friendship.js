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
  // Phase 87.1 (BINT-02, D-05): protective FKs to the Users UUID PK on BOTH endpoints,
  // ON DELETE CASCADE. Ship in BOTH this model (sync() builds the FKs on the CI/test DB)
  // AND migration 20260703000002 (prod via migrate:apply). Plan 09 cutover: the old
  // Auth0-string `requester_id` / `addressee_id` columns have been removed from this model
  // (D-08 static drop-safety proof; the physical DB columns are retained as the D-07
  // rollback net and dropped in the D-08 follow-up PR). allowNull is now `false` — all
  // writers key the UUID endpoints, so the sync()-built test DB enforces NOT NULL to match
  // the prod migration's SET NOT NULL. The LEAST/GREATEST functional pair-unique index is
  // raw SQL in the migration (Sequelize can't express it), so it is NOT declared here.
  requester_uuid: {
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
  addressee_uuid: {
    type: DataTypes.UUID,
    allowNull: false,
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
    { fields: ['requester_uuid'] },
    { fields: ['addressee_uuid'] },
    { fields: ['status'] },
  ],
});

module.exports = Friendship;
