#!/usr/bin/env node
'use strict';
//
// scripts/ci/provision-premigration-schema.js
//
// F8 (Phase 87.1 review, HIGH-2 option 3): provision a TRUE pre-migration schema so CI can
// exercise the REAL sequelize-cli path (`npx sequelize-cli db:migrate`) for the 7 UUID
// re-key migrations (20260703000001..07). The known local cli-migrations gap
// (URL-only CLI config + a full-chain replay that collides on already-built tables) means
// Railway pre-deploy would otherwise be the FIRST-EVER real CLI run of these migrations —
// this script + the migrate-cli-replay CI job move that first real run into CI.
//
// It reuses the same pre-migration-shape technique as tests/migrations/rekey.test.js:
//   run each migration's own down() (drops the *_uuid column + its FK + uuid indexes;
//   Postgres auto-drops the sync-built dependent index/constraint objects), then re-add
//   the legacy Auth0-string column(s) via raw SQL — because Plan 09 removed them from the
//   models, sync() no longer builds them, so without this the migrations' backfill UPDATE
//   / DROP-NOT-NULL steps (which reference the old column) would throw "column does not
//   exist".
//
// MODES
//   provision (default):
//     1. sync-build the schema from the MODELS (POST-migration shape: *_uuid present,
//        legacy string columns absent);
//     2. transform the 7 re-keyed tables to TRUE pre-migration shape (down() + re-add
//        legacy columns);
//     3. seed SequelizeMeta with EVERY migration filename EXCEPT the 7 new 20260703* ones,
//        so `db:migrate` runs ONLY those 7 (the ~53 older migrations assume an empty DB
//        and are already satisfied by the sync-built schema — marking them applied skips
//        them, avoiding the A5 "earliest migration assumes Users exists" collision).
//   verify:
//     assert SequelizeMeta now records all 7 of the 20260703* filenames (run AFTER
//     `npx sequelize-cli db:migrate`).
//
// LOCAL PROOF (against the sandbox test DB):
//   DATABASE_URL=postgres://... node scripts/ci/provision-premigration-schema.js provision
//   DATABASE_URL=postgres://... npx sequelize-cli db:migrate
//   DATABASE_URL=postgres://... node scripts/ci/provision-premigration-schema.js verify
//
// The CLI config (config/sequelize-cli.config.js) resolves DATABASE_URL via the same
// precedence chain as the runtime, so all three commands hit the same DB.

const fs = require('fs');
const path = require('path');
const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../models');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

// The 7 UUID re-key migrations + the legacy Auth0-string column(s) each one replaced.
// (Matches the rekey.test.js provisioning map; 000003/GroupInvite re-keys invited_by.)
const REKEY = [
  { file: '20260703000001-rekey-usergroup-user-uuid.js', table: 'UserGroups', legacy: ['user_id'] },
  { file: '20260703000002-rekey-friendship-uuid.js', table: 'Friendships', legacy: ['requester_id', 'addressee_id'] },
  { file: '20260703000003-rekey-groupinvite-invited-by-uuid.js', table: 'GroupInvites', legacy: ['invited_by'] },
  { file: '20260703000004-rekey-eventrsvp-user-uuid.js', table: 'EventRsvps', legacy: ['user_id'] },
  { file: '20260703000005-rekey-eventbring-user-uuid.js', table: 'EventBrings', legacy: ['user_id'] },
  { file: '20260703000006-rekey-eventballotvote-user-uuid.js', table: 'EventBallotVotes', legacy: ['user_id'] },
  { file: '20260703000007-rekey-sentnotification-user-uuid.js', table: 'SentNotifications', legacy: ['user_id'] },
  // Phase 87.5 (BE PR-1) — the 3 fresh sibling-column rekeys (availability CASCADE, ballot SET NULL).
  // Each retains its old sub column, so provision() must down()+re-add the legacy column for replay.
  { file: '20260720000001-rekey-useravailability-user-uuid.js', table: 'UserAvailabilities', legacy: ['user_id'] },
  { file: '20260720000002-rekey-availabilityresponse-user-uuid.js', table: 'AvailabilityResponses', legacy: ['user_id'] },
  { file: '20260720000003-rekey-eventballotoption-created-by-uuid.js', table: 'EventBallotOptions', legacy: ['created_by'] },
];
const REKEY_FILES = new Set(REKEY.map((r) => r.file));

// Phase 87.4 (Plan 03 owns this registration so Plans 03 and 04 stay parallel in wave 2
// with disjoint files). These are pure JSONB DATA migrations — NOT column re-keys — so
// they have no legacy column to down()/re-add and operate on the sync-built schema as-is.
// They are therefore EXCLUDED from the REKEY pre-migration-shape loop below, but STILL
// withheld from the SequelizeMeta seed so the CLI's `db:migrate` replays them under the
// migrate-cli-replay job (the `test` job builds schema via sync() and never migrates).
const DATA_MIGRATIONS_874 = new Set([
  '20260716000001-sweep-participant-user-ids-uuid.js',   // Plan 03 — participant_user_ids sub→UUID sweep
  '20260716000002-backfill-selected-member-ids-uuid.js', // Plan 04 — selected_member_ids sub→UUID backfill
  '20260716000003-resweep-selected-member-ids-uuid.js',  // Plan 11 — selected_member_ids PR-2 re-sweep (residue window close)
]);

