// utils/errors.js
// Single source of truth for the canonical error envelope (Phase 85, BAPI-01).
//
// Exports:
//   - AppError        : Error subclass that looks up status + default message by code
//   - ERROR_REGISTRY  : frozen { code: { httpStatus, message } } map; keys ARE the wire codes
//   - formatEnvelope  : the ONE serializer that builds { code, message, details?, error }
//   - sendError       : call-site helper -> res.status(httpStatus).json(body)
//
// Design notes:
//   - Wire codes are lowercase snake_case to match the live FE vocabulary shipped in
//     Phase 84 (src/lib/api.ts reads body.code verbatim; queryClient.ts NON_RETRYABLE_API_CODES).
//     The five retry-visible codes equal the FE tokens exactly: validation / unauthorized /
//     forbidden / not_found / rate_limited. Do NOT rename or re-case (re-opens locked threat T-84-08).
//   - httpStatus values are ANCHORED to the CURRENT wire status at each site (non-breaking).
//   - The `internal` branch returns generic registry prose and NEVER serializes err.message/stack
//     (preserves the getSafeErrorMessage info-disclosure guarantee, ASVS V7).
//   - `error` (= message) and the top-level validation `errors[]` are LEGACY ALIASES for the
//     85->86 window only; both are removed end of Phase 86 (see the durable alias-removal todo).
//   - This is a PURE module: it wires no throw path and does not require express-async-errors.

