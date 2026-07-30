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
    //
    // DECISION Phase 88.4 F-23 (D1a): `onUpdate: 'NO ACTION'` is declared HERE, on the ATTRIBUTE,
    // OVER declaring it on the `UserGroup.belongsTo(User)` / `User.hasMany(UserGroup)` pair in
    // models/index.js where the other 22 RC-1 findings are fixed. Prod's FK
    // (migration 20260703000001:36) specifies only `onDelete`, so Postgres gives it `NO ACTION`,
    // while Sequelize's unconditional `onUpdate = onUpdate || 'CASCADE'` default gave every
    // sync()-built database `ON UPDATE CASCADE` — census finding F-23.
    //
    // WHY NOT ON THE ASSOCIATION, like its 22 siblings: this column is ALSO written by the two
    // `belongsToMany` calls at the top of models/index.js, which run FIRST. FK actions are
    // first-writer-wins (`_injectAttributes` merges via `Utils.mergeDefaults`, which does not
    // overwrite an existing field), so an association-level `onUpdate` here is a silent no-op and
    // the FK still emitted CASCADE. Measured, not assumed: tracing every write to this attribute's
    // `onUpdate` shows three, all from `belongsToMany`'s `Object.assign`. An attribute-level value
    // works because `belongs-to-many.js:233,243` explicitly READ THROUGH to it
    // (`this.options.onUpdate || through.rawAttributes[fk].onUpdate`).
    //
    // Do NOT "restore consistency" by moving this onto the association — that reverts F-23. And do
    // NOT add `onUpdate` to the `belongsToMany` options instead: those also govern
    // `UserGroups.group_id`, which AGREES with prod today and would start drifting.
    type: DataTypes.UUID,
    allowNull: false,
    references: { model: 'Users', key: 'id' },
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
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
    }
    // DECISION Phase 88.4 F-28 (D2b): the `{ fields: ['status'] }` entry that used to sit here is
    // DELETED, OVER adding a `CREATE INDEX CONCURRENTLY` migration to give prod the matching index.
    // It existed only in the models, so only sync()-built databases ever had it (census finding
    // F-28 / cross-check C-3); no migration has ever created it.
    //
    // Deciding evidence (gathered for the Plan 07 sign-off, 13 call sites): EVERY UserGroup query
    // that filters on `status` also filters on `user_uuid` and/or `group_id` — routes/games.js:83,
    // routes/events.js:291, routes/groups.js:199, :487-490, :605, :1143-1145, :1183-1186,
    // :1225-1228, :1260-1263, :1321, :1342, :1411-1414 — and NOT ONE filters on `status` alone.
    // Both of those columns already LEAD an existing index (the two entries above), so a standalone
    // low-cardinality `(status)` index would essentially never be chosen by the planner while
    // costing write throughput on every membership insert and update.
    //
    // Corroborating: it was the ONLY entry in this array with no explicit `name`, while both
    // siblings carry a comment saying the explicit name exists precisely to keep sync() and the
    // migration identical. That is the signature of an oversight, which is what makes deleting it
    // safe rather than a loss. Re-adding it means adding the migration too — otherwise the drift
    // gate goes red.
  ]
});


module.exports = UserGroup;