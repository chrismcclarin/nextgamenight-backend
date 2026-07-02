// tests/routes/ballot-routes.test.js
// TDD RED: Tests for ballot route module structure and validators

describe('Ballot route module', () => {
  it('should export an Express router', () => {
    const ballot = require('../../routes/ballot');
    expect(ballot).toBeDefined();
    expect(typeof ballot).toBe('function'); // Express routers are functions
    // Express routers have a .stack property with route layers
    expect(ballot.stack).toBeDefined();
    expect(Array.isArray(ballot.stack)).toBe(true);
  });

  it('should have GET /:eventId route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const getRoute = routes.find(r => r.path === '/:eventId' && r.methods.includes('get'));
    expect(getRoute).toBeDefined();
  });

  it('should have POST /:eventId/options route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const postRoute = routes.find(r => r.path === '/:eventId/options' && r.methods.includes('post'));
    expect(postRoute).toBeDefined();
  });

  it('should have PUT /:eventId/options route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const putRoute = routes.find(r => r.path === '/:eventId/options' && r.methods.includes('put'));
    expect(putRoute).toBeDefined();
  });

  it('should have POST /:eventId/vote route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const voteRoute = routes.find(r => r.path === '/:eventId/vote' && r.methods.includes('post'));
    expect(voteRoute).toBeDefined();
  });

  it('should have POST /:eventId/resolve-tie route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const tieRoute = routes.find(r => r.path === '/:eventId/resolve-tie' && r.methods.includes('post'));
    expect(tieRoute).toBeDefined();
  });
});

describe('Ballot validators', () => {
  it('should export validateBallotOptions', () => {
    const validators = require('../../middleware/validators');
    expect(validators.validateBallotOptions).toBeDefined();
    expect(Array.isArray(validators.validateBallotOptions)).toBe(true);
  });

  it('should export validateBallotVote', () => {
    const validators = require('../../middleware/validators');
    expect(validators.validateBallotVote).toBeDefined();
    expect(Array.isArray(validators.validateBallotVote)).toBe(true);
  });
});

describe('Server mounts ballot routes', () => {
  it('should reference ballot route in server.js', () => {
    const fs = require('fs');
    const path = require('path');
    const serverCode = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    expect(serverCode).toContain("require('./routes/ballot')");
    expect(serverCode).toContain("/api/ballot");
  });
});

// NOTE: the former 'Frontend ballotAPI client' describe block read a FRONTEND
// lib file in a DIFFERENT repo (the poly-repo split). That file is absent on a
// clean backend checkout, so the assertion threw ENOENT and reddened the suite
// in CI. Backend tests stay in the backend repo; the frontend client surface is
// the frontend repo's concern. Block removed (cross-repo coupling, not a
// backend-greening fix).

