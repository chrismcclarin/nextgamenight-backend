// tests/routes/groups.leave-cascade.test.js
// Phase 71.1-02 (post-checkpoint scope expansion):
//   Verify the leave-group cascade deletes a user's per-event rows on FUTURE
//   events of the group they leave (or are removed from), while preserving
//   past/completed event history and other users' rows on the same events.
//
// Cascade tables (FK type asymmetry preserved — load-bearing):
//   - EventParticipation.user_id  = UUID    (User.id)
//   - EventRsvp.user_id           = STRING  (Auth0 user_id)
//   - EventBring.user_id          = STRING  (Auth0 user_id)
//   - EventBallotVote.user_id     = STRING  (Auth0 user_id) — joined to event
//                                          via EventBallotOption.event_id
//
// Auth0 middleware is short-circuited by injecting `req.user` ahead of the
// router (matches the polls.test.js / events.lifecycle.test.js pattern).
// New file (separate from tests/routes/groups.test.js) so this suite can
// inject req.user without disturbing the existing fixture chain there.
const request = require('supertest');
const express = require('express');

const groupRoutes = require('../../routes/groups');
const {
  Group,
  User,
  UserGroup,
  Event,
  Game,
  EventParticipation,
  EventRsvp,
  EventBring,
  EventBallotOption,
  EventBallotVote,
  sequelize,
} = require('../../models');

// Helper: build a test app that injects req.user (no real Auth0).
function makeApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: userId, email: `${userId}@example.com` };
    next();
  });
  app.use('/api/groups', groupRoutes);
  return app;
}

