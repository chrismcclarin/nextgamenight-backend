// tests/unit/errors.test.js
// Phase 85 / Plan 01: DB-FREE unit coverage for utils/errors.js (BAPI-01).
//
// Strategy: utils/errors.js is a pure module — no DB, no Redis, no network. These tests
// require it directly and assert the wire contract. They MUST stay DB-free: no model-layer
// import and no destructive schema rebuild (the 83.1 shared-DB hazard — RESEARCH Pitfall 4).
//
// Coverage:
//   1. Every registered code maps to its documented httpStatus (COMPLETE 10-code map, pinned)
//   2. formatEnvelope shape: { code, message, details?, error } with error === message,
//      and the top-level errors[] mirror when details.errors is present
//   3. AppError carries code/httpStatus/status/details; unknown code -> internal
//   4. Internal safety: formatEnvelope(new Error('leak me')) -> 500, generic prose, no leak
//   5. Unknown-Error branch registry-GATES the code ({code:'23505'} -> internal)
//   6. Unknown-Error branch PRESERVES a valid 4xx err.status ({status:400} -> 400)

const { AppError, ERROR_REGISTRY, formatEnvelope, sendError } = require('../../utils/errors');

// Complete expected code -> httpStatus map. Drives the registry-iteration assertion so a
// status drift OR an added/removed code fails the suite (the code->status contract is locked).
const EXPECTED_STATUS = {
  validation: 400,
  rate_limited: 429,
  unauthorized: 401,
  token_invalid: 400,
  not_found: 404,
  forbidden: 403,
  prompt_deadline_expired: 400,
  prompt_closed: 400,
  reminder_cooldown: 429,
  internal: 500,
};

describe('utils/errors — exports', () => {
  test('exports AppError, ERROR_REGISTRY, formatEnvelope, sendError', () => {
    expect(typeof AppError).toBe('function');
    expect(typeof ERROR_REGISTRY).toBe('object');
    expect(typeof formatEnvelope).toBe('function');
    expect(typeof sendError).toBe('function');
  });

  test('ERROR_REGISTRY is frozen (tamper-proof contract)', () => {
    expect(Object.isFrozen(ERROR_REGISTRY)).toBe(true);
  });
});

describe('ERROR_REGISTRY — code -> httpStatus contract (every registered code)', () => {
  test('registry key set exactly equals the expected code set (no code added/removed unnoticed)', () => {
    expect(Object.keys(ERROR_REGISTRY).sort()).toEqual(Object.keys(EXPECTED_STATUS).sort());
  });

  // Iterate the COMPLETE expected map so not_found 404 and forbidden 403 are PINNED, not just
  // generically numeric (SPEC 85-SPEC.md:91 'every registered code'). Changing any status fails.
  test.each(Object.entries(EXPECTED_STATUS))(
    'code "%s" maps to httpStatus %i and has a non-empty string message',
    (code, expectedStatus) => {
      const entry = ERROR_REGISTRY[code];
      expect(entry).toBeDefined();
      expect(entry.httpStatus).toBe(expectedStatus);
      expect(typeof entry.message).toBe('string');
      expect(entry.message.length).toBeGreaterThan(0);
    }
  );
});

describe('formatEnvelope — envelope shape + aliases', () => {
  test('returns { code, message, error } with error === message and no details when none passed', () => {
    const { httpStatus, body } = formatEnvelope('internal');
    expect(httpStatus).toBe(500);
    expect(body.code).toBe('internal');
    expect(body.message).toBe(ERROR_REGISTRY.internal.message);
    expect(body.error).toBe(body.message); // legacy alias
    expect(body).not.toHaveProperty('details');
  });

  test('includes details only when passed', () => {
    const { body } = formatEnvelope('token_invalid', { action: 'request_new' });
    expect(body.details).toEqual({ action: 'request_new' });
    expect(body.code).toBe('token_invalid');
  });

  test('mirrors details.errors to a top-level errors[] legacy alias for the live FE', () => {
    const fieldErrors = [{ field: 'x', message: 'y' }];
    const { httpStatus, body } = formatEnvelope('validation', { errors: fieldErrors });
    expect(httpStatus).toBe(400);
    expect(body.details.errors).toEqual(fieldErrors);
    expect(body.errors).toEqual(body.details.errors); // top-level mirror present
  });

  test('messageOverride customizes prose while keeping the code stable', () => {
    const { body } = formatEnvelope('rate_limited', undefined, 'Too many auth attempts.');
    expect(body.code).toBe('rate_limited');
    expect(body.message).toBe('Too many auth attempts.');
    expect(body.error).toBe('Too many auth attempts.');
  });

  test('unknown code string falls back to internal', () => {
    const { httpStatus, body } = formatEnvelope('NOT_A_REAL_CODE');
    expect(httpStatus).toBe(500);
    expect(body.code).toBe('internal');
  });
});

