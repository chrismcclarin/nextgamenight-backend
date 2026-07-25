// services/tokenAnalyticsService.js
// [87.6-07] getTokenMetrics removed (its only consumer, GET /api/tokens/metrics,
// was deleted). trackValidation + extractTokenId stay LIVE (magicAuth.js). The
// MagicToken/AvailabilityPrompt/sequelize/Op imports were getTokenMetrics-only
// and are dropped with it.
const { TokenAnalytics } = require('../models');

/**
 * Track a token validation attempt
 * Fire-and-forget - errors are logged but don't fail the request
 *
 * @param {object} options
 * @param {string} options.tokenId - JWT jti claim (may be null if malformed)
 * @param {boolean} options.success - Whether validation succeeded
 * @param {string} options.reason - Failure reason (if failed)
 * @param {string} options.ipAddress - Request IP
 * @param {string} options.userAgent - Browser user agent
 * @param {boolean} options.graceUsed - Whether grace period was used
 */
async function trackValidation({ tokenId, success, reason, ipAddress, userAgent, graceUsed = false }) {
  try {
    await TokenAnalytics.create({
      token_id: tokenId,
      validation_success: success,
      failure_reason: success ? null : reason,
      ip_address: ipAddress,
      user_agent: userAgent ? userAgent.substring(0, 500) : null,
      grace_period_used: graceUsed,
      timestamp: new Date()
    });
  } catch (err) {
    // Log but don't fail the request if analytics tracking fails
    console.error('Failed to track token analytics:', err.message);
  }
}

/**
 * Helper to extract JWT jti claim even from invalid tokens
 * Useful for analytics logging when token fails verification
 *
 * @param {string} token - JWT string
 * @returns {string|null} The jti claim or null if unparseable
 */
function extractTokenId(token) {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.decode(token, { complete: false });
    return decoded?.jti || null;
  } catch {
    return null;
  }
}

module.exports = { trackValidation, extractTokenId };