// Phase 87.5 pure non-rekey DDL/data migrations replayed by the CLI (no legacy column to
// down()/re-add — they operate on the sync-built schema as-is, so they are EXCLUDED from
// the REKEY loop but STILL withheld from the SequelizeMeta seed). Plan 07 appends the 3
// PR-2 contract-drop filenames to this same set.
const DATA_MIGRATIONS_875 = new Set([
  '20260720000004-finalize-d08-notnull-drop-legacy.js', // Plan 01 — D-08 finalize (SET NOT NULL 7 + DROP 8 legacy)
]);

// Every migration the CLI path is expected to apply + book in SequelizeMeta.
const CLI_APPLIED_FILES = new Set([...REKEY_FILES, ...DATA_MIGRATIONS_874, ...DATA_MIGRATIONS_875]);

async function provision() {
  // Safety: sync({force:true}) DROPS every table. This script is CI/local-only and
  // must NEVER touch a production DB. Refuse under NODE_ENV=production (mirrors the
  // tests/globalSetup.js first guard); CI leaves NODE_ENV unset, local proof sets test.
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to provision: NODE_ENV=production (sync({force:true}) would drop every table)');
  }

  const qi = sequelize.getQueryInterface();

  // (1) Build the current (POST-migration) schema from the models.
  console.log('[premigration] sync({force:true}) — build POST-migration schema from models');
  await sequelize.sync({ force: true });

  // (2) Transform the 7 re-keyed tables to TRUE pre-migration shape.
  for (const { file, table, legacy } of REKEY) {
    const migration = require(path.join(MIGRATIONS_DIR, file));
    await migration.down(qi); // drops *_uuid + FK + uuid indexes (Postgres auto-drops dependents)
    for (const col of legacy) {
      await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col}" VARCHAR`);
    }
    console.log(`[premigration] ${table}: down() + re-added legacy column(s) ${legacy.join(', ')}`);
  }

  // (3) Seed SequelizeMeta with every migration EXCEPT the 7 new ones.
  await sequelize.query(
    `CREATE TABLE IF NOT EXISTS "SequelizeMeta" (
       "name" VARCHAR(255) NOT NULL,
       CONSTRAINT "SequelizeMeta_pkey" PRIMARY KEY ("name")
     )`
  );
  const allFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
  const toSeed = allFiles.filter((f) => !CLI_APPLIED_FILES.has(f));
  for (const name of toSeed) {
    await sequelize.query(
      `INSERT INTO "SequelizeMeta" ("name") VALUES (:name) ON CONFLICT ("name") DO NOTHING`,
      { replacements: { name } }
    );
  }
  console.log(
    `[premigration] SequelizeMeta seeded with ${toSeed.length} pre-existing migration(s); ` +
      `${CLI_APPLIED_FILES.size} migration(s) left UNAPPLIED for the CLI to run ` +
      `(${REKEY_FILES.size} re-key + ${DATA_MIGRATIONS_874.size} Phase-87.4 data + ${DATA_MIGRATIONS_875.size} Phase-87.5 data migrations).`
  );
}

async function verify() {
  const rows = await sequelize.query(
    `SELECT name FROM "SequelizeMeta" WHERE name IN (:names)`,
    { replacements: { names: [...CLI_APPLIED_FILES] }, type: QueryTypes.SELECT }
  );
  const found = new Set(rows.map((r) => r.name));
  const missing = [...CLI_APPLIED_FILES].filter((f) => !found.has(f));
  if (missing.length) {
    console.error(
      `[premigration:verify] FAIL — ${missing.length} migration(s) NOT recorded in ` +
        `SequelizeMeta after db:migrate:\n  ${missing.join('\n  ')}`
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `[premigration:verify] OK — all ${CLI_APPLIED_FILES.size} CLI migrations recorded in SequelizeMeta ` +
      `(${REKEY_FILES.size} re-key + ${DATA_MIGRATIONS_874.size} Phase-87.4 data + ${DATA_MIGRATIONS_875.size} Phase-87.5 data; the sequelize-cli path applied and booked them).`
  );
}

(async () => {
  const mode = process.argv[2] || 'provision';
  try {
    if (mode === 'provision') {
      await provision();
    } else if (mode === 'verify') {
      await verify();
    } else {
      console.error(`Unknown mode "${mode}" — use "provision" or "verify".`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[premigration] ${mode} threw:`, err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
