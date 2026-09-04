// utils/provisioningReport.js
//
// Phase 88.8 / BOPS-05 (SPEC R4, CONTEXT D-17) — the ONE reporting seam for JIT
// account provisioning.
//
// WHY A SHARED HELPER, not a capture call at each site: every provisioning fallback
// must report with the SAME tag vocabulary, or the events cannot be counted together.
// The original defect is exactly the opposite shape — each of the seven provisioning
// writers invented its own console warning ("Auth0 Management API lookup failed during
// user creation (this is optional)"), so a vendor failure that ran for five months and
// gave every new account a synthetic <sub>@auth0.local address produced no signal
// anywhere but Railway's log stream. A frozen reason vocabulary plus one capture site
// is what makes "how many accounts fell back last week" a question with an answer.
//
// SCOPE BOUNDARY — this helper owns the PROVISIONING vocabulary only, and must NOT
// grow into a general Sentry util:
//   - services/auth0Service.js deliberately keeps its own inline
//     { service: 'auth0-management', op } vocabulary. Those events describe a VENDOR
//     call; these describe a PROVISIONING OUTCOME. Routing one through the other would
//     merge two different questions into one tag namespace. Do not do it.
//   - One general utils/sentry.js de-duplicating the fourteen backend require blocks is
//     a RECORDED DEFERRAL owned by Phase 91 (.planning/deferred/phase-91.md, section
//     "One utils/sentry.js for the 14 backend Sentry require blocks", which names this
//     file explicitly as provisioning-scoped and NOT that util). This file deliberately
//     does not become it.
//
// THE PII RULE (SPEC R4 prohibition): a provisioning event carries the Auth0 sub and the
// email DOMAIN. Never the local part, never a picture URL, never a token, never a whole
// user instance. emailDomain() below is the mechanical half of that rule; the judgment
// half is the code review. Phase 91's beforeSend scrub is the backstop, not the guard.
// CALLER CONTRACT: an `err` passed in here is captured verbatim, so never hand this
// function an error whose message embeds an address (wrap it first).
//
// ORDERING: reporting happens AFTER the row is persisted and never on the response path.
// A telemetry helper must never be the thing that breaks a request, which is why every
// failure mode below returns rather than throws.

// The unconditional try-require idiom (D-17, SPEC Amendment A2) copied from
// routes/users.js:19-25 — Sentry is initialised in server.js only when SENTRY_DSN is
// set, so a dev/test environment resolves the module but never flushes. The DSN-GATED
// variant at services/notificationService.js:11-18 is the OTHER idiom and is
// deliberately not the one used here.
let Sentry = null;
try {
  Sentry = require('@sentry/node');
} catch (_e) {
  Sentry = null;
}

// The tag value every provisioning event shares, so one Sentry query returns the whole
// class. Kept as a constant rather than a literal at the capture site because the
// source-scan style checks in the service suite grep for it.
const PROVISIONING_FEATURE = 'provisioning';

// SPEC R4's reason vocabulary, spelled exactly as the SPEC lists it. Frozen so a caller
// cannot bolt a synonym on at runtime and split the counts.
const PROVISIONING_REASONS = Object.freeze({
  CLAIMS_MISSING: 'claims_missing',
  MGMT_API_FAILED: 'mgmt_api_failed',
  EMAIL_UNVERIFIED: 'email_unverified',
  UNIQUE_EMAIL_COLLISION: 'unique_email_collision',
  ORPHAN_RELEASED: 'orphan_released',
  GENUINE_CONFLICT: 'genuine_conflict',
});

// Used when a caller passes a reason outside the vocabulary. Reporting with a generic
// tag is strictly better than throwing inside a fallback path that is, by definition,
// already handling something going wrong.
const UNSPECIFIED_REASON = 'unspecified';

const KNOWN_REASONS = Object.freeze(Object.values(PROVISIONING_REASONS));

/**
 * The domain half of an email address, and nothing else.
 *
 * @param {unknown} value - an address, or anything at all.
 * @returns {string|null} the lowercased domain, or null when there is not one.
 */
function emailDomain(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Split on the LAST at-sign: a quoted local part may legally contain one
  // ("weird@local"@example.com), and splitting on the first would return a domain that
  // is actually part of the local part — i.e. it would leak the thing this exists to hide.
  const at = trimmed.lastIndexOf('@');
  if (at === -1) {
    return null;
  }
  const domain = trimmed.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * Report one provisioning fallback to Sentry. Never throws, never returns anything the
 * caller should branch on, never touches the response.
 *
 * @param {{ sub?: string, reason?: string, email?: string|null, err?: Error }} args
 * @returns {void}
 */
function reportProvisioning({ sub, reason, email, err } = {}) {
  // A DSN-less dev or test environment must be a complete no-op — SPEC Edge Coverage
  // row `adjacency / R4`. Guard on the FUNCTION, not on the module, because a mocked or
  // partially-initialised SDK resolves to an object either way.
  if (!Sentry || typeof Sentry.captureException !== 'function') {
    return;
  }

  const tagReason = KNOWN_REASONS.includes(reason) ? reason : UNSPECIFIED_REASON;

  // Capture the caller's error when there is one so the stack points at the real
  // failure; otherwise synthesise one, because a fallback with no exception is still an
  // event we want counted and Sentry groups on an exception.
  const event =
    err instanceof Error ? err : new Error(`provisioning fallback: ${tagReason}`);

  try {
    Sentry.captureException(event, {
      tags: { feature: PROVISIONING_FEATURE, reason: tagReason },
      extra: {
        auth0_sub: typeof sub === 'string' && sub.length > 0 ? sub : null,
        // Domain ONLY. If you are tempted to add the address here, read the PII rule
        // in the header first — that is a decision, not a cleanup.
        email_domain: emailDomain(email),
      },
    });
  } catch (_captureFailed) {
    // Telemetry is never allowed to be the thing that breaks a request.
  }
}

module.exports = {
  reportProvisioning,
  emailDomain,
  PROVISIONING_REASONS,
  PROVISIONING_FEATURE,
};
