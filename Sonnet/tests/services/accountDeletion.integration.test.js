// tests/services/accountDeletion.integration.test.js
//
// Phase 88.2 Plan 08 Task 4 — the REAL-DATABASE pin for T-88.2-09, inherited from
// plan 03 by owner decision 2026-07-27.
//
// RUN ALONE (the backend's full Jest run has never been green):
//   npm test -- tests/services/accountDeletion.integration.test.js --forceExit
//
// ================================================================================
// THE THREAT
// ================================================================================
//
// services/accountDeletionService.js hard-deletes a SOLE-OWNED group with a forced
// destroy. Group became paranoid in plan 88.2-01, so if that flag were ever dropped
// the group would be SOFT-deleted with a NULL `purge_after` — nothing on the
// account-deletion path stamps one. Such a row is:
//
//   - invisible to getDeletionBlockers (which reads through the paranoid clause),
//   - permanently uncollectable by the plan-08 purge sweep, whose candidate query
//     requires a NON-NULL deadline strictly in the past (T-88.2-44),
//
// so it sits there forever holding invitee email PII with no path to removal. Plan
// 03 landed the forced destroy and its permanent DECISION marker, but could pin it
// only at CALL-OPTIONS grain: an assertion that the service ASKED for a hard delete
// is not an assertion that the database PERFORMED one.
//
// This suite reads the database instead. Every group-row assertion below uses
// `paranoid: false`; a default-scoped read cannot tell a hard delete from a soft one
// and is the exact blind spot this file exists to close.
//
// FOUND WHILE WRITING THIS (reported in 88.2-08-SUMMARY.md): plan 03's summary and
// this plan's task text both say no real-DB test of deleteAccount exists anywhere.
// That is FALSE — tests/integration/accountDeletion.integrity.test.js (Phase 87.2
// Plan 06) is a real-Postgres deleteAccount test. But it contains ZERO
// paranoid-escaping reads: its sole-owned-group assertion is a default-scoped
// findByPk, which since plan 88.2-01 CANNOT distinguish a hard delete from a soft
// one. So the gap is real; only its description was wrong.
//
// ================================================================================
// ENVIRONMENT CAVEAT — same discipline as tests/services/groupPurgeSweep.test.js
// ================================================================================
//
// The invite-row assertion below cannot distinguish a correct explicit delete from a
// database that cascades on its own. 88.2-CASCADE-AUDIT.md section 4 measured the
// constraint PRESENT in the sync-built CI database and ABSENT in the migration-built
// one. The real control for that delete is the CI workflow step
//
//     "Grep gate — purge sweep must delete GroupInvite + SingleUseToken explicitly
//      (88.2 / SPEC-REQ-10)"
//
// The beforeAll below probes pg_constraint and warns loudly next to the assertion.

// ---------------------------------------------------------------------------
// External-boundary mocks ONLY. No model is mocked and neither is sequelize.
// The live require graph of services/accountDeletionService.js was read at write
// time: googleCalendarService, auth0Service and emailService are its three external
// requires, and the BullMQ queue is lazy-required inside the Auth0-failure enqueue
// path (never at module top) — mocked here anyway so Redis can never be touched.
// ---------------------------------------------------------------------------
const mockDeleteCalEvent = jest.fn().mockResolvedValue({ deleted: true });
const mockDeleteHolds = jest.fn().mockResolvedValue({ deleted: 0, failed: 0 });
const mockRevoke = jest.fn().mockResolvedValue({ revoked: true });
const mockAuth0DeleteUser = jest.fn().mockResolvedValue({ deleted: true });
const mockEmailSend = jest.fn().mockResolvedValue({ success: true });

jest.mock('../../services/googleCalendarService', () => ({
  deleteCalendarEventForUser: (...a) => mockDeleteCalEvent(...a),
  deleteTentativeHolds: (...a) => mockDeleteHolds(...a),
  revokeGoogleAccess: (...a) => mockRevoke(...a),
}));
jest.mock('../../services/auth0Service', () => ({
  deleteUser: (...a) => mockAuth0DeleteUser(...a),
}));
jest.mock('../../services/emailService', () => ({
  send: (...a) => mockEmailSend(...a),
}));
jest.mock('../../queues');

