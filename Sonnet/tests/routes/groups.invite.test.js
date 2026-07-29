// tests/routes/groups.invite.test.js
// BSEC-01 / BE-043: Group.invite_token defaultScope (safe-by-default) +
// withInviteToken opt-in + token-stability regression (the review-flagged bug).
//
// Behaviors:
//   1) a default Group read has NO invite_token (safe-by-default)
//   2) a .scope('withInviteToken')/.unscoped() read HAS invite_token
//   3) TOKEN STABILITY — two sequential lazy-generate GET calls for a group
//      that ALREADY has a token return the SAME invite_token (no regeneration
//      on the second QR view). This proves the mutation site reads the column
//      via the scope so `if (!group.invite_token)` is correctly false.
//
// The global tests/setup.js beforeAll requires a test DB, so this whole file
// runs in CI; locally without Postgres it is gated off by that setup hook.

const request = require('supertest');
const express = require('express');
const groupRoutes = require('../../routes/groups');
const { Group, User, UserGroup, sequelize } = require('../../models');

// Harness: inject a verified req.user before the router (mirrors the real
// verifyAuth0Token middleware that server.js mounts). Vary per-test via the
// shared `currentActor` ref.
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/groups', groupRoutes);

describe('BSEC-01 Group invite_token defaultScope + stability', () => {
  let owner;
  let group;

  // Schema built once by tests/globalSetup.js; the global beforeEach TRUNCATEs
  // all tables, so the owner/group/membership must be seeded per-test.
  beforeEach(async () => {
    owner = await User.create({
      user_id: 'auth0|bsec01-invite-owner',
      username: 'invite-owner',
      email: 'invite-owner@example.com',
    });

    group = await Group.create({
      group_id: 'bsec01-invite-group',
      name: 'Invite Test Group',
    });

    // Phase 87.1 seed cutover: DUAL-WRITE user_uuid (Users.id) alongside the old
    // Auth0-string user_id so the re-keyed UserGroup gates resolve post-Plan-09.
    await UserGroup.create({
      user_id: owner.user_id, // Auth0 string (old keyspace)
      user_uuid: owner.id,    // Users.id UUID (new keyspace)
      group_id: group.id,     // UUID — references Group.id
      role: 'owner',
      status: 'active',
    });

    currentActor = owner.user_id;
  });

  it('Test 1: a default Group read has NO invite_token', async () => {
    const row = await Group.findByPk(group.id);
    expect(row).not.toBeNull();
    expect(row.toJSON()).not.toHaveProperty('invite_token');
  });

  it('Test 2a: .scope("withInviteToken") read includes invite_token', async () => {
    // Ensure a token exists first via the lazy-generate endpoint.
    await request(app).get(`/api/groups/${group.id}/invite-token`).expect(200);
    const row = await Group.scope('withInviteToken').findByPk(group.id);
    expect(row.invite_token).toBeTruthy();
    expect(typeof row.invite_token).toBe('string');
  });

  it('Test 2b: .unscoped() read includes invite_token', async () => {
    // Ensure a token exists first via the lazy-generate endpoint. (Previously
    // this test relied on Test 2a's token leaking across the shared beforeAll
    // fixture; under per-test TRUNCATE each test gets a fresh group, so we must
    // generate the token within this test.)
    await request(app).get(`/api/groups/${group.id}/invite-token`).expect(200);
    const row = await Group.unscoped().findByPk(group.id);
    expect(row.invite_token).toBeTruthy();
  });

  it('Test 3: TOKEN STABILITY — two sequential lazy-generate GETs return the SAME token', async () => {
    const first = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);
    const second = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);

    expect(first.body.invite_token).toBeTruthy();
    expect(second.body.invite_token).toBe(first.body.invite_token);
    // And the DB row was not rewritten to a new value.
    const row = await Group.scope('withInviteToken').findByPk(group.id);
    expect(row.invite_token).toBe(first.body.invite_token);
  });

  it('Test 3b: reset-invite-token rotates to a DIFFERENT token, then it is stable again', async () => {
    const before = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);

    const rotated = await request(app)
      .post(`/api/groups/${group.id}/reset-invite-token`)
      .expect(200);

    expect(rotated.body.invite_token).toBeTruthy();
    expect(rotated.body.invite_token).not.toBe(before.body.invite_token);

    // After rotation, the lazy-generate GET must return the rotated token,
    // not regenerate yet again.
    const afterRotate = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);
    expect(afterRotate.body.invite_token).toBe(rotated.body.invite_token);
  });

  it('non-member cannot read the invite token (membership gate intact)', async () => {
    currentActor = 'auth0|not-a-member';
    await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(403);
  });

  // Phase 88.2 Plan 01 (SPEC-REQ-3c, D-01) — THE RE-JOIN LANDMINE.
  //
  // Once UserGroup is paranoid, a removed membership row stays in the table with a
  // non-null deletedAt. Re-joining by QR then tries to INSERT a second row for the
  // same (user_uuid, group_id) pair — which a FULL unique index rejects with a
  // SequelizeUniqueConstraintError, hard-failing the join for anyone who has ever
  // left or been removed.
  //
  // The defuser is the PARTIAL unique index `usergroups_user_uuid_group_id_uq`
  // (`WHERE "deletedAt" IS NULL`), declared in BOTH models/UserGroup.js and
  // migration 20260725000001. A RED HERE MEANS THAT INDEX REVERTED TO FULL — check
  // both halves of the dual-write before touching this test.
  //
  // Mechanism note: the existing-membership lookup at routes/groups.js:681-683 is
  // itself paranoid-filtered, so it does NOT see the stamped row; the handler
  // therefore takes the UserGroup.create branch at :704-710 rather than the
  // re-activate branch. That create is exactly the path the partial index permits.
  //
  // Stamped with update({ deletedAt }, { silent: true }) rather than destroy() — see
  // the STAMPING DISCIPLINE note in tests/routes/groups.softDelete.test.js.
  it('SPEC-REQ-3c: a user whose membership row is soft-deleted can re-join by token (partial unique index)', async () => {
    // Generate the invite token while the owner is still an active member.
    const tokenRes = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);
    const token = tokenRes.body.invite_token;
    expect(token).toBeTruthy();

    // Soft-delete the membership row (the "left the group" / "was removed" state).
    await UserGroup.update(
      { deletedAt: new Date() },
      { where: { user_uuid: owner.id, group_id: group.id }, silent: true }
    );
    expect(
      await UserGroup.findOne({ where: { user_uuid: owner.id, group_id: group.id } })
    ).toBeNull();

    // Re-join. With a FULL unique index this 500s on SequelizeUniqueConstraintError.
    const res = await request(app)
      .post('/api/groups/join-by-token')
      .send({ token })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.group_id).toBe(group.id);

    // A NEW live membership row exists, and the soft-deleted one is still there.
    const live = await UserGroup.findOne({
      where: { user_uuid: owner.id, group_id: group.id },
    });
    expect(live).not.toBeNull();
    expect(live.status).toBe('active');
    expect(live.role).toBe('member');

    const all = await UserGroup.findAll({
      where: { user_uuid: owner.id, group_id: group.id },
      paranoid: false,
    });
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.deletedAt === null)).toHaveLength(1);
  });
});

