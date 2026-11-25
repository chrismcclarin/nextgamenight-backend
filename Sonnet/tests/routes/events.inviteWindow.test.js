// tests/routes/events.inviteWindow.test.js
// Phase 89.6-28 (X42 backend twin, plan review R1 D3, D10, D18): the invite preview and
// join-by-token answer 410 'already passed' only once the night is OVER (isNightOver), not at its
// start, so a Share Game QR scanned while the night runs still joins. Starts are staged relative to
// the real clock (no fake timers under supertest), with a wide margin on each side of every edge.
const request = require('supertest');
const express = require('express');

// The join route's outbound services are stubbed so no mail, calendar or network call leaves the
// test (the events.lifecycle.test.js shape).
const mockSendGameJoinConfirmation = jest.fn(() => Promise.resolve({ success: true }));
jest.mock('../../services/emailService', () => {
  const real = jest.requireActual('../../services/emailService');
  real.send = jest.fn(() => Promise.resolve({ success: true }));
  real.sendGameJoinConfirmation = (...args) => mockSendGameJoinConfirmation(...args);
  return real;
});
jest.mock('../../services/notificationService', () => ({
  sendToMany: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../services/googleCalendarService', () => ({}));

const eventRoutes = require('../../routes/events');
const { Event, Game } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

const MIN = 60 * 1000;
const PASSED = { error: 'This game night has already passed', expired: true };

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

describe('invite preview and join-by-token: the join window (Phase 89.6-28, X42 backend twin)', () => {
  let host, joiner, group, game;

  beforeEach(async () => {
    host = await makeUser({ user_id: 'test-user-invite-window-host', username: 'invitewindowhost' });
    // The joiner is a real user who is NOT a member of the group.
    joiner = await makeUser({ user_id: 'test-user-invite-window-joiner', username: 'invitewindowjoiner' });
    group = await makeGroup({ group_id: 'test-group-invite-window', name: 'Invite Window Group' });
    await addToGroup(host, group, 'owner');
    game = await Game.create({ name: 'Invite Window Game', is_custom: true });
    mockSendGameJoinConfirmation.mockClear();
  });

  const stage = async ({ startOffsetMin, duration = null, status = 'scheduled', token }) =>
    Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(Date.now() + startOffsetMin * MIN),
      duration_minutes: duration,
      status,
      invite_token: token,
    });

  const cases = [
    { name: 'started an hour ago, 180 minutes long: still running', startOffsetMin: -60, duration: 180, expected: 200 },
    { name: 'started 130 minutes ago, 120 minutes long: over', startOffsetMin: -130, duration: 120, expected: 410 },
    { name: 'started seven hours ago, no stored length: still running (eight-hour default)', startOffsetMin: -7 * 60, duration: null, expected: 200 },
    { name: 'started eight hours and a minute ago, no stored length: over', startOffsetMin: -(8 * 60 + 1), duration: null, expected: 410 },
    { name: 'cancelled, started an hour ago: over', startOffsetMin: -60, duration: 180, status: 'cancelled', expected: 410 },
    { name: 'starts in an hour: open', startOffsetMin: 60, duration: 180, expected: 200 },
    { name: 'cancelled, starts in an hour: open (unchanged from before)', startOffsetMin: 60, duration: 180, status: 'cancelled', expected: 200 },
  ];

  describe('GET /api/events/invite-preview/:token', () => {
    test.each(cases)('$name -> $expected', async ({ startOffsetMin, duration, status, expected }) => {
      const event = await stage({ startOffsetMin, duration, status, token: 'invite-window-preview-token' });
      const res = await request(makeApp(null)).get('/api/events/invite-preview/invite-window-preview-token');
      expect(res.status).toBe(expected);
      if (expected === 410) expect(res.body).toEqual(PASSED);
      else expect(res.body.event_id).toBe(event.id);
    });
  });

  describe('POST /api/events/join-game-by-token', () => {
    test.each(cases)('$name -> $expected', async ({ startOffsetMin, duration, status, expected }) => {
      const event = await stage({ startOffsetMin, duration, status, token: 'invite-window-join-token' });
      const res = await request(makeApp(joiner)).post('/api/events/join-game-by-token').send({ token: 'invite-window-join-token' });
      expect(res.status).toBe(expected);
      if (expected === 410) expect(res.body).toEqual(PASSED);
      else expect(res.body.event_id).toBe(event.id);
    });
  });
});
