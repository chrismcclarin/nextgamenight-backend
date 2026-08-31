// tests/routes/events.colour.test.js
//
// Phase 88.3.1 — code review findings #11 / #14.
//
// WHY THIS FILE EXISTS. `color_preset` reaches THREE of the six frontend colour
// consumers — `CalendarMonthView.js:294`, `CalendarListView.js:745` and
// `EventDayModal.js:135`, which all read `storedGroupColour(event.Group)` — and it
// reaches them through exactly two lines: the hand-written `attributes` allowlists on
// the Group include in `routes/events.js` (GET /user/:user_id and GET /group/:group_id).
//
// Unlike `GET /groups/:group_id` and `GET /groups/user/:user_id`, which return the
// column "for free" through the default scope, an explicit `attributes` array is
// precisely the place a field gets silently dropped — by a payload trim, an include
// refactor, or a merge-conflict resolution. Before this file, a `grep color_preset`
// over `Sonnet/tests` returned hits in only `groups.test.js`,
// `unit/groupColourPresets.test.js` and the migration test: ZERO on either events
// route. And the phase's one cross-repo e2e proof (AMENDMENT W) navigates to
// `/groupHomePage`, which is served by `GET /groups/:group_id` — so it covers one of
// the four wire surfaces and cannot red on this one.
//
// AFTER BE PR-2's remap sets `background_color = NULL` estate-wide, `color_preset`
// becomes the ONLY colour these three surfaces can read. Dropping it from either array
// would then render every calendar tile, every event-list row and every day-modal row
// uncoloured in production, with a fully green suite in BOTH repos. That is the same
// silently-green vacuity class AMENDMENT W was built to close for the header; the
// calendar half was left open.
//
// The assertions are authored FROM THE CONSUMER (`storedGroupColour(event.Group)` =
// `group?.color_preset ?? group?.background_color`), not from the route source, so they
// stay true if the route is refactored and false if the contract breaks.
const request = require('supertest');
const express = require('express');
const eventRoutes = require('../../routes/events');
const { Event, Game } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

// NOTE: this is a JEST suite. `expect(value, 'message')` is the VITEST idiom and
// throws "Expect takes at most one argument" here — failure context goes in a
// comment above the assertion instead.

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

describe('Phase 88.3.1 (SPEC Req 5) — the events Group include carries color_preset', () => {
  let owner, group, game, event;

  beforeEach(async () => {
    owner = await makeUser();
    // The POST-remap shape: preset set, legacy column NULL. This is what every
    // coloured group looks like after BE PR-2, so `color_preset` is the only
    // colour the three calendar surfaces can read.
    group = await makeGroup({ color_preset: 'blue', background_color: null });
    await addToGroup(owner, group, 'owner');
    game = await Game.create({ name: `Colour Contract Game ${Date.now()}`, is_custom: true });
    event = await Event.create({
      group_id: group.id,
      game_id: game.id,
      start_date: new Date(),
      status: 'scheduled',
    });
  });

  /** What the FE's one accessor does: `color_preset ?? background_color`. */
  const storedGroupColour = (g) => g?.color_preset ?? g?.background_color ?? null;

  it('GET /events/user/:user_id — routes/events.js:356', async () => {
    const res = await request(makeApp(owner))
      .get(`/api/events/user/${owner.user_id}`)
      .expect(200);

    const row = res.body.find((e) => e.id === event.id);
    // If this is undefined the route stopped returning the seeded event at all.
    expect(row).toBeDefined();
    // If this is undefined the Group include itself vanished, not just the column.
    expect(row.Group).toBeDefined();
    // The contract, stated as the consumer sees it.
    expect(storedGroupColour(row.Group)).toBe('blue');
    // …and stated again as the wire shape, so a `?? background_color` fallback
    // cannot make this pass while the preset key itself is gone.
    expect(row.Group).toHaveProperty('color_preset', 'blue');
  });

  it('GET /events/group/:group_id — routes/events.js:410', async () => {
    const res = await request(makeApp(owner))
      .get(`/api/events/group/${group.id}`)
      .expect(200);

    const row = res.body.find((e) => e.id === event.id);
    // If this is undefined the route stopped returning the seeded event at all.
    expect(row).toBeDefined();
    // If this is undefined the Group include itself vanished, not just the column.
    expect(row.Group).toBeDefined();
    expect(storedGroupColour(row.Group)).toBe('blue');
    expect(row.Group).toHaveProperty('color_preset', 'blue');
  });
});
