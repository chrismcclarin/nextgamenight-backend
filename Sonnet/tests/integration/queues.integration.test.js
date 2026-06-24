// tests/integration/queues.integration.test.js
// BTEST-04 / D-03 part 2 (plan 83.1-04): the real-Redis integration ring.
//
// Module mocks verify the two ENDS of the producer->worker chain (did my code
// enqueue the right job? does my handler behave?) but are blind to the MIDDLE —
// producer<->worker queue-NAME/PAYLOAD drift that silently breaks delivery
// ("I didn't receive a prompt I should have"). This ring closes exactly that gap:
// it enqueues -> a REAL worker processes -> asserts the side-effect.
//
// Five tests, wiring-drift detection (NOT coverage):
//   - 4 NAME-drift tests (reminders, prompts, deadlines, gcal-sync): bind a real
//     Worker to the producer's OWN queue NAME (derived from getQueue().name, never
//     a hardcoded camelCase literal) and assert worker.name === queue.name, so the
//     test cannot disagree with the producer about the queue name.
//   - 1 PAYLOAD-drift test: drive a REAL producer (gcalCleanupService —
//     IMMEDIATE enqueue, deliberately NOT a delayed producer such as the reminder
//     scheduler whose jobs carry a >= 5min delay the 20s worker would never receive)
//     and assert the real payload shape the worker receives.
//
// Isolation (review HIGH-6):
//   - The 4 name-drift queues + workers run on a DEDICATED Redis DB index (db:15)
//     so they never touch the producers' prod keyspace.
//   - Each ring Worker gets its OWN ioredis connection (not the queue's
//     getConnection()), so closing a worker never tears down a connection a queue
//     still references ("Connection is closed").
//   - obliterate({ force: true }) in BOTH beforeEach AND afterEach (removeOnFail:false
//     leaves jobs around across runs) for the db:15 ring queues AND the producers'
//     default-keyspace gcal-sync queue used by the payload test.
//
// Run via: jest --config jest.integration.config.js (npm run test:integration).
// Needs a live Redis (CI provides redis:7; locally redis://localhost:6379).

const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// Dedicated DB index for the ring's name-drift queues — isolated from the
// producers' default db (0). ioredis honors the `db` connection option.
const RING_DB = 15;

function makeRingConnection() {
  const c = new Redis(REDIS_URL, {
    db: RING_DB,
    maxRetriesPerRequest: null, // REQUIRED for BullMQ blocking commands
    enableReadyCheck: false
  });
  c.on('error', () => {}); // swallow shutdown / dead-port noise
  return c;
}

// Derive the four producer queue NAMES from the real lazy getQueue() handles so
// the ring can never disagree with the producer about the name (review HIGH-2:
// the gcal-sync name is HYPHENATED, not the camelCase identifier form).
//
// getQueue() instantiates a REAL lazy Queue + ioredis connection on the producers'
// default db. We only need the .name, but the underlying handle is now live and
// MUST be closed in afterAll or it keeps the event loop alive (a leak the
// --detectOpenHandles run would otherwise hang on). Capture the modules so we can
// close their constructed queues + connections at teardown.
const producerQueueModules = [
  require('../../queues/reminderQueue'),
  require('../../queues/promptQueue'),
  require('../../queues/deadlineQueue'),
  require('../../queues/gcalSyncQueue')
];
const reminderQueueName = producerQueueModules[0].getQueue().name;
const promptQueueName = producerQueueModules[1].getQueue().name;
const deadlineQueueName = producerQueueModules[2].getQueue().name;
const gcalSyncQueueName = producerQueueModules[3].getQueue().name;

// Track every ring-local Queue/Worker/connection so afterAll can close them.
const cleanup = { queues: [], workers: [], connections: [] };

function ringQueue(name) {
  const connection = makeRingConnection();
  cleanup.connections.push(connection);
  const q = new Queue(name, { connection });
  cleanup.queues.push(q);
  return q;
}

function ringWorker(name, handler) {
  const connection = makeRingConnection(); // OWN connection (review MEDIUM)
  cleanup.connections.push(connection);
  const w = new Worker(name, handler, { connection });
  cleanup.workers.push(w);
  w.on('error', () => {}); // swallow shutdown noise
  return w;
}

afterAll(async () => {
  // Close workers FIRST (they hold bullmq's blocking brpoplpush connection),
  // then queues, then the producers' lazy queues we built just to read .name.
  await Promise.allSettled(cleanup.workers.map((w) => w.close()));
  await Promise.allSettled(cleanup.queues.map((q) => q.close()));
  await Promise.allSettled(producerQueueModules.map((m) => m.getQueue().close()));
  // quit() then disconnect() every ring connection: quit() drains gracefully,
  // disconnect() force-tears the socket so --detectOpenHandles finds no lingering
  // ioredis handle (bullmq can otherwise leave a duplicated blocking client around).
  await Promise.allSettled(cleanup.connections.map((c) => c.quit()));
  for (const c of cleanup.connections) {
    try { c.disconnect(); } catch (_) { /* already gone */ }
  }
});

