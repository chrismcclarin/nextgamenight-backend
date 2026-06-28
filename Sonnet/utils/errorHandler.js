// utils/errorHandler.js
// Utility functions for safe error handling in production

const { formatEnvelope } = require('./errors');

// Optional Sentry integration — DSN-gated, mirrors workers/deadlineWorker.js.
// Required lazily behind the SENTRY_DSN gate so non-DSN environments (and DB-free
// unit tests that do NOT set the DSN) never pull @sentry/node into the graph.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[errorHandler] Sentry not available:', err.message);
  }
}

/**
 * Get a safe error message for client responses
 * In production, don't expose internal error details
 */
function getSafeErrorMessage(error, defaultMessage = 'An error occurred') {
  if (process.env.NODE_ENV === 'development') {
    // In development, show full error details
    return error.message || defaultMessage;
  }

  // In production, return generic message
  // Log full error server-side for debugging
  console.error('Error details (server-side only):', {
    message: error.message,
    name: error.name,
    stack: error.stack
  });

  return defaultMessage;
}

/**
 * Send a safe error response.
 *
 * Emits the canonical error envelope (BAPI-01) instead of a bare `{ error }`:
 *   - 5xx -> formatEnvelope('internal', ..., <safe message>) so the body carries
 *     code:'internal', the prod-safe message, and the `error` legacy alias. Production
 *     NEVER serializes raw err.message/stack (getSafeErrorMessage governs the prose; ASVS V7).
 *   - <500 -> wrap the same safe message as an envelope with a generic ad-hoc code
 *     (no FE-contract code invented for these direct-response sites).
 *
 * Because sendSafeError responds DIRECTLY (it never calls next()), it owns its own
 * observability escalation: a DSN-gated Sentry.captureException for 5xx ONLY, tagged with
 * the low-cardinality route PATTERN (req.route.path + baseUrl) — NEVER req.originalUrl, which
 * carries path-embedded PII like emails (routes/users.js:23) / player_names (ASVS V7). This
 * does not double-fire with the global handler because the response is already sent here.
 */
function sendSafeError(res, statusCode, error, defaultMessage = 'An error occurred') {
  const safeMessage = getSafeErrorMessage(error, defaultMessage);

  let body;
  if (statusCode >= 500) {
    ({ body } = formatEnvelope('internal', undefined, safeMessage));

    // 5xx-only DSN-gated escalation, route-PATTERN tagged (never originalUrl — ASVS V7).
    if (Sentry) {
      const req = res && res.req;
      Sentry.captureException(error, {
        tags: {
          route: (req && req.route && ((req.baseUrl || '') + req.route.path)) || 'unmatched',
          method: req && req.method,
        },
      });
    }
  } else {
    // <500: keep the prod-safe message but still wrap it as an envelope. Generic code only.
    body = { code: 'error', message: safeMessage, error: safeMessage };
  }

  res.status(statusCode).json(body);
}

module.exports = {
  getSafeErrorMessage,
  sendSafeError
};
