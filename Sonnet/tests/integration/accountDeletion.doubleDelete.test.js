// tests/integration/accountDeletion.doubleDelete.test.js
// Phase 88.8 / Plan 07 (SPEC R8, D-21) — the concurrent double delete, on real Postgres.
//
// WHY THIS FILE EXISTS AT ALL: a model-mocked route test cannot raise a genuine unique
// violation, so it can only ever assert that the catch arm maps a HAND-BUILT error. Only
// a real database can prove that two overlapping DELETE /users/me requests for one sub
// actually collide on the marker's unique index and that the loser comes out as an honest
// 410 rather than a 500. The unit-level arm is pinned separately in
// tests/services/accountDeletionService.test.js ("concurrent double delete (R8)").
//
// Closes the todo 2026-07-09-double-delete-users-me-race-500-not-410.md.
//
// RUN LOCATION: this path IS in the default `npm test` run. jest.config.js ignores exactly
// one file under tests/integration/ (queues.integration.test.js, the real-Redis ring), not
// the directory — verified by reading jest.config.js testPathIgnorePatterns, and by the
// same reasoning recorded there for tests/integration/accountDeletion.integrity.test.js.
// So this file inherits globalSetup's schema build and setup.js's per-test TRUNCATE.
//
// RUN ALONE when investigating (shared test-DB force-sync gotcha):
//   npm test -- tests/integration/accountDeletion.doubleDelete.test.js
//
// External boundaries are mocked (Google, Auth0 Management, Resend, the Redis queue) —
// the DATABASE is real, which is the entire point. Same shape as the 87.2 integrity test.

const mockDeleteCalEvent = jest.fn().mockResolvedValue({ deleted: true });
const mockDeleteHolds = jest.fn().mockResolvedValue({ deleted: 0, failed: 0 });
const mockRevoke = jest.fn().mockResolvedValue({ revoked: true });
const mockDeleteUser = jest.fn().mockResolvedValue({ deleted: true });
const mockEmailSend = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../services/googleCalendarService', () => ({
  deleteCalendarEventForUser: (...a) => mockDeleteCalEvent(...a),
  deleteTentativeHolds: (...a) => mockDeleteHolds(...a),
  revokeGoogleAccess: (...a) => mockRevoke(...a),
}));
jest.mock('../../services/auth0Service', () => ({
  deleteUser: (...a) => mockDeleteUser(...a),
  // routes/users.js -> provisioningService reaches for these on the JIT path; this suite
  // never exercises it, but the module must still shape-match its real export surface.
  getUserById: jest.fn().mockResolvedValue(null),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(),
}));
jest.mock('../../services/emailService', () => ({
  send: (...a) => mockEmailSend(...a),
}));
jest.mock('../../services/smsService', () => ({ send: jest.fn() }));
// Manual mock at queues/__mocks__/index.js — keeps Redis out of the default run.
jest.mock('../../queues');

const request = require('supertest');
const express = require('express');

const { User, PendingAuth0Deletion } = require('../../models');
const { makeUser } = require('../factories');
const { stubAuth } = require('../helpers/authStub');
const userRoutes = require('../../routes/users');

function makeApp(sub) {
  const app = express();
  app.use(express.json());
  app.use(stubAuth({ user_id: sub, email: `${sub}@example.com` }));
  app.use('/api/users', userRoutes);
  return app;
}

describe('DELETE /api/users/me — concurrent double delete on real Postgres (R8)', () => {
  test('two overlapping deletes yield exactly one 200 and one 410, one tombstone, no Users row', async () => {
    const user = await makeUser();
    const sub = user.user_id;
    const app = makeApp(sub);

    // Fire BOTH without awaiting the first — that overlap is the whole test. Both
    // requests load the (still present) Users row, both open a deletion transaction, and
    // both reach the marker INSERT; Postgres' unique index on auth0_sub decides the
    // winner. `allSettled` (not `all`) so a rejection is reported rather than masking the
    // other request's result.
    const settled = await Promise.allSettled([
      request(app).delete('/api/users/me'),
      request(app).delete('/api/users/me'),
    ]);

    // --- ANTI-VACUITY GUARD -------------------------------------------------------
    // A test that silently observed one request, or that saw a transport-level failure
    // instead of an HTTP response, would prove nothing. Assert BOTH requests actually
    // completed WITH a status before asserting anything about which statuses they were.
    expect(settled).toHaveLength(2);
    const rejected = settled.filter((s) => s.status === 'rejected');
    expect(rejected.map((r) => String(r.reason))).toEqual([]);
    const statuses = settled.map((s) => s.value.status);
    expect(statuses.every((c) => typeof c === 'number')).toBe(true);
    // ------------------------------------------------------------------------------

    // Exactly one 200 and one 410, in EITHER order (the winner is whichever request the
    // database picked; the test must not depend on scheduling).
    expect(statuses.slice().sort((a, b) => a - b)).toEqual([200, 410]);

    // The loser never returns 500 — that is the defect this closes.
    expect(statuses).not.toContain(500);

    const loser = settled.find((s) => s.value.status === 410).value;
    expect(loser.body.code).toBe('account_deleted');
    expect(loser.body).toHaveProperty('message');

    const winner = settled.find((s) => s.value.status === 200).value;
    expect(winner.body).toHaveProperty('message');

    // Exactly ONE durable tombstone for the sub — the unique constraint is what
    // guarantees this, and asserting it is what proves the constraint was actually
    // exercised rather than the second request having merely arrived after the first
    // finished cleanly.
    const markers = await PendingAuth0Deletion.findAll({ where: { auth0_sub: sub } });
    expect(markers).toHaveLength(1);

    // The account is gone.
    const survivor = await User.findOne({ where: { user_id: sub } });
    expect(survivor).toBeNull();
  });

  test('a repeat DELETE after a completed deletion still returns 410 (the backstop path)', async () => {
    const user = await makeUser();
    const sub = user.user_id;
    const app = makeApp(sub);

    const first = await request(app).delete('/api/users/me');
    expect(first.status).toBe(200);

    // Sequential, not overlapping: the row is gone and the tombstone exists, so this goes
    // through classifyMissingRow rather than the marker race. Both routes to 410 are
    // covered by this file, and they must agree.
    const second = await request(app).delete('/api/users/me');
    expect(second.status).toBe(410);
    expect(second.body.code).toBe('account_deleted');

    // Still exactly one tombstone — a repeat delete must not mint a second marker.
    const markers = await PendingAuth0Deletion.findAll({ where: { auth0_sub: sub } });
    expect(markers).toHaveLength(1);
  });

  test('a sub that never had a Users row and no tombstone gets 404 not_provisioned, not 410 (R7)', async () => {
    // No seeding at all — this caller's token is valid but nothing was ever provisioned.
    const app = makeApp('auth0|never-provisioned-integration');

    const res = await request(app).delete('/api/users/me');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_provisioned');
    // The user is NOT told their account was deleted.
    expect(res.body.code).not.toBe('account_deleted');
    // And nothing was created as a side effect of asking.
    const markers = await PendingAuth0Deletion.findAll({
      where: { auth0_sub: 'auth0|never-provisioned-integration' },
    });
    expect(markers).toHaveLength(0);
  });
});