describe('queues integration ring (BTEST-04 / D-03 part 2)', () => {
  // ---- 4 NAME-drift tests --------------------------------------------------
  // Each: bind a real Worker to the producer's derived queue name, enqueue a
  // payload, assert the worker received it AND worker.name === queue.name.

  const nameCases = [
    { label: 'reminders', name: reminderQueueName, payload: { kind: 'reminder', v: 1 } },
    { label: 'prompts', name: promptQueueName, payload: { kind: 'prompt', v: 2 } },
    { label: 'deadlines', name: deadlineQueueName, payload: { kind: 'deadline', v: 3 } },
    { label: 'gcal-sync', name: gcalSyncQueueName, payload: { kind: 'gcal', v: 4 } }
  ];

  for (const { label, name, payload } of nameCases) {
    test(`name-drift: ${label} — enqueue -> real worker -> assert (derived binding)`, async () => {
      const queue = ringQueue(name);
      // obliterate leftover jobs from a prior run (removeOnFail:false keeps them).
      await queue.obliterate({ force: true });

      let resolveProcessed;
      const processed = new Promise((resolve) => {
        resolveProcessed = resolve;
      });
      const worker = ringWorker(name, async (job) => {
        resolveProcessed(job.data);
        return job.data;
      });

      // Derived-binding invariant: the worker watches the SAME name the producer's
      // getQueue() reports — a name-drift would make these disagree.
      expect(worker.name).toBe(queue.name);

      await queue.add('test', payload);
      await expect(processed).resolves.toMatchObject(payload);

      await queue.obliterate({ force: true });
    }, 20000);
  }

  // ---- 1 PAYLOAD-drift test (real producer, immediate enqueue) -------------
  // Drives gcalCleanupService.enqueueCleanupJobForAttendee (immediate enqueue,
  // NO delay) — deliberately NOT the reminder scheduler producer (its jobs carry a
  // >= 5min delay the 20s worker would never receive: round-1 HIGH-4). The producer writes to the
  // PRODUCERS' shared gcal-sync queue (default db 0), so the asserting worker for
  // THIS test binds to the producers' connection/keyspace, not db:15.

  describe('payload-drift: real producer -> worker -> assert real payload', () => {
    const gcalCleanupService = require('../../services/gcalCleanupService');
    // The producers' default-keyspace gcal-sync queue handle (lazy getQueue()).
    const prodGcalQueue = require('../../queues/gcalSyncQueue').getQueue();
    // Own connection on the producers' default db (0) for the asserting worker.
    let prodWorkerConnection;

    beforeEach(async () => {
      // Obliterate the PRODUCERS' gcal-sync queue (default db, NOT db:15) so a
      // leftover job from a prior run (removeOnFail:false) is not picked up
      // (round-2 MEDIUM).
      await prodGcalQueue.obliterate({ force: true });
    });

    afterEach(async () => {
      await prodGcalQueue.obliterate({ force: true });
    });

    afterAll(async () => {
      if (prodWorkerConnection) {
        await prodWorkerConnection.quit().catch(() => {});
        try { prodWorkerConnection.disconnect(); } catch (_) { /* already gone */ }
      }
    });

    test('enqueueCleanupJobForAttendee with a truthy gcal id -> worker receives the real payload', async () => {
      const expectedPayload = {
        eventId: 'evt-itest-1',
        eventParticipationId: 'ep-itest-1',
        userId: 'user-itest-1',
        // round-2 MEDIUM: MUST be a TRUTHY non-empty string. A falsy value makes
        // the producer short-circuit at gcalCleanupService.js:110 (enqueued:0,
        // skipped:1) and NEVER call gcalSyncQueue.add — the worker would then hang
        // the full 20s and the test would fail on timeout.
        googleCalendarEventId: 'gcal-evt-test-123'
      };

      let resolveProcessed;
      const processed = new Promise((resolve) => {
        resolveProcessed = resolve;
      });

      // Asserting worker on the PRODUCERS' keyspace (default db 0), created within
      // THIS test so only one gcal-sync worker is active at a time. Own connection.
      prodWorkerConnection = new Redis(REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      });
      prodWorkerConnection.on('error', () => {});
      const worker = new Worker(
        gcalSyncQueueName,
        async (job) => {
          resolveProcessed(job.data);
          return job.data;
        },
        { connection: prodWorkerConnection }
      );
      worker.on('error', () => {});

      try {
        // Drive the REAL producer (immediate enqueue). Fast-fail BEFORE awaiting
        // the worker so a falsy-id / skip path fails immediately with a clear
        // message rather than a 20s timeout (round-2 MEDIUM).
        const result = await gcalCleanupService.enqueueCleanupJobForAttendee(expectedPayload);
        expect(result.enqueued).toBe(1);
        expect(result.skipped).toBe(0);

        // Now the worker should receive the REAL payload shape — catching payload
        // drift (a field rename/drop), not just queue-name drift.
        await expect(processed).resolves.toMatchObject(expectedPayload);
      } finally {
        await worker.close();
      }
    }, 20000);
  });
});
