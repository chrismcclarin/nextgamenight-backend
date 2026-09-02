// tests/middleware/httpsRedirect.test.js
// DB-FREE unit test for the production HTTPS-enforcement middleware.
//
// Pins the DECISION in middleware/httpsRedirect.js: Railway's deploy healthcheck probes
// `/health` over plain HTTP (no x-forwarded-proto) and needs a 200, so `/health` is exempt
// from the 301; everything else that arrives without HTTPS is still redirected.
// Regression for Railway deployment 08464eff (2026-09-02): "Attempt #1 failed with HTTP 301".
//
// No database, no Redis, no network.
const request = require('supertest');
const express = require('express');
const { httpsRedirect, DEFAULT_EXEMPT_PATHS } = require('../../middleware/httpsRedirect');

function buildApp(opts) {
  const app = express();
  app.set('trust proxy', 1); // same as server.js
  app.use(httpsRedirect(opts));
  app.get('/health', (req, res) => res.json({ status: 'OK' }));
  app.get('/api/games', (req, res) => res.json({ ok: true }));
  app.post('/api/feedback', (req, res) => res.status(201).json({ ok: true }));
  return app;
}

describe('httpsRedirect (production HTTPS enforcement)', () => {
  it('exempts /health by default so a plain-HTTP healthcheck probe gets 200, not 301', async () => {
    expect(DEFAULT_EXEMPT_PATHS).toContain('/health');
    const res = await request(buildApp()).get('/health').set('Host', 'healthcheck.railway.app');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });

  it('301s a plain-HTTP GET on any other path to the https:// equivalent', async () => {
    const res = await request(buildApp()).get('/api/games?x=1').set('Host', 'api.nextgamenight.app');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://api.nextgamenight.app/api/games?x=1');
  });

  it('passes a GET through when the edge says it was HTTPS (x-forwarded-proto)', async () => {
    const res = await request(buildApp()).get('/api/games').set('x-forwarded-proto', 'https');
    expect(res.status).toBe(200);
  });

  it('passes a GET through when x-forwarded-ssl is on', async () => {
    const res = await request(buildApp()).get('/api/games').set('x-forwarded-ssl', 'on');
    expect(res.status).toBe(200);
  });

  it('never redirects non-GET methods (unchanged behaviour)', async () => {
    const res = await request(buildApp()).post('/api/feedback').send({});
    expect(res.status).toBe(201);
  });

  it('honours a custom exemption list', async () => {
    const app = buildApp({ exemptPaths: ['/api/games'] });
    expect((await request(app).get('/api/games')).status).toBe(200);
    expect((await request(app).get('/health')).status).toBe(301);
  });
});
