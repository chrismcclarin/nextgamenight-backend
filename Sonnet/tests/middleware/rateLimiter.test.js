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
