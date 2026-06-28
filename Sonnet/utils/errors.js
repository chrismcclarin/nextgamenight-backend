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
  not_found:               { httpStatus: 404, message: 'Resource not found' },
  forbidden:               { httpStatus: 403, message: 'You do not have permission to perform this action' },
  prompt_deadline_expired: { httpStatus: 400, message: 'The deadline for this availability prompt has passed.' },
  prompt_closed:           { httpStatus: 400, message: 'This availability prompt is no longer accepting responses.' },
  reminder_cooldown:       { httpStatus: 429, message: 'A reminder was sent too recently. Please wait before retrying.' }, // 429 verified at routes/availabilityPrompt.js:179
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
    det = details !== undefined ? details : (codeOrErr && codeOrErr.details);
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
