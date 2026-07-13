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
 * Deliberately NO scope option (87.3 code-review #4/#16): this helper's input is
 * always client-supplied, so it must only ever return default-scope rows. A
 * handler that genuinely needs a PII-lifting scope (e.g. 'withContactInfo')
 * re-fetches explicitly by the RESOLVED primary key — see routes/invites.js —
 * so the lifted read is never keyed on raw client input.
 *
 * @param {string} identifier - a Users.id UUID (post-PR-C) or an Auth0 sub (today)
 * @returns {Promise<import('sequelize').Model|null>} the User instance or null.
 */
async function resolveTargetUser(identifier) {
  if (identifier == null || identifier === '') return null;
  const value = typeof identifier === 'string' ? identifier : String(identifier);
  if (isUuid(value)) {
    // UUID-shaped: resolve on the primary key. No sub fallback — a UUID-shaped
    // value is never an Auth0 sub, so a miss here is a genuine "no such user".
    return User.findByPk(value);
  }
  // Not UUID-shaped: resolve on the Auth0 sub (today's wire shape).
  return User.findOne({ where: { user_id: value } });
}

/**
 * Phase 87.3 PR-C (plan 09, amended D1 contraction): UUID-ONLY target
 * resolution. The PR-A dual-key expand window is CLOSED for the friend request
 * endpoints (POST /friendships/request, POST /invites/send friend_user_id) and
 * the five group-admin target-param mutations — PR-B (plans 05/06) cut every FE
 * sender of those identifiers to the nested `.id` (a Users.id UUID), so a
 * sub-shaped target is now rejected as not-found. Known ACCEPTED trade-off
 * (owner decision): a stale pre-PR-C browser bundle still sending a sub 404s —
 * do NOT re-add the sub fallback for it; a refresh resolves it.
 *
 * The sole retained dual-key caller after PR-C is the POST /:group_id/users
 * friend-invite/add-member path (outside D1's endpoint list), which keeps
 * using resolveTargetUser above.
 *
 * @param {string} identifier - a Users.id UUID (the only accepted shape)
 * @returns {Promise<import('sequelize').Model|null>} the User instance or null.
 */
async function resolveTargetUserUuidOnly(identifier) {
  if (identifier == null || identifier === '') return null;
  const value = typeof identifier === 'string' ? identifier : String(identifier);
  if (!isUuid(value)) return null; // sub-shaped (or garbage) → not found
  return User.findByPk(value);
}

module.exports = { resolveTargetUser, resolveTargetUserUuidOnly, isUuid };
