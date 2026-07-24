// tests/routes/feedback.test.js
// -----------------------------------------------------------------------------
// Phase 87.6 (review WR-01, owner decision 2026-07-24): POST /api/feedback does
// NOT attribute feedback to a user account. The route rides the public transport
// (no bearer ever reaches it), so any user_id would be client-asserted and
// unverifiable — new rows always store user_id: null, and user_email is the
// contact handle. These tests pin that contract:
//
//   1. A body-asserted user_id (even a valid UUID) is IGNORED — stored null.
//   2. A garbage (non-UUID) body user_id does not 400 or 500 — ignored, stored null.
//   3. The anonymous path (no session, no user_id) works and stores null.
//   4. A verified session changes nothing — attribution is not tracked at all.
//
// MOCKED MODELS (no sequelize.sync): mirrors the friendships.test.js convention —
// spyOn model methods + inject req.user via a harness middleware. No real rows, no
// DB connection. Runs green ALONE; the authoritative gate is BE PR CI Postgres.
// -----------------------------------------------------------------------------

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

const feedbackRoutes = require('../../routes/feedback');
const { Feedback } = require('../../models');
const emailService = require('../../services/emailService');

// Harness: emulate the mount-level optionalAuth (server.js) — set req.user from a
// module-level session sub when present, else leave it null (anonymous).
let sessionSub = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = sessionSub ? { user_id: sessionSub } : null;
  next();
});
app.use('/api/feedback', feedbackRoutes);

const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SESSION_SUB = 'auth0|feedback-session-user';

beforeEach(() => {
  sessionSub = null;
  jest.restoreAllMocks();
  // Never hit the real email path: mark the service unconfigured so the handler
  // skips escapeHtml/send entirely.
  jest.spyOn(emailService, 'isConfigured').mockReturnValue(false);
  jest.spyOn(Feedback, 'create').mockResolvedValue({ id: 'fb-1', created_at: new Date() });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const basePayload = { type: 'bug', subject: 'Something broke', description: 'A clear description of the bug.' };

describe('POST /api/feedback — no user attribution (87.6, WR-01 resolution)', () => {
  it('ignores a body-asserted valid UUID user_id and stores null', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_id: VALID_UUID });

    expect(res.status).toBe(200);
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: null });
  });

  it('ignores a garbage (non-UUID) body user_id — no 400, no 500, stored null', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_id: 'auth0|not-a-uuid' });

    expect(res.status).toBe(200);
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: null });
  });

  it('anonymous path (no session, no user_id) works and stores null', async () => {
    sessionSub = null;
    const res = await request(app).post('/api/feedback').send({ ...basePayload });

    expect(res.status).toBe(200);
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: null });
  });

  it('a verified session changes nothing — attribution is not tracked', async () => {
    sessionSub = SESSION_SUB;
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_id: VALID_UUID });

    expect(res.status).toBe(200);
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: null });
  });

  it('preserves user_email as the contact handle', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_email: 'reporter@example.com' });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({
      user_email: 'reporter@example.com',
      user_id: null,
    });
  });
});
