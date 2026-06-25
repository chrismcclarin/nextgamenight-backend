// queues/__mocks__/index.js
// Manual Jest mock for the queue layer (BTEST-04 / D-03 part 1).
//
// Activated by `jest.mock('../../queues')` in unit suites that exercise enqueue
// or mount a route/service that transitively imports queues. Returns stub
// queues with a jest.fn `.add` so suites can assert "did my code enqueue the
// right job?" without a real Redis.
//
// Most failing suites already mock at the SERVICE boundary, so once lazy-connect
// (the real queue modules) stops the import-time throw they will not even need
// this — it exists for suites that directly assert enqueue behavior. Mirrors the
// repo's "mock-a-boundary / No DB, no Redis" convention
// (tests/routes/rsvp.gcalCleanup.test.js, tests/services/gcalCleanupService.test.js).

// WR-03: mirror the full Queue surface that prod consumers actually call so a suite
// activating this mock exercises a faithful double, not a divergent one:
//  - add (enqueue assertions)
//  - getJobCounts (routes/adminMetrics.js)
//  - upsertJobScheduler / getJobSchedulers / removeJobScheduler (schedulers/promptScheduler.js)
//  - close (teardown)
const stubQueue = () => ({
  add: jest.fn().mockResolvedValue({ id: 'mock-job' }),
  getJobCounts: jest.fn().mockResolvedValue({}),
  upsertJobScheduler: jest.fn().mockResolvedValue({}),
  getJobSchedulers: jest.fn().mockResolvedValue([]),
  removeJobScheduler: jest.fn().mockResolvedValue(undefined),
  close: jest.fn(),
});

module.exports = {
  reminderQueue: stubQueue(),
  promptQueue: stubQueue(),
  deadlineQueue: stubQueue(),
  gcalSyncQueue: stubQueue(),
  connection: {
    quit: jest.fn(),
    disconnect: jest.fn(),
  },
};
