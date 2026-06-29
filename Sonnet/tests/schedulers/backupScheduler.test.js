// tests/schedulers/backupScheduler.test.js
// Phase 85 / Plan 06 (BAPI-02): additive Sentry capture on the swallowed weekly
// backup failure. Fully DB-FREE — no Postgres, no Redis, no real child process.
//
// Run in isolation via:
//   npx jest --config jest.unit.config.js \
//     --testMatch '**/tests/schedulers/backupScheduler.test.js' --forceExit
//
// Strategy: backupScheduler.js wires its failure logic inside the cron callback
// passed to node-cron's schedule(). We:
//   - mock node-cron to CAPTURE that callback (so we can invoke it directly),
//   - mock child_process.execFile to force the backup child to fail (or succeed),
//   - mock schedulerHealthService.recordRun to invoke the inner fn and CAPTURE its
//     return value (so we can assert the {sent:0,skipped:1} contract is unchanged),
//   - mock @sentry/node + set SENTRY_DSN BEFORE require so the DSN gate passes.

// --- captured state (mock-prefixed so jest.mock factories may close over it) ---
const mockCronState = { cb: null, result: undefined };
const mockCaptureException = jest.fn();
const mockExecFile = jest.fn();
const mockRecordRun = jest.fn(async (name, fn) => {
  mockCronState.result = await fn();
  return mockCronState.result;
});

// node-cron: capture the scheduled callback, return a no-op job handle.
jest.mock('node-cron', () => ({
  schedule: jest.fn((schedule, cb /* opts */) => {
    mockCronState.cb = cb;
    return { start: jest.fn(), stop: jest.fn() };
  }),
}));

// child_process: control the backup child's exit per test.
jest.mock('child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

// schedulerHealthService: invoke the inner fn and record its return value.
jest.mock('../../services/schedulerHealthService', () => ({
  recordRun: (...args) => mockRecordRun(...args),
}));

// @sentry/node mock (virtual — need not be installed for the unit-config run).
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCaptureException(...args),
}), { virtual: true });

// Force the DSN gate to pass BEFORE requiring the scheduler.
process.env.SENTRY_DSN = 'https://fake@sentry.io/85';

// Require AFTER the mocks/env are in place — this registers the cron callback.
require('../../schedulers/backupScheduler');

describe('backupScheduler additive Sentry capture (Phase 85/06 BAPI-02)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCronState.result = undefined;
    // recordRun must keep invoking the inner fn after clearAllMocks wipes calls.
    mockRecordRun.mockImplementation(async (name, fn) => {
      mockCronState.result = await fn();
      return mockCronState.result;
    });
  });

  it('captured a cron callback at require time', () => {
    expect(typeof mockCronState.cb).toBe('function');
  });

  it('backup failure: captures to Sentry (job:backup) AND returns {sent:0,skipped:1} with recordRun intact', async () => {
    // Force the backup child to exit non-zero.
    const childErr = new Error('backup exited 1');
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(childErr, '', 'stderr blob'));

    // Invoke the captured cron job callback (must NOT throw — swallow preserved).
    await mockCronState.cb();

    // recordRun telemetry still invoked with the 'backup' job name + a function.
    expect(mockRecordRun).toHaveBeenCalledTimes(1);
    expect(mockRecordRun).toHaveBeenCalledWith('backup', expect.any(Function));

    // Additive capture fired with the documented tag.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(childErr, { tags: { job: 'backup' } });

    // Behavior-preservation: the inner fn STILL returns {sent:0,skipped:1} verbatim.
    expect(mockCronState.result).toEqual({ sent: 0, skipped: 1 });
  });

  it('backup success: no capture, returns {sent:1,skipped:0}, recordRun still invoked', async () => {
    // Force the backup child to succeed (exit 0).
    mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, 'ok stdout', ''));

    await mockCronState.cb();

    expect(mockRecordRun).toHaveBeenCalledWith('backup', expect.any(Function));
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCronState.result).toEqual({ sent: 1, skipped: 0 });
  });
});
