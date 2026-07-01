// tests/middleware/rateLimiter.test.js
// DB-FREE unit test for the rate_limited envelope on 429 bodies.
//
// Two layers of proof:
//   1. formatEnvelope('rate_limited').body carries code === 'rate_limited' + the
//      legacy error (= message) alias (the exact value rateLimiter.js feeds into
//      each limiter's `message` option).
//   2. An inline express-rate-limit limiter (max:1, NO localhost skip) actually
//      emits that body on the 2nd request as a real 429 — proving the wiring
//      pattern the production limiters use. (The exported limiters skip
//      127.0.0.1 in non-production, so we exercise the same message body via an
//      un-skipped inline limiter rather than fighting the skip.)
//
// No database, no Redis, no network.
const request = require('supertest');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { formatEnvelope } = require('../../utils/errors');
const { magicTokenLimiter } = require('../../middleware/rateLimiter');

describe('rate_limited envelope (429)', () => {
  it('formatEnvelope(\'rate_limited\') builds a rate_limited body with the error alias', () => {
    const { httpStatus, body } = formatEnvelope('rate_limited');
    expect(httpStatus).toBe(429);
    expect(body.code).toBe('rate_limited');
    expect(body.message).toBeTruthy();
    expect(body.error).toBe(body.message);
  });

  it('preserves a custom messageOverride while keeping the rate_limited code', () => {
    const { body } = formatEnvelope('rate_limited', undefined, 'Too many auth attempts.');
    expect(body.code).toBe('rate_limited');
    expect(body.message).toBe('Too many auth attempts.');
    expect(body.error).toBe('Too many auth attempts.');
  });

  it('a limiter emits the rate_limited envelope on the 429', async () => {
    const app = express();
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 1,
      message: formatEnvelope('rate_limited').body,
      standardHeaders: false,
      legacyHeaders: false,
    });
    app.get('/x', limiter, (req, res) => res.json({ ok: true }));

    const first = await request(app).get('/x');
    expect(first.status).toBe(200);

    const second = await request(app).get('/x');
    expect(second.status).toBe(429);
    expect(second.body.code).toBe('rate_limited');
    expect(second.body.error).toBe(second.body.message);
  });
});

// -----------------------------------------------------------------------------
// Phase 86 / T-86-07 regression: under `trust proxy = 1` the magicTokenLimiter
// keys on the REAL per-client IP (the single edge-appended, right-most
// X-Forwarded-For value) and CANNOT be defeated by a client-supplied spoofed
// X-Forwarded-For. A forged left-most XFF entry does NOT grant a fresh allowance.
//
// DB-free, no Redis, no network. Run in isolation per the backend-suite gotcha:
//   npm test -- tests/middleware/rateLimiter.test.js
// -----------------------------------------------------------------------------
describe('magicTokenLimiter spoof-safety under trust proxy = 1 (T-86-07)', () => {
  // Distinctive token + IPs so this test never shares a MemoryStore bucket with
  // any other test that touches magicTokenLimiter. Token prefix = first 16 chars.
  const TOKEN = 'spoofsafe-regres-AAAAAAAAAAAAAAAA'; // prefix: 'spoofsafe-regres'
  const REAL_IP = '10.77.0.5';
  const OTHER_REAL_IP = '10.77.0.9';

  function buildApp() {
    const app = express();
    app.set('trust proxy', 1); // mirror server.js — trust ONLY the edge hop
    app.use(express.json());
    // req.ip echo (proves the trust-proxy resolution itself).
    app.get('/whoami', (req, res) => res.json({ ip: req.ip }));
    // A FAILED magic-token attempt (401). magicTokenLimiter has
    // skipSuccessfulRequests:true, so only failures accrue toward the limit.
    app.post('/magic', magicTokenLimiter, (req, res) =>
      res.status(401).json({ ok: false })
    );
    return app;
  }

  it('req.ip is the edge-appended (right-most) XFF value, NOT the forged left-most one', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/whoami')
      .set('X-Forwarded-For', `6.6.6.6, ${REAL_IP}`);
    expect(res.status).toBe(200);
    // trust proxy = 1 trusts exactly the one edge hop → right-most value wins;
    // the attacker-controlled '6.6.6.6' prefix is ignored.
    expect(res.body.ip).toBe(REAL_IP);
    expect(res.body.ip).not.toBe('6.6.6.6');
  });

  it('rotating a forged X-Forwarded-For prefix does NOT earn fresh magic-token allowance', async () => {
    const app = buildApp();

    // Hammer failed attempts from the SAME real client IP but a DIFFERENT forged
    // XFF prefix each time + the SAME token. If the forged prefix could shift the
    // key, each request would land in a fresh bucket and NEVER 429. Because the
    // limiter keys on the trusted real IP + token prefix, the shared bucket must
    // exhaust. 60 > both the prod (5) and dev (50) MAGIC_TOKEN_LIMIT.
    let saw429 = false;
    for (let i = 0; i < 60; i++) {
      const res = await request(app)
        .post('/magic')
        .set('X-Forwarded-For', `9.9.${i}.1, ${REAL_IP}`) // rotating forged prefix
        .send({ token: TOKEN });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(401); // pre-limit responses are the failed attempt
    }
    expect(saw429).toBe(true);

    // Control: a DIFFERENT real client IP (same token) is a DIFFERENT bucket —
    // it must NOT already be rate-limited, proving keying is per real client IP.
    const control = await request(app)
      .post('/magic')
      .set('X-Forwarded-For', `9.9.9.9, ${OTHER_REAL_IP}`)
      .send({ token: TOKEN });
    expect(control.status).toBe(401);
  });
});

