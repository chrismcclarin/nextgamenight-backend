// tests/routes/bullBoard.mount.test.js
//
// Guards the middleware ORDER on the /admin/queues mount.
//
// CodeQL js/missing-rate-limiting (first scan, 2026-09-08): the global apiLimiter is
// mounted on `/api/` only (server.js:237), and this board lives at `/admin/queues` —
// outside that prefix — so it had no limiter at all and unauthenticated traffic reached
// JWT verification unthrottled. The fix is one line in routes/bullBoard.js, and it is
// exactly the kind of line a later refactor drops without noticing, so assert it here.
//
// The assertion is on ORDER, not merely presence: a limiter mounted BEHIND
// verifyAuth0Token cannot bound the cost of traffic that fails auth, which is the whole
// point of having it. Presence alone would pass while the property was gone.

const path = require('path');

// Bull Board's own packages are stubbed: this test is about the Express mount, and
// createBullBoard/ExpressAdapter would otherwise drag in real adapters.
jest.mock('@bull-board/api', () => ({ createBullBoard: jest.fn() }));
jest.mock('@bull-board/api/bullMQAdapter', () => ({
  BullMQAdapter: jest.fn().mockImplementation((q) => ({ queue: q })),
}));
jest.mock('@bull-board/express', () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn(() => function boardRouter(req, res, next) { next(); }),
  })),
}));

// queues/index.js connects to Redis on property access (the lazy-registry getter), so
// the whole module is stubbed — no Redis in the default `npm test` ring (BTEST-04).
jest.mock('../../queues', () => ({
  promptQueue: { name: 'prompt' },
  deadlineQueue: { name: 'deadline' },
  reminderQueue: { name: 'reminder' },
  gcalSyncQueue: { name: 'gcal-sync' },
  auth0CleanupQueue: { name: 'auth0-cleanup' },
  emailNoticeQueue: { name: 'email-notice' },
}));

const mountBullBoard = require('../../routes/bullBoard');
const { apiLimiter } = require('../../middleware/rateLimiter');
const { verifyAuth0Token } = require('../../middleware/auth0');
const { requirePlatformAdmin } = require('../../middleware/adminAuth');

/**
 * Capture the exact middleware chain handed to app.use('/admin/queues', ...).
 */
function captureMount() {
  const calls = [];
  const fakeApp = { use: (...args) => calls.push(args) };
  mountBullBoard(fakeApp);
  const mount = calls.find((c) => c[0] === '/admin/queues');
  expect(mount).toBeDefined();
  return mount.slice(1); // drop the path, keep the middleware chain
}

describe('bullBoard /admin/queues mount', () => {
  it('mounts the shared apiLimiter on the board', () => {
    expect(captureMount()).toContain(apiLimiter);
  });

  it('runs the limiter BEFORE Auth0 token verification', () => {
    const chain = captureMount();
    const limiterIdx = chain.indexOf(apiLimiter);
    const authIdx = chain.indexOf(verifyAuth0Token);

    expect(limiterIdx).toBeGreaterThanOrEqual(0);
    expect(authIdx).toBeGreaterThanOrEqual(0);
    // A limiter behind the auth check throttles nothing that gets rejected.
    expect(limiterIdx).toBeLessThan(authIdx);
  });

  it('still enforces platform-admin authorization after authentication', () => {
    const chain = captureMount();
    // Order guard for D-02 / BSEC-02: authn precedes authz, both precede the board.
    expect(chain.indexOf(verifyAuth0Token)).toBeLessThan(chain.indexOf(requirePlatformAdmin));
    expect(chain.indexOf(requirePlatformAdmin)).toBeLessThan(chain.length - 1);
  });

  it('reuses the exported limiter rather than defining a local one (config unchanged)', () => {
    const src = require('fs').readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'bullBoard.js'),
      'utf8'
    );
    expect(src).toMatch(/require\(['"]\.\.\/middleware\/rateLimiter['"]\)/);
    // No rateLimit({...}) construction here — the ceiling lives in middleware/rateLimiter.js
    // (Phase 86 / T-86-07 raise, Phase 91 / BOPS-02 per-user keying deferred).
    expect(src).not.toMatch(/rateLimit\s*\(\s*\{/);
  });
});
