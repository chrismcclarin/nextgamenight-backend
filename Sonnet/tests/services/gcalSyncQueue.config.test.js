// tests/services/gcalSyncQueue.config.test.js
// Phase 75 / Plan 02 -- unit tests for the gcal-sync BullMQ queue config.
//
// Plan 75-02 ships only the queue/worker infrastructure. These tests lock
// the contract Plan 75-03 will rely on:
//   1. Queue identity ('gcal-sync')
//   2. Retry config matches CONTEXT D-RETRY (3 attempts, exponential backoff,
//      removeOnFail=false so failed jobs stay in Bull Board for ops debugging)
//   3. Worker is bound to the same queue name
//   4. Bull Board route registers the queue (source-level inspection -- avoids
//      booting express + Redis just to verify wiring)
//
// BullMQ Queue construction is synchronous and does NOT connect to Redis until
// the first command, so the queue-identity + config assertions run without a
// live Redis. The worker DOES connect on construction; we always close it in
// afterAll so jest exits cleanly even when REDIS_URL points at a missing host.

// ---------------------------------------------------------------------------
// Mocks BEFORE requiring the worker (BTEST-04 / plan 83.1-04, review HIGH-4 +
// round-1 HIGH-5 + round-3 MEDIUM-4). `require('../../workers/gcalSyncWorker')`
// below would otherwise (a) construct a REAL `new Worker('gcal-sync', ...)` at
// import (workers/gcalSyncWorker.js:163) — a real worker that, in a shared
// process, competes for the integration ring's gcal-sync jobs — AND (b) run the
// module-top `const connection = new Redis(...)` at workers/gcalSyncWorker.js:40,
// which has NO `.on('error')` and NO `lazyConnect`, so under a Redis-less
// `npm test` it emits an unhandled ioredis 'error' on ECONNREFUSED (reds the
// suite) and even in CI leaks a Redis handle the mocked Worker.close never quits.
// Mock BOTH bullmq's Worker AND ioredis (mirroring tests/workers/gcalSyncWorker.test.js:31-40)
// so requiring the worker constructs NEITHER a real Worker NOR a real Redis at import.
//
// CRITICAL (round-1 HIGH-5): the analog mock sets only `this.on`/`this.close` and
// NOT `this.name`; this suite asserts `gcalSyncWorker.name === 'gcal-sync'` (L46),
// so the mocked Worker MUST set `this.name` from its first constructor arg (the
// queue name the real `new Worker('gcal-sync', ...)` passes). The real bullmq
// `Queue` is preserved via requireActual so the queue-identity / defaultJobOptions
// reads below still hit the real (lazy, Redis-less) Queue.
jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq');
  return {
    ...actual,
    Worker: jest.fn().mockImplementation(function (name) {
      this.name = name; // round-1 HIGH-5: preserve worker.name for the L46 assertion
      this.on = jest.fn();
      this.close = jest.fn().mockResolvedValue();
    })
  };
});
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  // bullmq's Queue.close() / RedisConnection.close() calls `.off`, `.quit`,
  // `.disconnect` on the connection. Stub the full surface the close path
  // touches so the afterAll teardown of the REAL (lazy) gcalSyncQueue — whose
  // connection is now this mock — is a clean no-op instead of throwing
  // "Cannot read properties of undefined (reading 'off')".
  on: jest.fn(),
  off: jest.fn(),
  once: jest.fn(),
  removeListener: jest.fn(),
  disconnect: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
  status: 'ready'
})));

const fs = require('fs');
const path = require('path');

const { gcalSyncQueue } = require('../../queues');
const gcalSyncWorker = require('../../workers/gcalSyncWorker');

afterAll(async () => {
  // Close the worker (mocked Worker.close is a no-op) and the queue. ioredis is
  // mocked for this suite, so neither the worker nor the queue holds a REAL Redis
  // handle to leak — but bullmq's internal RedisConnection.close() walks the
  // (mocked) connection and can throw on the stubbed surface. Swallow that: there
  // is nothing real to release, and --detectOpenHandles has no live handle to find.
  try {
    await gcalSyncWorker.close();
  } catch (_) { /* mocked worker — nothing to close */ }
  try {
    await gcalSyncQueue.close();
  } catch (_) { /* mocked ioredis — no real connection to release */ }
});

describe('gcal-sync queue config (Phase 75 / Plan 02)', () => {
  test('queue identity is "gcal-sync"', () => {
    expect(gcalSyncQueue.name).toBe('gcal-sync');
  });

  test('retry config matches CONTEXT D-RETRY (3 attempts, exponential backoff, removeOnFail=false)', () => {
    const opts = gcalSyncQueue.defaultJobOptions;
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toBeDefined();
    expect(opts.backoff.type).toBe('exponential');
    expect(typeof opts.backoff.delay).toBe('number');
    expect(opts.backoff.delay).toBeGreaterThan(0);
    expect(opts.removeOnFail).toBe(false); // keep failed jobs for debugging
  });

  test('worker is bound to the same queue name', () => {
    expect(gcalSyncWorker.name).toBe('gcal-sync');
  });

  test('Bull Board route registers gcalSyncQueue', () => {
    // Source-level assertion -- lighter weight than booting express + Redis.
    const bullBoardSrc = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'bullBoard.js'),
      'utf8'
    );
    expect(bullBoardSrc).toMatch(/BullMQAdapter\(gcalSyncQueue\)/);
    // Verify the queues require + gcalSyncQueue reference survived plan 02's lazy
    // relocation (round-2 HIGH): plan 02 moved the `require('../queues')` destructure
    // from module-top into mountBullBoard(); a multi-line / per-queue lazy require
    // (sanctioned by PATTERNS/RESEARCH) would split the tokens, failing the old
    // single-line `gcalSyncQueue.*require('../queues')` regex on a clean checkout.
    // Two independent, line-agnostic matches instead (may span lines).
    expect(bullBoardSrc).toMatch(/require\(['"]\.\.\/queues['"]\)/);
    expect(bullBoardSrc).toMatch(/gcalSyncQueue/);
  });
});
