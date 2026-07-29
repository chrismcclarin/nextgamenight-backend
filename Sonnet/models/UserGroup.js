// models/UserGroup.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');


const UserGroup = sequelize.define('UserGroup', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  user_uuid: {
    // Phase 87.1 (BINT-02, D-01): protective FK to the Users UUID PK, ON DELETE CASCADE.
    // Ships in BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000001 (prod via migrate:apply). Plan 09 cutover: the old Auth0-string
    // `user_id` column has been removed from this model (D-08 static drop-safety proof;
    // the physical DB column is retained as the D-07 rollback net and dropped in the
    // D-08 follow-up PR). allowNull is now `false` — all writers key user_uuid, so the
    // sync()-built test DB enforces NOT NULL to match the prod migration's SET NOT NULL.
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: false,
  },
  role: {
    type: DataTypes.ENUM('pending', 'member', 'admin', 'owner'),
    defaultValue: 'member',
  },
  status: {
    type: DataTypes.ENUM('invited', 'active', 'declined'),
    defaultValue: 'active',
    allowNull: false,
  },
  joined_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: true,
  // DECISION Phase 88.2 D-01: paranoid soft-delete, so a removed membership row
  // survives a group's 30-day recovery window and can be restored with it. See
  // models/Group.js for the full paranoid-over-defaultScope rationale.
  paranoid: true,
  indexes: [
    {
      // Composite covers single-column user_uuid lookups via its leading column
      // (no standalone user_uuid index — redundant, per adversarial review).
      //
      // DECISION Phase 88.2 D-01: this unique index is PARTIAL
      // (`WHERE "deletedAt" IS NULL`) OVER the plain full unique index it replaces.
      // A full unique index would hard-fail POST /groups/join-by-token
      // (routes/groups.js:614-710) for any user whose membership row is
      // soft-deleted: the existing-membership lookup at :681-683 is itself
      // paranoid-filtered, so it does not see the stamped row and the handler takes
      // the UserGroup.create branch at :704-710 — straight into a
      // SequelizeUniqueConstraintError. The partial predicate is what permits that
      // path.
      //
      // DECISION Phase 88.2 D-01: the predicate is declared HERE IN THE MODEL as
      // well as in migration 20260725000001, deliberately deviating from
      // models/GroupInvite.js:64-65's comment claiming "Sequelize doesn't support
      // partial indexes". That claim is FALSE for Sequelize 6 — verified by running
      // the installed 6.37.7 query generator, which emits exactly
      //   CREATE UNIQUE INDEX "usergroups_user_uuid_group_id_uq"
      //     ON "UserGroups" ("user_uuid", "group_id") WHERE "deletedAt" IS NULL
      // Following that comment (migration-only) would leave the sync()-built test DB
      // with a FULL unique index while prod has a partial one, so the QR re-join
      // regression test would pass in CI and fail in prod — the exact CI/prod schema
      // divergence documented in 88.2-CASCADE-AUDIT.md.
      //
      // Explicit `name` so sync() and the migration produce the identical index name.
      fields: ['user_uuid', 'group_id'],
      unique: true,
      where: { deletedAt: null },
      name: 'usergroups_user_uuid_group_id_uq'
    },
    {
      // Phase 88.2 code-review M-1: plain NON-unique (group_id, user_uuid). The
      // partial unique index above is invisible to `paranoid: false` lookups
      // (soft-deleted rows aren't in it) and leads on user_uuid, so group_id-
      // leading queries (roster reads, counts, purge destroys) and the in-lock
      // invite-accept membership checks were sequential scans. Dual-declared
      // with migration 20260727000001; explicit name keeps sync() and the
      // migration identical.
      fields: ['group_id', 'user_uuid'],
      name: 'usergroups_group_id_user_uuid'
    },
    {
      fields: ['status']
    }
  ]
});


module.exports = UserGroup;