'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.4 Plan 08 — drop four REDUNDANT DUPLICATE constraints from production.
// Closes census findings F-36, F-37, F-38, F-39 (88.4-DRIFT-CENSUS.md § 4.3, root cause RC-2),
// under owner decision D3a (2026-07-30).
//
// SCHEMA DUAL-WRITE (the rule this whole phase exists to enforce). This migration is the PROD
// source of truth for the change: it runs under `migrate:apply` -> `npx sequelize-cli db:migrate`
// and is tracked in SequelizeMeta. The corresponding sync/CI source is the MODELS —
// models/EventParticipation.js + models/index.js:102-103 (F-37), models/Event.js:37-38,45-46 +
// models/index.js:107-108 (F-38/F-39), and models/SingleUseToken.js:124-128 (F-36). All four
// already declare exactly ONE object each, which is why the sync side is correct and prod is the
// side being fixed here — no model edit accompanies this file. IF YOU CHANGE ONE SIDE, CHANGE THE
// OTHER. Phase 88.4 is the phase that finally ENFORCES that rule mechanically: the
// `migrate-cli-replay` CI job replays this chain from an empty database, builds a second database
// from the models with sync(), and structurally diffs the two.
//
// WHAT WENT WRONG (RC-2), because it decides the DIRECTION of this fix. Three earlier migrations
// guard their `ADD CONSTRAINT` with `SELECT 1 FROM pg_constraint WHERE conname = :name` using a
// LOWERCASE name, while the constraint that already existed — created by `sync()` in the
// pre-migration era and faithfully reproduced by the baseline migration — is CamelCase. The guard
// found nothing and added a SECOND, functionally identical foreign key on the same column, with no
// error. So we KEEP THE CamelCase CONSTRAINT (which matches what the models emit, byte for byte)
// and DROP THE LOWERCASE DUPLICATE — prod converges on the sync definition, not the reverse.
// F-36 is the same defect in a different spelling: 20260618000002-create-single-use-tokens.js:47
// sets column-level `unique: true` (yielding constraint `single_use_tokens_nonce_key`) AND :100
// creates the named index `single_use_tokens_nonce_unique` — two unique objects on one column.
// models/SingleUseToken.js:24-30 documents that exact collision and declares only the named index;
// the migration was never fixed.
//
// The guards themselves are hardened in the SAME commit as this file
// (20260701000002:49-52 and 20260709000001:67-70 now probe (column, parent) rather than a name).
// That fixes the from-empty replay and every future database; it CANNOT fix prod, because those
// filenames are already booked in prod's SequelizeMeta and will never run there again. Hence this
// file. Neither half substitutes for the other.
//
// ============================================================================================
// DIRECTION-SAFE BY CONSTRUCTION — READ THIS BEFORE "SIMPLIFYING" THE PROBES BELOW.
//
// Whether PROD actually carries these duplicates is a fact about provisioned database history,
// and the drift gate is structurally blind to it (census § 6.1): the duplicate is PROVEN on the
// from-empty replay, but on prod it depends on whether prod's tables still held the CamelCase
// sync()-era constraint at the moment the Phase 87/87.2 migration ran. If prod holds ONLY the
// lowercase FK, then dropping it would leave prod with NO foreign key at all — strictly worse than
// the duplicate.
//
// So nothing here drops anything unconditionally. Each step drops the redundant object ONLY IF a
// structurally equivalent one survives it. That makes this migration correct under BOTH possible
// prod states, and it is why it can ship before the read-only prod audit is reported. It is also
// why every step logs what it found: the Railway pre-deploy log becomes the record of what prod
// actually contained.
//
// Reproduce the audit read-only, against any database:
//   SELECT conrelid::regclass, conname, pg_get_constraintdef(oid)
//     FROM pg_constraint
//    WHERE conrelid IN ('"Events"'::regclass, '"EventParticipations"'::regclass)
//      AND contype = 'f'
//    ORDER BY 1, 2;
// Expected on a database carrying the duplicates: 9 rows across the two tables (4 CamelCase +
// 2 lowercase on Events, 2 CamelCase + 1 lowercase on EventParticipations). Expected once this
// migration has run: 6.
// ============================================================================================
//
// LOCK COST. Every statement here is a `DROP CONSTRAINT` or `DROP INDEX`, not an add. A drop takes
// a brief ACCESS EXCLUSIVE lock and performs NO table scan and NO validation — there is nothing to
// verify when removing a constraint. Row counts are therefore irrelevant to the cost of this
// migration, and the `NOT VALID` / `VALIDATE CONSTRAINT` two-step form does not apply (it exists to
// split the validation scan out of an ADD). This is the cheapest possible shape of change; the
// remaining constraint continues to enforce the same rule with zero gap, because it is never
// dropped and the whole thing is one transaction.
//
// ORPHAN CHECK — NOT APPLICABLE HERE, and the reason is stated rather than left implied, because
// "no orphan check" is otherwise indistinguishable from "forgot the orphan check".
//
// An orphan scan is mandatory before ADDING a foreign key, because `ADD CONSTRAINT` validates every
// existing row and fails outright on the first violation. `up()` in this file ADDS NOTHING — every
// statement is a `DROP CONSTRAINT`, and dropping a constraint cannot fail on data. There is no row
// state that can make this migration abort mid-deploy.
//
// The only `ADD CONSTRAINT` in this file is in `down()`, restoring the duplicates. It needs no
// orphan check either, and not by luck: a duplicate is BY DEFINITION structurally identical to the
// sibling constraint that was never dropped and is still enforcing the same rule, so every row in
// the table already satisfies it. `down()` additionally refuses to add a duplicate when that sibling
// is absent (see the guard there), which is the case where the assumption would not hold.
//
// The FK-ADD orphan measurement this phase does require lives in
// 20260730000003-reconcile-single-use-tokens-user-fk.js, the one migration that adds a genuinely new
// foreign key.
//
// CONSUMER SWEEP — none needed, and the reason is worth stating rather than leaving implied.
// Adding an FK changes DELETE semantics and demands a sweep of service code. This migration only
// REMOVES REDUNDANT objects: after each step the surviving constraint enforces exactly the same
// referential rule with the same ON DELETE action, so no delete ordering that was legal before
// becomes illegal, and none becomes a silent no-op. Nothing in services/ or workers/ can observe
// the difference. (The FK-ADD sweeps live in 20260730000003, which does add one.)
//
// IRREVERSIBLE-ISH `down()`: see the note on down() at the bottom.

