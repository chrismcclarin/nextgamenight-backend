// models/Friendship.js
// Social graph model: tracks friend requests and friendships between users.
// One-row model: one row per friendship pair (requester sends, addressee receives).
// The LEAST/GREATEST compound unique index preventing duplicate pairs is declared in BOTH the
// migration (20260703000002:138, prod) and this model's `indexes` array (sync()-built databases) —
// see the DECISION Phase 88.4 F-42 marker there. It used to be migration-only.
const Sequelize = require('sequelize');
const { DataTypes } = Sequelize;
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
  // the prod migration's SET NOT NULL. The LEAST/GREATEST functional pair-unique index IS now
  // declared here too — see the DECISION Phase 88.4 F-42 marker in the `indexes` array below.
  // (This comment previously said "Sequelize can't express it"; that was false and is corrected
  // there rather than silently deleted.)
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
    {
      // DECISION Phase 88.4 F-42 (D2c): the functional pair-unique index prod already has
      // (migration 20260703000002:138) is DECLARED HERE, over leaving it migration-only with an
      // allowlist entry. The owner was shown the allowlist option WITH its honest argument in
      // favour — `Sequelize.fn('LEAST', ...)` in a model file is genuinely less readable than the
      // raw SQL — and declined it. The cost of allowlisting was decisive: every sync()-built
      // database (the BE Jest DB, the FE e2e DB) would PERMANENTLY lack the constraint that stops a
      // duplicate-direction friendship row, so a test could assert behaviour on data prod refuses.
      //
      // THE "SEQUELIZE CAN'T EXPRESS IT" CLAIM IN THIS FILE'S HEADER AND ABOVE WAS FALSE, and was
      // load-bearing for two phases. Tested against the installed 6.37.7 with a REAL `sync()`
      // against Postgres (not the query generator alone — sync() also has to accept the declaration
      // and its index-existence check has to tolerate functional fields on a second run, which it
      // does). The readback was byte-identical to the migration side:
      //   CREATE UNIQUE INDEX friendships_pair_unique_uuid ON public."Friendships"
      //     USING btree (LEAST(requester_uuid, addressee_uuid),
      //                  GREATEST(requester_uuid, addressee_uuid))
      //
      // LEAST/GREATEST is what makes the pair DIRECTIONLESS: (A,B) and (B,A) normalize to the same
      // key, so it enforces one friendship row per unordered pair rather than per direction. A
      // plain `unique: ['requester_uuid','addressee_uuid']` would permit both directions and is NOT
      // an equivalent simplification. Explicit name keeps sync() and the migration identical.
      fields: [
        Sequelize.fn('LEAST', Sequelize.col('requester_uuid'), Sequelize.col('addressee_uuid')),
        Sequelize.fn('GREATEST', Sequelize.col('requester_uuid'), Sequelize.col('addressee_uuid')),
      ],
      unique: true,
      name: 'friendships_pair_unique_uuid',
    },
  ],
});

module.exports = Friendship;
