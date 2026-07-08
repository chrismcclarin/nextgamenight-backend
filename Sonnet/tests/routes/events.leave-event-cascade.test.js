// tests/routes/events.leave-event-cascade.test.js
// Phase 71.1-02 (post-checkpoint scope expansion):
//   Verify the leave-event cascade — DELETE /events/:event_id/participations/:user_id
//   deletes the user's RSVP / EventBring / EventBallotVote rows on that
//   event in addition to the EventParticipation row, while preserving the
//   audit-log write (EVT-08 silent-welcome-back contract from Phase 65-01).
//
// Game-only participants have no group membership to leave from, so this
// endpoint is their only exit. Without the cascade their forward-commitment
// rows orphan and remain visible to organizers (the bug surfaced during
// Phase 71.1-02 UAT after the leave-GROUP cascade landed).
//
// User_id type asymmetry preserved (load-bearing):
//   - EventParticipation.user_id  = UUID    (User.id)
//   - EventRsvp.user_id           = STRING  (Auth0 user_id)
//   - EventBring.user_id          = STRING  (Auth0 user_id)
//   - EventBallotVote.user_id     = STRING  (Auth0 user_id) joined via
//                                          EventBallotOption.event_id
//
// Auth0 middleware is short-circuited by injecting `req.user` ahead of the
// router (matches the polls.test.js / events.lifecycle.test.js / groups
// leave-cascade pattern). New file (separate from tests/routes/events.test.js)
// so this suite can inject req.user without disturbing the existing fixture
// chain there (events.test.js has pre-existing UserGroup user_id schema
// failures documented in the 71.1 deferred-items.md).
const request = require('supertest');
const express = require('express');

const eventRoutes = require('../../routes/events');
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
  EventAuditLog,
  sequelize,
} = require('../../models');

function makeApp(userId) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: userId, email: `${userId}@example.com` };
    next();
  });
  app.use('/api/events', eventRoutes);
  return app;
}

