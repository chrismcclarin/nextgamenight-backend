// tests/workers/emailNoticeWorker.test.js
// Phase 88.8 / plan 10 Task 2 (CONTEXT D-40, SPEC A13, T-88.8-75/76/77).
//
// The durable delivery lane for the A13 security notice. D-40 chose queued-with-
// retries over fire-and-forget precisely because a single provider hiccup would
// otherwise permanently destroy the only out-of-band warning the real account
// holder ever gets that their address was taken over. So the properties under
// test here are not cosmetic:
//   - a refused send THROWS, so BullMQ retries (returning cleanly would mark the
//     job complete and silently discard the entire retry lane)
//   - Sentry fires ONLY on attempts-exhausted, so it stays signal
//   - the exhausted payload carries the sub and the recipient DOMAIN and
//     nothing else — never the local part, never the new address in any form
//   - requiring the queue module connects to nothing
//
// Strategy mirrors tests/workers/auth0CleanupWorker.test.js: drive the exported
// processor and the exported failure hook directly. Never a real Worker, which
// would need Redis.

// ---------------------------------------------------------------------------
// Mocks BEFORE requiring the worker
// ---------------------------------------------------------------------------

// MAIL SAFETY: the notice sender is mocked at the service boundary, so no
// provider call is possible from this suite.
const mockSendNotice = jest.fn();
jest.mock('../../services/emailService', () => ({
  sendEmailChangeNotice: (...args) => mockSendNotice(...args),
}));

// Keep the REAL (lazy, Redis-less) Queue so the defaultJobOptions assertions
// read the actual shipped config; stub only the Worker, whose construction at
// module load would otherwise open a real Redis connection.
jest.mock('bullmq', () => {
  const actual = jest.requireActual('bullmq');
  return {
    ...actual,
    Worker: jest.fn().mockImplementation(function (name) {
      this.name = name; // the queue-binding assertion below reads this
      this.on = jest.fn();
      this.close = jest.fn().mockResolvedValue();
    }),
  };
});

// Stub the full surface bullmq's close path walks, so teardown of the real
// (lazy) queue is a clean no-op rather than a throw on a partial double.
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  off: jest.fn(),
  once: jest.fn(),
  removeListener: jest.fn(),
  disconnect: jest.fn(),
  quit: jest.fn().mockResolvedValue('OK'),
  status: 'ready',
})));

const mockCaptureException = jest.fn();
jest.mock('@sentry/node', () => ({
  captureException: (...args) => mockCaptureException(...args),
  addBreadcrumb: jest.fn(),
}), { virtual: true });

// Force the worker file to require @sentry/node (it gates on SENTRY_DSN).
process.env.SENTRY_DSN = 'https://fake@sentry.io/123';

const fs = require('fs');
const path = require('path');

const emailNoticeQueueModule = require('../../queues/emailNoticeQueue');
const emailNoticeWorker = require('../../workers/emailNoticeWorker');
const { processEmailNoticeJob, handleJobFailed } = emailNoticeWorker;

const RECIPIENT = 'gregory@priorhost.example';
const LOCAL_PART = 'gregory';
const SUB = 'auth0|abc123';

function makeJob(overrides = {}, opts = { attempts: 10 }, attemptsMade = 1) {
  return {
    id: 'job-1',
    data: {
      to: RECIPIENT,
      sub: SUB,
      action: 'changed',
      newAddress: 'newperson@attacker.example',
      ...overrides,
    },
    opts,
    attemptsMade,
  };
}

beforeEach(() => {
  mockSendNotice.mockReset();
  mockCaptureException.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await emailNoticeWorker.close();
  } catch (_) { /* mocked Worker — nothing to close */ }
});