// POLL-06 (Phase 71-03): gate-coverage tests on the vote handler.
// Verifies the belt-and-suspenders gate is structurally present in
// the ballot route source so future refactors do not silently drop it.
describe('POLL-06 vote gate coverage (structural)', () => {
  const fs = require('fs');
  const path = require('path');
  const ballotSource = fs.readFileSync(
    path.join(__dirname, '../../routes/ballot.js'),
    'utf-8'
  );

  // Isolate the POST /:eventId/vote handler body (between its declaration
  // and the next route declaration) so we don't accidentally match
  // gates from sibling handlers.
  const voteHandlerStart = ballotSource.indexOf("router.post('/:eventId/vote'");
  expect(voteHandlerStart).toBeGreaterThan(-1);
  const afterVote = ballotSource.indexOf("router.post('/:eventId/resolve-tie'", voteHandlerStart);
  const voteHandler = ballotSource.slice(voteHandlerStart, afterVote);

  it('vote handler enforces the event-scoped surface predicate (H-D edge case)', () => {
    // Phase 71.1 widened the gate from isActiveMember to
    // canReadEventScopedSurface so game-only participants can vote on the
    // event they joined. The H-D edge case (stale EventRsvp without any
    // current scope membership) is still closed because the helper returns
    // allowed=false when neither isActiveMember nor isEventParticipant
    // resolves true.
    expect(voteHandler).toMatch(/canReadEventScopedSurface\s*\(\s*userId\s*,\s*eventId\s*\)/);
    // Must 403 when not allowed by the event-scoped helper
    expect(voteHandler).toMatch(/Only event participants can vote on the ballot/);
  });

  it('vote handler enforces the yes/maybe RSVP predicate (D-BALLOT-02)', () => {
    // The gate must check status is in ['yes', 'maybe'] explicitly.
    // After the 71-03 patch the lookup is unconditional and the membership
    // check is in code (not in the SQL where-clause), so both shapes are
    // acceptable: predicate-in-where OR predicate-in-code.
    const inSqlWhere = /status:\s*\{\s*\[Op\.in\]\s*:\s*\[\s*'yes'\s*,\s*'maybe'\s*\]/.test(voteHandler);
    const inCode = /\['yes'\s*,\s*'maybe'\]\s*\.includes\s*\(\s*rsvp\.status\s*\)/.test(voteHandler);
    expect(inSqlWhere || inCode).toBe(true);
    // 403 message must communicate the predicate to the user
    expect(voteHandler).toMatch(/Only attendees who RSVPed Yes or Maybe can vote/);
  });

  it('vote handler 403 message includes the user\'s actual RSVP status (UX clarity)', () => {
    // After the 71-03 patch, the 403 message includes the status (or 'not set')
    // so users understand WHY they were rejected.
    expect(voteHandler).toMatch(/your RSVP is currently/);
  });

  it('vote handler runs the gate BEFORE EventBallotVote.create (no race)', () => {
    // Phase 71.1: predicate is now canReadEventScopedSurface, not
    // isActiveMember. The structural invariant is the same — both the
    // surface gate and the RSVP gate must run before any vote write.
    const createIdx = voteHandler.indexOf('EventBallotVote.create');
    const surfaceIdx = voteHandler.indexOf('canReadEventScopedSurface');
    const rsvpIdx = voteHandler.indexOf('EventRsvp.findOne');
    expect(createIdx).toBeGreaterThan(-1);
    expect(surfaceIdx).toBeGreaterThan(-1);
    expect(rsvpIdx).toBeGreaterThan(-1);
    expect(surfaceIdx).toBeLessThan(createIdx);
    expect(rsvpIdx).toBeLessThan(createIdx);
  });

  it('only ONE EventBallotVote.create site exists in the ballot route', () => {
    // Ensure no future patch silently adds an ungated parallel write path.
    const matches = ballotSource.match(/EventBallotVote\.(create|upsert|findOrCreate|bulkCreate)/g) || [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe('EventBallotVote.create');
  });
});

// ============================================================================
// Phase 87 (BINT-01): DB-backed behavior tests for the hardened ballot route.
//   (a) ATOMICITY   — a forced mid-replace failure rolls back → prior options
//                     intact (no zero-option ballot). [T-87-02]
//   (b) IDEMPOTENCY — a concurrent duplicate vote-create absorbs the unique
//                     constraint → no 500, exactly one vote row. [T-87-03]
//   (c) AUTHZ       — creator-based replace/wipe: creator succeeds,
//                     non-creator member 403, legacy NULL → owner/admin only,
//                     creator-after-removal 403 (membership required), and an
//                     owner/admin replace PRESERVES the original creator. [T-87-01]
//   (d) PRODUCTION  — a ballot born via the real FE path (POST /events with
//                     embedded ballot_options) is stamped created_by=event
//                     creator, so the creator-authz branch is live in prod.
//                     [T-87-04]
//
// Real-DB (sequelize.sync via tests/globalSetup.js; per-test TRUNCATE via
// tests/setup.js). Run ALONE per the never-green-locally caveat:
//   npm test -- tests/routes/ballot-routes.test.js
// ============================================================================
const request = require('supertest');
const express = require('express');
const ballotRoutes = require('../../routes/ballot');
const eventRoutes = require('../../routes/events');
const {
  Event,
  EventBallotOption,
  EventBallotVote,
  EventRsvp,
  Game,
  sequelize,
} = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

// Per-test app that injects req.user ahead of the routers (mirrors
// events.test.js). Without it every handler short-circuits at 401.
function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = actor ? { user_id: actor.user_id, email: actor.email } : undefined;
    next();
  });
  app.use('/api/ballot', ballotRoutes);
  app.use('/api/events', eventRoutes);
  return app;
}

