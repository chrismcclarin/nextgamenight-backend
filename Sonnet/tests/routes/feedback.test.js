// tests/routes/feedback.test.js
// -----------------------------------------------------------------------------
// Phase 87.6-07 Task 4 (adversarial-review #20, owner decision 2026-07-24):
// harden the public POST /api/feedback input surface.
//
//   1. A non-UUID user_id is rejected with 400 by validateFeedback (isUUID rule)
//      BEFORE the handler runs — closing the spoofed-attribution / Sequelize-500
//      gap that the phase's publicFetch flip re-cements as this route's transport.
//   2. A verified session's identity takes precedence over the body-asserted
//      user_id: the resolved caller Users.id is stamped, never the body value.
//   3. The sanctioned anonymous path (no session, null user_id) still works.
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
const { Feedback, User } = require('../../models');
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

// Genuinely valid v4 UUIDs (correct version + variant nibbles — a same-digit
// filler like 2222… fails express-validator's isUUID variant check).
const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SESSION_SUB = 'auth0|feedback-session-user';
const SESSION_UUID = '9c5b94b1-35ad-49bb-b118-8e8fc24abf80';

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

describe('POST /api/feedback — user_id hardening (87.6-07 Task 4)', () => {
  it('400s on a non-UUID user_id (validateFeedback isUUID) before the handler runs', async () => {
    const createSpy = Feedback.create;
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_id: 'auth0|not-a-uuid' });

    expect(res.status).toBe(400);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('accepts a valid UUID user_id on the anonymous path (no session) and persists it', async () => {
    sessionSub = null;
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_id: VALID_UUID });

    expect(res.status).toBe(200);
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: VALID_UUID });
  });

  it('accepts an absent user_id (anonymous path intact) and persists null', async () => {
    sessionSub = null;
    const res = await request(app).post('/api/feedback').send({ ...basePayload });

    expect(res.status).toBe(200);
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: null });
  });

  it('prefers the verified-session identity over the body-asserted user_id', async () => {
    sessionSub = SESSION_SUB;
    const userSpy = jest.spyOn(User, 'findOne').mockResolvedValue({ id: SESSION_UUID });

    const res = await request(app)
      .post('/api/feedback')
      // Attacker asserts a DIFFERENT UUID in the body; it must be ignored.
      .send({ ...basePayload, user_id: VALID_UUID });

    expect(res.status).toBe(200);
    expect(userSpy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { user_id: SESSION_SUB } })
    );
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    // Stamped the SESSION identity, NOT the body-asserted UUID.
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: SESSION_UUID });
  });

  it('fails safe to null (not the body value) when a session has no Users row', async () => {
    sessionSub = SESSION_SUB;
    jest.spyOn(User, 'findOne').mockResolvedValue(null);

    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_id: VALID_UUID });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: null });
  });
});