// ---------------------------------------------------------------------------
// The queue module — lazy shape and the D-06 retry profile
// ---------------------------------------------------------------------------
describe('queues/emailNoticeQueue (D-40 on the shipped D-06 retry profile)', () => {
  it('requiring the module connects to nothing — the lazy getQueue/getConnection shape', () => {
    // The real proof of laziness is that this suite runs AT ALL in a Redis-less
    // environment: a module-top `new Queue(...)` would have thrown on require,
    // before any assertion could run. This assertion locks the exported shape so
    // a future edit cannot quietly re-eager it. (T-88.8-77.)
    expect(typeof emailNoticeQueueModule.getQueue).toBe('function');
    expect(typeof emailNoticeQueueModule.getConnection).toBe('function');
    expect(emailNoticeQueueModule.getQueue.length).toBe(0);
  });

  it('is named email-notice', () => {
    expect(emailNoticeQueueModule.getQueue().name).toBe('email-notice');
  });

  it('carries the D-06 profile: 10 attempts, exponential 60s backoff, removeOnFail false', () => {
    const opts = emailNoticeQueueModule.getQueue().defaultJobOptions;
    expect(opts.attempts).toBe(10);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 60000 });
    expect(opts.removeOnFail).toBe(false); // dead-letter row stays visible in Bull Board
  });

  it('is exposed through the lazy queues/index.js registry', () => {
    const registry = require('../../queues');
    expect(Object.keys(registry)).toContain('emailNoticeQueue');
    expect(registry.emailNoticeQueue.name).toBe('email-notice');
  });

  it('is registered in Bull Board, with the queues require still INSIDE the mount function', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'bullBoard.js'),
      'utf8'
    );
    expect(src).toMatch(/BullMQAdapter\(emailNoticeQueue\)/);
    // queues/index.js:15-20: a module-top destructure in a consumer connects to
    // Redis at that consumer's import time. bullBoard.js is one of the three
    // deliberately de-eagered consumers; the require must stay in the function.
    const requireIdx = src.indexOf("require('../queues')");
    const mountIdx = src.indexOf('function mountBullBoard');
    expect(requireIdx).toBeGreaterThan(mountIdx);
  });
});

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------
describe('emailNoticeWorker processor', () => {
  it('calls the notice mail method with the job to, action and newAddress', async () => {
    mockSendNotice.mockResolvedValue({ success: true, id: 'mail-1' });
    await processEmailNoticeJob(makeJob());
    expect(mockSendNotice).toHaveBeenCalledWith(RECIPIENT, {
      action: 'changed',
      newAddress: 'newperson@attacker.example',
    });
  });

  it('returns a plain result object on success and does not throw', async () => {
    mockSendNotice.mockResolvedValue({ success: true, id: 'mail-1' });
    const result = await processEmailNoticeJob(makeJob());
    expect(result).toEqual(expect.objectContaining({ ok: true, sub: SUB }));
  });

  it('THROWS when the mail method resolves { success: false } so BullMQ retries', async () => {
    mockSendNotice.mockResolvedValue({ success: false, error: 'provider 503' });
    await expect(processEmailNoticeJob(makeJob())).rejects.toThrow();
  });

  it('lets a thrown provider error bubble to the retry lane', async () => {
    mockSendNotice.mockRejectedValue(new Error('socket hang up'));
    await expect(processEmailNoticeJob(makeJob())).rejects.toThrow('socket hang up');
  });

  it('does not put the recipient local part or the new address in the thrown message', async () => {
    mockSendNotice.mockResolvedValue({ success: false, error: 'provider 503' });
    await expect(processEmailNoticeJob(makeJob())).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(LOCAL_PART),
      })
    );
  });

  it('throws when the job carries no recipient rather than sending nowhere', async () => {
    await expect(processEmailNoticeJob(makeJob({ to: undefined }))).rejects.toThrow();
    expect(mockSendNotice).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The failure hook
// ---------------------------------------------------------------------------
describe('emailNoticeWorker.handleJobFailed', () => {
  it('attempts-exhausted -> Sentry.captureException (T-88.8-75)', () => {
    const job = makeJob({}, { attempts: 10 }, 10);
    handleJobFailed(job, new Error('provider down'));
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('falls back to 10 attempts when job.opts carries none', () => {
    const job = makeJob({}, {}, 10);
    handleJobFailed(job, new Error('provider down'));
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it('a NON-exhausted failure logs and captures nothing', () => {
    const job = makeJob({}, { attempts: 10 }, 3);
    handleJobFailed(job, new Error('transient'));
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });

  it('no job context -> logs, captures nothing', () => {
    handleJobFailed(undefined, new Error('boom'));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('the exhausted extra carries the sub and the recipient DOMAIN', () => {
    const job = makeJob({}, { attempts: 10 }, 10);
    handleJobFailed(job, new Error('provider down'));
    const [, options] = mockCaptureException.mock.calls[0];
    expect(options.extra.sub).toBe(SUB);
    expect(Object.values(options.extra)).toContain('priorhost.example');
  });

  it('the exhausted payload contains NO local part and NO new address, masked or not (T-88.8-76)', () => {
    const job = makeJob({}, { attempts: 10 }, 10);
    handleJobFailed(job, new Error('provider down'));
    const [, options] = mockCaptureException.mock.calls[0];
    const serialized = JSON.stringify(options);
    // Telemetry is not mail copy: even the masked form is a domain plus an
    // initial, and SPEC R4's domain-only rule governs this boundary.
    expect(serialized).not.toContain(LOCAL_PART);
    expect(serialized).not.toContain('newperson');
    expect(serialized).not.toContain('attacker.example');
    expect(serialized).not.toContain('g***@');
  });

  it('tags the capture as this worker and as exhausted', () => {
    const job = makeJob({}, { attempts: 10 }, 10);
    handleJobFailed(job, new Error('provider down'));
    const [, options] = mockCaptureException.mock.calls[0];
    expect(options.tags).toEqual(
      expect.objectContaining({ worker: 'email-notice', exhausted: 'true' })
    );
  });
});

// ---------------------------------------------------------------------------
// Production wiring — the worker actually starts
// ---------------------------------------------------------------------------
describe('production wiring', () => {
  it('binds the Worker to the email-notice queue at module load', () => {
    expect(emailNoticeWorker.name).toBe('email-notice');
  });

  it('workers/index.js requires, closes and exports the new worker', () => {
    // server.js:520-522 gates on NODE_ENV/ENABLE_WORKERS and then does
    // `require('./workers')`. That REQUIRE is what constructs every Worker — the
    // destructure at :522 names only three and is not a start list. So a require
    // line here is what starts this worker in production.
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'workers', 'index.js'),
      'utf8'
    );
    expect(src).toMatch(/require\(['"]\.\/emailNoticeWorker['"]\)/);
    expect(src).toMatch(/emailNoticeWorker\.close\(\)/);
    expect(src).toMatch(/module\.exports[\s\S]*emailNoticeWorker/);
  });
});