// Keys ARE the wire codes (FE-facing contract — name stably, treat as append-only).
const ERROR_REGISTRY = Object.freeze({
  validation:              { httpStatus: 400, message: 'Validation failed' },
  rate_limited:            { httpStatus: 429, message: 'Too many requests, please try again later.' },
  unauthorized:            { httpStatus: 401, message: 'Authentication required' },
  token_invalid:           { httpStatus: 400, message: 'This link is no longer valid.' }, // magic-token reject is 400 today
  // not_found (404) and forbidden (403) were registered as FORWARD-COMPAT (Phase 86+) under
  // decision D-03 (convert-when-touched). AMENDED Phase 88.8 (round 3 #17): both are now LIVE —
  // the five email-change routes in routes/users.js emit `forbidden` from emailChangeSelfGate on
  // every one of them and `not_found` at their missing-row arms, plus the deletion endpoints emit
  // `not_provisioned`. A frontend reader must treat a real 403/404 from those routes as expected.
  // (The sendSafeError <500 status->code map still references them only as hardening.)
  not_found:               { httpStatus: 404, message: 'Resource not found' },
  forbidden:               { httpStatus: 403, message: 'You do not have permission to perform this action' },
  prompt_deadline_expired: { httpStatus: 400, message: 'The deadline for this availability prompt has passed.' },
  prompt_closed:           { httpStatus: 400, message: 'This availability prompt is no longer accepting responses.' },
  reminder_cooldown:       { httpStatus: 429, message: 'A reminder was sent too recently. Please wait before retrying.' }, // 429 verified at routes/availabilityPrompt.js:179
  // Phase 87.2 (account deletion) — append-only per D-11. Cross-repo contract consumed by the FE
  // in plan 87.2-07 (queryClient NON_RETRYABLE_API_CODES + DangerZone blocked-groups render).
  // The blocked groups list rides in `details.groups` via formatEnvelope — no envelope-format change.
  owner_of_active_groups:  { httpStatus: 409, message: 'You still own one or more groups with other members. Transfer ownership or remove members before deleting your account.' },
  // 410 tombstone/JIT guard: repeat-DELETE and post-deletion re-auth refusals emit this (never a raw 410).
  account_deleted:         { httpStatus: 410, message: 'This account has been deleted.' },
  // Phase 88.2 (group soft-delete recovery) — append-only per D-11. Emitted by the
  // hand-rolled bodies in POST /groups/accept-ownership, NOT via sendError (see below).
  // NOTE: `invalid_token` (410, restore link) is NOT `token_invalid` (400, magic-token
  // reject) above. Two codes, two statuses, deliberately distinct — do not merge them.
  //
  // DECISION Phase 88.2 MED-1: registration WITHOUT converting the handlers to
  // sendError was chosen OVER (a) converting them, because sendError nests caller data
  // under `details` and plan 10 reads the 409's id off the RAW body as
  // `err.details.group_id` — the envelope accessor getEnvelopeDetails reads
  // `err.details.details` and would return undefined, silently killing the redirect;
  // and OVER (b) leaving them unregistered, which would put four codes on the wire
  // that this contract file does not know exist. These entries are the canonical
  // status/message record; the routes keep their raw shape. Same forward-compat
  // pattern `not_found` / `forbidden` above already occupy — registered, documented
  // as not-emitted-through-the-chokepoint, and explicitly NOT a gap.
  already_restored:        { httpStatus: 409, message: 'This group has already been restored.' },
  // Phase 88-34 Task 4 (fork F, owner-ruled 2026-08-20) — append-only per D-11.
  // Group-invite 409s. Same registered-but-hand-rolled shape as the 88.2 MED-1
  // block above: routes/invites.js keeps its raw { error, code } body and is NOT
  // converted to sendError, because existing consumers read the raw `error`
  // string off these two responses. The `message` values below are BYTE-IDENTICAL
  // to the strings those handlers emit — this registry is the canonical
  // status/message record the FE contract anchors on, so an unregistered code
  // emitted outside sendError would be invisible to it. Test-pinned: the
  // registry message must equal the live route string.
  // FE side (88-33 Task 2): ApiErrorCode union + NON_RETRYABLE_API_CODES (409 is
  // TERMINAL — omitting it makes these silently retryable) + MESSAGE_BY_CODE.
  already_member:          { httpStatus: 409, message: 'This person is already a member of the group' },
  invite_pending:          { httpStatus: 409, message: 'This person already has a pending invite' },
  invalid_token:           { httpStatus: 410, message: 'This restore link is no longer valid.' },
  already_used:            { httpStatus: 410, message: 'This restore link is no longer valid.' },
  window_expired:          { httpStatus: 410, message: 'This link has expired.' },
  // Phase 88.8 (BOPS-05, SPEC R7) — append-only per D-11. Emitted through sendError by
  // BOTH deletion endpoints (DELETE /users/me and GET /users/me/deletion-blockers) when
  // the caller's token is valid but there is no Users row AND no deletion tombstone.
  //
  // DECISION Phase 88.8 R7: a NEW code was chosen OVER reusing the existing generic
  // `not_found` (404) above. `not_found` is registered as forward-compat and is emitted
  // by no live chokepoint (see its comment), so reusing it would look free — but the
  // whole point of R7 is that the frontend must tell three states apart: "you never had
  // an account here" (this code), "your account was deleted" (account_deleted, 410), and
  // "the thing you asked for is missing" (not_found, 404). Sharing a code with the
  // generic 404 collapses exactly the distinction this requirement exists to create, and
  // the FE's exhaustive message Record could no longer render different copy for them.
  //
  // The `message` here is the API-CONSUMER fallback, not the user-facing string: the
  // frontend renders its OWN copy from MESSAGE_BY_CODE (plan 11). Worded so it never
  // implies a deletion happened.
  not_provisioned:         { httpStatus: 404, message: 'This account has no stored data yet.' },
  // Phase 88.8 post-merge (round-5 #29, round-6) — append-only per D-11. Emitted through
  // sendError by POST /users/:user_id/email when the requested address matches the app's
  // OWN synthetic-account sentinel (the broad NIX-AUTH0 predicate). DELIBERATELY DISTINCT
  // from the generic `validation` (400) beside it: `validation` is the shape/length/body-key
  // verdict, and the frontend's EmailAddressSection overrides copy for that code with
  // "That action is no longer available — reload the page", which is false twice over for a
  // typed address that will fail identically forever. A separate code is what lets the FE
  // render a reason. Cross-repo: the FE adds it to its ApiErrorCode union, MESSAGE_BY_CODE
  // and NON_RETRYABLE_API_CODES in the same fix set. The `message` here is the
  // API-CONSUMER fallback; the FE renders its own copy.
  unsupported_address:     { httpStatus: 400, message: 'That address cannot be used with this app — the domain is reserved by our sign-in system.' },
  internal:                { httpStatus: 500, message: 'An internal error occurred' }, // 500 fallback
});

