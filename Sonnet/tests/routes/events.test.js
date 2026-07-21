// tests/routes/events.test.js
const request = require('supertest');
const express = require('express');
const eventRoutes = require('../../routes/events');
// Phase 87.5 (BINT-02, PR-1): the POST /events production ballot-creation path stamps
// created_by_uuid; this suite exercises it AND the routes/ballot.js replace/wipe gate
// as the same creator, so it mounts BOTH routers on a shared app for that one test.
const ballotRoutes = require('../../routes/ballot');
const { Event, Game, User, Group, EventParticipation, EventRsvp, EventBallotOption, UserGroup, sequelize } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');
const { QueryTypes } = require('sequelize');
// Phase 87 (BINT-02): the migration under test — used by the preclean unit test
// to exercise the real orphan-DELETE + guarded ADD CONSTRAINT on a raw connection.
const epUserFkMigration = require('../../migrations/20260701000002-add-eventparticipation-user-fk');

const EP_FK_NAME = 'eventparticipations_user_id_fkey';

// The event routes derive the actor from req.user (BE-040/BE-044 / BSEC-01
// default-deny authz, Phase 83) and always membership-check. Build a per-test
// app that injects req.user ahead of the router (mirrors authStub.js + the
// leave-cascade suites). Without it every handler short-circuits at 401.
function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor ? { user_id: actor.user_id, email: actor.email } : undefined;
    next();
  });
  app.use('/api/events', eventRoutes);
  return app;
}

