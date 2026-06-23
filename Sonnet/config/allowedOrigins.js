// config/allowedOrigins.js
// Single source of truth for the CORS / redirect allow-list.
// Built from FRONTEND_URL + Vercel preview URL + comma-split ALLOWED_ORIGINS,
// matching the multi-origin prod setup (apex + www). Consumed by server.js
// (CORS) AND routes/googleAuth.js (D-04 OAuth frontend_url allow-list) so the
// OAuth redirect allow-list never drifts from the CORS allow-list.

function buildAllowedOrigins() {
  const origins = [
    'http://localhost:3000',
    'http://localhost:3001', // Alternative local port
    process.env.FRONTEND_URL, // Production frontend URL from env
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null, // Vercel preview deployments
  ].filter(Boolean);

  if (process.env.ALLOWED_ORIGINS) {
    origins.push(
      ...process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    );
  }

  return origins;
}

/**
 * Normalize an origin/URL to its origin (scheme + host + port), trailing slash stripped.
 * Returns null if the value is not a parseable absolute URL.
 */
function normalizeOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve a requested frontend_url against the allow-list.
 * Compares by ORIGIN (so a path on an allow-listed origin is accepted) and
 * returns the caller-supplied (trailing-slash-trimmed) URL when allowed, else null.
 *
 * @param {string} requested - The frontend_url requested by the client.
 * @returns {string|null} The accepted frontend_url, or null if not allow-listed.
 */
function resolveAllowedFrontendUrl(requested) {
  const reqOrigin = normalizeOrigin(requested);
  if (!reqOrigin) return null;
  const allowed = buildAllowedOrigins()
    .map(normalizeOrigin)
    .filter(Boolean);
  if (!allowed.includes(reqOrigin)) return null;
  return requested.replace(/\/$/, '');
}

module.exports = {
  buildAllowedOrigins,
  resolveAllowedFrontendUrl,
  normalizeOrigin,
};
