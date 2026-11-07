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
    // The submitted input value is NOT reflected back to the client (no echo of user input).
    expect(res.body.errors[0]).not.toHaveProperty('value');

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

// PR #69 review L1 (2026-11-07): express-validator's non-strict isISO8601() accepts ISO week ("2026-W10"), ordinal
// ("2026-100") and basic ("20261107T100000Z") forms that `new Date()` cannot parse (NaN). Downstream, PUT /events/:id
// compares instants with getTime(), so a NaN start would read as "date changed" AND flip the status derivation. Both
// event validators must reject anything JavaScript cannot parse as a date.
describe('event validators -> start_date must parse as a JavaScript date', () => {
  const { validateEventCreate, validateEventUpdate } = require('../../middleware/validators');
  const app2 = express();
  app2.use(express.json());
  app2.post('/create', validateEventCreate, (req, res) => res.json({ ok: true }));
  app2.put('/update', validateEventUpdate, (req, res) => res.json({ ok: true }));
  const unparsable = ['2026-W10', '2026-100', '20261107T100000Z'];
  const createBody = { group_id: '11111111-1111-4111-8111-111111111111', game_name: 'Catan' };

  for (const bad of unparsable) {
    it(`update rejects start_date "${bad}" (ISO 8601 by the library, NaN to new Date)`, async () => {
      const res = await request(app2).put('/update').send({ start_date: bad });
      expect(res.status).toBe(400);
      expect(res.body.errors.some((e) => e.field === 'start_date')).toBe(true);
    });
    it(`create rejects start_date "${bad}"`, async () => {
      const res = await request(app2).post('/create').send({ ...createBody, start_date: bad });
      expect(res.status).toBe(400);
      expect(res.body.errors.some((e) => e.field === 'start_date')).toBe(true);
    });
  }
  it('update still accepts a real ISO string', async () => {
    const res = await request(app2).put('/update').send({ start_date: '2026-11-14T03:00:00.000Z' });
    expect(res.status).toBe(200);
  });
});