describe('Event Routes', () => {
  let testUser1, testUser2, testGroup, testGame;

  // Seed in beforeEach so fixtures survive the global per-test TRUNCATE
  // (plan-01 isolation harness). Connection lifecycle is owned by
  // tests/globalTeardown.js — this suite never calls sequelize.close().
  // testUser1 is the group OWNER (passes member + owner/admin gates);
  // testUser2 is a non-member (used for the 403 path).
  beforeEach(async () => {
    testUser1 = await makeUser({ user_id: 'test-user-events-1', username: 'testuser1' });
    testUser2 = await makeUser({ user_id: 'test-user-events-2', username: 'testuser2' });

    testGroup = await makeGroup({ group_id: 'test-group-events-1', name: 'Test Group' });

    testGame = await Game.create({
      name: 'Test Game',
      is_custom: true
    });

    // testUser1 is the owner of the group (Auth0 string user_id via factory).
    await addToGroup(testUser1, testGroup, 'owner');
  });

  describe('GET /api/events/group/:group_id', () => {
    it('should get all events for a group (member access)', async () => {
      await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      const response = await request(makeApp(testUser1))
        .get(`/api/events/group/${testGroup.id}`)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should return 403 if actor not in group', async () => {
      const response = await request(makeApp(testUser2))
        .get(`/api/events/group/${testGroup.id}`)
        .expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toBe('Access denied to this group');
    });

    it('should return 401 if unauthenticated', async () => {
      const response = await request(makeApp(null))
        .get(`/api/events/group/${testGroup.id}`)
        .expect(401);

      expect(response.body.error).toBe('Unauthorized');
    });
  });

  describe('POST /api/events', () => {
    it('should create a new event', async () => {
      const eventData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date().toISOString(),
        duration_minutes: 60
      };

      const response = await request(makeApp(testUser1))
        .post('/api/events')
        .send(eventData)
        .expect(200);

      expect(response.body).toHaveProperty('id');
      expect(response.body.group_id).toBe(testGroup.id);
      expect(response.body.game_id).toBe(testGame.id);
    });

    it('should create event with participants', async () => {
      const eventData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date().toISOString(),
        participants: [
          {
            // EventParticipation.user_id is a UUID (User.id) — correct to use .id here.
            user_id: testUser1.id,
            score: 100,
            placement: 1
          }
        ]
      };

      const response = await request(makeApp(testUser1))
        .post('/api/events')
        .send(eventData)
        .expect(200);

      expect(response.body).toHaveProperty('EventParticipations');
      expect(response.body.EventParticipations.length).toBe(1);
    });

    it('should return 403 if actor not a member of the group', async () => {
      const eventData = {
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date().toISOString(),
        duration_minutes: 60
      };

      const response = await request(makeApp(testUser2))
        .post('/api/events')
        .send(eventData)
        .expect(403);

      expect(response.body).toHaveProperty('error');
    });

    // Phase 87 (T-87-08-01): the multi-write set is one managed transaction.
    it('rolls back the whole write set (0 Event rows) when a mid-write fails', async () => {
      // Force EventParticipation.bulkCreate — the SECOND write, after Event.create
      // — to throw inside the transaction. The managed transaction must roll the
      // Event.create back, leaving zero persisted rows for this attempt.
      const spy = jest
        .spyOn(EventParticipation, 'bulkCreate')
        .mockRejectedValueOnce(new Error('forced mid-write failure'));

      const before = await Event.count({ where: { group_id: testGroup.id } });

      const response = await request(makeApp(testUser1))
        .post('/api/events')
        .send({
          group_id: testGroup.id,
          game_id: testGame.id,
          start_date: new Date().toISOString(),
          participants: [{ user_id: testUser1.id, score: 10, placement: 1 }],
        })
        .expect(500);

      expect(response.body).toHaveProperty('error');

      // No orphaned Event row survived the rollback.
      const after = await Event.count({ where: { group_id: testGroup.id } });
      expect(after).toBe(before);

      spy.mockRestore();
    });

    // Phase 87 (T-87-08-01): ballot_options are de-duped by game_name before
    // bulkCreate so the (event_id, game_name) unique index cannot 500.
    it('de-dups ballot_options by game_name (one row per name, no 500)', async () => {
      const response = await request(makeApp(testUser1))
        .post('/api/events')
        .send({
          group_id: testGroup.id,
          game_id: testGame.id,
          start_date: new Date().toISOString(),
          rsvp_deadline: new Date(Date.now() + 86400000).toISOString(),
          // Two "Catan" entries + one "Wingspan": the duplicate collapses to a
          // single row; the ballot still materializes (>= 2 distinct names).
          ballot_options: [
            { game_name: 'Catan' },
            { game_name: 'Catan' },
            { game_name: 'Wingspan' },
          ],
        })
        .expect(200);

      expect(response.body).toHaveProperty('id');

      const catanRows = await EventBallotOption.findAll({
        where: { event_id: response.body.id, game_name: 'Catan' },
      });
      expect(catanRows.length).toBe(1); // exactly one row for the duplicated name

      const allRows = await EventBallotOption.findAll({
        where: { event_id: response.body.id },
      });
      expect(allRows.length).toBe(2); // Catan (de-duped) + Wingspan
    });

    // Phase 87 (adversarial review #6/#7): a caller-supplied >=2 ballot that
    // collapses to <2 DISTINCT trimmed names must be rejected LOUDLY (400)
    // BEFORE any write — never silently create a ballot-less event + 200.
    it('rejects a ballot that de-dups below 2 distinct game_names (400, no event created)', async () => {
      const before = await Event.count({ where: { group_id: testGroup.id } });

      const response = await request(makeApp(testUser1))
        .post('/api/events')
        .send({
          group_id: testGroup.id,
          game_id: testGame.id,
          start_date: new Date().toISOString(),
          rsvp_deadline: new Date(Date.now() + 86400000).toISOString(),
          // Two entries, same trimmed name → 1 distinct → below the 2 minimum.
          ballot_options: [
            { game_name: 'Catan' },
            { game_name: '  Catan  ' },
          ],
        })
        .expect(400);

      expect(response.body.error).toMatch(/at least 2 distinct/i);

      // Validation runs before Event.create — no ballot-less event persisted.
      const after = await Event.count({ where: { group_id: testGroup.id } });
      expect(after).toBe(before);
    });

    // Phase 87.5 (BINT-02, PR-1, T-875-04-PRODPATH): POST /events with embedded
    // ballot_options is the REAL production ballot-creation path (the FE births every
    // ballot here). It must stamp created_by_uuid with the creator's Users.id UUID so
    // the routes/ballot.js creator-authz branch is actually reachable in production. We
    // use a plain MEMBER creator (not owner/admin) so a passing replace gate proves the
    // CREATOR branch specifically, not the owner/admin branch.
    it('stamps created_by_uuid = creator UUID and a non-admin creator passes the replace/wipe gate', async () => {
      const memberCreator = await makeUser({ username: 'events-ballot-creator' });
      await addToGroup(memberCreator, testGroup, 'member');

      // One app injecting the member creator; mount BOTH routers so the same caller
      // hits the events create path AND the ballot replace gate.
      const combined = express();
      combined.use(express.json());
      combined.use((req, _res, next) => {
        req.user = { user_id: memberCreator.user_id, email: memberCreator.email };
        next();
      });
      combined.use('/api/events', eventRoutes);
      combined.use('/api/ballot', ballotRoutes);

      const createRes = await request(combined)
        .post('/api/events')
        .send({
          group_id: testGroup.id,
          game_id: testGame.id,
          start_date: new Date(Date.now() + 5 * 86400000).toISOString(),
          duration_minutes: 120,
          rsvp_deadline: new Date(Date.now() + 2 * 86400000).toISOString(),
          ballot_options: [
            { game_name: 'Events Path A' },
            { game_name: 'Events Path B' },
          ],
        })
        .expect(200);

      const eventId = createRes.body.id;
      expect(eventId).toBeDefined();

      // Every option born via POST /events carries the creator's UUID — not the sub, not NULL.
      const rows = await EventBallotOption.findAll({ where: { event_id: eventId } });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(rows.every(o => o.created_by_uuid === memberCreator.id)).toBe(true);
      expect(rows.some(o => o.created_by_uuid === null)).toBe(false);

      // The member creator (NOT an owner/admin) passes the routes/ballot.js replace
      // gate — proving the creator-authz branch is live for the production path — and
      // the replacement PRESERVES the creator's UUID (identity never lost/overwritten).
      const replaceRes = await request(combined)
        .put(`/api/ballot/${eventId}/options`)
        .send({ options: [{ game_name: 'Replace A' }, { game_name: 'Replace B' }] });
      expect(replaceRes.status).toBe(200);

      const afterRows = await EventBallotOption.findAll({ where: { event_id: eventId } });
      expect(afterRows.map(o => o.game_name).sort()).toEqual(['Replace A', 'Replace B']);
      expect(afterRows.every(o => o.created_by_uuid === memberCreator.id)).toBe(true);
    });
  });

  describe('PUT /api/events/:id', () => {
    it('should update an event', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      const updateData = {
        duration_minutes: 120,
        comments: 'Updated comment'
      };

      const response = await request(makeApp(testUser1))
        .put(`/api/events/${event.id}`)
        .send(updateData)
        .expect(200);

      expect(response.body.duration_minutes).toBe(updateData.duration_minutes);
      expect(response.body.comments).toBe(updateData.comments);
    });

    it('should update event participants', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      await EventParticipation.create({
        event_id: event.id,
        user_id: testUser1.id, // EventParticipation.user_id is UUID — correct.
        score: 50
      });

      const updateData = {
        participants: [
          {
            user_id: testUser1.id, // UUID — correct.
            score: 100,
            placement: 1
          }
        ]
      };

      const response = await request(makeApp(testUser1))
        .put(`/api/events/${event.id}`)
        .send(updateData)
        .expect(200);

      expect(response.body.EventParticipations.length).toBe(1);
      // score is DECIMAL(10,2); pg/Sequelize serializes it as a string.
      expect(Number(response.body.EventParticipations[0].score)).toBe(100);
    });

    it('should return 404 if event not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(makeApp(testUser1))
        .put(`/api/events/${fakeId}`)
        .send({ duration_minutes: 120 })
        .expect(404);

      expect(response.body.error).toBe('Event not found');
    });
  });

  describe('DELETE /api/events/:id', () => {
    it('should delete an event', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      const response = await request(makeApp(testUser1))
        .delete(`/api/events/${event.id}`)
        .expect(200);

      expect(response.body.message).toBe('Event deleted successfully');

      // Verify event is deleted
      const deletedEvent = await Event.findByPk(event.id);
      expect(deletedEvent).toBeNull();
    });

    it('should delete event and its participations', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed'
      });

      await EventParticipation.create({
        event_id: event.id,
        user_id: testUser1.id, // UUID — correct.
        score: 100
      });

      await request(makeApp(testUser1))
        .delete(`/api/events/${event.id}`)
        .expect(200);

      // Verify participations are deleted
      const participations = await EventParticipation.findAll({
        where: { event_id: event.id }
      });
      expect(participations.length).toBe(0);
    });

    it('should return 404 if event not found', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      const response = await request(makeApp(testUser1))
        .delete(`/api/events/${fakeId}`)
        .expect(404);

      expect(response.body.error).toBe('Event not found');
    });

    // Phase 87 (T-87-08-02): the three destroys are one managed transaction.
    it('rolls back the whole delete set when a mid-delete fails (event + children survive)', async () => {
      const event = await Event.create({
        group_id: testGroup.id,
        game_id: testGame.id,
        start_date: new Date(),
        status: 'completed',
      });
      const ep = await EventParticipation.create({
        event_id: event.id,
        user_id: testUser1.id, // UUID — correct.
        score: 100,
      });

      // Force EventParticipation.destroy — the SECOND destroy, after
      // EventRsvp.destroy — to throw inside the transaction. The managed
      // transaction must roll back so the Event row and its children survive.
      const spy = jest
        .spyOn(EventParticipation, 'destroy')
        .mockRejectedValueOnce(new Error('forced mid-delete failure'));

      const response = await request(makeApp(testUser1))
        .delete(`/api/events/${event.id}`)
        .expect(500);

      expect(response.body).toHaveProperty('error');

      spy.mockRestore();

      // Event row survived the rollback.
      const survivingEvent = await Event.findByPk(event.id);
      expect(survivingEvent).not.toBeNull();

      // Child participation survived too (no partial delete).
      const survivingEp = await EventParticipation.findByPk(ep.id);
      expect(survivingEp).not.toBeNull();
    });
  });
});

