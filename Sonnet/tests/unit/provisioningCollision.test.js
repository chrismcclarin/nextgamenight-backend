// tests/unit/provisioningCollision.test.js
// Phase 88.8 plan 05 Task 1 (BOPS-05 / SPEC R5, CONTEXT D-15) — the collision
// discriminator, in isolation.
//
// PURE UNIT: no database, no network, no Sentry. It requires
// services/provisioningService.js (which requires ../models, constructing a Sequelize
// instance lazily) but never issues a query, so it is green under BOTH
// `npm run test:unit` (jest.unit.config.js, no Postgres) and `npm test -- <this file>`.
//
// WHY A HAND-BUILT ERROR IS CORRECT *HERE*, and only here.
// The brief for this plan is emphatic that a collision test must drive a REAL collision
// through the call shape production uses, because a hand-built error encodes the very
// assumption under test. That rule is honoured — and the real-collision proof lives in
// `tests/services/provisioningService.test.js` ("THE SHAPE MATRIX, measured not
// assumed"), which drives all five reachable shapes (findOrCreate / create /
// instance.update x both constraints) against real Postgres and asserts the predicate on
// every one. THIS file covers the one shape a real call CANNOT produce on demand: the
// no-DETAIL fallback, where Postgres returned a 23505 whose DETAIL line did not parse, so
// `fields` is empty and the constraint NAME is the only evidence left. Sequelize's own
// source is the proof that this shape exists:
// node_modules/sequelize/lib/dialects/postgres/query.js `formatError`, case '23505' —
// the second `return` (no `fields` key) is taken whenever `errDetail` is absent or does
// not match /Key \((.*?)\)=\((.*?)\)/.
//
// CORRECTION TO THE PLAN TEXT, measured 2026-09-04 against the installed source: the plan
// describes that shape as "NO `fields` key at all". It is actually an EMPTY `fields`
// OBJECT — `UniqueConstraintError`'s constructor does `this.fields = options.fields ?? {}`
// (node_modules/sequelize/lib/errors/validation/unique-constraint-error.js). Both are
// asserted below: `{}` because it is what really happens, and a deleted key because a
// predicate that survives one and not the other is fragile in a catch block.

const {
  isEmailCollision,
  EMAIL_UNIQUE_CONSTRAINTS,
} = require('../../services/provisioningService');

const { UniqueConstraintError } = require('sequelize');

// Build the error the way sequelize's formatError builds it, then adjust the one axis
// under test. `parent` mirrors the wire shape: a pg error carrying `code` + `constraint`.
function uniqueError({ constraint, fields, detail }) {
  const err = new UniqueConstraintError({
    message: 'Validation error',
    parent: {
      name: 'error',
      message: 'duplicate key value violates unique constraint',
      sql: 'INSERT INTO "Users" ...',
      code: '23505',
      ...(constraint !== undefined ? { constraint } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
    ...(fields !== undefined ? { fields } : {}),
  });
  return err;
}

describe('isEmailCollision — the constraint-NAME arm (the no-DETAIL fallback)', () => {
  it('recognises Users_email_key when fields is EMPTY (the real no-DETAIL shape)', () => {
    const err = uniqueError({ constraint: 'Users_email_key', fields: {} });
    expect(Object.keys(err.fields)).toHaveLength(0);
    expect(isEmailCollision(err)).toBe(true);
  });

  it('recognises users_email_lower_unique when fields is EMPTY', () => {
    const err = uniqueError({ constraint: 'users_email_lower_unique', fields: {} });
    expect(isEmailCollision(err)).toBe(true);
  });

  it('recognises the constraint name when the fields KEY is absent entirely', () => {
    // Defensive: a catch block must not depend on `fields` being present at all.
    const err = uniqueError({ constraint: 'Users_email_key', fields: {} });
    delete err.fields;
    expect('fields' in err).toBe(false);
    expect(isEmailCollision(err)).toBe(true);
  });
});

describe('isEmailCollision — the field-KEY arm (the findOrCreate shape)', () => {
  it('recognises a fields object keyed `email` with NO parent.constraint', () => {
    const err = uniqueError({ fields: { email: 'taken@example.com' }, detail: 'Key (email)=(taken@example.com) already exists.' });
    expect(err.parent.constraint).toBeUndefined();
    expect(isEmailCollision(err)).toBe(true);
  });

  it('recognises the lower-index expression key with NO parent.constraint', () => {
    // This is the shape EVERY provisioning writer produces: findOrCreate sets
    // options.exception, so the rebuilt parent carries code + detail and no constraint,
    // and the lower index spells its key `lower(email::text)` — `err.fields.email` is
    // undefined, which is the trap D-15's original one-name predicate fell into.
    const err = uniqueError({ fields: { 'lower(email::text)': 'taken@example.com' } });
    expect(err.parent.constraint).toBeUndefined();
    expect(err.fields.email).toBeUndefined();
    expect(isEmailCollision(err)).toBe(true);
  });

  it('recognises a whitespace/case variant of the index-expression key', () => {
    expect(isEmailCollision(uniqueError({ fields: { 'LOWER(email::text)': 'x' } }))).toBe(true);
    expect(isEmailCollision(uniqueError({ fields: { 'lower( email::text )': 'x' } }))).toBe(true);
  });
});

describe('isEmailCollision — negative space', () => {
  it('rejects a violation of a DIFFERENT constraint (a user_id violation)', () => {
    const err = uniqueError({
      constraint: 'Users_user_id_key',
      fields: { user_id: 'auth0|abc' },
    });
    expect(isEmailCollision(err)).toBe(false);
  });

  it('rejects a different constraint whose fields are EMPTY (neither arm may fire)', () => {
    expect(isEmailCollision(uniqueError({ constraint: 'Users_username_key', fields: {} }))).toBe(false);
  });

  it('rejects a plain Error, and null/undefined, without throwing', () => {
    expect(isEmailCollision(new Error('nope'))).toBe(false);
    expect(isEmailCollision(null)).toBe(false);
    expect(isEmailCollision(undefined)).toBe(false);
    expect(isEmailCollision({})).toBe(false);
    expect(isEmailCollision('SequelizeUniqueConstraintError')).toBe(false);
  });

  it('never throws on an error object carrying neither parent nor fields', () => {
    const bare = new Error('half-built');
    bare.name = 'SequelizeUniqueConstraintError';
    expect(() => isEmailCollision(bare)).not.toThrow();
    expect(isEmailCollision(bare)).toBe(false);
  });

  it('rejects a non-string constraint and a non-object fields bag without throwing', () => {
    const weird = new Error('weird');
    weird.name = 'SequelizeUniqueConstraintError';
    weird.parent = { constraint: 42 };
    weird.fields = 'not-an-object';
    expect(() => isEmailCollision(weird)).not.toThrow();
    expect(isEmailCollision(weird)).toBe(false);
  });
});

describe('EMAIL_UNIQUE_CONSTRAINTS — the SET, not a single name', () => {
  it('holds BOTH email unique constraints and is frozen', () => {
    // Both, because plan 02 added users_email_lower_unique on an owner ruling of
    // 2026-09-04 and CONTEXT D-15's one-name predicate predates it.
    expect(EMAIL_UNIQUE_CONSTRAINTS).toEqual(['Users_email_key', 'users_email_lower_unique']);
    expect(Object.isFrozen(EMAIL_UNIQUE_CONSTRAINTS)).toBe(true);
  });
});
