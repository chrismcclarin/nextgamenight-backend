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
//
// PHASE 87.4 PLAN 02 (SPEC Req 5, D-04): PERMANENT dual-accept. The frozen
// frontend sends the caller's OWN Auth0 sub as the self-param today; Plan 10
// (PR-2) cuts those self-params to the caller's Users.id UUID. So the self-param
// gate must accept EITHER shape of the caller's OWN identity — sub OR resolved
// UUID — for the whole rollout window (and permanently: both are token-derived,
// nothing leaks on the wire). The dual-accept lives in ONE shared helper,
// `matchesSelf`, that both this factory AND the inline self-param sites
// (availability.js / rsvp.js / lists.js) call, so the family has a single
// implementation (SPEC Req 5).

const { User } = require('../models');
// Reuse the canonical UUID shape from resolveTargetUser — never re-declare the
// regex (subs are provider-prefixed and never match, so the keyspaces are
// unambiguous).
const { isUuid } = require('../utils/resolveTargetUser');

/**
 * Shared self-param dual-accept predicate (SPEC Req 5, D-04).
 *
 * Returns true iff `paramValue` is the CALLER'S OWN identity, in either keyspace:
 *   - sub era:  paramValue === req.user.user_id  (pure string compare, NO DB hit)
 *   - UUID era: isUuid(paramValue) AND paramValue === the caller's own Users.id,
 *               resolved LAZILY from the caller's OWN token sub.
 *
 * BOLA guard (threat T-874-02-BOLA): the UUID arm resolves `me` from the
 * CALLER's OWN sub, then compares `paramValue === me.id`. It NEVER looks up the
 * param's owner, so an arbitrary valid UUID (another user's id) is never treated
 * as authorized. The DB lookup fires ONLY when the param is UUID-shaped, so the
 * sub era stays DB-free (threat T-874-02-PERF).
 *
 * @param {import('express').Request} req - carries `req.user.user_id` (the sub).
 * @param {string} paramValue - the client-supplied self-param.
 * @returns {Promise<boolean>}
 */
async function matchesSelf(req, paramValue) {
  const sub = req.user && req.user.user_id;
  if (!sub) return false;
  // Sub era: the param is the caller's own Auth0 sub. No DB needed.
  if (paramValue === sub) return true;
  // UUID era: only a UUID-shaped param can be the caller's own Users.id. Resolve
  // the caller's UUID from their OWN sub (BOLA-safe) and require an exact match.
  if (isUuid(paramValue)) {
    const me = await User.findOne({ where: { user_id: sub }, attributes: ['id'] });
    return !!me && paramValue === me.id;
  }
  return false;
}

/**
 * Factory: require the verified actor (JWT sub) to equal a named route param —
 * accepting the actor's OWN sub OR OWN resolved Users.id UUID (dual-accept).
 *
 * @param {string} paramName - the route param holding the target user identity.
 * @returns {(req, res, next) => Promise<void>} Express middleware.
 *   - no `req.user.user_id` (unauthenticated) → 401 Unauthorized
 *   - `matchesSelf` false (not the caller's own identity) → 403 Forbidden
 *   - match → next()
 */
const requireParamMatchesToken = (paramName) => {
  return async (req, res, next) => {
    try {
      const userId = req.user && req.user.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!(await matchesSelf(req, req.params[paramName]))) {
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

module.exports = { requireSelf, requireParamMatchesToken, matchesSelf };
