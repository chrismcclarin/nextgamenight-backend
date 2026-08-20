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
    // DECISION Phase 88-34 Task 4: app-side `len` backstop, NOT a STRING(40)
    // column type — a type change needs a migration and tangles with the 88.4
    // migrate-cli-replay drift gate for zero user-visible gain. The route
    // (validateGroupCreate / validateGroupUpdate, max 40) is the enforcement;
    // this catches a future write path that forgets. Unlike User.username there
    // is no machine-derived writer here — every Group.name comes from a human
    // typing into a validated form — so no clamp-at-writer is needed.
    validate: { len: [1, 40] },
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
  purge_after: {
    // Phase 88.2 (SPEC-REQ-1 / SPEC-REQ-9): the moment this soft-deleted group
    // becomes eligible for permanent purge. Written at delete time alongside
    // deletedAt; read by the purge sweep. NULL on every live group.
    // Dual-write with migration 20260725000001 (prod); this model builds the
    // sync()-built CI/test DB.
    type: DataTypes.DATE,
    allowNull: true,
  },
  // DECISION Phase 88.2 D-01: soft-delete is Sequelize's built-in paranoid option
  // OVER a hand-written where-based default scope (`{ where: { deletedAt: null } }`).
  //
  // A where-based default scope would be REPLACED, not merged, by
  // `scope('withInviteToken')` — Sequelize's `_injectScope` swaps the named scope
  // in for the default one — so every invite-token read site would silently lose
  // the hide filter and reopen the BE-043 / BSEC-01 era leak. Paranoid is applied
  // by `Model._paranoidClause` (node_modules/sequelize/lib/model.js:158-186) AFTER
  // and INDEPENDENTLY of `_injectScope` (:1112 vs :1135); it never consults
  // `_scope`. The two compose instead of colliding. Proven, not inferred —
  // 88.2-RESEARCH.md F-01 ran the installed Sequelize 6.37.7 against a replica of
  // this scope pair and printed the generated SQL.
  //
  // The three-model split (Group + UserGroup + Event) is deliberate. NOT Group
  // alone — that leaves the three `GET /events/user/:user_id` read paths needing
  // hand-written filters, which is exactly the per-call-site design SPEC-REQ-3
  // rejects. NOT all six — GameReview, GroupInvite and EventParticipation are only
  // reachable through a Group or an Event that is already hidden, so making them
  // paranoid buys nothing and costs a `force: true` sweep across every existing
  // destroy site (88.2-RESEARCH.md F-01, F-03).
  //
  // Changing any of this is a decision, not a cleanup.
}, {
  timestamps: true,
  paranoid: true,
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
    },
    {
      // Phase 88.2: the purge sweep scans soft-deleted groups by purge_after.
      // Explicit name so sync() and migration 20260725000001 agree.
      fields: ['purge_after'],
      name: 'groups_purge_after'
    }
  ]
});

module.exports = Group;