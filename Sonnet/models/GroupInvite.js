// models/GroupInvite.js
// Stores group membership invitations with token-based acceptance flow
const Sequelize = require('sequelize');
const { DataTypes, Op } = Sequelize;
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
  invited_by_uuid: {
    // Phase 87.1 (BINT-02, D-04): NULLABLE protective FK to the Users UUID PK,
    // ON DELETE SET NULL — a pending invite outlives its inviter's account. Ships in
    // BOTH this model (sync() builds the FK on the CI/test DB) AND migration
    // 20260703000003 (prod via migrate:apply). SET NULL precedent: models/index.js:126
    // (created_by_user_id). Plan 09 cutover: the old Auth0-string `invited_by` column
    // has been removed from this model (D-08 static drop-safety proof; the physical DB
    // column is retained as the D-07 rollback net and dropped in the D-08 follow-up PR).
    // Stays `allowNull: true` PERMANENTLY (D-04 exception — no Plan 09 tightening, since
    // SET NULL requires nullability).
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
    // Phase 88.2 code-review L-9: the purge sweep's destroy({ where: { group_id } })
    // had no group_id index (the partial-unique pending-invite index can't serve a
    // plain group_id lookup). Dual-declared with migration 20260727000001; explicit
    // name keeps sync() and the migration identical.
    {
      fields: ['group_id'],
      name: 'group_invites_group_id',
    },
    {
      // DECISION Phase 88.4 F-32 (D2a): declared model-side to match migration
      // 20260703000003:95, which prod already has. The partial-unique index below cannot serve a
      // plain `invited_by_uuid` lookup (different key, and it is predicated on status='pending'),
      // so this is not redundant with it. Dual-declared; explicit name keeps both sides identical.
      fields: ['invited_by_uuid'],
      name: 'groupinvites_invited_by_uuid_idx',
    },
    {
      // DECISION Phase 88.4 F-43 (D2c): the partial unique index prod already has (migration
      // 20260228000001:125) is DECLARED HERE, over leaving it migration-only with an allowlist
      // entry. The owner was shown the allowlist option WITH its honest argument in favour — a
      // functional index written as `Sequelize.fn('LOWER', ...)` is genuinely less readable than
      // the raw SQL — and declined it, because the cost is that every sync()-built database (the BE
      // Jest DB, the FE e2e DB) permanently LACKS a uniqueness constraint prod enforces, so a test
      // could insert a duplicate pending invite, pass, and ship.
      //
      // THE COMMENT THAT USED TO SIT HERE WAS FALSE, ON BOTH COUNTS, AND IT IS WORTH RECORDING
      // WHY SO THE WRONG REASON STOPS PROPAGATING. It said the index "is handled in the migration
      // via raw SQL since Sequelize doesn't support partial indexes".
      //   1. PARTIAL is supported. models/UserGroup.js:76-80 declares a partial unique index
      //      successfully and its Phase 88.2 comment documents the same discovery, citing THIS
      //      comment as the claim it was disproving.
      //   2. The `LOWER()` key was then proposed as "the real blocker" instead. That is ALSO false.
      // Both were tested against the installed 6.37.7 with a real `sync()` against Postgres — not
      // with the query generator alone, because sync() also has to ACCEPT the declaration and its
      // index-existence check has to tolerate a functional field on a second run. Both passed, and
      // the readback was byte-identical to the migration:
      //   CREATE UNIQUE INDEX group_invites_pending_unique ON public."GroupInvites"
      //     USING btree (group_id, lower((invited_email)::text))
      //     WHERE (status = 'pending'::"enum_GroupInvites_status")
      //
      // THE ENUM PREDICATE WAS THE ONE OPEN QUESTION AND IT IS NOW SETTLED. The census left F-43
      // contingent: its probe had declared `status` as STRING, which renders
      // `((status)::text = 'pending'::text)` — a varchar artifact, since varchar comparison goes
      // through text — while the migration side has `(status = 'pending'::"enum_...")`. Re-run in
      // Plan 08 against a REAL ENUM column, the predicate rendered identically to the migration's.
      // That is why F-43 stayed `reconcile` and did NOT return to the owner as an allowlist
      // candidate. If `status` is ever changed away from ENUM, this predicate's rendering changes
      // and the drift gate will go red — that is the gate working, not a bug here.
      fields: ['group_id', Sequelize.fn('LOWER', Sequelize.col('invited_email'))],
      unique: true,
      where: { status: 'pending' },
      name: 'group_invites_pending_unique',
    },
  ],
});

module.exports = GroupInvite;
