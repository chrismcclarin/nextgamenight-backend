// services/bggHttpIdentity.js
// The one place the backend says who it is to BoardGameGeek.

// DECISION quick-261001 (BGG 403): an honest app User-Agent over a browser disguise. BGG is behind
// Cloudflare, which answers a non-browser claiming to be Chrome with its challenge page (HTTP 403,
// `cf-mitigated: challenge`) before the request ever reaches the layer that reads the application
// token — that is what took every live BGG call down in September 2026 with a working token.
// A 403 from BGG is not a reason to put a browser string back here; it is what a browser string
// causes. Pinned by tests/unit/bggHttpIdentity.test.js.
const BGG_USER_AGENT = 'Nextgamenight/1.0 (+https://www.nextgamenight.app)';

module.exports = { BGG_USER_AGENT };