// -----------------------------------------------------------------------------
// Phase 86 code-review HIGH regression: the BFF collapses ALL authenticated
// writes onto ONE Vercel egress IP, so the IP-keyed writeOperationLimiter became
// a single shared bucket for the whole userbase. The read limiter was raised
// (API_LIMIT 300 -> 30000) but the WRITE limiter was left at the old per-user
// 100/15min — which would 429-storm every user's writes under the BFF. The
// interim mitigation raises the PRODUCTION WRITE_LIMIT to a shared-IP-appropriate
// ceiling (10000/15min). This test asserts a representative shared-IP write burst
// ABOVE the old 100 ceiling is NOT globally throttled. Guards against reverting
// WRITE_LIMIT to the per-user value before the Phase 91 / BOPS-02 per-user keying
// lands.
//
// DB-free, no Redis, no network. Run in isolation per the backend-suite gotcha:
//   npm test -- tests/middleware/rateLimiter.test.js
// -----------------------------------------------------------------------------
describe('writeOperationLimiter shared-IP ceiling under the BFF (Phase 86 HIGH)', () => {
  // Load the limiter with NODE_ENV=production so WRITE_LIMIT is the raised prod
  // ceiling (not the dev value) AND the localhost skip is inactive (prod skips no
  // IP), letting us drive the limiter behaviorally from the test client.
  function loadProdWriteLimiter() {
    const prev = process.env.NODE_ENV;
    let writeOperationLimiter;
    jest.isolateModules(() => {
      process.env.NODE_ENV = 'production';
      ({ writeOperationLimiter } = require('../../middleware/rateLimiter'));
    });
    process.env.NODE_ENV = prev;
    return writeOperationLimiter;
  }

  it('does NOT 429 a shared-IP write burst above the OLD 100/15min ceiling', async () => {
    const writeOperationLimiter = loadProdWriteLimiter();
    const app = express();
    app.set('trust proxy', 1); // mirror server.js — resolve the real edge-hop IP
    app.use(express.json());
    app.post('/w', writeOperationLimiter, (req, res) => res.json({ ok: true }));

    // 110 writes (> the old prod WRITE_LIMIT of 100) from ONE shared egress IP,
    // simulating the BFF collapse. Under the old 100 ceiling, request #101 would
    // 429; under the raised 10000 ceiling every one must pass.
    const SHARED_EGRESS_IP = '10.88.0.7';
    let saw429 = false;
    for (let i = 0; i < 110; i++) {
      const res = await request(app)
        .post('/w')
        .set('X-Forwarded-For', SHARED_EGRESS_IP)
        .send({ n: i });
      if (res.status === 429) { saw429 = true; break; }
      expect(res.status).toBe(200);
    }
    expect(saw429).toBe(false);
  });
});
