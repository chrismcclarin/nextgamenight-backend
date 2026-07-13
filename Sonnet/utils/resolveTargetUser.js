// utils/resolveTargetUser.js
//
// Phase 87.3 (BINT-02, PR-A expand stage): dual-key target-user resolution for
// the client-supplied identifier passed into the sub-keyed WRITE handlers.
//
// Today the frozen frontend sends other users' Auth0 subs (via the D-12 wire
// shims) as the target of group-admin mutations, friend requests, and group
// friend-invites. Phase 87.3 converges the READ contract onto the Users.id UUID:
// PR-B (plans 05/06) cuts those FE senders to the nested `.id` (a UUID) and PR-C
// (plan 09) removes the sub from the wire entirely. Between PR-A and PR-C BOTH
// identifier shapes are in flight, so every write handler that resolves a target
// user must accept EITHER shape:
//
//   - UUID-shaped identifier -> look up by Users.id (the post-PR-C wire shape)
//   - otherwise              -> look up by user_id (the Auth0 sub, today's shape)
//
// Factoring this as ONE shared lookup (rather than divergent per-handler copies)
// means PR-C and any future handler inherit identical semantics. This is
// request-side resolution ONLY — no response serialization changes here.
const { User } = require('../models');

// Canonical UUID shape (any variant). Auth0 subs are provider-prefixed strings
// (e.g. `auth0|...`, `google-oauth2|...`) and never match this, so the two
// keyspaces are unambiguous.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Resolve a client-supplied target identifier to a Users row, dual-keyed.
 *
 * @param {string} identifier - a Users.id UUID (post-PR-C) or an Auth0 sub (today)
 * @param {object} [opts]
 * @param {string} [opts.scope] - optional Sequelize named scope (e.g.
 *   'withContactInfo') applied to the lookup.
 * @returns {Promise<import('sequelize').Model|null>} the User instance or null.
 */
async function resolveTargetUser(identifier, { scope } = {}) {
  if (identifier == null || identifier === '') return null;
  const value = typeof identifier === 'string' ? identifier : String(identifier);
  const model = scope ? User.scope(scope) : User;
  if (isUuid(value)) {
    // UUID-shaped: resolve on the primary key. No sub fallback — a UUID-shaped
    // value is never an Auth0 sub, so a miss here is a genuine "no such user".
    return model.findByPk(value);
  }
  // Not UUID-shaped: resolve on the Auth0 sub (today's wire shape).
  return model.findOne({ where: { user_id: value } });
}

module.exports = { resolveTargetUser, isUuid };
