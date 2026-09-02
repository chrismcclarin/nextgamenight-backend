/**
 * HTTPS enforcement for production.
 *
 * Railway (like Heroku before it) terminates TLS at its edge and forwards plain HTTP to the
 * container with `x-forwarded-proto: https`. This middleware 301s any GET that did not arrive
 * over HTTPS so a stray http:// link can never serve app content in the clear.
 *
 * DECISION 2026-09-02 (quick-001, Railway deployment 08464eff): `/health` is EXEMPT. Railway's
 * deploy healthcheck probes the container over plain HTTP from `healthcheck.railway.app` with NO
 * x-forwarded-proto header, and only marks a deployment active on an HTTP 200 — a 301 here made
 * a perfectly healthy Node 22 container "never become healthy" and the deploy fail. The health
 * route carries no user data, so exempting it costs nothing. Exempt over "drop the healthcheck":
 * the healthcheck is the thing that stops a boot-then-crash container from taking traffic.
 * Changing the exemption list is a decision, not a cleanup.
 */
const DEFAULT_EXEMPT_PATHS = ['/health'];

function isSecure(req) {
  return req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    req.headers['x-forwarded-ssl'] === 'on';
}

function httpsRedirect({ exemptPaths = DEFAULT_EXEMPT_PATHS } = {}) {
  const exempt = new Set(exemptPaths);
  return function httpsRedirectMiddleware(req, res, next) {
    if (exempt.has(req.path)) return next();
    if (!isSecure(req) && req.method === 'GET') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  };
}

module.exports = { httpsRedirect, DEFAULT_EXEMPT_PATHS };
