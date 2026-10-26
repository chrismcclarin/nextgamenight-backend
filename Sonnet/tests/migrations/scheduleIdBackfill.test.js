// tests/migrations/scheduleIdBackfill.test.js
//
// quick-261025-rl3 (261025-dzo review WR-02): pure pins of the one-time backfill
// in migrations/20261025000001-add-schedule-id-to-availability-prompts.js.
//
// This file NEVER runs the migration and never queries the database. It pins the
// JS half (parseWorkerWeekKey, the exported patterns) and proves the SQL reads
// the same patterns through replacements rather than carrying its own copy. The
// rule it follows is tests/migrations/columnMirror.test.js's "THIS TEST MUST
// NEVER REPLAY A MIGRATION". The real-Postgres proof of the UPDATE lives in
// tests/migrations/scheduleIdBackfill.db.test.js (DML only, see its header).

const migration = require('../../migrations/20261025000001-add-schedule-id-to-availability-prompts.js');

const {
  WEEK_PREFIX,
  WORKER_WEEK_KEY,
  SCHEDULE_WEEK_KEY,
  BACKFILL_REPLACEMENTS,
  BACKFILL_SQL,
  parseWorkerWeekKey,
} = migration;

const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';

describe('scheduleIdBackfill: parseWorkerWeekKey reads only the two keys the worker writes (P1)', () => {
  it('a week plus a lowercase UUID gives that UUID', () => {
    expect(parseWorkerWeekKey(`2026-W43-${UUID}`)).toEqual({ scheduleId: UUID });
  });

  it('a week plus an uppercase UUID gives it lowercased', () => {
    expect(parseWorkerWeekKey(`2026-W43-${UUID.toUpperCase()}`)).toEqual({ scheduleId: UUID });
  });

  it('a week plus legacy is a worker key with no schedule id', () => {
    expect(parseWorkerWeekKey('2026-W43-legacy')).toEqual({ scheduleId: null });
  });

  it.each([
    ['2026-W43', 'the seed script bare ISO week'],
    ['e2e-ci-magic-link', 'the e2e fixture key'],
    ['2026-W43-sched-abc', 'a non-UUID schedule suffix'],
    [`2026-W43-${UUID}-x`, 'a UUID followed by more text'],
    ['', 'the empty string'],
    [null, 'null'],
    [undefined, 'undefined'],
  ])('%p (%s) is not a worker key: null', (value) => {
    expect(parseWorkerWeekKey(value)).toBeNull();
  });
});

describe('scheduleIdBackfill: the SQL shares the JS patterns (P2)', () => {
  it('BACKFILL_REPLACEMENTS carries the exported patterns, not copies', () => {
    expect(BACKFILL_REPLACEMENTS.workerKey).toBe(WORKER_WEEK_KEY);
    expect(BACKFILL_REPLACEMENTS.scheduleKey).toBe(SCHEDULE_WEEK_KEY);
    expect(BACKFILL_REPLACEMENTS.weekPrefix).toBe(WEEK_PREFIX);
  });

  it.each([
    ':workerKey',
    ':scheduleKey',
    ':weekPrefix',
    'ap.created_by_user_id IS NULL',
    'ap.created_by_settings_id IS NULL',
    'gps.group_id = ap.group_id',
    'RETURNING',
  ])('BACKFILL_SQL contains %p', (fragment) => {
    expect(BACKFILL_SQL).toContain(fragment);
  });

  it('BACKFILL_SQL writes no pattern inline (it could drift from the JS one)', () => {
    expect(BACKFILL_SQL).not.toContain('[0-9]{4}');
  });
});

describe('scheduleIdBackfill: module contract (P3)', () => {
  it('exports up and down as functions', () => {
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});