const { QueryTypes } = require('sequelize');

// The duplicate FK pairs. `keep` matches what the models emit; `drop` is the lowercase duplicate a
// conname-only guard added. Pinned by (table, column, parent) so the probe is structural.
const DUPLICATE_FKS = [
  {
    finding: 'F-37',
    table: 'EventParticipations',
    column: 'user_id',
    parent: 'Users',
    keep: 'EventParticipations_user_id_fkey',
    drop: 'eventparticipations_user_id_fkey',
    addedBy: '20260701000002-add-eventparticipation-user-fk.js:54-58',
  },
  {
    finding: 'F-38',
    table: 'Events',
    column: 'picked_by_id',
    parent: 'Users',
    keep: 'Events_picked_by_id_fkey',
    drop: 'events_picked_by_id_fkey',
    addedBy: '20260709000001-add-event-winner-picker-fks.js:67-79',
  },
  {
    finding: 'F-39',
    table: 'Events',
    column: 'winner_id',
    parent: 'Users',
    keep: 'Events_winner_id_fkey',
    drop: 'events_winner_id_fkey',
    addedBy: '20260709000001-add-event-winner-picker-fks.js:67-79',
  },
];

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      // ---- F-37 / F-38 / F-39: drop each lowercase duplicate FK, but only if its CamelCase
      // ---- counterpart on the same (column, parent) survives.
      for (const fk of DUPLICATE_FKS) {
        const siblings = await sequelize.query(
          `SELECT c.conname
             FROM pg_constraint c
             JOIN pg_attribute a
               ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f'
              AND c.conrelid  = to_regclass(:child)
              AND c.confrelid = to_regclass(:parent)
              AND array_length(c.conkey, 1) = 1
              AND a.attname = :column`,
          {
            replacements: {
              child: `"${fk.table}"`,
              parent: `"${fk.parent}"`,
              column: fk.column,
            },
            type: QueryTypes.SELECT,
            transaction: t,
          }
        );
        const names = siblings.map((r) => r.conname);
        const survivors = names.filter((n) => n !== fk.drop);

        if (!names.includes(fk.drop)) {
          console.log(
            `[88.4-reconcile] ${fk.finding}: ${fk.table}.${fk.column} -> ${fk.parent} carries ` +
              `${names.length} FK(s) [${names.join(', ')}]; the duplicate "${fk.drop}" is not ` +
              `present. Nothing to drop — this database never took the ${fk.addedBy} branch that ` +
              `creates it, or it has already been cleaned.`
          );
          continue;
        }
        if (survivors.length === 0) {
          // The prod state census § 4.3 flagged as UNVERIFIED and possible. Dropping here would
          // leave the column with NO foreign key, so we refuse and say so loudly. The hardened
          // guard in the source migration already prevents recurrence, so the correct outcome in
          // this world is simply to keep the one FK that exists.
          console.log(
            `[88.4-reconcile] ${fk.finding}: ${fk.table}.${fk.column} -> ${fk.parent} carries ` +
              `ONLY "${fk.drop}" and no equivalent survivor. NOT dropping it — that would leave ` +
              `the column with no foreign key at all, which is worse than a redundant one. This ` +
              `is the alternative prod state census § 4.3 records as UNVERIFIED; the reconciliation ` +
              `in this world is the hardened (column, parent) guard shipped alongside this file, ` +
              `which stops the class recurring. No action needed.`
          );
          continue;
        }

        await sequelize.query(
          `ALTER TABLE "${fk.table}" DROP CONSTRAINT IF EXISTS "${fk.drop}"`,
          { transaction: t }
        );
        console.log(
          `[88.4-reconcile] ${fk.finding}: dropped redundant FK "${fk.drop}" from ` +
            `${fk.table}.${fk.column}; "${survivors.join(', ')}" survives and enforces the same ` +
            `rule. Duplicate was added by ${fk.addedBy}.`
        );
      }

      // ---- F-36: two unique objects on single_use_tokens.nonce.
      // `single_use_tokens_nonce_key` is the column-level `unique: true` constraint from
      // 20260618000002:47; `single_use_tokens_nonce_unique` is the explicitly-named index from
      // :100 — and the named index is the ONE the model declares
      // (models/SingleUseToken.js:124-128). So drop the CONSTRAINT and keep the INDEX.
      //
      // The direction matters and is not arbitrary: dropping the named index instead would leave
      // prod enforcing uniqueness under an auto-generated constraint name that no model declares,
      // and the drift gate would still report the mismatch. Uniqueness is never interrupted —
      // the surviving index enforces it throughout, inside this one transaction.
      const nonceObjects = await sequelize.query(
        `SELECT i.relname AS name,
                EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = ix.indexrelid) AS backs_constraint
           FROM pg_index ix
           JOIN pg_class i ON i.oid = ix.indexrelid
          WHERE ix.indrelid = to_regclass('single_use_tokens')
            AND ix.indisunique
            AND NOT ix.indisprimary
            AND ix.indnkeyatts = 1
            AND (SELECT a.attname FROM pg_attribute a
                  WHERE a.attrelid = ix.indrelid AND a.attnum = ix.indkey[0]) = 'nonce'
          ORDER BY i.relname`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const nonceNames = nonceObjects.map((r) => r.name);
      const REDUNDANT_NONCE = 'single_use_tokens_nonce_key';
      const KEEP_NONCE = 'single_use_tokens_nonce_unique';

      if (nonceNames.includes(REDUNDANT_NONCE) && nonceNames.includes(KEEP_NONCE)) {
        // It is a CONSTRAINT, so it must be dropped as one — `DROP INDEX` refuses to remove an
        // index that backs a constraint.
        await sequelize.query(
          `ALTER TABLE single_use_tokens DROP CONSTRAINT IF EXISTS "${REDUNDANT_NONCE}"`,
          { transaction: t }
        );
        console.log(
          `[88.4-reconcile] F-36: dropped redundant unique constraint "${REDUNDANT_NONCE}" from ` +
            `single_use_tokens.nonce; "${KEEP_NONCE}" survives and continues to enforce ` +
            `uniqueness. Both were created by 20260618000002 (:47 column-level unique, :100 the ` +
            `named index); the model has only ever declared the named index.`
        );
      } else if (!nonceNames.includes(KEEP_NONCE)) {
        console.log(
          `[88.4-reconcile] F-36: single_use_tokens.nonce carries [${nonceNames.join(', ')}] and ` +
            `NOT "${KEEP_NONCE}". NOT dropping anything — removing the only unique object would ` +
            `drop nonce uniqueness, which is a security control (single-use token replay). ` +
            `Investigate before re-running.`
        );
      } else {
        console.log(
          `[88.4-reconcile] F-36: single_use_tokens.nonce already carries exactly ` +
            `[${nonceNames.join(', ')}] — nothing redundant to drop.`
        );
      }
    });
  },

  async down(queryInterface) {
    // A REAL down(), unlike Plan 01's baseline: it re-creates the duplicates this migration
    // removed, so the schema is restored exactly. That is deliberately a faithful rollback of a
    // schema change and NOT an endorsement — re-running `up()` afterwards removes them again.
    //
    // Guarded the same way `up()` is, and for the same reason: on a database that never had the
    // duplicates (any from-empty replay after the guards were hardened), re-creating them here
    // would MANUFACTURE the very drift this phase removes. So down() only restores a duplicate on
    // a table that still has its surviving counterpart, and it uses the same
    // `IF NOT EXISTS`-equivalent structure probe on the NAME (a duplicate is, by definition,
    // structurally identical to its sibling, so a structural probe cannot distinguish them here —
    // the name check is the correct one for this direction).
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      const REDUNDANT_NONCE = 'single_use_tokens_nonce_key';
      const nonceExists = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: REDUNDANT_NONCE }, type: QueryTypes.SELECT, transaction: t }
      );
      if (nonceExists.length === 0) {
        await sequelize.query(
          `ALTER TABLE single_use_tokens
             ADD CONSTRAINT "${REDUNDANT_NONCE}" UNIQUE (nonce)`,
          { transaction: t }
        );
        console.log(`[88.4-reconcile] down: restored ${REDUNDANT_NONCE}.`);
      }

      // Reverse order of up().
      for (const fk of [...DUPLICATE_FKS].reverse()) {
        const exists = await sequelize.query(
          `SELECT 1 FROM pg_constraint WHERE conname = :name`,
          { replacements: { name: fk.drop }, type: QueryTypes.SELECT, transaction: t }
        );
        if (exists.length > 0) continue;

        const keepExists = await sequelize.query(
          `SELECT 1 FROM pg_constraint WHERE conname = :name`,
          { replacements: { name: fk.keep }, type: QueryTypes.SELECT, transaction: t }
        );
        if (keepExists.length === 0) {
          console.log(
            `[88.4-reconcile] down: skipping ${fk.drop} — its counterpart ${fk.keep} is absent, ` +
              `so this database never carried the duplicate and re-creating it would manufacture ` +
              `drift.`
          );
          continue;
        }

        const action = fk.column === 'user_id' ? 'CASCADE' : 'SET NULL';
        await sequelize.query(
          `ALTER TABLE "${fk.table}"
             ADD CONSTRAINT "${fk.drop}"
             FOREIGN KEY (${fk.column}) REFERENCES "${fk.parent}"(id) ON DELETE ${action}`,
          { transaction: t }
        );
        console.log(`[88.4-reconcile] down: restored ${fk.drop} (ON DELETE ${action}).`);
      }
    });
  },
};