// ============================================================================
// Phase 88.2 plan 04 Task 4, Fix 1b (AF-3 / D-04): POST /groups/join-by-token
// cannot land a LIVE membership row on a group that a concurrent delete hid.
//
// Why a gate and not plan 06's delete-side FOR UPDATE lock: that lock refuses a
// concurrent join only because ACCOUNT DELETION DESTROYS the Groups row, so the
// waiting join fails its FK check. A SOFT delete leaves the row in place — when
// the lock releases, the join's FOR KEY SHARE FK check SUCCEEDS and the row
// lands. The lock serializes; it cannot refuse. Only a liveness re-read refuses.
// ============================================================================
describe('88.2 AF-3 Fix 1b — POST /groups/join-by-token liveness gate', () => {
  let owner;
  let joiner;
  let group;
  let token;

  beforeEach(async () => {
    owner = await User.create({
      user_id: 'auth0|af3b-owner', username: 'af3b-owner', email: 'af3b-owner@example.com',
    });
    joiner = await User.create({
      user_id: 'auth0|af3b-joiner', username: 'af3b-joiner', email: 'af3b-joiner@example.com',
    });
    group = await Group.create({ group_id: 'af3b-group', name: 'AF3b Group' });
    await UserGroup.create({
      user_uuid: owner.id, group_id: group.id, role: 'owner', status: 'active',
    });

    currentActor = owner.user_id;
    const tokenRes = await request(app)
      .get(`/api/groups/${group.id}/invite-token`)
      .expect(200);
    token = tokenRes.body.invite_token;
    expect(token).toBeTruthy();

    currentActor = joiner.user_id;
  });

  const stamp = async (transaction) => {
    const deletedAt = new Date();
    await Group.update({ deletedAt }, { where: { id: group.id }, silent: true, transaction });
    await UserGroup.update({ deletedAt }, { where: { group_id: group.id }, silent: true, transaction });
    return deletedAt;
  };

  // Poll for the handler's transaction actually BLOCKING on our row lock. This is
  // an observable database condition, not a sleep — once a session is waiting on a
  // Lock while running a FOR UPDATE, the handler is provably past its initial
  // Group.findOne and inside its own transaction.
  async function waitForLockWaiter({ timeoutMs = 10000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [row] = await sequelize.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND query ILIKE '%FOR UPDATE%'
             AND pid <> pg_backend_pid()`,
        { type: sequelize.QueryTypes.SELECT }
      );
      if (row && row.n > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }

  it('DETERMINISTIC RACE: a join that passes its liveness read, then blocks on the delete\'s row lock, is REFUSED with 410 and creates zero UserGroup rows', async () => {
    // 1) Take the same row lock the delete side takes, from a test-owned txn.
    const t1 = await sequelize.transaction();
    await sequelize.query('SELECT id FROM "Groups" WHERE id = :id FOR UPDATE', {
      replacements: { id: group.id },
      type: sequelize.QueryTypes.SELECT,
      transaction: t1,
    });

    let released = false;
    let pending;
    try {
      // 2) Fire the join. Its initial Group.findOne sees a LIVE group (nothing is
      //    stamped yet), then its own transaction blocks on our lock.
      //    `.then()` is REQUIRED: a supertest Test is lazy and does not dispatch
      //    until end()/then() is called. Building it without this leaves the
      //    request unsent, nothing ever blocks, and the poll below times out
      //    holding the lock.
      pending = request(app)
        .post('/api/groups/join-by-token')
        .send({ token })
        .then((r) => r, (e) => e);

      // 3) Wait for the handler to be provably BLOCKED — not a timing guess.
      const blocked = await waitForLockWaiter();
      expect(blocked).toBe(true);

      // 4) Soft-delete under the lock, then release it.
      await stamp(t1);
      await t1.commit();
      released = true;
    } finally {
      // Never leave the row lock held — a leaked lock hangs the global
      // truncateAll in tests/setup.js and reds every subsequent test in the file
      // with a misleading hook timeout.
      if (!released) {
        await t1.rollback().catch(() => {});
      }
    }

    // 5) The handler's re-read now sees a hidden group and refuses.
    const res = await pending;
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/no longer available/i);

    // ZERO membership rows for the joiner — live or stamped. Before the gate this
    // was a LIVE UserGroup{status:'active'} row on a hidden group, passing
    // isActiveMember for the whole 30-day window.
    const rows = await UserGroup.findAll({
      where: { user_uuid: joiner.id, group_id: group.id },
      paranoid: false,
    });
    expect(rows).toHaveLength(0);
  }, 30000);

  it('a join by token for an ALREADY soft-deleted group is refused and creates zero UserGroup rows', async () => {
    // Recorded behavior, verified rather than assumed: the handler's FIRST lookup
    // (Group.findOne by invite_token) is itself paranoid-filtered, so a group that
    // is already hidden when the request arrives is refused there with 404
    // ('Invalid invite link') and never reaches the locked re-read's 410. Both are
    // refusals; the status differs by WHICH guard fires. Asserting the range rather
    // than pinning 404 keeps this green if a later plan reorders the lookups, while
    // still failing loudly if either refusal is lost.
    await stamp();

    const res = await request(app).post('/api/groups/join-by-token').send({ token });

    expect([404, 410]).toContain(res.status);
    expect(res.body.success).toBeUndefined();

    const rows = await UserGroup.findAll({
      where: { user_uuid: joiner.id, group_id: group.id },
      paranoid: false,
    });
    expect(rows).toHaveLength(0);
  });

  it('(non-regression) a join by token for a LIVE group still succeeds and creates one active membership row', async () => {
    const res = await request(app)
      .post('/api/groups/join-by-token')
      .send({ token })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.group_id).toBe(group.id);

    const rows = await UserGroup.findAll({
      where: { user_uuid: joiner.id, group_id: group.id },
      paranoid: false,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].role).toBe('member');
    expect(rows[0].deletedAt).toBeNull();
  });
});
