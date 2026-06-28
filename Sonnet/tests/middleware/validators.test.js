// tests/middleware/validators.test.js
// DB-FREE unit test for the `validate` middleware's validation envelope.
//
// Drives a REAL express-validator failure through the actual `validate`
// middleware (tiny express app + supertest) and asserts the dual-emit envelope:
// the field errors appear at BOTH a TOP-LEVEL body.errors[] (the live FE
// api.ts:148 dependency — the marquee assertion) AND a mirrored
// body.details.errors[]. This is the executable guard that validators.js passes
// the `{ errors: fieldErrors }` OBJECT (not the array directly) so the central
// serializer produces the top-level mirror — a grep cannot catch a wrong shape.
//
// No database, no Redis, no network — runs green in true isolation.
const request = require('supertest');
const express = require('express');
const { body } = require('express-validator');
const { validate } = require('../../middleware/validators');

const app = express();
app.use(express.json());
app.post(
  '/test',
  body('name')
    .isLength({ min: 3 })
    .withMessage('Name must be at least 3 characters'),
  validate,
  (req, res) => res.json({ ok: true })
);

describe('validate middleware -> validation envelope (dual-emit)', () => {
  it('rejects a bad body with the dual-emit validation envelope (400)', async () => {
    const res = await request(app).post('/test').send({ name: 'a' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation');
    expect(res.body.message).toBeTruthy();

    // Marquee assertion: field errors at the TOP LEVEL (live FE api.ts:148 alias).
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors[0].field).toBe('name');
    expect(res.body.errors[0].message).toBe('Name must be at least 3 characters');

    // details.errors[] mirrors the top-level errors[] (dual-emit from serializer).
    expect(res.body.details.errors).toEqual(res.body.errors);

    // Legacy error (= message) alias.
    expect(res.body.error).toBe(res.body.message);
  });

  it('passes a valid body through to the handler (200)', async () => {
    const res = await request(app).post('/test').send({ name: 'abc' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
