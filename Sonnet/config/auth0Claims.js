// config/auth0Claims.js
// Single source of truth for the namespaced Auth0 access-token claim names.
// The table is DEFINED in auth0/actions/post-login-claims.js — the same file that is
// pasted into the Auth0 dashboard as the post-login Action — and merely re-exported
// here. Consumed by middleware/auth0.js (BOTH verifyAuth0Token and optionalAuth) AND,
// from Phase 88.8 plan 04 onward, services/provisioningService.js — so the names the
// backend READS can never drift from the names the Action WRITES.
//
// Phase 88.8 / BOPS-05 / D-02. See auth0/actions/post-login-claims.js for the claim
// table itself and auth0/actions/README.md for the dashboard deploy procedure.

const { CLAIMS, SOCIAL_CONNECTION_STRATEGIES } = require('../auth0/actions/post-login-claims');

module.exports = { CLAIMS, SOCIAL_CONNECTION_STRATEGIES };
