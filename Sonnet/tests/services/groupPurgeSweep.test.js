// tests/services/groupPurgeSweep.test.js
//
// Phase 88.2 Plan 08 (SPEC-REQ-10, D-04, D-05) — the daily purge sweep, proven
// against the real database.
//
// RUN THIS SUITE ALONE. The backend's full Jest run has never been green (several
// files call sequelize.sync({ force... }) against the SHARED test Postgres and yank
// tables out from under their neighbours), and this suite additionally holds a real
// row lock in its concurrency case:
//
//     npm test -- tests/services/groupPurgeSweep.test.js
//
// ================================================================================
// THE INVITE ASSERTION IN THIS FILE IS NOT THE CONTROL. READ THIS BEFORE TRUSTING IT.
// ================================================================================
//
// The test database is built by sequelize.sync() (tests/globalSetup.js), and
// Sequelize's `belongsTo` puts ON DELETE CASCADE on every NOT NULL foreign key. So
// this database removes a purged group's invite rows BY ITSELF. The assertion below
// that zero invite rows survive therefore passes WHETHER OR NOT
// services/groupPurgeSweep.js contains the explicit delete — it cannot distinguish a
// correct purge from a database cascading on its own, and it is not the control.
//
// The real control is the CI workflow step named
//
//     "Grep gate — purge sweep must delete GroupInvite + SingleUseToken explicitly
//      (88.2 / SPEC-REQ-10)"
//
// in .github/workflows/ci.yml, self-tested by tests/routes/ci-grep-gate.fixture.test.js.
// If you delete the explicit delete from the sweep and everything here stays green,
// that is expected — go look at that gate. The assertion is kept anyway, because it
// still proves the rows are gone in the environment the sweep actually ran in; the
// beforeAll below prints a loud warning next to it saying which mechanism did it.
//
// The same reasoning applies to the restore-token rows, which have no foreign key at
// all by deliberate choice (plan 02's D-02 marker).

const { Op } = require('sequelize');
const {
  Group,
  UserGroup,
  Event,
  EventParticipation,
  EventRsvp,
  EventBring,
  EventBallotOption,
  EventBallotVote,
  EventAuditLog,
  SentNotification,
  GameReview,
  GroupInvite,
  SingleUseToken,
  Game,
  sequelize,
} = require('../../models');
const { runGroupPurgeSweep } = require('../../services/groupPurgeSweep');
const { softDeleteGroup } = require('../../services/groupRecoveryService');
const {
  makeUser,
  makeGroup,
  addToGroup,
  makeGroupInvite,
  makeEventRsvp,
  makeEventBring,
  makeEventBallotOption,
  makeEventBallotVote,
  makeSentNotification,
} = require('../factories');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Read a group ignoring the paranoid clause — the only honest way to tell a hard
 *  delete from a soft one. */
function findGroupRaw(groupId) {
  return Group.findByPk(groupId, { paranoid: false });
}

/** Stamp a group's deadline directly. `silent` keeps updatedAt untouched. */
function forceDeadline(groupId, when) {
  return Group.update(
    { purge_after: when },
    { where: { id: groupId }, paranoid: false, silent: true }
  );
}

/**
 * Seed a fully-populated, soft-deleted group whose deadline has passed.
 *
 * Every table SPEC-REQ-10 names gets at least one row, plus all five Event-scoped
 * children — including a ballot option carrying a vote, so the two-step
 * votes-before-options ordering in the sweep is actually exercised rather than
 * trivially satisfied by an empty option set.
 *
 * @param {Object} [opts]
 * @param {number} [opts.deadlineOffsetMs] - relative to now; negative = past.
 */
