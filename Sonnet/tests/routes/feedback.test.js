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

// [87.8-05 Task 4] POST /api/feedback/github runs behind verifyAuth0Token —
// stub it so the pageUrl-scrub tests can reach the handler. The POST / tests
// below never touch this middleware, so the stub changes nothing for them.
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => {
    req.user = { user_id: 'auth0|feedback-scrub-tester' };
    next();
  },
}));

const feedbackRoutes = require('../../routes/feedback');
const { scrubPageUrl } = feedbackRoutes;
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

// -----------------------------------------------------------------------------
// [87.8-05 Task 4, round-3 security] pageUrl credential scrub.
// The five token-bearing routes embed a LIVE credential in the PATH segment,
// and the RSVP query string carries an Auth0 sub — neither may reach a GitHub
// Issue body or the DB page_context column. The scrub is a pure helper
// (exported from routes/feedback.js) whose single output feeds BOTH sinks.
// -----------------------------------------------------------------------------

describe('scrubPageUrl (pure helper — 87.8-05 Task 4)', () => {
  const TOKEN_PREFIXES = [
    '/availability-form/',
    '/rsvp/',
    '/invite/group/',
    '/invite/game/',
    '/restore/group/',
  ];

  it('replaces the token segment of every token route with the literal placeholder', () => {
    for (const prefix of TOKEN_PREFIXES) {
      expect(scrubPageUrl(`${prefix}eyJhbGciOiJIUzI1NiJ9.live.credential`)).toBe(`${prefix}[token]`);
    }
  });

  it('scrubs absolute URLs from stale clients (origin preserved, token replaced)', () => {
    expect(scrubPageUrl('https://nextgamenight.app/availability-form/eyJhbGci.abc.def')).toBe(
      'https://nextgamenight.app/availability-form/[token]',
    );
  });

  it('strips the query string — the RSVP query carries an Auth0 sub', () => {
    expect(scrubPageUrl('https://nextgamenight.app/rsvp/3f9a1c2b?e=5&u=auth0%7Cabc&s=sig')).toBe(
      'https://nextgamenight.app/rsvp/[token]',
    );
    expect(scrubPageUrl('/rsvp/3f9a1c2b?e=5&u=auth0%7Cabc&s=sig')).toBe('/rsvp/[token]');
  });

  it('never truncates the token partially — the whole remainder becomes the placeholder', () => {
    expect(scrubPageUrl('/invite/group/tok/extra/segments')).toBe('/invite/group/[token]');
  });

  it('leaves non-token routes unaffected (query still stripped)', () => {
    expect(scrubPageUrl('/groupHomePage')).toBe('/groupHomePage');
    expect(scrubPageUrl('https://nextgamenight.app/groupHomePage?id=3')).toBe(
      'https://nextgamenight.app/groupHomePage',
    );
  });
});

describe('POST /api/feedback/github — pageUrl scrubbed before persistence (87.8-05 Task 4)', () => {
  // The GitHub sink is unreachable in this harness (the ESM-only @octokit/rest
  // dynamic import fails under Jest's CJS sandbox, and no GITHUB_TOKEN is
  // configured), so the handler deterministically takes the DB fallback —
  // which is exactly the persistence sink this test pins. The issue-body sink
  // interpolates the SAME `safePageUrl` variable (one scrubbed value feeds
  // both sinks, asserted structurally by the pure-helper tests above plus the
  // single-variable construction in routes/feedback.js).
  const githubPayload = {
    category: 'General',
    text: 'This is a sufficiently long piece of feedback.',
    userName: 'Reporter',
    userEmail: 'reporter@example.com',
  };

  it('a token-bearing pageUrl is persisted as the placeholder with no query string', async () => {
    const res = await request(app)
      .post('/api/feedback/github')
      .send({
        ...githubPayload,
        pageUrl: 'https://nextgamenight.app/availability-form/eyJhbGciOiJIUzI1NiJ9.live.cred?x=1',
      });

    expect(res.status).toBe(200);
    expect(Feedback.create).toHaveBeenCalledTimes(1);
    const persisted = Feedback.create.mock.calls[0][0];
    expect(persisted.page_context).toBe('https://nextgamenight.app/availability-form/[token]');
    expect(persisted.page_context).not.toContain('eyJ');
    expect(persisted.page_context).not.toContain('?');
  });

  it('a non-token pageUrl is persisted unchanged', async () => {
    const res = await request(app)
      .post('/api/feedback/github')
      .send({ ...githubPayload, pageUrl: '/groupHomePage' });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({
      page_context: '/groupHomePage',
    });
  });
});
