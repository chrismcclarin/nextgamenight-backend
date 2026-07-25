// tests/routes/deadRoutes.pin.test.js
// -----------------------------------------------------------------------------
// ORPHAN 404-PINS for Phase 87.6 dead-route deletions (D-04 hybrid placement).
//
// PLACEMENT RULE (D-04): this file hosts 404-pins for deleted routes whose
// OWNING AREA HAS NO EXISTING TEST SUITE. Pins for a route whose owning area DOES
// have a suite live in THAT suite (per WR-02 — see lists.test.js:96-139 for the
// canonical converted-block precedent). Do not move owning-suite pins here.
//
// NO DB (RESEARCH Pitfall 5): every pin builds a minimal standalone `express()`
// app and mounts only the still-live router, then asserts the deleted path 404s
// at the express routing layer — no handler runs, no query fires. This file does
// NOT call `sequelize.sync()` and issues zero DB queries, so it sidesteps the
// force-sync/shared-Postgres never-green gotcha and runs green ALONE.
//
// Pinned deletions (5):
//   - GET  /api/availability/user/:user_id                    (87.6 availability-reads, Tier 1)
//   - GET  /api/availability/group/:group_id/overlaps         (87.6 availability-reads, Tier 2)
//   - GET  /api/prompts/:promptId/suggestions                 (87.6 availability-suggestions, Tier 2)
//   - POST /api/prompts/:promptId/suggestions/refresh         (87.6 availability-suggestions, Tier 2)
//   - GET  /api/tokens/metrics                                (87.6 tokens-metrics, D-05 WEAKER pin)
// -----------------------------------------------------------------------------

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');

// A valid-shaped UUID for :group_id (validateUUID would 400 a malformed one, but
// a DELETED route 404s at the routing layer before any validator runs — the UUID
// just keeps the path realistic).
const UUID = '11111111-1111-1111-1111-111111111111';

// Build a standalone app that mounts a single live router at its prod prefix.
// No auth middleware is injected: a deleted route 404s before any route-level
// middleware, so the assertion holds regardless of auth.
function mountApp(prefix, router) {
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
  return app;
}

// ---------------------------------------------------------------------------
// availability router (no general availability test suite exists — orphan pins)
// ---------------------------------------------------------------------------
describe('availability orphan pins (deleted 87.6 availability-reads)', () => {
  const availabilityRouter = require('../../routes/availability');
  const app = mountApp('/api/availability', availabilityRouter);

  // Tier 1: superseded by the live patterns/recurring/override reads
  // (calculateUserAvailability stays live via those).
  describe('GET /api/availability/user/:user_id (deleted 87.6 availability-reads)', () => {
    it('404s — route deleted', async () => {
      await request(app)
        .get(`/api/availability/user/${encodeURIComponent('auth0|someone')}`)
        .expect(404);
    });
  });

  // Tier 2 COVERAGE PROOF: redundant thin wrapper. The underlying
  // availabilityService.calculateGroupOverlaps stays LIVE — consumed by
  // getGroupHeatmap (availabilityService.js:670), which the live
  // GET /group/:group_id/heatmap route drives. So deleting this route loses no
  // capability; the overlap computation is still reachable via the heatmap read.
  describe('GET /api/availability/group/:group_id/overlaps (deleted 87.6 availability-reads)', () => {
    it('404s — route deleted (calculateGroupOverlaps stays live via getGroupHeatmap)', async () => {
      await request(app)
        .get(`/api/availability/group/${UUID}/overlaps`)
        .expect(404);
    });
  });
});

// ---------------------------------------------------------------------------
// availabilitySuggestion router (mounted at /api for /convert; no owning suite
// for the deleted prompt-suggestion reads — orphan pins)
// ---------------------------------------------------------------------------
describe('availability-suggestion orphan pins (deleted 87.6 availability-suggestions)', () => {
  const suggestionRouter = require('../../routes/availabilitySuggestion');
  // Prod mount is `app.use('/api', ...)`, so the routes are /api/prompts/... .
  const app = mountApp('/api', suggestionRouter);

  // Tier 2 COVERAGE PROOF: the same aggregated rows are served live by
  // GET /prompts/:promptId/heatmap (availabilityPrompt.js:761 → heatmapService),
  // and re-aggregation happens automatically on prompt close
  // (promptLifecycleService.js:202). Deleting these reads loses no capability.
  describe('GET /api/prompts/:promptId/suggestions (deleted 87.6 availability-suggestions)', () => {
    it('404s — route deleted (rows served live by GET /prompts/:promptId/heatmap)', async () => {
      await request(app)
        .get(`/api/prompts/${UUID}/suggestions`)
        .expect(404);
    });
  });

  describe('POST /api/prompts/:promptId/suggestions/refresh (deleted 87.6 availability-suggestions)', () => {
    it('404s — route deleted (auto re-aggregation on prompt close)', async () => {
      await request(app)
        .post(`/api/prompts/${UUID}/suggestions/refresh`)
        .expect(404);
    });
  });

  // Name-collision guard + live-route sanity: the router STAYS MOUNTED — the
  // sibling POST /suggestions/:suggestionId/convert must NOT 404 (it 401s with no
  // token). Proves we deleted the reads, not the whole router.
  describe('POST /api/suggestions/:suggestionId/convert (LIVE — must NOT 404)', () => {
    it('does not 404 (route still mounted)', async () => {
      const res = await request(app)
        .post(`/api/suggestions/${UUID}/convert`)
        .send({});
      expect(res.status).not.toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// tokens router — WEAKER pin (D-05). tokens.js was emptied and DELETED, and the
// server.js require + mount removed. There is no live router to mount, so a bare
// 404 is VACUOUS (any unmounted path 404s). The real resurrection teeth are the
// SOURCE-LEVEL assertions against server.js below — they fail if the tokens
// router is ever re-required or re-mounted.
// ---------------------------------------------------------------------------
describe('tokens orphan pin (deleted 87.6 tokens-metrics)', () => {
  // D-05: weaker guarantee — unmounted path, not a removed handler.
  describe('GET /api/tokens/metrics (deleted 87.6 tokens-metrics)', () => {
    it('404s — path unmounted (D-05: weaker guarantee — unmounted path, not a removed handler)', async () => {
      // No router mounts /api/tokens anymore; an empty app 404s the path.
      const app = express();
      app.use(express.json());
      await request(app).get('/api/tokens/metrics').expect(404);
    });

    // RESURRECTION TEETH: the 404 above is vacuous on its own. These assert the
    // wiring in server.js stays gone — they FAIL if tokens routing is
    // re-introduced (comment lines mentioning /api/tokens do NOT match these
    // active-code patterns).
    it('server.js no longer requires the tokens router', () => {
      const serverSrc = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
      // Module-stem match: also catches './routes/tokens.js' and other
      // respellings of the same module, not just the exact deleted literal.
      expect(serverSrc).not.toMatch(/require\(\s*['"][^'"]*routes\/tokens(\.js)?['"]\s*\)/);
    });

    it('server.js no longer mounts /api/tokens', () => {
      const serverSrc = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
      // Any active mount whose path segment is /api/tokens (with or without a
      // trailing subpath), regardless of the router identifier used.
      expect(serverSrc).not.toMatch(/app\.use\(\s*['"]\/api\/tokens(\/[^'"]*)?['"]/);
    });

    it('routes/tokens.js stays deleted (file-level tripwire)', () => {
      // Belt-and-suspenders alongside the source regexes: re-creating the
      // module file at its old path trips this even before any mount lands.
      expect(fs.existsSync(path.join(__dirname, '../../routes/tokens.js'))).toBe(false);
    });
  });
});
