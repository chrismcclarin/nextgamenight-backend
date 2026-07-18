// Bare-node supertest harness for 87.4 code-review M-4 (memoize the caller's own
// Users row on req.selfUser/req.selfUuid; KEYMISS handlers reuse it => one Users
// lookup per request in the UUID steady state, two only for users.js which needs the
// withContactInfo scope) and L-3 (uppercase own-UUID param authorizes + resolves).
// A User `beforeFind` hook counts every Users find (incl. scoped). jest hangs locally
// on authenticate; CI suites are authoritative.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env.test') });
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');
const { sequelize, User, Event, Game } = require('../../models');
const { makeUser, makeGroup, addToGroup, makeUserGame } = require('../factories');
const eventsRoutes = require('../../routes/events');
const gamesRoutes = require('../../routes/games');
const usersRoutes = require('../../routes/users');

// Count Users finds (findOne/findByPk/findAll, scoped or not — the hook is on the model).
let userFinds = 0;
User.addHook('beforeFind', () => { userFinds++; });

let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (currentActor) req.user = { user_id: currentActor }; next(); });
app.use('/api/events', eventsRoutes);
app.use('/api/games', gamesRoutes);
app.use('/api/users', usersRoutes);

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}${extra ? ' :: ' + extra : ''}`); }
}

(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  const caller = await makeUser({ username: 'memo-caller' });
  const group = await makeGroup({ name: 'Memo Group' });
  await addToGroup(caller, group, 'member');
  const game = await Game.create({ name: 'Memo Game', is_custom: true });
  const event = await Event.create({
    group_id: group.id, game_id: game.id,
    start_date: new Date(Date.now() + 7 * 864e5), status: 'scheduled',
  });
  await makeUserGame(caller, game);
  currentActor = caller.user_id;

  // events GET /user/:uuid — UUID era: matchesSelf resolves+memoizes; handler reuses.
  userFinds = 0;
  let res = await request(app).get(`/api/events/user/${caller.id}`);
  check('events UUID -> 200 + returns the event', res.status === 200 && res.body.some((e) => e.id === event.id), String(res.status));
  check('events UUID -> exactly ONE Users lookup (M-4)', userFinds === 1, `userFinds=${userFinds}`);

  // games GET /for-event/:group/:uuid — one lookup.
  userFinds = 0;
  res = await request(app).get(`/api/games/for-event/${group.id}/${caller.id}`);
  const owned = res.status === 200 && res.body.find((g) => g.id === game.id && g.is_owned);
  check('games UUID -> 200 + owned game present', !!owned, String(res.status));
  check('games UUID -> exactly ONE Users lookup (M-4)', userFinds === 1, `userFinds=${userFinds}`);

  // users GET /:uuid — documented 2 lookups (matchesSelf + withContactInfo re-fetch).
  userFinds = 0;
  res = await request(app).get(`/api/users/${caller.id}`);
  check('users UUID -> 200 + own profile', res.status === 200 && res.body.id === caller.id, String(res.status));
  check('users UUID -> TWO Users lookups (memo + withContactInfo scope)', userFinds === 2, `userFinds=${userFinds}`);

  // Sub era still resolves (one lookup in the handler; matchesSelf short-circuits DB-free).
  userFinds = 0;
  res = await request(app).get(`/api/events/user/${encodeURIComponent(caller.user_id)}`);
  check('events SUB -> 200 + returns the event', res.status === 200 && res.body.some((e) => e.id === event.id), String(res.status));
  check('events SUB -> ONE Users lookup (handler only, matchesSelf DB-free)', userFinds === 1, `userFinds=${userFinds}`);

  // L-3: uppercase own-UUID param authorizes + resolves to the caller's data.
  res = await request(app).get(`/api/events/user/${caller.id.toUpperCase()}`);
  check('L-3 events UPPERCASE UUID -> 200 (not 403)', res.status === 200, String(res.status));
  check('L-3 events UPPERCASE UUID -> returns the caller event', Array.isArray(res.body) && res.body.some((e) => e.id === event.id));

  res = await request(app).get(`/api/users/${caller.id.toUpperCase()}`);
  check('L-3 users UPPERCASE UUID -> 200 + own profile', res.status === 200 && res.body.id === caller.id, String(res.status));

  await sequelize.close();
  console.log(`\nM4/L3 HARNESS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
