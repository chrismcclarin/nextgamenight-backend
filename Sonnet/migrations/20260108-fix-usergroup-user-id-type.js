// migrations/20260108-fix-usergroup-user-id-type.js
// Fix UserGroup.user_id to be STRING instead of UUID to support Auth0 user IDs
//
// ---------------------------------------------------------------------------------------
// AMENDED by Phase 88.4 Plan 01 (SPEC R1, replay risk R-1) — 2026-07-29.
// ---------------------------------------------------------------------------------------
// WHAT CHANGED: one idempotent `DROP CONSTRAINT IF EXISTS "UserGroups_user_id_fkey"` was
// added ahead of the original changeColumn. Nothing else. The amendment is recorded here,
// in the open, rather than applied silently — this is a HISTORICAL migration and rewriting
// one without a paper trail is how a chain becomes unauditable.
//
// WHY IT WAS NEEDED: this migration had NEVER been executed against a from-empty database
// in this repo's history. It was written in the sync() era, when the schema it met was
// whatever `sequelize.sync()` had already built plus whatever had been done by hand. Phase
// 88.4 made `npx sequelize-cli db:migrate` work from `CREATE DATABASE` onward
// (00000000000000-baseline-pre-migration-schema.js recreates the 2026-01-07 sync schema as
// migration #1), and this migration was the FIRST thing in the chain to fail on that path:
//
//   ERROR: foreign key constraint "UserGroups_user_id_fkey" cannot be implemented
//   ERROR DETAIL: Key columns "user_id" of the referencing table and "id" of the
//                 referenced table are of incompatible types: character varying and uuid.
//
// The sync-era schema gave "UserGroups".user_id a uuid FK to "Users".id. Postgres REBUILDS
// dependent constraints as part of `ALTER TABLE ... ALTER COLUMN ... TYPE`, so the moment
// user_id becomes an Auth0 VARCHAR the FK is unimplementable and the whole statement aborts.
// Dropping the FK is not a workaround, it is the semantic truth of this migration: once
// user_id holds an Auth0 subject string it CANNOT reference Users.id, so the constraint has
// to go. Prod's own history agrees — no such FK exists there today, and Phase 87.1/87.5
// replaced this column entirely with the `user_uuid` uuid FK.
//
// PROD IMPACT: none. This filename has been booked in prod's SequelizeMeta since January
// 2026, so `migrate:apply` never re-runs it. The amendment is reachable ONLY on a
// from-empty replay (CI's migrate-cli-replay gate). The `IF EXISTS` makes it a no-op
// anywhere the FK is already absent, which is every database except a freshly baselined one.
//
// DECISION Phase 88.4 R-1: DROP the sync-era FK before the type change OVER adding a
// `USING "user_id"::text` cast to the ALTER (the contingency the plan pre-registered) — the
// cast was never the problem. uuid -> varchar is an assignment cast, so Postgres performs
// the column conversion without a USING clause; the failure is entirely the dependent FK
// rebuild, and a USING clause does not address it. Verified empirically against PostgreSQL
// 18 on a from-empty replay: with the FK dropped the original unmodified changeColumn
// succeeds. Do not "simplify" by deleting the DROP and adding a cast — that restores the
// failure.
//
// DECISION Phase 88.4 R-1b: amend this historical migration OVER skipping it on the
// from-empty path (e.g. a `SequelizeMeta` pre-seed or an early return) — the chain's whole
// value as a drift gate is that the end state it produces is the real end state. A skipped
// migration leaves user_id as uuid, and every later migration that assumes the Auth0 string
// then diverges from prod.
// ---------------------------------------------------------------------------------------

'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Phase 88.4 R-1 amendment — see the header. Idempotent: a no-op on any database where
    // the sync-era FK is already gone (i.e. everything but a freshly baselined one).
    await queryInterface.sequelize.query(
      'ALTER TABLE "UserGroups" DROP CONSTRAINT IF EXISTS "UserGroups_user_id_fkey"'
    );

    // Change user_id column from UUID to VARCHAR to support Auth0 user IDs
    await queryInterface.changeColumn('UserGroups', 'user_id', {
      type: Sequelize.STRING,
      allowNull: false,
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert back to UUID (note: this might fail if there are non-UUID values)
    //
    // Phase 88.4 note: this down() is left exactly as written. It does NOT restore
    // "UserGroups_user_id_fkey", because it cannot know whether the rows still cast to uuid
    // and because by the end of the chain the column no longer exists at all (Phase 87.5
    // dropped it in favour of `user_uuid`). Nothing in CI or prod runs this direction; it is
    // not part of the from-empty gate.
    await queryInterface.changeColumn('UserGroups', 'user_id', {
      type: Sequelize.UUID,
      allowNull: false,
    });
  }
};