class AppError extends Error {
  constructor(code, details) {
    const entry = ERROR_REGISTRY[code] || ERROR_REGISTRY.internal;
    super(entry.message);
    this.name = 'AppError';
    this.code = ERROR_REGISTRY[code] ? code : 'internal';
    this.httpStatus = entry.httpStatus;
    this.status = entry.httpStatus; // alias so the existing handler's `err.status || 500` keeps working
    if (details !== undefined) this.details = details;
    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }
}

// Single serializer. Accepts an AppError, a code string, OR an unknown thrown Error.
// messageOverride lets a call site customize the human prose while keeping the code stable.
function formatEnvelope(codeOrErr, details, messageOverride) {
  let code, message, httpStatus, det;

  if (codeOrErr instanceof AppError) {
    ({ code, message, httpStatus, details: det } = codeOrErr);
    // allow a caller to attach/override details at format time
    if (details !== undefined) det = details;
  } else if (typeof codeOrErr === 'string') {
    const entry = ERROR_REGISTRY[codeOrErr] || ERROR_REGISTRY.internal;
    code = ERROR_REGISTRY[codeOrErr] ? codeOrErr : 'internal';
    httpStatus = entry.httpStatus;
    message = entry.message;
    det = details;
  } else {
    // Unknown thrown error reaching the global handler.
    // (a) registry-GATE the code: never leak an unregistered err.code (e.g. Sequelize '23505',
    //     Node 'ECONNREFUSED') verbatim onto the public wire envelope (ASVS V7 info-disclosure).
    code = (codeOrErr && ERROR_REGISTRY[codeOrErr.code]) ? codeOrErr.code : 'internal';
    // (b) PRESERVE a valid numeric err.httpStatus/err.status so body-parser 4xx (malformed JSON 400,
    //     payload-too-large 413) keep their status; fall back to 500 only when absent.
    httpStatus = (codeOrErr && (codeOrErr.httpStatus || codeOrErr.status)) || 500;
    // (c) always emit generic registry prose, never err.message/stack.
    message = ERROR_REGISTRY[code] ? ERROR_REGISTRY[code].message : ERROR_REGISTRY.internal.message;
    // (d) use ONLY the explicit details ARGUMENT — never fall back to codeOrErr.details.
    //     A thrown library/driver error can carry a `.details` property (e.g. validation
    //     internals, driver metadata); reflecting it would leak it onto the public envelope
    //     (ASVS V7 — code/message are already gated above, details must be too).
    det = details;
  }

  if (messageOverride) message = messageOverride;

  const body = { code, message };
  if (det !== undefined) body.details = det;
  // Top-level errors[] LEGACY ALIAS — the live FE (api.ts:148) reads top-level errors[] for
  // per-field form messages. Mirror it from details.errors for the 85->86 window only.
  if (det && Array.isArray(det.errors)) body.errors = det.errors;
  body.error = message; // LEGACY ALIAS (= message) — removed end of Phase 86

  return { httpStatus, body };
}

function sendError(res, code, details, messageOverride) {
  const { httpStatus, body } = formatEnvelope(code, details, messageOverride);
  return res.status(httpStatus).json(body);
}

module.exports = { AppError, ERROR_REGISTRY, formatEnvelope, sendError };