describe('Group leave cascade (Phase 71.1-02)', () => {
  // Pin user_ids so cleanup-by-user_id is deterministic across runs.
  const owner = { user_id: 'auth0|leave-cascade-owner', username: 'cascadeowner', email: 'cascade-owner@example.com' };
  const leaver = { user_id: 'auth0|leave-cascade-leaver', username: 'cascadeleaver', email: 'cascade-leaver@example.com' };
  const bystander = { user_id: 'auth0|leave-cascade-bystander', username: 'cascadebystander', email: 'cascade-bystander@example.com' };

  let group;
  let game;
  let leaverRow;
  let bystanderRow;
  let futureEvent;
  let pastEvent;

  // Tear down every cascadable row + the fixture entities before each test
  // so the cascade-effect assertions are not contaminated by sibling tests.
  async function clearAll() {
    await EventBallotVote.destroy({ where: {} });
    await EventBallotOption.destroy({ where: {} });
    await EventBring.destroy({ where: {} });
    await EventRsvp.destroy({ where: {} });
    await EventParticipation.destroy({ where: {} });
    await Event.destroy({ where: {} });
    await UserGroup.destroy({ where: {} });
    await Group.destroy({ where: {} });
    await User.destroy({ where: { user_id: [owner.user_id, leaver.user_id, bystander.user_id] } });
    await Game.destroy({ where: { is_custom: true, name: 'CascadeTestGame' } });
  }

  beforeAll(async () => {
    await sequelize.sync();
  });

  // Note: do NOT call sequelize.close() in afterAll — tests/setup.js owns the
  // shared connection lifecycle. Closing here would break other test files
  // that run after this one in the same Jest process.

  beforeEach(async () => {
    await clearAll();

    // Create users
    await User.create(owner);
    leaverRow = await User.create(leaver);
    bystanderRow = await User.create(bystander);

    // Create a group (Group.id is a UUID, group_id is a STRING handle —
    // routes use the UUID path param so we use group.id throughout)
    group = await Group.create({
      group_id: `cascade-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      name: 'CascadeTestGroup',
    });
    game = await Game.create({ name: 'CascadeTestGame', is_custom: true });

    await UserGroup.create({ user_id: owner.user_id, group_id: group.id, status: 'active', role: 'owner' });
    await UserGroup.create({ user_id: leaver.user_id, group_id: group.id, status: 'active', role: 'member' });
    await UserGroup.create({ user_id: bystander.user_id, group_id: group.id, status: 'active', role: 'member' });

    // Future event (cascade target) — start_date > NOW() AND status='scheduled'
    futureEvent = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // +7 days
      duration_minutes: 120,
      status: 'scheduled',
    });

    // Past event (cascade MUST NOT touch) — start_date < NOW(), status='completed'
    pastEvent = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // -7 days
      duration_minutes: 120,
      status: 'completed',
    });

    // Seed cascade rows on the FUTURE event for the leaver across all four tables.
    // (User_id type asymmetry intentional: EventParticipation = UUID, others = Auth0 STRING.)
    await EventParticipation.create({ event_id: futureEvent.id, user_id: leaverRow.id, score: null });
    await EventRsvp.create({ event_id: futureEvent.id, user_id: leaver.user_id, status: 'yes' });
    await EventBring.create({ event_id: futureEvent.id, user_id: leaver.user_id, game_id: game.id });
    const futureOption = await EventBallotOption.create({ event_id: futureEvent.id, game_id: game.id, game_name: game.name, display_order: 0 });
    await EventBallotVote.create({ option_id: futureOption.id, user_id: leaver.user_id });

    // Seed identical rows on the PAST event for the leaver — these MUST be preserved.
    await EventParticipation.create({ event_id: pastEvent.id, user_id: leaverRow.id, score: 5 });
    await EventRsvp.create({ event_id: pastEvent.id, user_id: leaver.user_id, status: 'yes' });
    await EventBring.create({ event_id: pastEvent.id, user_id: leaver.user_id, game_id: game.id });
    const pastOption = await EventBallotOption.create({ event_id: pastEvent.id, game_id: game.id, game_name: game.name, display_order: 0 });
    await EventBallotVote.create({ option_id: pastOption.id, user_id: leaver.user_id });

    // Seed bystander rows on the FUTURE event — these MUST NOT be touched.
    await EventParticipation.create({ event_id: futureEvent.id, user_id: bystanderRow.id, score: null });
    await EventRsvp.create({ event_id: futureEvent.id, user_id: bystander.user_id, status: 'yes' });
    await EventBring.create({ event_id: futureEvent.id, user_id: bystander.user_id, game_id: game.id });
    await EventBallotVote.create({ option_id: futureOption.id, user_id: bystander.user_id });
  });

  describe('POST /api/groups/:group_id/leave (self-leave)', () => {
    it('cascades future-event rows for the leaving user across all four tables', async () => {
      const app = makeApp(leaver.user_id);
      const res = await request(app).post(`/api/groups/${group.id}/leave`).send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({ success: true }));

      // Membership row gone
      const remainingMembership = await UserGroup.findOne({
        where: { user_id: leaver.user_id, group_id: group.id },
      });
      expect(remainingMembership).toBeNull();

      // Future-event rows for leaver: ALL deleted
      expect(
        await EventParticipation.count({ where: { event_id: futureEvent.id, user_id: leaverRow.id } })
      ).toBe(0);
      expect(
        await EventRsvp.count({ where: { event_id: futureEvent.id, user_id: leaver.user_id } })
      ).toBe(0);
      expect(
        await EventBring.count({ where: { event_id: futureEvent.id, user_id: leaver.user_id } })
      ).toBe(0);
      const futureOptions = await EventBallotOption.findAll({
        where: { event_id: futureEvent.id }, attributes: ['id'],
      });
      expect(
        await EventBallotVote.count({
          where: { option_id: futureOptions.map(o => o.id), user_id: leaver.user_id },
        })
      ).toBe(0);
    });

    it('preserves past-event rows for the leaving user (history is sacred)', async () => {
      const app = makeApp(leaver.user_id);
      await request(app).post(`/api/groups/${group.id}/leave`).send().expect(200);

      expect(
        await EventParticipation.count({ where: { event_id: pastEvent.id, user_id: leaverRow.id } })
      ).toBe(1);
      expect(
        await EventRsvp.count({ where: { event_id: pastEvent.id, user_id: leaver.user_id } })
      ).toBe(1);
      expect(
        await EventBring.count({ where: { event_id: pastEvent.id, user_id: leaver.user_id } })
      ).toBe(1);
      const pastOptions = await EventBallotOption.findAll({
        where: { event_id: pastEvent.id }, attributes: ['id'],
      });
      expect(
        await EventBallotVote.count({
          where: { option_id: pastOptions.map(o => o.id), user_id: leaver.user_id },
        })
      ).toBeGreaterThanOrEqual(1);
    });

    it("cascades future events regardless of status (defends against data-corrupt 'completed' future events)", async () => {
      // Production data has been observed with future events stamped
      // status='completed' (data hygiene bug, separate todo). The cascade
      // scope must rely on start_date alone — a status filter would let
      // these slip through and orphan the user's forward-commitment rows.
      const corruptedFutureEvent = await Event.create({
        group_id: group.id,
        game_id: game.id,
        start_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // +14 days
        duration_minutes: 120,
        status: 'completed', // ← the corruption: future event marked completed
      });
      await EventParticipation.create({ event_id: corruptedFutureEvent.id, user_id: leaverRow.id, score: null });
      await EventRsvp.create({ event_id: corruptedFutureEvent.id, user_id: leaver.user_id, status: 'yes' });
      await EventBring.create({ event_id: corruptedFutureEvent.id, user_id: leaver.user_id, game_id: game.id });

      const app = makeApp(leaver.user_id);
      await request(app).post(`/api/groups/${group.id}/leave`).send().expect(200);

      expect(
        await EventParticipation.count({ where: { event_id: corruptedFutureEvent.id, user_id: leaverRow.id } })
      ).toBe(0);
      expect(
        await EventRsvp.count({ where: { event_id: corruptedFutureEvent.id, user_id: leaver.user_id } })
      ).toBe(0);
      expect(
        await EventBring.count({ where: { event_id: corruptedFutureEvent.id, user_id: leaver.user_id } })
      ).toBe(0);
    });

    it("does not touch other users' rows on the same future event", async () => {
      const app = makeApp(leaver.user_id);
      await request(app).post(`/api/groups/${group.id}/leave`).send().expect(200);

      expect(
        await EventParticipation.count({ where: { event_id: futureEvent.id, user_id: bystanderRow.id } })
      ).toBe(1);
      expect(
        await EventRsvp.count({ where: { event_id: futureEvent.id, user_id: bystander.user_id } })
      ).toBe(1);
      expect(
        await EventBring.count({ where: { event_id: futureEvent.id, user_id: bystander.user_id } })
      ).toBe(1);
      const futureOptions = await EventBallotOption.findAll({
        where: { event_id: futureEvent.id }, attributes: ['id'],
      });
      expect(
        await EventBallotVote.count({
          where: { option_id: futureOptions.map(o => o.id), user_id: bystander.user_id },
        })
      ).toBe(1);
    });
  });

  describe('DELETE /api/groups/:group_id/users/:target_user_id (admin removal)', () => {
    it('cascades future-event rows for the removed user (same cascade as self-leave)', async () => {
      const app = makeApp(owner.user_id);
      const res = await request(app)
        .delete(`/api/groups/${group.id}/users/${leaver.user_id}`)
        .send();
      expect(res.status).toBe(200);

      // Membership row gone
      const remainingMembership = await UserGroup.findOne({
        where: { user_id: leaver.user_id, group_id: group.id },
      });
      expect(remainingMembership).toBeNull();

      // Future-event rows for removed user: ALL deleted across the four cascade tables
      expect(
        await EventParticipation.count({ where: { event_id: futureEvent.id, user_id: leaverRow.id } })
      ).toBe(0);
      expect(
        await EventRsvp.count({ where: { event_id: futureEvent.id, user_id: leaver.user_id } })
      ).toBe(0);
      expect(
        await EventBring.count({ where: { event_id: futureEvent.id, user_id: leaver.user_id } })
      ).toBe(0);
      const futureOptions = await EventBallotOption.findAll({
        where: { event_id: futureEvent.id }, attributes: ['id'],
      });
      expect(
        await EventBallotVote.count({
          where: { option_id: futureOptions.map(o => o.id), user_id: leaver.user_id },
        })
      ).toBe(0);

      // Past-event rows preserved
      expect(
        await EventParticipation.count({ where: { event_id: pastEvent.id, user_id: leaverRow.id } })
      ).toBe(1);

      // Bystander untouched on the future event
      expect(
        await EventParticipation.count({ where: { event_id: futureEvent.id, user_id: bystanderRow.id } })
      ).toBe(1);
    });
  });
});
