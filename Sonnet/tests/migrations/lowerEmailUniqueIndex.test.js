// tests/migrations/lowerEmailUniqueIndex.test.js
//
// Phase 88.8 — behavioural pin for the `users_email_lower_unique` index added by
// migrations/20260902000007-add-lower-email-unique-index-to-users.js (owner
// ruling 2026-09-04).
//
// tests/migrations/columnMirror.test.js proves the index EXISTS. This file proves
// it BITES, and — more importantly — pins the exact SHAPE of the error it raises,
// because that shape is a cross-plan contract:
//
//   CONTEXT D-15 specifies that plan 04's collision-aware repair discriminates a
//   unique violation with `err.fields?.email || err.parent?.constraint ===
//   'Users_email_key'`. NEITHER discriminator matches this index (measured, see
//   the assertions below): the constraint name is `users_email_lower_unique`, and
//   `err.fields` is keyed on the EXPRESSION `lower(email::text)`, so
//   `err.fields.email` is undefined. A case-variant collision therefore falls
//   through D-15's guard as written. Whoever implements plan 04 must widen it.
//   If this test goes red because the error shape changed, that guard has to change
//   with it — that is the whole reason the shape is asserted rather than described.
//
// Replays NO migration (the CLAUDE.md rekey lesson: a migration-replaying test that
// does not restore the CURRENT schema in afterAll poisons every suite after it).
// It only writes ROWS, which tests/setup.js truncates in beforeEach.

const { User } = require('../../models');

describe('users_email_lower_unique — case-insensitive uniqueness on Users.email', () => {
  it('rejects a second row whose address differs only by case', async () => {
    await User.create({
      user_id: 'auth0|lower-email-probe-1',
      username: 'probe-one',
      email: 'Probe.Case@example.com',
    });

    await expect(
      User.create({
        user_id: 'auth0|lower-email-probe-2',
        username: 'probe-two',
        email: 'probe.case@example.com',
      })
    ).rejects.toThrow();
  });

  it('still allows two genuinely different addresses', async () => {
    await User.create({
      user_id: 'auth0|lower-email-probe-3',
      username: 'probe-three',
      email: 'one@example.com',
    });
    await expect(
      User.create({
        user_id: 'auth0|lower-email-probe-4',
        username: 'probe-four',
        email: 'two@example.com',
      })
    ).resolves.toBeDefined();
  });

  it('raises the error SHAPE plan 04 (D-15) must discriminate on', async () => {
    await User.create({
      user_id: 'auth0|lower-email-probe-5',
      username: 'probe-five',
      email: 'Shape@example.com',
    });

    let err = null;
    try {
      await User.create({
        user_id: 'auth0|lower-email-probe-6',
        username: 'probe-six',
        email: 'shape@example.com',
      });
    } catch (e) {
      err = e;
    }

    expect(err).not.toBeNull();

    // (1) The generic `error.name` discriminator DOES match. This is what
    //     routes/groups.js:839 uses, which is why the group-join provisioning
    //     path already degrades gracefully to its synthetic-email retry.
    expect(err.name).toBe('SequelizeUniqueConstraintError');

    // (2) The constraint name is NOT `Users_email_key`. D-15's second
    //     discriminator does not match this index.
    expect(err.parent.constraint).toBe('users_email_lower_unique');
    expect(err.parent.constraint).not.toBe('Users_email_key');

    // (3) `err.fields` is keyed on the INDEX EXPRESSION, not on the column, so
    //     D-15's first discriminator (`err.fields?.email`) is undefined here.
    //     Asserted as a measured fact so plan 04 cannot rely on it by accident.
    expect(err.fields.email).toBeUndefined();
    expect(Object.keys(err.fields).join(',')).toContain('lower');
  });
});
