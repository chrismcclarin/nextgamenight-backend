'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.8 (SPEC R12 as amended by A12, CONTEXT D-07/D-35) — extend
// `single_use_tokens` so it can carry the emailed CODE that proves a user
// controls the address they are changing TO.
//
// One DDL fact: `email_change_verify` added to the `enum_single_use_tokens_purpose`
// PG ENUM type (created by migrations/20260618000002-create-single-use-tokens.js).
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the PROD
// source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`, tracked in
// SequelizeMeta); its sync()-built counterpart is `models/SingleUseToken.js`, whose
// `purpose` attribute states the same four-member list. Change one, change the other
// — the Jest/CI database is built by `sequelize.sync({ force: true })` in
// tests/globalSetup.js and never by this file, so a divergence here is invisible
// until prod.
//
// Pitfall 2 — the drift gate is BLIND to ENUM labels specifically. `migrate-cli-replay`
// runs scripts/ci/schema-drift-diff.js, which contains no `pg_enum` and no `enumlabel`
// query AT ALL (its four catalog queries cover foreign keys, PK/UNIQUE constraints,
// indexes and a table inventory; IDENTITY_FIELDS at :313-316 has no column kind and its
// own comment at :319-323 calls a column-level kind FUTURE work). Adding an ENUM label
// creates no table, no constraint and no index, so the gate stays green either way. The
// label mirroring is proven by tests/migrations/columnMirror.test.js (which asserts the
// pg_enum label set on the sync-built database AND that this file exists on disk naming
// its own value) and by this migration booting under `migrate:apply` — never by the gate.
//
// NON-TRANSACTIONAL: `ALTER TYPE ... ADD VALUE` is deliberately NOT wrapped in an
// explicit transaction, and the new value is NOT used anywhere in this migration.
// Postgres 12+ permits ADD VALUE inside a transaction block but forbids *using* the
// new value in that same transaction. Target is Postgres 16 (see
// periodictabletopbackend_v2/.github/workflows/ci.yml `image: postgres:16`). Same
// shape as the two in-repo precedents,
// migrations/20260725000002-single-use-tokens-group-restore.js:23-30 and
// migrations/20260322000001-add-pending-role-to-usergroups.js:1-19, whose headers
// record the same constraint. `down()` therefore cannot remove the value and logs
// instead, mirroring both.
//
// ONE-WAY, owner-ruled 2026-09-04 (plan 88.8-02 Task 2, CONTEXT D-07): a Postgres ENUM
// value cannot be dropped by down(). Accepted on the record — an unused label has no
// side effects. Rejected at discuss: a DEDICATED TABLE for email-change verifications
// (fully reversible, but it silently opts out of the account-deletion sweep that
// destroys these rows by user — services/accountDeletionService.js:286 and
// services/pendingAuth0DeletionSweep.js:203 both run
// `SingleUseToken.destroy({ where: { user_id: sub } })` — and post-A12 each of these
// rows holds a REAL pending email address in `target`, so a missed sweep is a PII leak,
// not a stale row); and a FREE-TEXT `purpose` column (loses the database-level
// constraint for oauth_state/rsvp/group_restore too).

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // ENUM value. Idempotent via IF NOT EXISTS — a re-run is a no-op, not a throw,
    // which matters because a throwing migration blocks the Railway deploy at
    // preDeployCommand before /health is ever reached (T-88.8-09). Deliberately no
    // transaction option at all, and the value is not USED below.
    await sequelize.query(
      `ALTER TYPE "enum_single_use_tokens_purpose" ADD VALUE IF NOT EXISTS 'email_change_verify';`
    );

    console.log(
      '[88.8] single_use_tokens: email_change_verify ENUM value added to enum_single_use_tokens_purpose.'
    );
  },

  async down() {
    // PostgreSQL cannot remove an individual ENUM value without recreating the type.
    // Leaving 'email_change_verify' in enum_single_use_tokens_purpose is harmless — an
    // unused value has no side effects. Same disposition as the two precedents:
    // migrations/20260725000002-single-use-tokens-group-restore.js down() and
    // migrations/20260322000001-add-pending-role-to-usergroups.js down().
    console.log(
      "[88.8] NOTE: 'email_change_verify' remains in enum_single_use_tokens_purpose (PostgreSQL cannot remove ENUM values without recreating the type)."
    );
  },
};