const { Op } = require('sequelize');
const {
  Group,
  UserGroup,
  Event,
  EventParticipation,
  GameReview,
  GroupInvite,
  Game,
  sequelize,
} = require('../../models');
const { deleteAccount } = require('../../services/accountDeletionService');
const { makeUser, makeGroup, addToGroup, makeGroupInvite } = require('../factories');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Seed a group populated with the rows an account deletion has to take with it.
 *
 * @param {Object} roles - { owner: User, members?: User[] }
 * @param {User} participant - the user whose participation/review rows are seeded
 */
async function seedGroup({ owner, members = [] }, participant = owner) {
  const group = await makeGroup();
  await addToGroup(owner, group, 'owner');
  for (const m of members) {
    await addToGroup(m, group, 'member');
  }

  const game = await Game.create({ name: `Game ${Date.now()}-${Math.random()}` });
  const event = await Event.create({
    group_id: group.id,
    game_id: game.id,
    start_date: new Date(Date.now() + 7 * DAY_MS),
  });
  await EventParticipation.create({ event_id: event.id, user_id: participant.id });
  await GameReview.create({
    user_id: participant.id,
    group_id: group.id,
    game_id: game.id,
    rating: 4.0,
  });
  await makeGroupInvite(group, owner);

  return { group, game, event };
}

/** Budget overrides — the external lanes are all mocked, so keep them short. */
const FAST_BUDGETS = { budgets: { googleMs: 500, auth0Ms: 500, emailMs: 500 } };

/**
 * The permanent-orphan predicate, as a query. A soft-deleted group carrying no purge
 * deadline can never be collected by the plan-08 sweep (its candidate query requires
 * a NON-NULL deadline in the past, T-88.2-44) and never surfaces to
 * getDeletionBlockers. Written as the shape of the orphan, not as a row count, so it
 * keeps stating the invariant when the surrounding fixtures change.
 */
function findPermanentOrphans(scopeIds) {
  return Group.findAll({
    where: {
      ...(scopeIds ? { id: { [Op.in]: scopeIds } } : {}),
      deletedAt: { [Op.ne]: null },
      purge_after: null,
    },
    paranoid: false,
  });
}

let inviteFkCascades = false;

beforeAll(async () => {
  const rows = await sequelize.query(
    `SELECT conrelid::regclass::text AS child, confdeltype
       FROM pg_constraint
      WHERE contype='f' AND confrelid='"Groups"'::regclass`,
    { type: sequelize.QueryTypes.SELECT }
  );
  inviteFkCascades = rows.some((r) => String(r.child).includes('GroupInvites'));
  if (inviteFkCascades) {
    console.warn(
      [
        '',
        '*** [accountDeletion.integration.test] ENVIRONMENT CAVEAT ***',
        'This database HAS a foreign key from GroupInvites to Groups and cascades those',
        'rows away BY ITSELF, so the invite assertion below passes whether or not the',
        'deletion path removes them explicitly. The real control is the CI workflow step',
        '  "Grep gate - purge sweep must delete GroupInvite + SingleUseToken explicitly',
        '   (88.2 / SPEC-REQ-10)".',
        'The GROUP-ROW assertions in this file are NOT affected by that caveat: nothing',
        'cascades a Groups row away, so they measure the deletion path directly.',
        '',
      ].join('\n')
    );
  }
});