async function seedDoomedGroup({ deadlineOffsetMs = -DAY_MS } = {}) {
  const owner = await makeUser();
  const member = await makeUser();
  const group = await makeGroup();
  await addToGroup(owner, group, 'owner');
  await addToGroup(member, group, 'member');

  const game = await Game.create({ name: `Game ${Date.now()}-${Math.random()}` });

  const event = await Event.create({
    group_id: group.id,
    game_id: game.id,
    start_date: new Date(Date.now() + 7 * DAY_MS),
  });

  await EventParticipation.create({ event_id: event.id, user_id: owner.id });
  await makeEventRsvp(event, member);
  await makeEventBring(event, member, game);
  const option = await makeEventBallotOption(event, owner);
  await makeEventBallotVote(option, member);
  await makeSentNotification(event, member);
  await EventAuditLog.create({
    event_id: event.id,
    group_id: group.id,
    actor_user_id: owner.id,
    action: 'delete',
    was_after_start: false,
    was_within_15min_grace: false,
    suppressed_email: false,
    event_snapshot: { id: event.id, group_id: group.id, game_id: game.id },
  });

  await GameReview.create({
    user_id: member.id,
    group_id: group.id,
    game_id: game.id,
    rating: 4.0,
  });
  await makeGroupInvite(group, owner);

  // Go through the REAL soft-delete service so the restore token, the stamp and the
  // deadline are produced exactly as production produces them.
  await softDeleteGroup(group.id, { excludeUserUuid: owner.id });
  await forceDeadline(group.id, new Date(Date.now() + deadlineOffsetMs));

  return { owner, member, group, game, event, option };
}

/** Count every row the purge is responsible for, for one group. */
async function remainingCounts(groupId, eventId, optionId) {
  const eventScoped = { event_id: eventId };
  return {
    groups: await Group.count({ where: { id: groupId }, paranoid: false }),
    userGroups: await UserGroup.count({ where: { group_id: groupId }, paranoid: false }),
    events: await Event.count({ where: { group_id: groupId }, paranoid: false }),
    participations: await EventParticipation.count({ where: eventScoped }),
    rsvps: await EventRsvp.count({ where: eventScoped }),
    brings: await EventBring.count({ where: eventScoped }),
    ballotOptions: await EventBallotOption.count({ where: eventScoped }),
    ballotVotes: await EventBallotVote.count({ where: { option_id: optionId } }),
    sentNotifications: await SentNotification.count({ where: eventScoped }),
    auditLogs: await EventAuditLog.count({ where: { group_id: groupId } }),
    gameReviews: await GameReview.count({ where: { group_id: groupId } }),
    groupInvites: await GroupInvite.count({ where: { group_id: groupId } }),
    restoreTokens: await SingleUseToken.count({
      where: { group_id: groupId, purpose: 'group_restore' },
    }),
  };
}

/**
 * Poll for transactions actually BLOCKING on the Groups row lock — an observable
 * database condition, not a sleep. Same shape as the deterministic race tests plans
 * 06 and 07 established.
 */
