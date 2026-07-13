// tests/routes/rsvp.test.js
// D-04 / BSEC-03: single-use RSVP magic links via the SingleUseToken table.
//
// Live code mints THREE HMAC links (yes/maybe/no) per email; GET /respond reads
// eventId/userId/status from the client query and recomputes the HMAC. This suite
// proves the single-use redesign:
//   1. a valid link records the RSVP on first use AND consumes its row
//   2. replay -> 403 AND the EventRsvp row is UNCHANGED (consume gates before upsert)
//   3. consuming the 'yes' link revokes its 'maybe'/'no' batch siblings -> sibling 403
//   4. an expired link -> 403
//   5. resending mints a new batch and revokes ALL prior active rows -> old links 403,
//      exactly one new link consumable
//   6. backward-compat: an HMAC-valid link with NO paired row -> documented 403
//
// Real-DB (sequelize.sync). The gcalCleanupService is mocked (best-effort, Redis).
// Runs against the Postgres service container in CI.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';
process.env.MAGIC_TOKEN_SECRET =
  process.env.MAGIC_TOKEN_SECRET || 'test-secret-key-for-rsvp-hmac-minimum-32-chars';

// Mock the gcal cleanup service (best-effort, would otherwise reach Redis).
jest.mock('../../services/gcalCleanupService', () => ({
  enqueueCleanupJobForAttendee: jest.fn().mockResolvedValue(undefined),
  enqueueCleanupJobsForEvent: jest.fn().mockResolvedValue(undefined),
}));

// Phase 87 / BINT-01: the authenticated POST / (upsert) route sits behind
// verifyAuth0Token, which validates a real Auth0 JWT. Stub it to a passthrough
// so the concurrent-RSVP race test can drive the route with an injected
// req.user. The magic-link GET /respond tests below do NOT use verifyAuth0Token,
// so this stub is inert for the existing suite. validateRsvpCreate and
// canReadEventScopedSurface are NOT mocked — the race test sends a valid body
// and seeds a real active membership so both pass naturally.
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
}));

const request = require('supertest');
const express = require('express');
const rsvpRoutes = require('../../routes/rsvp');
const { generateRsvpToken, mintRsvpBatch } = require('../../routes/rsvp');
const {
  EventRsvp,
  EventBring,
  Event,
  User,
  Group,
  Game,
  UserGroup,
  SingleUseToken,
  sequelize,
} = require('../../models');
const { makeUser, makeGroup, addToGroup, makeEventRsvp, makeEventBring } = require('../factories');

// Shared actor ref: injected as req.user ahead of the router (mirrors the real
// verifyAuth0Token middleware server.js mounts). Only the authenticated routes
// read it; GET /respond ignores it.
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/rsvp', rsvpRoutes);

const USER_ID = 'auth0|rsvp-single-use-test';

// D-05 include-pin shapes (Phase 87.3 Task 1): the nested User.id the FE cutover
// (PR-B) compares against is a UUID; the Auth0 sub is provider-prefixed.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_RE = /^(auth0|google-oauth2|apple)\|/;

async function respond(token, eventId, userId, status) {
  return request(app)
    .get('/api/rsvp/respond')
    .query({ token, e: eventId, u: userId, s: status });
}

