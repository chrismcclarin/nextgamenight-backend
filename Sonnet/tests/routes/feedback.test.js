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
//
// [88.8-09 Task 4] The sub is now MUTABLE (`mock`-prefixed so the jest.mock
// factory may close over it): the /github handler derives the persisted address
// from the CALLER'S Users row, so a test has to be able to say which caller.
let mockGithubSub = 'auth0|feedback-scrub-tester';
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => {
    req.user = { user_id: mockGithubSub };
    next();
  },
}));

const feedbackRoutes = require('../../routes/feedback');
const { scrubPageUrl } = feedbackRoutes;
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

const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SESSION_SUB = 'auth0|feedback-session-user';

beforeEach(() => {
  mockGithubSub = 'auth0|feedback-scrub-tester';
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

// -----------------------------------------------------------------------------
// [88.8-09 Task 4] The address on a feedback row is SERVER-DERIVED on the
// authenticated writer, and the broad `@auth0` synthetic guard applies to BOTH
// writers.
//
// WHY THIS EXISTS: D-42 moves Feedback rows by matching `user_email` against the
// user's `Users.email`. Review round 4 verified that `Feedback.user_email` was
// CLIENT-SUPPLIED and that both frontend writers send the Auth0 SESSION address,
// so on a repaired or synthetic row the column held an address D-42 would never
// match. The fix is structural — stop reading the claim on the ONE path that has a
// server-side identity — not a downstream normalisation of whatever arrives.
//
// THE ISSUE-BODY SINK IS ASSERTED STRUCTURALLY, not by intercepting Octokit. The
// GitHub sink is unreachable in this harness (see the describe above), so the
// deterministic path is the DB fallback. The "one derived value feeds BOTH sinks"
// property is pinned the same way the shipped safePageUrl property is: by a source
// assertion that a SINGLE binding is interpolated into the issue body's Email line
// and passed to Feedback.create.
// -----------------------------------------------------------------------------

describe('POST /api/feedback/github — the address is SERVER-DERIVED (88.8-09 Task 4, T-88.8-84)', () => {
  const githubPayload = {
    category: 'General',
    text: 'This is a sufficiently long piece of feedback.',
    pageUrl: '/groupHomePage',
    userName: 'Reporter',
  };

  async function seedCaller(sub, email) {
    return User.create({ user_id: sub, username: `fb${Date.now()}${Math.random().toString(36).slice(2, 7)}`, email });
  }

  it('THE DISCRIMINATING CASE: a body carrying a DIFFERENT address persists the STORED one', async () => {
    mockGithubSub = 'auth0|fb-derive-1';
    await seedCaller(mockGithubSub, 'stored@example.com');

    const res = await request(app)
      .post('/api/feedback/github')
      .send({ ...githubPayload, userEmail: 'asserted@evil.test' });

    expect(res.status).toBe(200);
    const persisted = Feedback.create.mock.calls[0][0];
    expect(persisted.user_email).toBe('stored@example.com');
    expect(JSON.stringify(persisted)).not.toContain('asserted@evil.test');
  });

  it('a body that OMITS userEmail entirely is persisted with the caller\'s stored address', async () => {
    mockGithubSub = 'auth0|fb-derive-2';
    await seedCaller(mockGithubSub, 'omitted@example.com');

    const res = await request(app).post('/api/feedback/github').send({ ...githubPayload });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_email: 'omitted@example.com' });
  });

  it('a caller with NO Users row still succeeds — user_email null, no 500', async () => {
    mockGithubSub = 'auth0|fb-never-provisioned';

    const res = await request(app)
      .post('/api/feedback/github')
      .send({ ...githubPayload, userEmail: 'ignored@evil.test' });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_email: null });
  });

  it('a SYNTHETIC stored address (broad @auth0 test) is persisted as null, never published', async () => {
    mockGithubSub = 'auth0|fb-synthetic';
    await seedCaller(mockGithubSub, 'google-oauth2-1|xyz@auth0.local');

    // The body carries a REAL address on purpose: without it this case would pass
    // vacuously against the pre-fix `userEmail || null`.
    const res = await request(app)
      .post('/api/feedback/github')
      .send({ ...githubPayload, userEmail: 'real@example.com' });

    expect(res.status).toBe(200);
    const persisted = Feedback.create.mock.calls[0][0];
    expect(persisted.user_email).toBeNull();
    expect(JSON.stringify(persisted)).not.toContain('@auth0');
    expect(JSON.stringify(persisted)).not.toContain('real@example.com');
  });

  it('the BROAD guard catches @auth0 without .local too (DECISION Phase 88.2 NIX-AUTH0)', async () => {
    mockGithubSub = 'auth0|fb-synthetic-broad';
    await seedCaller(mockGithubSub, 'legacy@auth0.placeholder.test');

    const res = await request(app)
      .post('/api/feedback/github')
      .send({ ...githubPayload, userEmail: 'real@example.com' });
    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_email: null });
  });

  it('user_id stays null — the 2026-07-24 owner decision is untouched', async () => {
    mockGithubSub = 'auth0|fb-userid';
    await seedCaller(mockGithubSub, 'stored@example.com');

    await request(app).post('/api/feedback/github').send({ ...githubPayload, userEmail: 'x@y.test' });
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_id: null, user_email: 'stored@example.com' });
  });

  it('source: ONE derived binding feeds BOTH sinks, the caller is loaded withContactInfo, and no address is destructured from the body', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../routes/feedback.js'), 'utf8');
    const code = source.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    // The scope is NOT optional: defaultScope excludes `email`, so a bare findOne
    // returns a row whose email is undefined and every caller persists null.
    expect(code).toContain("User.scope('withContactInfo')");
    // The body field is no longer a source of truth on this path.
    expect(code).not.toMatch(/const\s*\{[^}]*\buserEmail\b[^}]*\}\s*=\s*req\.body/);
    // ONE binding, two sinks.
    expect(code).toContain('**Email:** ${safeUserEmail');
    expect(code).toContain('user_email: safeUserEmail');
    // The rationale marker survives a line-comment-stripping grep.
    expect(source.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'))
      .toContain('DECISION Phase 88.8 D-42');
  });
});

