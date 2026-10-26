// tests/migrations/scheduleIdBackfill.db.test.js
//
// quick-261025-rl3 (261025-dzo review WR-02): the real-Postgres proof of the
// one-time backfill in
// migrations/20261025000001-add-schedule-id-to-availability-prompts.js.
//
// THIS IS NOT A SCHEMA REPLAY, AND MUST NOT BE DELETED AS ONE (orchestrator
// ruling 2026-10-25). The CLAUDE.md "never replay a migration in the suite" rule
// exists because tests that replayed SCHEMA migrations (tests/migrations/
// rekey.test.js) left an older schema behind and poisoned every later suite. This
// file runs DML only: the schedule_id column already exists in the sync-built
// schema (models/AvailabilityPrompt.js declares it), so up()'s describeTable guard
// skips the addColumn and no DDL runs; down() is never called. tests/setup.js
// truncates every table before each test, so the rows seeded here cannot leak.
// Precedent: tests/migrations/groupColourPreset.test.js already runs a data
// migration's up() in-suite (its `remap` require).
//
// Every scenario sits inside ONE `it` (seed -> up -> assert), because the global
// beforeEach truncates between tests.

const crypto = require('crypto');
const { AvailabilityPrompt, GroupPromptSettings } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

const migration = require('../../migrations/20261025000001-add-schedule-id-to-availability-prompts.js');

function makePoll(group, weekIdentifier, extra = {}) {
  return AvailabilityPrompt.create({
    group_id: group.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: 'active',
    week_identifier: weekIdentifier,
    ...extra,
  });
}

async function runUpCapturingLog() {
  const lines = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((...args) => {
    lines.push(args.join(' '));
  });
  try {
    await migration.up();
  } finally {
    spy.mockRestore();
  }
  // Echo for the record (the SUMMARY quotes these lines from a run alone).
  lines.forEach((l) => process.stdout.write(`${l}\n`));
  return lines;
}

describe('scheduleIdBackfill on real Postgres (quick-261025-rl3, dzo review WR-02)', () => {
  it('links only the polls the worker wrote, and a second run links 0', async () => {
    const creator = await makeUser({ username: 'rl3-backfill-creator' });
    const g1 = await makeGroup({ name: 'RL3 Backfill G1' });
    const g2 = await makeGroup({ name: 'RL3 Backfill G2 (no settings row)' });
    await addToGroup(creator, g1, 'owner');

    const A = crypto.randomUUID();
    const settings = await GroupPromptSettings.create({
      group_id: g1.id,
      schedule_timezone: 'UTC',
      template_config: { schedules: [{ id: A, template_name: 'Thursday Catan', is_active: true }] },
    });

    const a = await makePoll(g1, `2026-W43-${A}`);
    const b = await makePoll(g1, '2026-W44-legacy');
    const c = await makePoll(g1, `2026-W45-${A}`, { created_by_user_id: creator.id });
    const d = await makePoll(g1, '2026-W46');
    const e = await makePoll(g1, 'e2e-ci-magic-link');
    const f = await makePoll(g2, `2026-W43-${A}`);
    const g = await makePoll(g1, `2026-W47-${A}`, { created_by_settings_id: settings.id });

    const first = await runUpCapturingLog();
    expect(first).toEqual(expect.arrayContaining([
      expect.stringContaining('[WR-02] Column schedule_id already exists'),
      '[WR-02] backfill linked 2 automatic poll(s) to their settings row, 1 with a schedule id.',
    ]));

    const read = async (row) => {
      const r = await AvailabilityPrompt.findByPk(row.id);
      return { settings: r.created_by_settings_id, schedule: r.schedule_id, user: r.created_by_user_id };
    };

    // (a) worker key with a UUID: linked to the settings row and to schedule A.
    expect(await read(a)).toEqual({ settings: settings.id, schedule: A, user: null });
    // (b) worker legacy key: linked to the settings row, no schedule.
    expect(await read(b)).toEqual({ settings: settings.id, schedule: null, user: null });
    // (c) manual poll with a worker-shaped key: untouched (it has a creator).
    expect(await read(c)).toEqual({ settings: null, schedule: null, user: creator.id });
    // (d) bare ISO week (the seed's shape): untouched.
    expect(await read(d)).toEqual({ settings: null, schedule: null, user: null });
    // (e) e2e fixture key: untouched.
    expect(await read(e)).toEqual({ settings: null, schedule: null, user: null });
    // (f) worker key in a group with no settings row: untouched.
    expect(await read(f)).toEqual({ settings: null, schedule: null, user: null });
    // (g) already linked to its settings row: untouched (schedule_id stays null).
    expect(await read(g)).toEqual({ settings: settings.id, schedule: null, user: null });

    const second = await runUpCapturingLog();
    expect(second).toContain('[WR-02] backfill linked 0 automatic poll(s) to their settings row, 0 with a schedule id.');
  });
});