// Phase 87 (BINT-02, D-01/D-02/D-06): EventParticipation.user_id protective FK
// → Users.id (UUID PK) with ON DELETE CASCADE. Verifies the sync-side FK
// (rejection + cascade) and the migration-side orphan preclean.
//
// The model-level FK builds on the sync() test DB (models/EventParticipation.js),
// so the rejection/cascade tests are real DB-level assertions here. The orphan
// preclean, however, is CIRCULAR to test end-to-end against the synced schema:
// once the FK exists you CANNOT seed an orphan (the FK rejects it) and the
// migration's ADD CONSTRAINT is a guarded no-op. So the preclean is covered by
// dropping the FK, seeding dirty rows on a raw connection, and running the real
// migration up() (preclean DELETE + guarded re-ADD). Real dirty-data end-to-end
// coverage is the PR CI Postgres `migrate:apply` run (VALIDATION Manual-Only).
describe('EventParticipation.user_id → Users.id FK (Phase 87 BINT-02)', () => {
  let user;
  let event;

  beforeEach(async () => {
    user = await makeUser({ user_id: 'auth0|ep-fk-owner', username: 'ep-fk-owner' });
    const group = await makeGroup({ group_id: 'group-ep-fk', name: 'EP FK Group' });
    const game = await Game.create({ name: 'EP FK Game', is_custom: true });
    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(),
      status: 'scheduled',
    });
  });

  it('rejects an EventParticipation whose user_id is a non-existent Users.id (FK violation)', async () => {
    const orphanUserId = '11111111-1111-1111-1111-111111111111';
    await expect(
      EventParticipation.create({
        event_id: event.id,
        user_id: orphanUserId, // no such Users.id
        score: 10,
      })
    ).rejects.toThrow(); // SequelizeForeignKeyConstraintError from the DB-level FK
  });

  it('cascades: deleting a User removes their EventParticipation rows (ON DELETE CASCADE)', async () => {
    const ep = await EventParticipation.create({
      event_id: event.id,
      user_id: user.id, // valid UUID Users.id
      score: 42,
    });
    expect(ep.id).toBeTruthy();

    // Delete the user; the DB-level ON DELETE CASCADE must remove the EP row.
    await user.destroy();

    const survivors = await EventParticipation.findAll({ where: { id: ep.id } });
    expect(survivors.length).toBe(0);
  });

  it('migration preclean DELETEs only orphan EventParticipation rows, valid rows survive, then re-adds the FK', async () => {
    const qi = sequelize.getQueryInterface();

    // Discover the ACTUAL FK constraint(s) on EventParticipations. On the sync()
    // test DB the FK is named "EventParticipations_user_id_fkey" (Sequelize
    // preserves table case), NOT the lowercase "eventparticipations_user_id_fkey"
    // the migration uses in prod — the two names live in separate environments,
    // so they never collide. We must drop the sync-built one by its real name to
    // seed a dirty (orphan) row. try/finally always restores a working FK for
    // subsequent serial suites (--runInBand; schema is built once per run).
    const preExistingFks = await sequelize.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = '"EventParticipations"'::regclass AND contype = 'f'
         AND conname LIKE '%user_id%'`,
      { type: QueryTypes.SELECT }
    );
    for (const { conname } of preExistingFks) {
      await sequelize.query(
        `ALTER TABLE "EventParticipations" DROP CONSTRAINT IF EXISTS "${conname}"`
      );
    }

    try {
      // Seed 1 VALID EP (real user) + 1 ORPHAN EP (random non-existent user_id).
      // Raw INSERT bypasses model FK metadata (moot here anyway — constraint dropped).
      const validEp = await EventParticipation.create({
        event_id: event.id,
        user_id: user.id,
        score: 1,
      });
      const orphanUserId = '22222222-2222-2222-2222-222222222222';
      const orphanId = require('crypto').randomUUID();
      // Raw INSERT (id generated in JS to avoid any DB uuid-extension dependency).
      await sequelize.query(
        `INSERT INTO "EventParticipations" (id, event_id, user_id, is_new_player, is_guest, "createdAt", "updatedAt")
         VALUES (:id, :event_id, :user_id, false, false, NOW(), NOW())`,
        { replacements: { id: orphanId, event_id: event.id, user_id: orphanUserId }, type: QueryTypes.INSERT }
      );

      // Sanity: both rows present before preclean.
      const before = await EventParticipation.count();
      expect(before).toBe(2);

      // Run the REAL migration up(): orphan preclean DELETE + guarded ADD CONSTRAINT.
      await epUserFkMigration.up(qi);

      // Orphan gone, valid survives.
      const orphanSurvivors = await EventParticipation.findAll({ where: { id: orphanId } });
      expect(orphanSurvivors.length).toBe(0);
      const validSurvivors = await EventParticipation.findAll({ where: { id: validEp.id } });
      expect(validSurvivors.length).toBe(1);

      // FK re-added by the migration → constraint present again.
      const constraint = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: EP_FK_NAME }, type: QueryTypes.SELECT }
      );
      expect(constraint.length).toBe(1);
    } finally {
      // Guarantee the FK exists for the rest of the run even if an assertion threw.
      const stillThere = await sequelize.query(
        `SELECT 1 FROM pg_constraint WHERE conname = :name`,
        { replacements: { name: EP_FK_NAME }, type: QueryTypes.SELECT }
      );
      if (stillThere.length === 0) {
        await sequelize.query(
          `ALTER TABLE "EventParticipations"
             ADD CONSTRAINT "${EP_FK_NAME}"
             FOREIGN KEY (user_id) REFERENCES "Users"(id) ON DELETE CASCADE`
        );
      }
    }
  });
});

// Phase 87.1 (BINT-02, Part B) — EventParticipation UUID consistency assertion.
// EventParticipation was already re-keyed onto Users.id (UUID) with its protective
// FK in Phase 87 Part A (migration 20260701000002). Plan 87.1-02's discretion
// conclusion is that it needs NOTHING beyond a guarding assertion here — this suite
// makes that conclusion executable so a future regression (a revert to the Auth0
// string key, or a dropped FK) fails CI. NO change to models/EventParticipation.js
// or routes/events.js accompanies this test.
describe('EventParticipation UUID consistency (Phase 87.1 BINT-02, Part B — assertion only)', () => {
  it('EventParticipations retains a user FK to Users.id (case-agnostic pg_constraint discovery)', async () => {
    // Case-agnostic: the sync()-built CI DB names the FK "EventParticipations_user_id_fkey"
    // (Sequelize preserves table case) while prod's migration uses the lowercase
    // "eventparticipations_user_id_fkey". ILIKE + regclass + contype matches both — do NOT
    // assert an exact conname.
    const fks = await sequelize.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = '"EventParticipations"'::regclass
          AND contype = 'f'
          AND conname ILIKE '%user_id%'`,
      { type: QueryTypes.SELECT }
    );
    expect(fks.length).toBeGreaterThanOrEqual(1);
  });

  it('the events roster serializes participant user_id as a UUID (Users.id), not an Auth0 string', async () => {
    const owner = await makeUser({ user_id: 'auth0|ep-consistency-owner', username: 'ep-consistency-owner' });
    const group = await makeGroup({ group_id: 'group-ep-consistency', name: 'EP Consistency Group' });
    await addToGroup(owner, group, 'owner');
    const game = await Game.create({ name: 'EP Consistency Game', is_custom: true });
    const event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(),
      status: 'completed',
    });
    // EventParticipation.user_id is the UUID Users.id (Phase 87 Part A re-key).
    await EventParticipation.create({
      event_id: event.id,
      user_id: owner.id,
      score: 7,
    });

    const app = makeApp(owner);
    const res = await request(app).get(`/api/events/${event.id}`);
    expect(res.status).toBe(200);

    // formatEventWithCustomParticipants returns the roster under EventParticipations
    // with `user_id: ep.User?.id` (events.js:26) — i.e. the UUID PK, not the Auth0 string.
    const roster = res.body.EventParticipations || [];
    const mine = roster.find((p) => p.username === 'ep-consistency-owner');
    expect(mine).toBeTruthy();
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(mine.user_id).toMatch(UUID_V4);
    expect(mine.user_id).not.toMatch(/^(google-oauth2|auth0)\|/);
  });
});
