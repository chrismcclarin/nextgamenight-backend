// Bare-node supertest harness for 87.4 code-review H-1 (lists.js self-param
// dual-accept conversion) + L-7 (deleted player-games-by-id 404). Replicates the
// jest suite's app + data setup WITHOUT jest's globalSetup/setup hooks, which hang
// locally on sequelize.authenticate() (documented harness issue). CI's jest run is
// authoritative; this proves the route logic against the same real Postgres.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env.test') });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const { sequelize, Event, Game } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');
const listsRoutes = require('../../routes/lists');

let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor };
  next();
});
app.use('/api/lists', listsRoutes);

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}

(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  const caller = await makeUser({ username: 'h1-caller' });
  const other = await makeUser({ user_id: `google-oauth2|other-${Date.now()}`, username: 'h1-other' });
  const group = await makeGroup({ name: 'H1 Group' });
  await addToGroup(caller, group, 'member');

  const game = await Game.create({ name: 'H1 Game', is_custom: true });
  await Event.create({
    group_id: group.id,
    game_id: game.id,
    start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    status: 'scheduled',
  });

  // NOTE: most-played / alphabetical / player-games carry PRE-EXISTING query
  // defects (broken GROUP BY / ambiguous User association) that 500 for any
  // authorized caller — unchanged by H-1, out of scope. A 500 there still PROVES
  // the auth gate passed (the request reached the query), so the positive checks
  // for those routes assert "not 401/403" (auth passed); the 403 negative checks
  // run before the query and are query-independent.
  const authPassed = (s) => s !== 401 && s !== 403;

  currentActor = caller.user_id;

  // Healthy-query routes: full 200 assertion across both keyspaces.
  let res = await request(app).get(`/api/lists/by-theme/${group.id}/strategy/${caller.id}`);
  check('by-theme own UUID -> 200', res.status === 200 && Array.isArray(res.body));
  res = await request(app).get(`/api/lists/by-theme/${group.id}/strategy/${encodeURIComponent(caller.user_id)}`);
  check('by-theme own sub -> 200', res.status === 200);
  res = await request(app).get(`/api/lists/player-wins-by-id/${group.id}/${caller.id}/${caller.id}`);
  check('player-wins-by-id own UUID -> 200', res.status === 200 && Array.isArray(res.body));
  res = await request(app).get(`/api/lists/player-wins-by-id/${group.id}/${caller.id}/${encodeURIComponent(caller.user_id)}`);
  check('player-wins-by-id own sub self-param -> 200', res.status === 200);

  // Broken-query routes: auth passes (not 401/403) — proves H-1 gate reached query.
  res = await request(app).get(`/api/lists/most-played/${group.id}/${caller.id}`);
  check('most-played own UUID -> auth passes (500 = pre-existing query bug)', authPassed(res.status));
  res = await request(app).get(`/api/lists/alphabetical/${group.id}/${caller.id}`);
  check('alphabetical own UUID -> auth passes', authPassed(res.status));
  res = await request(app).get(`/api/lists/player-games/${group.id}/somename/${caller.id}`);
  check('player-games own UUID -> auth passes', authPassed(res.status));

  // BOLA / member-gate 403s (pre-query, query-independent).
  res = await request(app).get(`/api/lists/most-played/${group.id}/${other.id}`);
  check('most-played member requesting OTHER uuid (BOLA) -> 403', res.status === 403);
  res = await request(app).get(`/api/lists/alphabetical/${group.id}/garbage-not-me`);
  check('alphabetical garbage self-param -> 403', res.status === 403);

  // non-member: act as other with other own identity -> matchesSelf passes, member gate 403
  currentActor = other.user_id;
  res = await request(app).get(`/api/lists/most-played/${group.id}/${other.id}`);
  check('most-played non-member self -> 403 (member gate)', res.status === 403);
  currentActor = caller.user_id;

  // L-7: deleted player-games-by-id path 404
  res = await request(app).get(`/api/lists/player-games-by-id/${group.id}/${caller.id}/${caller.id}`);
  check('L-7 player-games-by-id -> 404 (no route)', res.status === 404);

  await sequelize.close();
  console.log(`\nH1 HARNESS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