describe('AppError', () => {
  test('carries code, httpStatus, status, and details', () => {
    const err = new AppError('forbidden', { reason: 'not owner' });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('forbidden');
    expect(err.httpStatus).toBe(403);
    expect(err.status).toBe(403); // alias for the existing handler's `err.status || 500`
    expect(err.details).toEqual({ reason: 'not owner' });
    expect(err.message).toBe(ERROR_REGISTRY.forbidden.message);
  });

  test('omits details when none provided', () => {
    const err = new AppError('not_found');
    expect(err).not.toHaveProperty('details');
  });

  test('unknown code -> internal (code and httpStatus)', () => {
    const err = new AppError('NOT_A_REAL_CODE');
    expect(err.code).toBe('internal');
    expect(err.httpStatus).toBe(500);
    expect(err.status).toBe(500);
  });

  test('an AppError passed to formatEnvelope serializes its own code/status/details', () => {
    const err = new AppError('prompt_closed', { promptId: 7 });
    const { httpStatus, body } = formatEnvelope(err);
    expect(httpStatus).toBe(400);
    expect(body.code).toBe('prompt_closed');
    expect(body.details).toEqual({ promptId: 7 });
    expect(body.error).toBe(body.message);
  });
});

describe('formatEnvelope — internal safety + unknown-Error branch (ASVS V7)', () => {
  test('a raw Error -> 500 with generic prose, never leaks err.message', () => {
    const { httpStatus, body } = formatEnvelope(new Error('secret db detail leak me'));
    expect(httpStatus).toBe(500);
    expect(body.code).toBe('internal');
    expect(body.message).toBe(ERROR_REGISTRY.internal.message);
    expect(body.message).not.toMatch(/secret|leak me/i);
    expect(body.error).toBe(body.message);
  });

  test('registry-GATES an unregistered err.code (Sequelize 23505 never reaches the wire)', () => {
    const { body } = formatEnvelope({ code: '23505', status: 500, message: 'duplicate key' });
    expect(body.code).toBe('internal');
    expect(body.message).not.toMatch(/duplicate/i);
  });

  test('PRESERVES a valid 4xx err.status (body-parser malformed-JSON 400 not regressed to 500)', () => {
    const { httpStatus, body } = formatEnvelope(Object.assign(new Error('bad json'), { status: 400 }));
    expect(httpStatus).toBe(400);
    expect(body.code).toBe('internal'); // unregistered code still gated, but status preserved
  });

  test('PRESERVES a valid err.httpStatus (e.g. payload-too-large 413)', () => {
    const { httpStatus } = formatEnvelope(Object.assign(new Error('too big'), { httpStatus: 413 }));
    expect(httpStatus).toBe(413);
  });

  test('does NOT reflect a thrown err.details onto the public envelope (ASVS V7)', () => {
    const { body } = formatEnvelope(Object.assign(new Error('x'), { details: { secret: 1 } }));
    // The unknown-Error branch uses ONLY the explicit details argument (absent here),
    // so raw err.details must not surface on the wire.
    expect(body.details).toBeUndefined();
  });
});

describe('sendError', () => {
  test('calls res.status(httpStatus).json(body)', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const res = { status };
    sendError(res, 'unauthorized');
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'unauthorized', message: ERROR_REGISTRY.unauthorized.message, error: ERROR_REGISTRY.unauthorized.message })
    );
  });
});