describe('Leave-event cascade (Phase 71.1-02)', () => {
  const owner = { user_id: 'auth0|leave-evt-owner', username: 'evtowner', email: 'evt-owner@example.com' };
  const leaver = { user_id: 'auth0|leave-evt-leaver', username: 'evtleaver', email: 'evt-leaver@example.com' };
  const bystander = { user_id: 'auth0|leave-evt-bystander', username: 'evtbystander', email: 'evt-bystander@example.com' };

  let group;
  let game;
  let ownerRow;
  let leaverRow;
  let bystanderRow;
  let event;
  let ballotOption;

  async function clearAll() {
    await EventBallotVote.destroy({ where: {} });
    await EventBallotOption.destroy({ where: {} });
    await EventBring.destroy({ where: {} });
    await EventRsvp.destroy({ where: {} });
    await EventAuditLog.destroy({ where: {} });
    await EventParticipation.destroy({ where: {} });
    await Event.destroy({ where: {} });
    await UserGroup.destroy({ where: {} });
    await Group.destroy({ where: {} });
    await User.destroy({ where: { user_id: [owner.user_id, leaver.user_id, bystander.user_id] } });
    await Game.destroy({ where: { is_custom: true, name: 'LeaveEvtCascadeGame' } });
  }

  // Schema is built once by the plan-01 globalSetup (D-02); a per-suite
  // sequelize.sync() is redundant here and a stray no-arg sync can race the
  // harness, so it has been removed (owned by plan 83.1-03).

  beforeEach(async () => {
    await clearAll();

    ownerRow = await User.create(owner);
    leaverRow = await User.create(leaver);
    bystanderRow = await User.create(bystander);

    group = await Group.create({
      group_id: `leave-evt-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      name: 'LeaveEvtCascadeGroup',
    });
    game = await Game.create({ name: 'LeaveEvtCascadeGame', is_custom: true });

    // Phase 87.1: getUserRoleInGroup (Plan 04) queries UserGroup by user_uuid, so
    // owner-initiated authz needs the membership seeds to dual-write user_uuid.
    await UserGroup.create({ user_uuid: ownerRow.id, group_id: group.id, status: 'active', role: 'owner' });
    await UserGroup.create({ user_uuid: bystanderRow.id, group_id: group.id, status: 'active', role: 'member' });
    // leaver is intentionally NOT a group member — game-only participant flow.

    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      duration_minutes: 120,
      status: 'scheduled',
    });

    // Seed leaver's per-event rows across all four cascade tables. Phase 87.1:
    // the cascade destroys key user_uuid, so dual-write it (= User.id) alongside
    // the old Auth0-string user_id.
    await EventParticipation.create({ event_id: event.id, user_id: leaverRow.id, is_guest: true });
    await EventRsvp.create({ event_id: event.id, user_uuid: leaverRow.id, status: 'yes' });
    await EventBring.create({ event_id: event.id, user_uuid: leaverRow.id, game_id: game.id });
    ballotOption = await EventBallotOption.create({
      event_id: event.id, game_id: game.id, game_name: game.name, display_order: 0,
    });
    await EventBallotVote.create({ option_id: ballotOption.id, user_uuid: leaverRow.id });

    // Seed bystander rows on the same event — must NOT be touched.
    await EventParticipation.create({ event_id: event.id, user_id: bystanderRow.id });
    await EventRsvp.create({ event_id: event.id, user_uuid: bystanderRow.id, status: 'yes' });
    await EventBring.create({ event_id: event.id, user_uuid: bystanderRow.id, game_id: game.id });
    await EventBallotVote.create({ option_id: ballotOption.id, user_uuid: bystanderRow.id });
  });

  it('cascades the leaving user’s RSVP / EventBring / EventBallotVote rows on the event (self-leave)', async () => {
    const app = makeApp(leaver.user_id);
    const res = await request(app)
      .delete(`/api/events/${event.id}/participations/${leaverRow.id}`)
      .send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true }));

    expect(await EventParticipation.count({ where: { event_id: event.id, user_id: leaverRow.id } })).toBe(0);
    expect(await EventRsvp.count({ where: { event_id: event.id, user_uuid: leaverRow.id } })).toBe(0);
    expect(await EventBring.count({ where: { event_id: event.id, user_uuid: leaverRow.id } })).toBe(0);
    expect(
      await EventBallotVote.count({ where: { option_id: ballotOption.id, user_uuid: leaverRow.id } })
    ).toBe(0);
  });

  it('preserves the EVT-08 audit log row (silent-welcome-back contract from Phase 65-01)', async () => {
    const app = makeApp(leaver.user_id);
    await request(app)
      .delete(`/api/events/${event.id}/participations/${leaverRow.id}`)
      .send()
      .expect(200);

    const auditRows = await EventAuditLog.findAll({
      where: { event_id: event.id, action: 'remove_participant' },
    });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].event_snapshot).toEqual(
      expect.objectContaining({ removed_user_id: leaverRow.id })
    );
  });

  it('does not touch the bystander’s rows on the same event', async () => {
    const app = makeApp(leaver.user_id);
    await request(app)
      .delete(`/api/events/${event.id}/participations/${leaverRow.id}`)
      .send()
      .expect(200);

    expect(await EventParticipation.count({ where: { event_id: event.id, user_id: bystanderRow.id } })).toBe(1);
    expect(await EventRsvp.count({ where: { event_id: event.id, user_uuid: bystanderRow.id } })).toBe(1);
    expect(await EventBring.count({ where: { event_id: event.id, user_uuid: bystanderRow.id } })).toBe(1);
    expect(
      await EventBallotVote.count({ where: { option_id: ballotOption.id, user_uuid: bystanderRow.id } })
    ).toBe(1);
  });

  it('PUT /events/:id (Edit Event) cascades RSVP/brings/votes for diff-removed participants', async () => {
    // Edit Event uses PUT /:id with a participants array. The handler does
    // destroy-then-recreate; participants omitted from the new array are
    // implicitly removed. This test covers the third cascade trigger:
    // organizer removes someone via Edit Event rather than the per-row
    // Remove control or Leave Event.
    const app = makeApp(owner.user_id);

    // Submit Edit Event with leaver omitted from participants array.
    // Bystander is kept. Backend destroys all then recreates only kept ones.
    const res = await request(app)
      .put(`/api/events/${event.id}`)
      .send({
        game_id: game.id,
        start_date: event.start_date.toISOString(),
        duration_minutes: 120,
        is_group_win: false,
        comments: '',
        participants: [
          { user_id: bystanderRow.id, score: null, faction: null, is_new_player: false, placement: null },
        ],
        custom_participants: [],
      });
    expect(res.status).toBe(200);

    // Leaver's participation gone (destroy-then-recreate left them out)
    expect(await EventParticipation.count({ where: { event_id: event.id, user_id: leaverRow.id } })).toBe(0);
    // Cascade fired for diff-removed leaver: RSVP/brings/votes also gone
    expect(await EventRsvp.count({ where: { event_id: event.id, user_uuid: leaverRow.id } })).toBe(0);
    expect(await EventBring.count({ where: { event_id: event.id, user_uuid: leaverRow.id } })).toBe(0);
    expect(
      await EventBallotVote.count({ where: { option_id: ballotOption.id, user_uuid: leaverRow.id } })
    ).toBe(0);

    // Bystander preserved across all tables (kept in the new participants array)
    expect(await EventParticipation.count({ where: { event_id: event.id, user_id: bystanderRow.id } })).toBe(1);
    expect(await EventRsvp.count({ where: { event_id: event.id, user_uuid: bystanderRow.id } })).toBe(1);
    expect(await EventBring.count({ where: { event_id: event.id, user_uuid: bystanderRow.id } })).toBe(1);
    expect(
      await EventBallotVote.count({ where: { option_id: ballotOption.id, user_uuid: bystanderRow.id } })
    ).toBe(1);

    // Audit log written for the diff-removed leaver (EVT-08 contract parity)
    const auditRows = await EventAuditLog.findAll({
      where: { event_id: event.id, action: 'remove_participant' },
    });
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].event_snapshot).toEqual(
      expect.objectContaining({ removed_user_id: leaverRow.id })
    );
  });

  it('owner removing a game-only participant cascades the same four tables', async () => {
    const app = makeApp(owner.user_id);
    const res = await request(app)
      .delete(`/api/events/${event.id}/participations/${leaverRow.id}`)
      .send();
    expect(res.status).toBe(200);

    expect(await EventParticipation.count({ where: { event_id: event.id, user_id: leaverRow.id } })).toBe(0);
    expect(await EventRsvp.count({ where: { event_id: event.id, user_uuid: leaverRow.id } })).toBe(0);
    expect(await EventBring.count({ where: { event_id: event.id, user_uuid: leaverRow.id } })).toBe(0);
    expect(
      await EventBallotVote.count({ where: { option_id: ballotOption.id, user_uuid: leaverRow.id } })
    ).toBe(0);

    // Bystander untouched
    expect(await EventParticipation.count({ where: { event_id: event.id, user_id: bystanderRow.id } })).toBe(1);
  });
});
