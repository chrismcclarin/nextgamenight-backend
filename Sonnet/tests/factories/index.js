// tests/factories/index.js
//
// Central fixture factory for User / Group / UserGroup (BTEST-03, D-04).
//
// WHY THIS EXISTS:
//   UserGroup.user_id is the Auth0 STRING (models/User.js:20-24, models/UserGroup.js:12-13),
//   and the User<->UserGroup association joins on it via `sourceKey: 'user_id'`
//   (models/index.js). The recurring fixture bug across the route suites was seeding
//   `UserGroup.create({ user_id: testUser.id })` — passing the UUID `User.id` into a
//   STRING column. The join then silently returns empty, producing 403/404/empty-array
//   false failures (groups.test.js even mixed correct/buggy on adjacent lines).
//
//   This factory reads `user.user_id` internally, so the UUID `.id` is UNREACHABLE as a
//   join key — callers physically cannot reintroduce the bug. It mirrors the
//   `{ user_id: <string> }` contract established in tests/helpers/authStub.js.
//
// SCOPE: seeding only. Assertion-side lookups (findOne/destroy where { user_id })
//   are corrected per-suite to use `.user_id` for UserGroup — the factory does not
//   cover reads.

const { User, Group, UserGroup } = require('../../models');

// Module-scoped monotonic counter so each call is unique within a run.
let seq = 0;

/**
 * Create a User with the Auth0 STRING user_id (the correct join key).
 * @param {object} overrides - spread last; can override user_id/username/email/etc.
 * @returns {Promise<User>}
 */
async function makeUser(overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return User.create({
    user_id: `auth0|test-${ts}-${n}`, // Auth0 STRING — the correct join key
    username: `user-${ts}-${n}`,
    email: `user-${ts}-${n}@example.com`,
    ...overrides,
  });
}

/**
 * Create a Group with a unique group_id handle + name.
 * @param {object} overrides - spread last.
 * @returns {Promise<Group>}
 */
async function makeGroup(overrides = {}) {
  const n = ++seq;
  const ts = Date.now();
  return Group.create({
    group_id: `group-${ts}-${n}`,
    name: `Group ${ts}-${n}`,
    ...overrides,
  });
}

/**
 * Seed a UserGroup membership row using the Auth0 STRING user_id.
 * Reads user.user_id, NEVER user.id, so the UUID bug is unreachable.
 * @param {User} user
 * @param {Group} group
 * @param {('pending'|'member'|'admin'|'owner')} [role='member']
 * @returns {Promise<UserGroup>}
 */
async function addToGroup(user, group, role = 'member') {
  return UserGroup.create({ user_id: user.user_id, group_id: group.id, role });
}

module.exports = { makeUser, makeGroup, addToGroup };