async function waitForLockWaiters(n, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sequelize.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock'
           AND query ILIKE '%FOR UPDATE%'
           AND pid <> pg_backend_pid()`,
      { type: sequelize.QueryTypes.SELECT }
    );
    if (row && row.n >= n) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// ---------------------------------------------------------------------------
// MANDATORY ENVIRONMENT CAVEAT — see the file header.
// ---------------------------------------------------------------------------
let inviteFkCascades = false;

beforeAll(async () => {
  const rows = await sequelize.query(
    `SELECT conname, conrelid::regclass::text AS child, confdeltype
       FROM pg_constraint
      WHERE contype='f' AND confrelid='"Groups"'::regclass`,
    { type: sequelize.QueryTypes.SELECT }
  );
  inviteFkCascades = rows.some((r) => String(r.child).includes('GroupInvites'));
  if (inviteFkCascades) {
    console.warn(
      [
        '',
        '*** [groupPurgeSweep.test] ENVIRONMENT CAVEAT ***',
        'This database HAS a foreign key from GroupInvites to Groups and cascades those',
        'rows away BY ITSELF. Every assertion in this file about invite rows being gone',
        'therefore passes whether or not the purge sweep deletes them explicitly — it is',
        'NOT the control for SPEC-REQ-10s PII clause.',
        'The real control is the CI workflow step',
        '  "Grep gate - purge sweep must delete GroupInvite + SingleUseToken explicitly',
        '   (88.2 / SPEC-REQ-10)"',
        'in .github/workflows/ci.yml, self-tested by tests/routes/ci-grep-gate.fixture.test.js.',
        '',
      ].join('\n')
    );
  } else {
    console.warn(
      '[groupPurgeSweep.test] No GroupInvites->Groups foreign key in this database — the invite assertions below are exercising the explicit delete directly.'
    );
  }
});

describe('runGroupPurgeSweep (88.2 / SPEC-REQ-10)', () => {
  // ==========================================================================
  // SPEC-REQ-10a — one sweep removes a past-deadline group completely
  // ==========================================================================
  it('SPEC-REQ-10a: destroys a past-deadline group and every row hanging off it', async () => {
    const { group, event, option } = await seedDoomedGroup();

    // Pre-condition: every table the sweep is responsible for actually holds a row,
    // or a green "all zero" below would prove nothing at all.
    const before = await remainingCounts(group.id, event.id, option.id);
    const emptyBeforeTheRun = Object.entries(before)
      .filter(([, n]) => n < 1)
      .map(([table]) => table);
    expect(emptyBeforeTheRun).toEqual([]);

    const counters = await runGroupPurgeSweep();

    expect(counters.candidates).toBe(1);
    expect(counters.purged).toBe(1);
    expect(counters.errors).toBe(0);
    expect(counters.skipped_restored).toBe(0);

    const after = await remainingCounts(group.id, event.id, option.id);
    expect(after).toEqual({
      groups: 0,
      userGroups: 0,
      events: 0,
      participations: 0,
      rsvps: 0,
      brings: 0,
      ballotOptions: 0,
      ballotVotes: 0,
      sentNotifications: 0,
      auditLogs: 0,
      gameReviews: 0,
      groupInvites: 0,
      restoreTokens: 0,
    });
  });

  // ==========================================================================
  // SPEC-REQ-10a — idempotency
  // ==========================================================================
  it('SPEC-REQ-10a: a second run immediately after purges zero and throws nothing', async () => {
    const { group } = await seedDoomedGroup();

    const first = await runGroupPurgeSweep();
    expect(first.purged).toBe(1);

    // resolves — never rejects — and finds nothing left to do.
    const second = await runGroupPurgeSweep();
    expect(second.candidates).toBe(0);
    expect(second.purged).toBe(0);
    expect(second.errors).toBe(0);
    expect(await findGroupRaw(group.id)).toBeNull();
  });

  // ==========================================================================
  // SPEC-REQ-10b — a deadline still in the future is untouched
  // ==========================================================================
  it('SPEC-REQ-10b: a soft-deleted group whose deadline is in the future is untouched', async () => {
    const { group, event, option } = await seedDoomedGroup({ deadlineOffsetMs: 5 * DAY_MS });

    const counters = await runGroupPurgeSweep();

    expect(counters.candidates).toBe(0);
    expect(counters.purged).toBe(0);

    const row = await findGroupRaw(group.id);
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();

    const after = await remainingCounts(group.id, event.id, option.id);
    expect(after.events).toBe(1);
    expect(after.groupInvites).toBe(1);
    expect(after.restoreTokens).toBe(1);
  });

  // ==========================================================================
  // SPEC-REQ-10b — restored between selection and the lock (the in-lock re-check)
  // ==========================================================================
  it('SPEC-REQ-10b: a group restored before the lock is skipped, not purged', async () => {
    const { group, event, option } = await seedDoomedGroup();

    // Restore the group but deliberately leave the STALE past deadline in place, so
    // the row would still be selected by a naive candidate query. Only the in-lock
    // re-check of deletedAt can save it.
    await Group.restore({ where: { id: group.id } });

    const counters = await runGroupPurgeSweep();

    expect(counters.candidates).toBe(1);
    expect(counters.purged).toBe(0);
    expect(counters.skipped_restored).toBe(1);
    expect(counters.errors).toBe(0);

    const row = await findGroupRaw(group.id);
    expect(row).not.toBeNull();
    expect(row.deletedAt).toBeNull();

    const after = await remainingCounts(group.id, event.id, option.id);
    expect(after.events).toBe(1);
    expect(after.groupInvites).toBe(1);
  });

  // ==========================================================================
  // D-04 — a restore committing WHILE the sweep is blocked on the shared row lock
  // ==========================================================================
  it('D-04: a restore that commits while the sweep waits on the row lock leaves the group WHOLE', async () => {
    const { group, event, option } = await seedDoomedGroup();

    // Hold the exact lock the sweep takes as the first statement of its per-group
    // transaction. A bare Promise.all would be non-deterministic about whether the
    // sweep had even selected its candidate yet; this makes the interleaving exact.
    const t0 = await sequelize.transaction();
    await sequelize.query('SELECT id FROM "Groups" WHERE id = :id FOR UPDATE', {
      replacements: { id: group.id },
      type: sequelize.QueryTypes.SELECT,
      transaction: t0,
    });

    let released = false;
    let counters;
    try {
      const sweep = runGroupPurgeSweep();

      // The sweep has now selected its candidate and is PROVABLY blocked acquiring
      // the row lock. Without that lock it would already be deleting this group's
      // events, invites and roster right now — the "acceptance succeeds over
      // half-purged data" failure D-04 exists to prevent.
      const blocked = await waitForLockWaiters(1);
      expect(blocked).toBe(true);

      // The restore commits first.
      await Group.restore({ where: { id: group.id }, transaction: t0 });
      await Group.update(
        { purge_after: null },
        { where: { id: group.id }, transaction: t0, paranoid: false, silent: true }
      );
      await t0.commit();
      released = true;

      counters = await sweep;
    } finally {
      if (!released) await t0.rollback();
    }

    expect(counters.candidates).toBe(1);
    expect(counters.purged).toBe(0);
    expect(counters.skipped_restored).toBe(1);
    expect(counters.errors).toBe(0);

    const row = await findGroupRaw(group.id);
    expect(row).not.toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(row.purge_after).toBeNull();

    // THE ASSERTION THAT MATTERS: not merely that the Groups row survived, but that
    // nothing underneath it was destroyed while the sweep waited.
    const after = await remainingCounts(group.id, event.id, option.id);
    expect(after.events).toBe(1);
    expect(after.userGroups).toBe(2);
    expect(after.groupInvites).toBe(1);
    expect(after.gameReviews).toBe(1);
    expect(after.participations).toBe(1);
  });

  // ==========================================================================
  // T-88.2-44 — a NULL deadline is never a candidate
  // ==========================================================================
  it('T-88.2-44: a soft-deleted group with a NULL purge_after is never selected', async () => {
    const { group } = await seedDoomedGroup();
    await forceDeadline(group.id, null);

    const counters = await runGroupPurgeSweep();

    expect(counters.candidates).toBe(0);
    expect(counters.purged).toBe(0);

    const row = await findGroupRaw(group.id);
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(row.purge_after).toBeNull();
  });

  // ==========================================================================
  // T-88.2-43 — one bad row cannot starve the batch
  // ==========================================================================
  it('T-88.2-43: never throws — a failing group is counted and its healthy sibling is still purged', async () => {
    // The doomed-first ordering is deliberate: candidates drain oldest-deadline
    // first, so the FAILING group is processed BEFORE the healthy one. If a per-group
    // failure aborted the loop, the sibling would survive and this test would red.
    const bad = await seedDoomedGroup({ deadlineOffsetMs: -3 * DAY_MS });
    const good = await seedDoomedGroup({ deadlineOffsetMs: -1 * DAY_MS });

    const realDestroy = GameReview.destroy.bind(GameReview);
    const spy = jest.spyOn(GameReview, 'destroy').mockImplementation((opts = {}) => {
      if (opts.where && opts.where.group_id === bad.group.id) {
        return Promise.reject(new Error('simulated child-delete failure'));
      }
      return realDestroy(opts);
    });

    let counters;
    try {
      counters = await runGroupPurgeSweep();
    } finally {
      spy.mockRestore();
    }

    expect(counters.candidates).toBe(2);
    expect(counters.errors).toBe(1);
    expect(counters.purged).toBe(1);

    // The failing group's transaction rolled back WHOLE — it is still fully present,
    // not half-destroyed — and the next nightly run will retry it.
    const badRow = await findGroupRaw(bad.group.id);
    expect(badRow).not.toBeNull();
    const badAfter = await remainingCounts(bad.group.id, bad.event.id, bad.option.id);
    expect(badAfter.events).toBe(1);
    expect(badAfter.groupInvites).toBe(1);

    expect(await findGroupRaw(good.group.id)).toBeNull();
  });

  // ==========================================================================
  // A live group is not a candidate at all
  // ==========================================================================
  it('a group that was never deleted is not a candidate and survives', async () => {
    const owner = await makeUser();
    const group = await makeGroup();
    await addToGroup(owner, group, 'owner');
    // Belt and braces: even a live group carrying a stale past deadline must not be
    // collected — the candidate query requires the row to be soft-deleted only via
    // the paranoid escape, so this pins the deletedAt half of the re-check too.
    await forceDeadline(group.id, new Date(Date.now() - DAY_MS));

    const counters = await runGroupPurgeSweep();

    expect(counters.purged).toBe(0);
    const row = await findGroupRaw(group.id);
    expect(row).not.toBeNull();
    expect(row.deletedAt).toBeNull();
  });

  // ==========================================================================
  // MED #27 — the batch cap and its saturation signal
  // ==========================================================================
  it('MED #27: a saturated batch drains oldest-first across runs and says so', async () => {
    const oldest = await seedDoomedGroup({ deadlineOffsetMs: -9 * DAY_MS });
    const middle = await seedDoomedGroup({ deadlineOffsetMs: -6 * DAY_MS });
    const newest = await seedDoomedGroup({ deadlineOffsetMs: -3 * DAY_MS });

    // Injected limit rather than seeding PURGE_BATCH_LIMIT + 1 real groups on the
    // shared test Postgres.
    const first = await runGroupPurgeSweep({ limit: 2 });
    expect(first.candidates).toBe(2);
    expect(first.purged).toBe(2);
    expect(first.batch_saturated).toBe(true);

    // Oldest-first: the two oldest deadlines went, the newest is still there.
    expect(await findGroupRaw(oldest.group.id)).toBeNull();
    expect(await findGroupRaw(middle.group.id)).toBeNull();
    expect(await findGroupRaw(newest.group.id)).not.toBeNull();

    const second = await runGroupPurgeSweep({ limit: 2 });
    expect(second.candidates).toBe(1);
    expect(second.purged).toBe(1);
    expect(second.batch_saturated).toBe(false);
    expect(await findGroupRaw(newest.group.id)).toBeNull();

    // Nothing starved: a third run is a clean no-op.
    const third = await runGroupPurgeSweep({ limit: 2 });
    expect(third.candidates).toBe(0);
    expect(third.errors).toBe(0);
  });

  // ==========================================================================
  // The environment caveat, asserted rather than merely printed
  // ==========================================================================
  it('records which mechanism actually removed the invite rows in THIS environment', async () => {
    const rows = await sequelize.query(
      `SELECT conrelid::regclass::text AS child, confdeltype
         FROM pg_constraint
        WHERE contype='f' AND confrelid='"Groups"'::regclass`,
      { type: sequelize.QueryTypes.SELECT }
    );
    const inviteFk = rows.find((r) => String(r.child).includes('GroupInvites'));
    // Not an assertion about which answer is correct — both are legitimate states of
    // a real database, and 88.2-CASCADE-AUDIT.md records that the environments
    // DISAGREE. This exists so the phase summary can state, from a run rather than
    // from a guess, which mechanism the green above actually proves.
    expect(typeof inviteFkCascades).toBe('boolean');
    expect(Boolean(inviteFk)).toBe(inviteFkCascades);
  });
});
