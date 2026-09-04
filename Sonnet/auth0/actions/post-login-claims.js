// auth0/actions/post-login-claims.js
//
// SOURCE OF TRUTH for the namespaced Auth0 access-token claim names (Phase 88.8, BOPS-05).
//
// THIS FILE HAS TWO CONSUMERS, and that is the whole point:
//   1. The Auth0 dashboard — its body is PASTED into a post-login Action bound to the
//      Login flow (see ./README.md for the exact procedure). The Actions runtime has no
//      access to this repo's node_modules, so this file is dependency-free CommonJS and
//      imports nothing.
//   2. The backend — config/auth0Claims.js re-exports CLAIMS and
//      SOCIAL_CONNECTION_STRATEGIES from here, and middleware/auth0.js maps the token
//      onto req.user using those exact keys. Because the emitter and the reader share
//      one table, the claim names cannot drift.
//
// Claim names MUST be fully-qualified URLs. An access token minted for an API audience
// cannot carry private, non-namespaced custom claims — Auth0 silently drops them.
// [CITED: auth0.com/docs — custom claims / post-login event object]
//
// When you paste this into the dashboard, record the commit you pasted:
//   SOURCE: auth0/actions/post-login-claims.js @ <commit>
// so a later reader can diff the deployed Action against this file.

const NS = 'https://nextgamenight.app';

const CLAIMS = Object.freeze({
  email: `${NS}/email`,
  emailVerified: `${NS}/email_verified`,
  picture: `${NS}/picture`,
  name: `${NS}/name`,
  nickname: `${NS}/nickname`,
  username: `${NS}/username`,
  connection: `${NS}/connection`,
});

// V4/A2: for a SOCIAL connection, event.connection.strategy === event.connection.name
// (e.g. 'google-oauth2'); a database connection reports 'auth0'. Kept here as DATA beside
// CLAIMS rather than as an inline literal in the consuming service so that if the tenant
// ever renames or replaces the Google connection, the social-only rules (e.g. the avatar
// rule) fail visibly in ONE place instead of silently degrading at each call site.
// [CITED: auth0.com/docs — post-login event object reference, event.connection]
const SOCIAL_CONNECTION_STRATEGIES = Object.freeze(['google-oauth2']);

/**
 * Auth0 post-login Action. Copies the seven profile facts the backend needs onto the
 * ACCESS token, so just-in-time account provisioning never has to call the Management API.
 *
 * @param {object} event - the post-login event object (event.user, event.connection).
 * @param {object} api   - the post-login API object (api.accessToken.setCustomClaim).
 */
exports.onExecutePostLogin = async (event, api) => {
  const u = (event && event.user) || {};
  const connection = (event && event.connection) || {};

  api.accessToken.setCustomClaim(CLAIMS.email, u.email);
  api.accessToken.setCustomClaim(CLAIMS.emailVerified, u.email_verified);
  api.accessToken.setCustomClaim(CLAIMS.picture, u.picture);
  api.accessToken.setCustomClaim(CLAIMS.name, u.name);
  api.accessToken.setCustomClaim(CLAIMS.nickname, u.nickname);
  api.accessToken.setCustomClaim(CLAIMS.username, u.username);
  api.accessToken.setCustomClaim(CLAIMS.connection, connection.strategy);
};

// DECISION Phase 88.8 D-02: these two extra exports ride along with the Action body,
// chosen OVER declaring the claim names a second time in config/auth0Claims.js.
// The rejected alternative (a standalone constants module plus a key-set diff test)
// only DETECTS drift; sharing one table makes drift impossible by construction.
// If the Auth0 Actions editor ever rejects the extra exports (A1, unverified until the
// first paste), the fallback is mechanical: move CLAIMS + SOCIAL_CONNECTION_STRATEGIES
// into config/auth0Claims.js and add a key-set diff test against this file.
exports.CLAIMS = CLAIMS;
exports.SOCIAL_CONNECTION_STRATEGIES = SOCIAL_CONNECTION_STRATEGIES;
