// migrations/20261025000001-add-schedule-id-to-availability-prompts.js
//
// quick-261025-rl3 (261025-dzo review WR-02): adds nullable schedule_id to
// AvailabilityPrompts and links the automatic polls the worker already wrote.
// Before this, workers/promptWorker.js created every automatic poll with neither
// created_by_settings_id nor any link to the schedule that fired it, so the
// open-polls card could not name the schedule and the D-ADAPT-05 close email
// (services/promptLifecycleService.js, handlePromptClosed) resolved no recipient.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); its counterpart is `models/AvailabilityPrompt.js`,
// which declares `schedule_id` with byte-identical type and nullability (UUID,
// allowNull true, no default, no foreign key). Change one, change the other — the
// Jest/CI database is built by `sequelize.sync({ force: true })` in
// tests/globalSetup.js and never by this file, so a divergence here is invisible
// until prod.
//
// Pitfall 2 — the drift gate does NOT cover this. `migrate-cli-replay` runs
// scripts/ci/schema-drift-diff.js, which diffs foreign keys, PK/UNIQUE
// constraints, indexes and a table inventory ONLY. A missing addColumn adds no
// table, no constraint and no index, so migrate-cli-replay stays green. The
// compensating control is tests/migrations/columnMirror.test.js, which asserts
// this file exists on disk and names its own column.
//
// DECISION quick-261025-rl3 (261025-dzo review WR-02): the poll stores a LINK to
// the nested schedule, OVER a name snapshot on the poll — a rename shows through
// on the next read and there is no second copy of the name to drift. REJECTED a
// schedule_name string column (it goes stale on rename). REJECTED parsing the
// schedule id out of week_identifier at read time (that is a dedup key, not a
// link; the one-time parse below is the recovery of links the worker never wrote,
// not a read path). No foreign key, because the target is an element of
// GroupPromptSettings.template_config.schedules, not a row. Turning this into a
// stored name, or adding a constraint to a table it cannot reference, is a
// decision, not a cleanup.
//
// THE BACKFILL links only rows the worker wrote: both creator columns null and a
// week_identifier of exactly the two shapes workers/promptWorker.js builds
// (`${isoWeek}-${schedule.id}` or `${isoWeek}-legacy`). Manual polls take a
// client-supplied week_identifier and lose created_by_user_id to SET NULL when
// the creator's user row goes, so a looser "any YYYY-Www- prefix" predicate could
// link a manual poll; the exact shapes keep that to a client key that mimics the
// worker form. The seed's bare ISO week ("2026-W43") and the e2e fixture keys
// never match. One settings row per group (models/GroupPromptSettings.js,
// `unique: true, // One settings per group`) makes the join one-to-one.
//
// DEPLOY WINDOW: a poll the OLD worker creates between this migration and the new
// container starting stays unlinked. Running this file directly
// (`node migrations/20261025000001-add-schedule-id-to-availability-prompts.js`,
// the require.main runner below) re-runs only the idempotent backfill, because
// the column add is guarded.
const sequelize = require('../config/database');

// Shared patterns: the JS parser and the SQL read the SAME strings (the SQL
// receives them as replacements), so the two can never drift apart.
// getISOWeek in workers/promptWorker.js always yields `YYYY-Www`.
const WEEK_PREFIX = '^[0-9]{4}-W[0-9]{2}-';
const UUID_TEXT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const WORKER_WEEK_KEY = WEEK_PREFIX + '(legacy|' + UUID_TEXT + ')$';
const SCHEDULE_WEEK_KEY = WEEK_PREFIX + UUID_TEXT + '$';

const BACKFILL_REPLACEMENTS = {
  workerKey: WORKER_WEEK_KEY,
  scheduleKey: SCHEDULE_WEEK_KEY,
  weekPrefix: WEEK_PREFIX,
};

/**
 * Reads a week_identifier the way the backfill does.
 * Returns null unless it is one of the two keys the worker writes; otherwise
 * { scheduleId } — the lowercased UUID after the week prefix, or null for the
 * `legacy` key.
 */
function parseWorkerWeekKey(weekIdentifier) {
  if (typeof weekIdentifier !== 'string' || !new RegExp(WORKER_WEEK_KEY).test(weekIdentifier)) {
    return null;
  }
  if (new RegExp(SCHEDULE_WEEK_KEY).test(weekIdentifier)) {
    return { scheduleId: weekIdentifier.replace(new RegExp(WEEK_PREFIX), '').toLowerCase() };
  }
  return { scheduleId: null };
}

// CAST(... AS uuid), not the double-colon cast, so the replacement parser never
// sees a colon it might read as a bind name.
const BACKFILL_SQL = `
  UPDATE "AvailabilityPrompts" AS ap
     SET created_by_settings_id = gps.id,
         schedule_id = CASE
           WHEN ap.week_identifier ~ :scheduleKey
             THEN CAST(regexp_replace(ap.week_identifier, :weekPrefix, '') AS uuid)
           ELSE NULL
         END
    FROM "GroupPromptSettings" AS gps
   WHERE gps.group_id = ap.group_id
     AND ap.created_by_user_id IS NULL
     AND ap.created_by_settings_id IS NULL
     AND ap.week_identifier ~ :workerKey
  RETURNING ap.id, ap.schedule_id`;

async function up() {
  const queryInterface = sequelize.getQueryInterface();
  const { DataTypes } = require('sequelize');

  // Idempotent column add. A throwing migration blocks the Railway deploy at
  // preDeployCommand, before /health is ever reached.
  const tableDescription = await queryInterface.describeTable('AvailabilityPrompts');
  if (!tableDescription.schedule_id) {
    await queryInterface.addColumn('AvailabilityPrompts', 'schedule_id', {
      type: DataTypes.UUID,
      allowNull: true,
    });
    console.log('[WR-02] Added schedule_id column to AvailabilityPrompts.');
  } else {
    console.log('[WR-02] Column schedule_id already exists on AvailabilityPrompts. Skipping the add.');
  }

  // Deliberately NO early return above (the template this file copies returns
  // when the column exists). The backfill must run on a database that already has
  // the column and on every re-run; it is idempotent because it only touches rows
  // whose created_by_settings_id is still null.
  const [rows] = await sequelize.query(BACKFILL_SQL, { replacements: BACKFILL_REPLACEMENTS });
  const linked = Array.isArray(rows) ? rows.length : 0;
  const withSchedule = Array.isArray(rows) ? rows.filter((r) => r.schedule_id !== null).length : 0;
  console.log(`[WR-02] backfill linked ${linked} automatic poll(s) to their settings row, ${withSchedule} with a schedule id.`);
}

async function down() {
  const queryInterface = sequelize.getQueryInterface();
  await queryInterface.removeColumn('AvailabilityPrompts', 'schedule_id');
  console.log('[WR-02] Dropped schedule_id column from AvailabilityPrompts. Backfilled created_by_settings_id values stay (they are correct data).');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = {
  up,
  down,
  WEEK_PREFIX,
  UUID_TEXT,
  WORKER_WEEK_KEY,
  SCHEDULE_WEEK_KEY,
  BACKFILL_REPLACEMENTS,
  BACKFILL_SQL,
  parseWorkerWeekKey,
};