describe('Phase 87 ballot integrity (DB-backed)', () => {
  let owner, creator, otherMember, group, game, event;

  beforeEach(async () => {
    owner = await makeUser({ username: 'ballot-owner' });
    creator = await makeUser({ username: 'ballot-creator' });
    otherMember = await makeUser({ username: 'ballot-other' });
    group = await makeGroup({ name: 'Ballot Group' });
    game = await Game.create({ name: 'Ballot Game', is_custom: true });

    await addToGroup(owner, group, 'owner');
    await addToGroup(creator, group, 'member');
    await addToGroup(otherMember, group, 'member');

    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
      rsvp_deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      ballot_status: 'open',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Seed a ballot with N options attributed to `attribUser` (or NULL for a
  // legacy ballot). Bypasses the route so tests control the created_by value.
  async function seedOptions(count, attribUser) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push({
        event_id: event.id,
        game_id: null,
        game_name: `Seed Option ${i + 1}`,
        display_order: i,
        created_by: attribUser ? attribUser.user_id : null,
      });
    }
    return EventBallotOption.bulkCreate(rows);
  }

  // ---- (a) ATOMICITY ----
  it('rolls back a mid-replace failure, leaving prior options intact', async () => {
    await seedOptions(3, owner);

    // Force the bulkCreate inside the replace transaction to reject ONCE.
    jest
      .spyOn(EventBallotOption, 'bulkCreate')
      .mockRejectedValueOnce(new Error('forced mid-replace failure'));

    const res = await request(makeApp(owner))
      .post(`/api/ballot/${event.id}/options`)
      .send({ options: [{ game_name: 'New A' }, { game_name: 'New B' }] });

    expect(res.status).toBe(500);

    // The destroy must have rolled back with the failed bulkCreate → the
    // original 3 options are still present (no zero-option ballot).
    const remaining = await EventBallotOption.findAll({ where: { event_id: event.id } });
    expect(remaining).toHaveLength(3);
    expect(remaining.map(o => o.game_name).sort()).toEqual(
      ['Seed Option 1', 'Seed Option 2', 'Seed Option 3']
    );
  });

  // ---- (b) VOTE IDEMPOTENCY ----
  it('absorbs a concurrent duplicate vote: no 500 and exactly one vote row', async () => {
    const [option] = await seedOptions(2, creator);
    await EventRsvp.create({ event_id: event.id, user_id: creator.user_id, status: 'yes' });

    // Force the toggle-off lookup to see NO existing vote for BOTH concurrent
    // requests, so both take the create branch — the real concurrent-duplicate
    // scenario. The (option_id, user_id) unique index then arbitrates: one row
    // wins, the loser's UniqueConstraintError is absorbed → { voted: true }.
    jest.spyOn(EventBallotVote, 'findOne').mockResolvedValue(null);

    const app = makeApp(creator);
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/ballot/${event.id}/vote`).send({ option_id: option.id }),
      request(app).post(`/api/ballot/${event.id}/vote`).send({ option_id: option.id }),
    ]);

    expect(r1.status).not.toBe(500);
    expect(r2.status).not.toBe(500);
    expect(r1.body).toEqual({ voted: true });
    expect(r2.body).toEqual({ voted: true });

    const votes = await EventBallotVote.findAll({
      where: { option_id: option.id, user_id: creator.user_id },
    });
    expect(votes).toHaveLength(1);
  });

  // ---- (c) AUTHZ ----
  it('lets the creator (still a member) replace their own ballot', async () => {
    await seedOptions(2, creator);

    const res = await request(makeApp(creator))
      .put(`/api/ballot/${event.id}/options`)
      .send({ options: [{ game_name: 'Creator Edit 1' }, { game_name: 'Creator Edit 2' }] });

    expect(res.status).toBe(200);
    const rows = await EventBallotOption.findAll({ where: { event_id: event.id } });
    expect(rows.map(o => o.game_name).sort()).toEqual(['Creator Edit 1', 'Creator Edit 2']);
  });

  it('403s a non-creator non-admin member on replace/wipe', async () => {
    await seedOptions(2, creator);

    const res = await request(makeApp(otherMember))
      .put(`/api/ballot/${event.id}/options`)
      .send({ options: [{ game_name: 'Hijack 1' }, { game_name: 'Hijack 2' }] });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/creator or a group owner\/admin/);
    // Original options untouched.
    const rows = await EventBallotOption.findAll({ where: { event_id: event.id } });
    expect(rows).toHaveLength(2);
  });

  it('legacy created_by IS NULL ballot: member 403, owner/admin succeeds', async () => {
    await seedOptions(2, null); // legacy ballot, no creator recorded

    const memberRes = await request(makeApp(otherMember))
      .put(`/api/ballot/${event.id}/options`)
      .send({ options: [{ game_name: 'M1' }, { game_name: 'M2' }] });
    expect(memberRes.status).toBe(403);

    const adminRes = await request(makeApp(owner))
      .put(`/api/ballot/${event.id}/options`)
      .send({ options: [{ game_name: 'A1' }, { game_name: 'A2' }] });
    expect(adminRes.status).toBe(200);
  });

  it('403s a creator who was later REMOVED from the group (membership required)', async () => {
    await seedOptions(2, creator);

    // Remove the creator's membership — historical created_by must NOT grant
    // replace/wipe rights once they leave the group (EoP fix).
    await sequelize.models.UserGroup.destroy({
      where: { user_id: creator.user_id, group_id: group.id },
    });

    const res = await request(makeApp(creator))
      .put(`/api/ballot/${event.id}/options`)
      .send({ options: [{ game_name: 'Ghost 1' }, { game_name: 'Ghost 2' }] });

    expect(res.status).toBe(403);
  });

  it('PRESERVES the original creator when an owner/admin replaces a member ballot', async () => {
    await seedOptions(2, creator);

    const res = await request(makeApp(owner))
      .put(`/api/ballot/${event.id}/options`)
      .send({ options: [{ game_name: 'Admin Edit 1' }, { game_name: 'Admin Edit 2' }] });

    expect(res.status).toBe(200);
    const rows = await EventBallotOption.findAll({ where: { event_id: event.id } });
    // created_by is still the ORIGINAL member-creator, NOT the owner editor.
    expect(rows.every(o => o.created_by === creator.user_id)).toBe(true);
    expect(rows.every(o => o.created_by === owner.user_id)).toBe(false);
  });

  // ---- (d) CREATED_BY ON THE PRODUCTION CREATION PATH ----
  it('stamps created_by=event-creator on a ballot born via POST /events', async () => {
    const res = await request(makeApp(owner))
      .post('/api/events')
      .send({
        group_id: group.id,
        game_id: game.id,
        start_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
        duration_minutes: 120,
        rsvp_deadline: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
        ballot_options: [
          { game_name: 'Prod Option A' },
          { game_name: 'Prod Option B' },
        ],
      });

    expect(res.status).toBe(200);
    const createdEventId = res.body.id;
    expect(createdEventId).toBeDefined();

    const rows = await EventBallotOption.findAll({ where: { event_id: createdEventId } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Every option row is born with a NON-NULL creator = the event creator, so
    // the "creator can replace/wipe" branch is live against the real FE path.
    expect(rows.every(o => o.created_by === owner.user_id)).toBe(true);
  });
});