describe('deleteAccount against the real database (T-88.2-09)', () => {
  it('T-88.2-09 core: a sole-owned group is HARD-deleted, not soft-deleted', async () => {
    const owner = await makeUser();
    const { group, event } = await seedGroup({ owner });

    // Seeded-THEN-gone, never merely gone: a green "all zero" below would prove
    // nothing if the fixtures never landed.
    expect(await Group.count({ where: { id: group.id }, paranoid: false })).toBe(1);
    expect(await Event.count({ where: { group_id: group.id }, paranoid: false })).toBe(1);
    expect(await UserGroup.count({ where: { group_id: group.id }, paranoid: false })).toBe(1);
    expect(await GroupInvite.count({ where: { group_id: group.id } })).toBe(1);
    expect(await EventParticipation.count({ where: { event_id: event.id } })).toBe(1);

    const result = await deleteAccount({ userId: owner.user_id }, FAST_BUDGETS);
    expect(result.status).toBe('deleted');

    // paranoid: false on EVERY group-family read. Without it these three assertions
    // pass against a soft delete and the whole test is theatre.
    expect(await Group.count({ where: { id: group.id }, paranoid: false })).toBe(0);
    expect(await Event.count({ where: { group_id: group.id }, paranoid: false })).toBe(0);
    expect(await UserGroup.count({ where: { group_id: group.id }, paranoid: false })).toBe(0);
    expect(await GroupInvite.count({ where: { group_id: group.id } })).toBe(0);
  });

  it('T-88.2-09 orphan shape: no group row is left soft-deleted with a NULL deadline', async () => {
    const target = await makeUser();
    const otherOwner = await makeUser();
    // A group the target SOLELY owns — the auto-delete target.
    const { group: solo } = await seedGroup({ owner: target });
    // A group the target is merely a MEMBER of — evaluated against a world that
    // contains a surviving group, not just an empty table. (Note it is NOT a
    // co-owned group: see the discrepancy note in the last case below.)
    const { group: shared } = await seedGroup({ owner: otherOwner, members: [target] }, target);

    const result = await deleteAccount({ userId: target.user_id }, FAST_BUDGETS);
    // Asserted, and load-bearing: a run that came back `blocked` would have deleted
    // nothing at all and the predicate below would pass VACUOUSLY.
    expect(result.status).toBe('deleted');
    expect(await Group.count({ where: { id: solo.id }, paranoid: false })).toBe(0);

    expect((await findPermanentOrphans([solo.id, shared.id])).map((g) => g.id)).toEqual([]);
    // And nothing anywhere else either — the per-test TRUNCATE means this whole
    // table is this test's own world.
    expect((await findPermanentOrphans(null)).map((g) => g.id)).toEqual([]);
  });

  it('a group the user is only a MEMBER of survives, live and intact', async () => {
    const target = await makeUser();
    const otherOwner = await makeUser();
    const { group, event } = await seedGroup({ owner: otherOwner, members: [target] }, target);

    expect(await UserGroup.count({ where: { group_id: group.id }, paranoid: false })).toBe(2);

    const result = await deleteAccount({ userId: target.user_id }, FAST_BUDGETS);
    expect(result.status).toBe('deleted');

    // The sole-owned auto-delete branch must not over-reach. Read PAST the paranoid
    // clause so a soft-deleted survivor cannot masquerade as a live one — a group
    // wrongly soft-deleted here would be the same permanent orphan T-88.2-09 names.
    const row = await Group.findByPk(group.id, { paranoid: false });
    expect(row).not.toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(row.purge_after).toBeNull();

    // Its contents survive; only the departing user's own rows go.
    expect(await Event.count({ where: { group_id: group.id }, paranoid: false })).toBe(1);
    expect(await GroupInvite.count({ where: { group_id: group.id } })).toBe(1);
    expect(await EventParticipation.count({ where: { event_id: event.id } })).toBe(0);
    const survivors = await UserGroup.findAll({ where: { group_id: group.id }, paranoid: false });
    expect(survivors.map((r) => r.user_uuid)).toEqual([otherOwner.id]);
  });

  it('a BLOCKED run soft-deletes nothing — no half-applied disposition', async () => {
    // PLAN-TEXT DISCREPANCY, reported rather than forced green (88.2-08-SUMMARY.md).
    // The plan's fourth case is "a group the user owns JOINTLY with another active
    // owner must survive the account deletion". That state is UNREACHABLE: an owned
    // group with >= 1 other UserGroup row of ANY status is a BLOCKER
    // (getDeletionBlockers), so the deletion never runs at all and there is no
    // sole-owned branch to over-reach. The property the plan wanted — the owned
    // group is still there afterwards — is asserted here on the path that actually
    // occurs, together with the half-applied-disposition check that matters more for
    // T-88.2-09: a blocked run must not leave a soft-deleted, deadline-less orphan.
    const target = await makeUser();
    const member = await makeUser();
    const { group } = await seedGroup({ owner: target, members: [member] });

    const result = await deleteAccount({ userId: target.user_id }, FAST_BUDGETS);
    expect(result.status).toBe('blocked');
    expect(result.groups.map((g) => g.id)).toEqual([group.id]);

    const row = await Group.findByPk(group.id, { paranoid: false });
    expect(row).not.toBeNull();
    expect(row.deletedAt).toBeNull();
    expect((await findPermanentOrphans(null)).map((g) => g.id)).toEqual([]);
  });
});
