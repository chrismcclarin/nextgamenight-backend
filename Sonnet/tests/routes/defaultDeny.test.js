// tests/routes/defaultDeny.test.js
//
// Real default-deny proof for the global `/api` authn layer (D-01 / BSEC-01).
//
// WHAT THIS PROVES (DB-INDEPENDENT — runs without Postgres):
//   1. A no-token request to an ARBITRARY authed `/api` route → 401. This is
//      the load-bearing guarantee: the gate denies by DEFAULT. `verifyAuth0Token`
//      401s on a missing Authorization header BEFORE any handler or DB read, so
//      this assertion needs no database.
//   2. Every EXPLICIT public allow-list route is reachable with NO token (the
//      gate calls next() instead of 401). We mount trivial 200-returning stub
//      handlers behind the REAL gate so "reachable" is observable without a DB —
//      proving the allow-list, not the downstream handler.
//   3. The allow-list matches on EXACT method+path: `GET /api/games/:id` is
//      public but `GET /api/games/for-event/:group_id/:user_id` is NOT — it
//      falls through to the gate and 401s with no token (the BOLA-audit gate).
//
// This test deliberately reconstructs the gate from the SAME public allow-list
// shape used in server.js and the SAME `verifyAuth0Token`. If server.js changes
// the allow-list, update PUBLIC_EXACT/PUBLIC_PREFIX here to match — they are the
// security contract under test.

const request = require('supertest');
const express = require('express');
const { verifyAuth0Token } = require('../../middleware/auth0');

// --- Mirror of the server.js allow-list (the security contract) ---------------
const PUBLIC_EXACT = [
  { method: 'GET', re: /^\/games$/ },
  { method: 'GET', re: /^\/games\/bgg\/search$/ },
  { method: 'GET', re: /^\/games\/[^/]+$/ },
  { method: 'GET', re: /^\/auth\/google\/callback$/ },
  { method: 'GET', re: /^\/rsvp\/respond$/ },
  { method: 'GET', re: /^\/groups\/invite-preview(\/|$)/ },
  { method: 'GET', re: /^\/events\/invite-preview(\/|$)/ },
  { method: 'GET', re: /^\/invites\/info(\/|$)/ },
];
const PUBLIC_PREFIX = [
  '/feedback',
  '/webhooks',
  '/magic-auth',
  '/availability-responses',
  '/availability-prefill',
];
const isPublicApiRequest = (req) => {
  const p = req.path;
  if (PUBLIC_PREFIX.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) return true;
  return PUBLIC_EXACT.some((entry) => req.method === entry.method && entry.re.test(p));
};

// --- Representative app slice: the REAL gate in front of stub routers ----------
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, res, next) => {
    if (isPublicApiRequest(req)) return next();
    return verifyAuth0Token(req, res, next);
  });
  // Stub handlers — 200 means "the gate let it through". A real handler would
  // touch the DB; we don't care here, only whether the gate denied or allowed.
  const ok = (_req, res) => res.json({ ok: true });
  app.get('/api/games', ok);
  app.get('/api/games/search-all', ok);
  app.get('/api/games/bgg/search', ok);
  app.get('/api/games/:id', ok);
  app.get('/api/games/for-event/:group_id/:user_id', ok); // NOT allow-listed
  app.get('/api/auth/google/callback', ok);
  app.get('/api/rsvp/respond', ok);
  app.get('/api/groups/invite-preview/:token', ok);
  app.get('/api/events/invite-preview/:token', ok);
  app.get('/api/invites/info/:token', ok);
  app.post('/api/feedback', ok);
  app.all('/api/webhooks/twilio/sms', ok);
  app.get('/api/magic-auth/validate', ok);
  app.post('/api/availability-responses', ok);
  app.post('/api/availability-prefill/gcal', ok);
  // Arbitrary authed routes (NOT public) — must 401 with no token.
  app.get('/api/lists/games/g1/u1', ok);
  app.get('/api/users/u1', ok);
  app.post('/api/games', ok);
  app.put('/api/games/abc', ok);
  app.delete('/api/games/abc', ok);
  return app;
}

describe('Default-deny `/api` authn layer (DB-independent)', () => {
  const app = buildApp();

  describe('Test 1 — default deny: arbitrary authed routes 401 with no token', () => {
    const denied = [
      ['GET', '/api/lists/games/g1/u1'],
      ['GET', '/api/users/u1'],
      ['POST', '/api/games'],
      ['PUT', '/api/games/abc'],
      ['DELETE', '/api/games/abc'],
    ];
    it.each(denied)('%s %s → 401', async (method, path) => {
      const res = await request(app)[method.toLowerCase()](path);
      expect(res.status).toBe(401);
    });
  });

  describe('Test 2 — allow-list reachable with NO token', () => {
    const allowed = [
      ['GET', '/api/games'],
      ['GET', '/api/games/search-all'],
      ['GET', '/api/games/bgg/search'],
      ['GET', '/api/games/some-game-id'],
      ['GET', '/api/auth/google/callback'],
      ['GET', '/api/rsvp/respond'],
      ['GET', '/api/groups/invite-preview/tok123'],
      ['GET', '/api/events/invite-preview/tok123'],
      ['GET', '/api/invites/info/tok123'],
      ['POST', '/api/feedback'],
      ['POST', '/api/webhooks/twilio/sms'],
      ['GET', '/api/magic-auth/validate'],
      ['POST', '/api/availability-responses'],
      ['POST', '/api/availability-prefill/gcal'],
    ];
    it.each(allowed)('%s %s → reachable (200)', async (method, path) => {
      const res = await request(app)[method.toLowerCase()](path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('Test 3 — exact-match: for-event is NOT auto-public from `/games` prefix', () => {
    it('GET /api/games/for-event/:group_id/:user_id with no token → 401', async () => {
      const res = await request(app).get('/api/games/for-event/g1/u1');
      expect(res.status).toBe(401);
    });
  });
});