describe('RSVP single-use magic links (D-04 / BSEC-03)', () => {
  let testGroup;
  let testGame;
  let futureEvent;
  // Phase 87.1 (Plan 09): EventRsvp is keyed on user_uuid (Users.id); capture the
  // seeded user's UUID so the assertions can query it (the old user_id column is gone).
  let rsvpUserUuid;

  // NOTE: schema is built once by tests/globalSetup.js; the global beforeEach in
  // tests/setup.js TRUNCATEs every table before each test. The FK parents
  // (User/Group/Game) MUST be re-seeded in beforeEach ABOVE the Event create, or
  // the per-test wipe leaves futureEvent's FK targets missing from test 2 onward.
  beforeEach(async () => {
    const rsvpUser = await User.create({ user_id: USER_ID, username: 'RSVP Tester', email: 'rsvp@test.com' });
    rsvpUserUuid = rsvpUser.id;
    testGroup = await Group.create({ name: 'RSVP Group', group_id: 'rsvp-test-group-001' });
    testGame = await Game.create({ name: 'Test Game' });

    futureEvent = await Event.create({
      group_id: testGroup.id,
      game_id: testGame.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
    });
  });

  it('Test 1: a valid link records the RSVP on first use and consumes its row', async () => {
    await mintRsvpBatch(futureEvent.id, USER_ID);
    const token = generateRsvpToken(futureEvent.id, USER_ID, 'yes');

    const res = await respond(token, futureEvent.id, USER_ID, 'yes');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('yes');

    const rsvp = await EventRsvp.findOne({ where: { event_id: futureEvent.id, user_uuid: rsvpUserUuid } });
    expect(rsvp).not.toBeNull();
    expect(rsvp.status).toBe('yes');

    const row = await SingleUseToken.findOne({ where: { nonce: token } });
    expect(row.status).toBe('used');
  });

  it('Test 2: replaying the SAME link returns 403 AND leaves the EventRsvp row unchanged', async () => {
    await mintRsvpBatch(futureEvent.id, USER_ID);
    const token = generateRsvpToken(futureEvent.id, USER_ID, 'yes');

    const first = await respond(token, futureEvent.id, USER_ID, 'yes');
    expect(first.status).toBe(200);

    // Capture state after first use.
    const afterFirst = await EventRsvp.findOne({ where: { event_id: futureEvent.id, user_uuid: rsvpUserUuid } });
    const beforeReplay = { status: afterFirst.status, updatedAt: afterFirst.updatedAt };

    const replay = await respond(token, futureEvent.id, USER_ID, 'yes');
    expect(replay.status).toBe(403);

    // RSVP state MUST be unchanged (consume gates before the upsert).
    const afterReplay = await EventRsvp.findOne({ where: { event_id: futureEvent.id, user_uuid: rsvpUserUuid } });
    expect(afterReplay.status).toBe(beforeReplay.status);
    expect(afterReplay.updatedAt.getTime()).toBe(beforeReplay.updatedAt.getTime());
  });

  it("Test 3: consuming the 'yes' link revokes its batch siblings — the 'maybe' link then returns 403", async () => {
    await mintRsvpBatch(futureEvent.id, USER_ID);
    const yesToken = generateRsvpToken(futureEvent.id, USER_ID, 'yes');
    const maybeToken = generateRsvpToken(futureEvent.id, USER_ID, 'maybe');

    const yesRes = await respond(yesToken, futureEvent.id, USER_ID, 'yes');
    expect(yesRes.status).toBe(200);

    const maybeRes = await respond(maybeToken, futureEvent.id, USER_ID, 'maybe');
    expect(maybeRes.status).toBe(403);

    // RSVP stays 'yes' — the sibling never mutated state.
    const rsvp = await EventRsvp.findOne({ where: { event_id: futureEvent.id, user_uuid: rsvpUserUuid } });
    expect(rsvp.status).toBe('yes');
  });

  it('Test 4: an expired link is rejected (403)', async () => {
    await mintRsvpBatch(futureEvent.id, USER_ID);
    const token = generateRsvpToken(futureEvent.id, USER_ID, 'yes');

    // Force the batch rows past expiry.
    await SingleUseToken.update(
      { expires_at: new Date(Date.now() - 1000) },
      { where: { event_id: futureEvent.id, user_id: USER_ID } }
    );

    const res = await respond(token, futureEvent.id, USER_ID, 'yes');
    expect(res.status).toBe(403);

    const rsvp = await EventRsvp.findOne({ where: { event_id: futureEvent.id, user_uuid: rsvpUserUuid } });
    expect(rsvp).toBeNull();
  });

  it('Test 5: a consumed answer is dead until a resend reactivates the batch; resend re-enables exactly one consume', async () => {
    // The RSVP HMAC is deterministic, so the three link strings are identical
    // across emails. The single-use invariant is enforced via row status:
    // a consumed answer stays dead until a resend reactivates the batch.

    // First batch + consume 'yes'.
    await mintRsvpBatch(futureEvent.id, USER_ID);
    const yesToken = generateRsvpToken(futureEvent.id, USER_ID, 'yes');

    const firstUse = await respond(yesToken, futureEvent.id, USER_ID, 'yes');
    expect(firstUse.status).toBe(200);

    // Without a resend, the same (now-consumed) link is dead.
    const deadReplay = await respond(yesToken, futureEvent.id, USER_ID, 'yes');
    expect(deadReplay.status).toBe(403);

    // Resend reactivates the batch (new batch_id, status back to active).
    await mintRsvpBatch(futureEvent.id, USER_ID);
    const batchIds = await SingleUseToken.findAll({
      where: { event_id: futureEvent.id, user_id: USER_ID, status: 'active' },
      attributes: ['email_batch_id'],
    });
    // Exactly one active batch_id across the three active rows (one email).
    const uniqueBatchIds = new Set(batchIds.map((r) => r.email_batch_id));
    expect(uniqueBatchIds.size).toBe(1);

    // The link is consumable again — exactly once.
    const afterResend = await respond(yesToken, futureEvent.id, USER_ID, 'yes');
    expect(afterResend.status).toBe(200);

    const replayAgain = await respond(yesToken, futureEvent.id, USER_ID, 'yes');
    expect(replayAgain.status).toBe(403);
  });

  it('Test 6 (backward-compat): an HMAC-valid link with NO paired row returns a documented 403', async () => {
    // No mintRsvpBatch — simulates an in-flight pre-deploy email.
    const token = generateRsvpToken(futureEvent.id, USER_ID, 'yes');

    const res = await respond(token, futureEvent.id, USER_ID, 'yes');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('expired_link');

    // No RSVP state was mutated.
    const rsvp = await EventRsvp.findOne({ where: { event_id: futureEvent.id, user_uuid: rsvpUserUuid } });
    expect(rsvp).toBeNull();
  });
});

