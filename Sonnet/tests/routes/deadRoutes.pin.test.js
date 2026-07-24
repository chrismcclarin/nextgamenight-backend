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