describe('POST /api/feedback — the PUBLIC writer keeps its client-supplied address but drops a SYNTHETIC one', () => {
  const priorFeedbackEmail = process.env.FEEDBACK_EMAIL;

  beforeEach(() => {
    process.env.FEEDBACK_EMAIL = 'admin@example.test';
    jest.spyOn(emailService, 'isConfigured').mockReturnValue(true);
    jest.spyOn(emailService, 'send').mockResolvedValue({ success: true });
    jest.spyOn(emailService, 'escapeHtml').mockImplementation((v) => String(v));
    jest.spyOn(emailService, 'stripCrlf').mockImplementation((v) => String(v));
  });

  afterEach(() => {
    if (priorFeedbackEmail === undefined) delete process.env.FEEDBACK_EMAIL;
    else process.env.FEEDBACK_EMAIL = priorFeedbackEmail;
  });

  it('a SYNTHETIC address persists null, the From line reads Anonymous, and the options carry NO replyTo KEY', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_email: 'google-oauth2-1|xyz@auth0.local' });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_email: null });

    expect(emailService.send).toHaveBeenCalledTimes(1);
    const options = emailService.send.mock.calls[0][0];
    // Assert on the KEY SET, not the value — :204 is a conditional spread, so a
    // null address must OMIT the key rather than send an empty one.
    expect(Object.keys(options)).not.toContain('replyTo');
    expect(options.text).toContain('From: Anonymous');
    expect(options.html).toContain('Anonymous');
    expect(JSON.stringify(options)).not.toContain('@auth0');
  });

  it('THE MIRROR: a REAL address is still persisted, still becomes the From line and still sets replyTo', async () => {
    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_email: 'reporter@example.com' });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({ user_email: 'reporter@example.com' });
    const options = emailService.send.mock.calls[0][0];
    expect(options.replyTo).toBe('reporter@example.com');
    expect(options.text).toContain('From: reporter@example.com');
  });

  it('this path DERIVES NOTHING — a seeded Users row does not win over the body value', async () => {
    sessionSub = 'auth0|fb-public-session';
    await User.create({
      user_id: sessionSub,
      username: `fbpub${Date.now()}`,
      email: 'stored-not-used@example.com',
    });

    const res = await request(app)
      .post('/api/feedback')
      .send({ ...basePayload, user_email: 'from-the-body@example.com' });

    expect(res.status).toBe(200);
    expect(Feedback.create.mock.calls[0][0]).toMatchObject({
      user_email: 'from-the-body@example.com',
      user_id: null,
    });
  });
});
