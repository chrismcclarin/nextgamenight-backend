// middleware/objectAuth.js
//
// Object-level authorization middleware (D-01 / BSEC-01).
//
// The global `/api` default-deny layer (server.js) proves AUTHENTICATION only —
// that the request carries a valid Auth0 JWT and `req.user.user_id` is populated.
// It does NOT prove the caller is allowed to act on the SPECIFIC resource named
// in the route. That object-level check is what closes the BOLA cluster.
//
// `requireParamMatchesToken(paramName)` is the reusable "this route names a
// user_id in the path; the actor MUST be that same user" guard. It derives the
// actor from the verified JWT (`req.user.user_id`) and 403s on any mismatch —
// the client can never spoof the actor via the path, body, or query.
//
// NOTES:
//   - Auth0 user_id is a STRING (e.g. "google-oauth2|123"), NOT a UUID. We do
//     NOT UUID-validate the param — that is validators.validateAuth0UserId's job
//     at the route boundary and would reject every legitimate Auth0 sub here.
//   - Membership/object-ownership checks (isActiveMember, review.User.user_id, …)
//     are deliberately NOT baked in: they need the resource id + a DB read and
//     stay per-handler. This middleware is purely the actor-vs-param-self check.
//   - Mirrors the in-codebase reference shape at routes/lists.js:232-252 and the
//     adminAuth skeleton (async + try/catch + req.user.user_id guard).

/**
 * Factory: require the verified actor (JWT sub) to equal a named route param.
 *
 * @param {string} paramName - the route param holding the target Auth0 user_id.
 * @returns {(req, res, next) => Promise<void>} Express middleware.
 *   - no `req.user.user_id` (unauthenticated) → 401 Unauthorized
 *   - `req.params[paramName] !== req.user.user_id` → 403 Forbidden
 *   - match → next()
 */
const requireParamMatchesToken = (paramName) => {
  return async (req, res, next) => {
    try {
      const userId = req.user && req.user.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (req.params[paramName] !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return next();
    } catch (err) {
      console.error('objectAuth.requireParamMatchesToken error:', err.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
};

/**
 * Convenience: the common case where the self-param is literally `user_id`.
 */
const requireSelf = requireParamMatchesToken('user_id');

module.exports = { requireSelf, requireParamMatchesToken };
