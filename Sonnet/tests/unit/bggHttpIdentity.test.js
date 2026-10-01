// tests/unit/bggHttpIdentity.test.js
// Pins how the backend introduces itself to BoardGameGeek.
//
// WHY THIS FILE EXISTS. Until 2026-10-01 both BGG services sent a fake Chrome User-Agent (and
// bggService a `Referer: https://boardgamegeek.com/`). BGG sits behind Cloudflare, which answers a
// non-browser that claims to be Chrome with its challenge page — HTTP 403, header
// `cf-mitigated: challenge` — BEFORE the request reaches the layer that reads the application
// token. Every live BGG call from production failed that way while the token itself was fine, and
// the service's own error text blamed rate limiting. Measured the same day with this client and
// these headers, no token: fake Chrome User-Agent -> 403 challenge; an honest app User-Agent -> 401
// from BGG itself ("Unauthorized. See https://boardgamegeek.com/using_the_xml_api").
//
// The source scan below is the half that matters over time: the disguise is the thing a future
// reader reaches for when a 403 appears, and it is exactly what causes the 403.
//
// DB-free: bggService imports only axios + xml2js; bggCsvService (which imports the models) is
// covered by the source scan, not by a require. Runs in the `npm run test:unit` lane.

const fs = require('fs');
const path = require('path');

const { BGG_USER_AGENT } = require('../../services/bggHttpIdentity');
const bggService = require('../../services/bggService');

const ROOT = path.join(__dirname, '..', '..');

function sourceFiles(dir) {
  return fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((f) => f.endsWith('.js'));
}

describe('BGG_USER_AGENT', () => {
  it('names the app and where to find it', () => {
    expect(BGG_USER_AGENT).toMatch(/^Nextgamenight\//);
    expect(BGG_USER_AGENT).toContain('https://www.nextgamenight.app');
  });

  it('does not claim to be a browser', () => {
    expect(BGG_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari|AppleWebKit|Gecko/i);
  });
});

describe('bggService.getHeaders()', () => {
  const original = bggService.applicationToken;
  afterEach(() => {
    bggService.applicationToken = original;
  });

  it('sends the honest User-Agent and no Referer', () => {
    const headers = bggService.getHeaders();
    expect(headers['User-Agent']).toBe(BGG_USER_AGENT);
    expect(headers).not.toHaveProperty('Referer');
  });

  it('still sends the application token as a Bearer header when one is set', () => {
    bggService.applicationToken = 'unit-test-token';
    expect(bggService.getHeaders().Authorization).toBe('Bearer unit-test-token');
  });

  it('sends no Authorization header when no token is set', () => {
    bggService.applicationToken = null;
    expect(bggService.getHeaders()).not.toHaveProperty('Authorization');
  });
});

describe('source scan — no browser disguise anywhere the backend makes requests', () => {
  const files = [...sourceFiles('services'), ...sourceFiles('routes')];

  it('scans a non-trivial set of files (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(path.join('services', 'bggService.js'));
    expect(files).toContain(path.join('services', 'bggCsvService.js'));
  });

  it('no service or route hardcodes a browser User-Agent', () => {
    const offenders = files.filter((f) => /Mozilla\/\d/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('bggCsvService takes its User-Agent from the shared constant', () => {
    const src = fs.readFileSync(path.join(ROOT, 'services', 'bggCsvService.js'), 'utf8');
    expect(src).toMatch(/'User-Agent':\s*BGG_USER_AGENT/);
  });
});
