// models/Group.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Group = sequelize.define('Group', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  group_id: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
  },
  profile_picture_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  background_color: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: '#ffffff', // Default white
  },
  background_image_url: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  invite_token: {
    type: DataTypes.STRING(64),
    allowNull: true,
    unique: true,
  },
}, {
  timestamps: true,
  // BSEC-01 / BE-043: fail-closed default. invite_token (a join secret) is
  // stripped from every default read so it is never serialized to the client.
  // Invite generation/rotation/preview reads opt back in via
  // .scope('withInviteToken'). CRITICAL: the lazy-generate + rotation MUTATION
  // sites in routes/groups.js MUST use the scope so `if(!group.invite_token)`
  // reads the real column value — otherwise the token regenerates on every
  // QR view (invalidating prior links). Mirrors User.defaultScope (D-03).
  defaultScope: { attributes: { exclude: ['invite_token'] } },
  scopes: {
    // empty override = restores all attributes (incl. invite_token)
    withInviteToken: {},
  },
  indexes: [
    {
      fields: ['group_id']
    }
  ]
});

module.exports = Group;