// ============================================================================
// Phase 87 / BINT-01 (T-87-06): concurrent first-RSVP idempotency (real DB).
//
// Two concurrent first-RSVPs for the same (event_id, user_id) both take the
// create branch (their findOne pre-checks each miss the not-yet-committed row).
// EventRsvp's (event_id, user_uuid) unique index IS declared in the model, so it
// builds on the sync DB and arbitrates the race: one INSERT wins (201), the
// other raises a UniqueConstraintError that the route absorbs -> re-find +
// update (200). Neither returns a 500, and exactly one row survives.
//
// We force BOTH pre-checks to miss by stubbing the first two EventRsvp.findOne
// calls to null (mirrors ballot-routes.test.js's "force both to the create
// branch"), then delegate to the REAL findOne so the loser's absorb re-find
// hits the winning row. This makes the outcome deterministic across every
// interleaving while still exercising the real unique index + absorb path.
// ============================================================================
describe('RSVP concurrent first-write idempotency (BINT-01 / T-87-06)', () => {
  const RACE_USER = 'auth0|rsvp-race-test';
  let raceGroup;
  let raceGame;
  let raceEvent;
  let raceUserUuid;

  beforeEach(async () => {
    currentActor = RACE_USER;
    const raceUser = await User.create({ user_id: RACE_USER, username: 'RSVP Racer', email: 'race@test.com' });
    raceUserUuid = raceUser.id;
    raceGroup = await Group.create({ name: 'RSVP Race Group', group_id: 'rsvp-race-group-001' });
    raceGame = await Game.create({ name: 'Race Game' });
    raceEvent = await Event.create({
      group_id: raceGroup.id,
      game_id: raceGame.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
    });
    // Active membership so canReadEventScopedSurface (real, unmocked) authorizes.
    // Phase 87.1: getUserRoleInGroup (Plan 04) queries UserGroup by user_uuid; the
    // old Auth0-string user_id column was removed from the model in Plan 09.
    await UserGroup.create({
      user_uuid: raceUser.id,
      group_id: raceGroup.id,
      role: 'member',
      status: 'active',
    });
  });

  afterEach(() => {
    currentActor = null;
    jest.restoreAllMocks();
  });

  it('two concurrent first-RSVPs both succeed (no 500) and leave exactly one row', async () => {
    const realFindOne = EventRsvp.findOne.bind(EventRsvp);
    let findOneCalls = 0;
    // Calls 1 & 2 are the two requests' pre-checks -> force a miss so both take
    // the create branch. Call 3 is the loser's absorb re-find -> real lookup.
    jest.spyOn(EventRsvp, 'findOne').mockImplementation((...args) => {
      findOneCalls += 1;
      if (findOneCalls <= 2) return Promise.resolve(null);
      return realFindOne(...args);
    });

    const [r1, r2] = await Promise.all([
      request(app).post('/api/rsvp').send({ event_id: raceEvent.id, status: 'yes' }),
      request(app).post('/api/rsvp').send({ event_id: raceEvent.id, status: 'yes' }),
    ]);

    // Neither concurrent write may 500 — the loser absorbs the unique violation.
    expect(r1.status).not.toBe(500);
    expect(r2.status).not.toBe(500);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);

    // The unique index guaranteed exactly one persisted row (findAll is NOT
    // spied, so this is a true DB count).
    const rows = await EventRsvp.findAll({
      where: { event_id: raceEvent.id, user_uuid: raceUserUuid },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('yes');
  });
});

// ============================================================================
// Phase 87.1 (BINT-02, D-11/D-12): RSVP ownership gates + wire shims on the
// UUID keyspace. Owners CAN act, non-owners CANNOT; responses serialize the
// Auth0 sub (never a raw user_uuid); null caller / magic-link resolves fail
// closed with the existing 403/404 envelope (never a raw 500); GET /respond
// resolves the user BEFORE burning the single-use token.
//
// Run ALONE per the never-green-locally caveat:
//   npm test -- tests/routes/rsvp.test.js
// ============================================================================
describe('RSVP UUID keyspace authz + wire (Phase 87.1)', () => {
  let owner;
  let other;
  let group;
  let game;
  let event;

  beforeEach(async () => {
    owner = await makeUser({ username: 'rsvp-uuid-owner' });
    other = await makeUser({ username: 'rsvp-uuid-other' });
    group = await makeGroup({ name: 'RSVP UUID Group' });
    game = await Game.create({ name: 'RSVP UUID Game', is_custom: true });
    await addToGroup(owner, group, 'member');
    await addToGroup(other, group, 'member');
    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
    });
  });

  afterEach(() => {
    currentActor = null;
    jest.restoreAllMocks();
  });

  it('DELETE: the RSVP owner can remove their own RSVP (UUID gate positive)', async () => {
    const rsvp = await makeEventRsvp(event, owner, { status: 'yes' });
    currentActor = owner.user_id;
    const res = await request(app).delete(`/api/rsvp/${rsvp.id}`);
    expect(res.status).toBe(200);
    expect(await EventRsvp.findByPk(rsvp.id)).toBeNull();
  });

  it("DELETE: a non-owner cannot remove someone else's RSVP (UUID gate negative)", async () => {
    const rsvp = await makeEventRsvp(event, owner, { status: 'yes' });
    currentActor = other.user_id;
    const res = await request(app).delete(`/api/rsvp/${rsvp.id}`);
    expect(res.status).toBe(403);
    expect(await EventRsvp.findByPk(rsvp.id)).not.toBeNull();
  });

  it('DELETE: an unresolvable caller fails closed with 403, not a 500', async () => {
    const rsvp = await makeEventRsvp(event, owner, { status: 'yes' });
    currentActor = 'auth0|ghost-no-users-row';
    const res = await request(app).delete(`/api/rsvp/${rsvp.id}`);
    expect(res.status).toBe(403);
    expect(await EventRsvp.findByPk(rsvp.id)).not.toBeNull();
  });

  it('POST downgrade to no destroys the caller bring on the UUID keyspace (D-11)', async () => {
    await makeEventRsvp(event, owner, { status: 'yes' });
    const bring = await makeEventBring(event, owner, game);
    currentActor = owner.user_id;
    const res = await request(app)
      .post('/api/rsvp')
      .send({ event_id: event.id, status: 'no' });
    expect([200, 201]).toContain(res.status);
    // The bring commitment must be gone (Auth0-keyed destroy would leave it).
    expect(await EventBring.findByPk(bring.id)).toBeNull();
  });

  it('POST response serializes user_id as the Auth0 sub, not a UUID (D-12)', async () => {
    currentActor = owner.user_id;
    const res = await request(app)
      .post('/api/rsvp')
      .send({ event_id: event.id, status: 'yes' });
    expect([200, 201]).toContain(res.status);
    expect(res.body.user_id).toBe(owner.user_id);
    expect(res.body.user_uuid).toBeUndefined();
  });

  it('GET /event/:id list serializes each rsvp user_id as the Auth0 sub (D-12)', async () => {
    await makeEventRsvp(event, owner, { status: 'yes' });
    currentActor = owner.user_id;
    const res = await request(app).get(`/api/rsvp/event/${event.id}`);
    expect(res.status).toBe(200);
    const row = res.body.rsvps.find((r) => r.id);
    expect(row).toBeDefined();
    expect(row.user_id).toBe(owner.user_id);
    expect(row.user_uuid).toBeUndefined();
    // D-05 INCLUDE-PIN (Phase 87.3 Task 1): the nested User.id the FE cutover
    // (PR-B) will compare against MUST be a UUID, never the Auth0 sub. This is
    // the regression net for PR-C's flat-field flip (plan 09).
    expect(row.User).toBeDefined();
    expect(row.User.id).toMatch(UUID_RE);
    expect(row.User.id).not.toMatch(SUB_RE);
    expect(row.User.id).toBe(owner.id);
  });

  it('GET /user/:id returns a freshly UUID-keyed RSVP and serializes user_id as the Auth0 sub (D-12)', async () => {
    // Seed UUID-keyed only: user_id is a non-matching sentinel so a query keyed
    // on the Auth0 param would MISS — only a user_uuid-keyed query finds it.
    const rsvp = await EventRsvp.create({
      event_id: event.id,
      user_id: `auth0|uuid-only-sentinel-${Date.now()}`,
      user_uuid: owner.id,
      status: 'yes',
    });
    currentActor = owner.user_id;
    const res = await request(app).get(`/api/rsvp/user/${owner.user_id}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find((r) => r.id === rsvp.id);
    expect(row).toBeDefined(); // proves the query keyed user_uuid, not the Auth0 param
    expect(row.user_id).toBe(owner.user_id); // D-12: Auth0 sub, defined, not a UUID
    expect(row.user_uuid).toBeUndefined();
  });

  it('GET /user/:id with an unresolvable caller returns an empty list (fail-closed, no 500)', async () => {
    const ghost = 'auth0|ghost-no-users-row';
    currentActor = ghost;
    const res = await request(app).get(`/api/rsvp/user/${encodeURIComponent(ghost)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('GET /respond writes an EventRsvp keyed by user_uuid for a seeded user', async () => {
    await mintRsvpBatch(event.id, owner.user_id);
    const token = generateRsvpToken(event.id, owner.user_id, 'yes');
    const res = await request(app)
      .get('/api/rsvp/respond')
      .query({ token, e: event.id, u: owner.user_id, s: 'yes' });
    expect(res.status).toBe(200);
    const rsvp = await EventRsvp.findOne({
      where: { event_id: event.id, user_uuid: owner.id },
    });
    expect(rsvp).not.toBeNull(); // proves the create wrote user_uuid
    expect(rsvp.user_uuid).toBe(owner.id);
  });

  it('GET /respond resolves the user BEFORE consuming the token: a null resolve returns 403 and does NOT burn the token', async () => {
    // Mint for a REAL user (SingleUseToken.user_id has a DB FK to Users.user_id,
    // so a token cannot exist for a nonexistent sub). Then simulate the sub
    // resolving to no Users row (e.g. account deleted mid-flight) by mocking the
    // resolve — this asserts the ordering guarantee: resolve happens BEFORE the
    // atomic consume, so a failed resolve never burns the single-use token.
    await mintRsvpBatch(event.id, owner.user_id);
    const token = generateRsvpToken(event.id, owner.user_id, 'yes');
    jest.spyOn(User, 'findOne').mockResolvedValue(null);
    const res = await request(app)
      .get('/api/rsvp/respond')
      .query({ token, e: event.id, u: owner.user_id, s: 'yes' });
    expect(res.status).toBe(403);
    // F4: the no-Users-row branch returns a DISTINCT, honest error code (the link is
    // valid; the account just doesn't exist) — not the expired/replayed-link envelope.
    expect(res.body.error).toBe('account_not_found');
    // The single-use token MUST survive the failed resolve (still active).
    const row = await SingleUseToken.findOne({ where: { nonce: token } });
    expect(row.status).toBe('active');
  });
});
