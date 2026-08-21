// utils/provisionedUsername.js
//
// DECISION Phase 88 wave-12 code review HIGH #2 (owner-approved 2026-08-21),
// extending the fork-D ruling (88-34 Task 4, owner-ruled 2026-08-20): EVERY
// machine-derived username write must clamp to the User.username len[1,50]
// model backstop, via THIS shared helper — over per-site ad-hoc clamps, which
// is how the original fix left 8 of 9 writers unclamped and shipped
// deterministic 500s on Google-Calendar connect, first-login JIT provisioning,
// and group-join provisioning for anyone with a >50-char identity-provider name.
//
// Apply PER-CANDIDATE (inside/before a `||` fallback chain, not around it):
// the helper returns null for a name that is empty after trimming (e.g. a
// whitespace-only token claim), so the caller's chain falls through to its
// next candidate and its final literal fallback ('User') guarantees the model
// backstop's min-1 bound. Wrapping a whole chain instead would let a truthy
// whitespace-only name win the chain and clamp to '' — a validation 500.
//
// This clamps DISPLAY usernames only. Identity keys (Users.user_id = Auth0
// sub), emails, and OAuth tokens are never routed through here.
//
// Human-entered usernames (routes/users.js PUT /:user_id/username) stay on
// their route validator — a human typing >50 chars should get a 400, not a
// silent truncation.

function clampProvisionedUsername(name) {
  const clamped = String(name ?? '').trim().slice(0, 50);
  return clamped || null;
}

module.exports = { clampProvisionedUsername };
