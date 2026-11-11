// tests/scripts/seedSampleData.test.js
// Quick task 261103-glx (Phase 88.9 round 2) — the seed's two walk-link fixtures, plus
// (Phase 88.9 round 2, pick row D2) the Strategy Squad roster that renders the +N chip:
// a group-restore link for the soft-deleted group Retired Raiders, and Alice's three
// single-use RSVP links on the Weekend Warriors Catan night.
// Quick task 261110-ugi adds the 88.9 round-2 glance fixtures block (status nights,
// group colours and images, the cancelled-today night), one pin per glance row.
//
// Runs the seed IN-PROCESS (the reportAccountHygiene.test.js precedent), calling
// seedDatabase({ syncSchema: false, closeConnection: false }): the schema stays the one
// tests/globalSetup.js built once for the whole run, and the shared connection stays open
// for every later serial suite. See the DECISION quick-261103-glx G1 marker above
// seedDatabase in scripts/seed-sample-data.js for why this is not a child process.
//
// The seed's console output is captured (and silenced) so each test can assert what a
// person running `npm run seed` would see — and, with CI set, what they would NOT see.
//
// Run alone:   npm test -- tests/scripts/seedSampleData.test.js

const util = require('util');
const request = require('supertest');
const express = require('express');
const models = require('../../models');
const { User, Group, UserGroup, Event, SingleUseToken, Game, EventParticipation } = models;
const { Op } = require('sequelize');
const groupRoutes = require('../../routes/groups');
// The module OBJECT, not destructured: the seed calls rsvpLinks.mintRsvpBatch through
// this same object (DECISION quick-261103-glx G4), so rsvp F can spy the mint here.
const rsvpLinks = require('../../routes/rsvp');
const heatmapService = require('../../services/heatmapService');
const groupRecoveryService = require('../../services/groupRecoveryService');
const { restoreGroupByToken } = groupRecoveryService;
const { seedDatabase, ALICE_PLACEHOLDER_SUB } = require('../../scripts/seed-sample-data');

// The restore preview and GET /rsvp/respond are both public, so the routers are
// mounted bare (same mounting as tests/routes/groups.restore.test.js, minus the auth
// stub nothing here needs).
const app = express();
app.use(express.json());
app.use('/api/groups', groupRoutes);
app.use('/api/rsvp', rsvpLinks);

// An obviously fake, test-only value — never a real secret.
const TEST_SECRET = 'glx-test-only-not-a-secret-000000000000';
const ENV_KEYS = ['CI', 'MAGIC_TOKEN_SECRET', 'FRONTEND_URL', 'AUTH0_ALICE_SUB'];
const DAY_MS = 24 * 60 * 60 * 1000;
// The seed's placeholder-sub notice (review finding 1); matched as a substring.
const PLACEHOLDER_SUB_NOTICE = "RSVP links are signed over Alice's placeholder sub";
// An obviously fake, test-only sub — never a real Auth0 account.
const TEST_ALICE_SUB = 'auth0|glx-test-only-alice-sub';

let envSnapshot;
let logLines;
let errorLines;

function render(args) {
  return args
    .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 5 })))
    .join(' ');
}

async function runSeed() {
  await seedDatabase({ syncSchema: false, closeConnection: false });
  return logLines;
}

// A Sequelize-shaped write failure: sql and parameters carry the marker the way a real
// one would carry an inlined nonce.
const LEAK_MARKER = 'GLX-NONCE-MARKER';
function sqlShapedError() {
  return Object.assign(new Error('glx simulated token write failure'), {
    name: 'SequelizeDatabaseError',
    sql: `INSERT INTO "single_use_tokens" ("nonce") VALUES ('${LEAK_MARKER}')`,
    parameters: [LEAK_MARKER],
  });
}

function parseRsvpLink(lines, status) {
  const line = lines.find((l) => l.includes('/rsvp/') && l.includes(`&s=${status}`));
  expect(line).toBeDefined();
  const url = new URL(line.match(/(http:\/\/localhost:3000\/rsvp\/\S+)/)[1]);
  return {
    token: url.pathname.split('/rsvp/')[1],
    e: url.searchParams.get('e'),
    u: url.searchParams.get('u'),
    s: url.searchParams.get('s'),
  };
}

// Scoped-check WR-02 (quick 261103-glx): the seed builds sampleUsers, and so the sub
// Alice is seeded on, ONCE, when its module loads. The seedDatabase required at the top
// of this file therefore always seeds Alice on whatever AUTH0_ALICE_SUB was when this
// file loaded (in CI: unset, so the placeholder), and toggling the var afterwards changes
// nothing the seed signs. To reach BOTH arms of the placeholder-sub notice, this helper
// sets (or unsets) AUTH0_ALICE_SUB and then requires a FRESH copy of the seed inside
// jest.isolateModules. Every module the seed requires that holds shared state (the models
// and their one Sequelize connection, the rsvp router, the two services) is doMock-ed to
// the instance this file already loaded, so only the seed module itself (and its
// dependency-free lib helper) is re-evaluated, and no second connection pool is opened.
// The mocks are dropped again right after, so nothing later in this file sees them.
const SEED_SHARED_DEPS = {
  '../../models': models,
  '../../routes/rsvp': rsvpLinks,
  '../../services/heatmapService': heatmapService,
  '../../services/groupRecoveryService': groupRecoveryService,
};
function loadSeedWithAliceSub(aliceSub) {
  if (aliceSub === undefined) {
    delete process.env.AUTH0_ALICE_SUB;
  } else {
    process.env.AUTH0_ALICE_SUB = aliceSub;
  }
  let seed;
  jest.isolateModules(() => {
    for (const [dep, instance] of Object.entries(SEED_SHARED_DEPS)) {
      jest.doMock(dep, () => instance);
    }
    seed = require('../../scripts/seed-sample-data');
  });
  for (const dep of Object.keys(SEED_SHARED_DEPS)) {
    jest.dontMock(dep);
  }
  return async () => {
    await seed.seedDatabase({ syncSchema: false, closeConnection: false });
    return logLines;
  };
}

// Review finding 1 + scoped-check WR-02: the notice states a fact about the printed links,
// so it must appear exactly when the yes link's u= (the sub the link is signed over) is
// Alice's placeholder sub. Returns u so each caller can also pin WHICH arm it reached.
function expectNoticeTracksLink(lines) {
  const { u } = parseRsvpLink(lines, 'yes');
  expect(lines.filter((l) => l.includes(PLACEHOLDER_SUB_NOTICE)))
    .toHaveLength(u === ALICE_PLACEHOLDER_SUB ? 1 : 0);
  return u;
}

async function seededUser(username) {
  const user = await User.findOne({ where: { username } });
  expect(user).not.toBeNull();
  return user;
}

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
  }
  delete process.env.CI;
  process.env.FRONTEND_URL = 'http://localhost:3000';
  process.env.MAGIC_TOKEN_SECRET = TEST_SECRET;

  logLines = [];
  errorLines = [];
  jest.spyOn(console, 'log').mockImplementation((...args) => { logLines.push(render(args)); });
  jest.spyOn(console, 'error').mockImplementation((...args) => { errorLines.push(render(args)); });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }
  jest.restoreAllMocks();
});

describe('seed membership fixtures (Phase 88.9 round 2, pick row D2)', () => {
  // The home card's collapsed MemberChipStack shows COLLAPSED_LIMIT = 4 other members and
  // a "+N" chip for the rest (periodictabletop/src/app/components/MemberChipStack.tsx);
  // both it and the Suggestions filter read ACTIVE memberships only. Until this fixture
  // no seeded group gave Alice more than 4 others, so the +N chip never rendered on the
  // walk DB and the pick row was blocked. Strategy Squad carries 7 members: Alice sees
  // four chips and "+2". Pinned so a later "tidy" of the roster does not re-block it.
  it('Strategy Squad has 7 active members (Alice + 6 others, Diana and Bartholomew included), so her collapsed chip stack shows four chips and +2', async () => {
    await runSeed();
    const squad = await Group.findOne({ where: { group_id: 'strategy-squad' } });
    expect(squad).not.toBeNull();
    const rows = await UserGroup.findAll({ where: { group_id: squad.id, status: 'active' } });
    expect(rows).toHaveLength(7);
    const alice = await seededUser('Alice');
    const diana = await seededUser('Diana');
    const bartholomew = await seededUser('Bartholomew Featherstonehaugh-Cholmondeley');
    const byUser = Object.fromEntries(rows.map((m) => [m.user_uuid, m.role]));
    expect(byUser[alice.id]).toBe('member');
    expect(byUser[diana.id]).toBe('member');
    expect(byUser[bartholomew.id]).toBe('member');
    const COLLAPSED_LIMIT = 4; // MemberChipStack.tsx
    const others = rows.filter((m) => m.user_uuid !== alice.id);
    expect(others.length - COLLAPSED_LIMIT).toBe(2); // the "+2" chip
  });
});

describe('seed look fixtures (88.9 round 2, quick 261110-ugi)', () => {
  // The 88.9-51 owner glance reads these on the local walk DB after a fresh reseed. Each
  // pin names its glance row; see sub-block (e) in scripts/seed-sample-data.js and its
  // DECISION quick-261110-ugi markers for why each fixture is shaped as it is.
  async function futureSquadNight(squad, status) {
    const rows = await Event.findAll({
      where: { group_id: squad.id, status, start_date: { [Op.gt]: new Date() } },
    });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it('W57 / R2-03: Strategy Squad holds one FUTURE cancelled Gloomhaven night at 18:00 local, 12 local days out, and Alice is an active member so her calendar lists it', async () => {
    await runSeed();
    const squad = await Group.findOne({ where: { group_id: 'strategy-squad' } });
    expect(squad).not.toBeNull();
    const night = await futureSquadNight(squad, 'cancelled');
    const gloomhaven = await Game.findOne({ where: { bgg_id: 174430 } });
    expect(night.game_id).toBe(gloomhaven.id);
    const ahead = night.start_date.getTime() - Date.now();
    expect(ahead).toBeGreaterThan(11 * DAY_MS);
    expect(ahead).toBeLessThan(13 * DAY_MS);
    expect(night.start_date.getHours()).toBe(18);
    expect(night.start_date.getMinutes()).toBe(0);
    const alice = await seededUser('Alice');
    expect(await UserGroup.count({ where: { group_id: squad.id, user_uuid: alice.id, status: 'active' } })).toBe(1);
  }, 120000);

  it('W57 / R2-03: a FUTURE completed night sits on the same local day as the cancelled one, so Alice\'s day modal opens with exactly those two rows, both Gloomhaven, already in Strategy Squad\'s history', async () => {
    await runSeed();
    const squad = await Group.findOne({ where: { group_id: 'strategy-squad' } });
    expect(squad).not.toBeNull();
    const cancelled = await futureSquadNight(squad, 'cancelled');
    const completed = await futureSquadNight(squad, 'completed');
    const day = cancelled.start_date.toDateString();
    expect(completed.start_date.toDateString()).toBe(day);
    expect(completed.start_date.getHours()).toBe(20);
    expect(completed.start_date.getMinutes()).toBe(30);

    // Alice's calendar, built the way GET /events/user/:user_id builds it: her active
    // groups' events OR the events she participates in, with no status filter.
    const alice = await seededUser('Alice');
    const groupIds = (await UserGroup.findAll({ where: { user_uuid: alice.id, status: 'active' } }))
      .map((m) => m.group_id);
    const eventIds = (await EventParticipation.findAll({ where: { user_id: alice.id } }))
      .map((p) => p.event_id);
    const calendar = await Event.findAll({
      where: { [Op.or]: [{ group_id: { [Op.in]: groupIds } }, { id: { [Op.in]: eventIds } }] },
    });
    const onDay = calendar.filter((e) => e.start_date.toDateString() === day);
    expect(onDay).toHaveLength(2);
    expect(onDay.map((e) => e.status).sort()).toEqual(['cancelled', 'completed']);

    // Both are a game the squad has already played, so its games list does not grow.
    // Play history is a past start AND a status other than cancelled, the games list's own
    // rule (routes/lists.js ("event.status !== 'cancelled'"), DECISION Phase 88-34 WI-B2).
    // Without the status filter, the started-today cancelled Gloomhaven night alone would
    // satisfy this pin (review M-1).
    const history = await Event.findAll({
      where: {
        group_id: squad.id,
        start_date: { [Op.lte]: new Date() },
        status: { [Op.ne]: 'cancelled' },
      },
    });
    const playedGameIds = new Set(history.map((e) => e.game_id));
    expect(playedGameIds.has(cancelled.game_id)).toBe(true);
    expect(playedGameIds.has(completed.game_id)).toBe(true);
  }, 120000);

  it('O-02 / #207: Casual Gamers stores colour preset blue and an https header image on an RFC 2606 .invalid host, and Alice is an active member, so the card takes the image arm and the image fails to load', async () => {
    await runSeed();
    const casual = await Group.findOne({ where: { group_id: 'casual-gamers' } });
    expect(casual).not.toBeNull();
    expect(casual.color_preset).toBe('blue');
    // The FE allow-list checks the protocol only, so https passes it; the .invalid host
    // then fails at fetch time: the image-failure arm, not the rejected-URL arm.
    const url = new URL(casual.background_image_url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname.endsWith('.invalid')).toBe(true);
    const alice = await seededUser('Alice');
    expect(await UserGroup.count({ where: { group_id: casual.id, user_uuid: alice.id, status: 'active' } })).toBe(1);
  }, 120000);

  it('N12 / N16b: Strategy Squad stores colour preset green and no image, so Alice\'s coloured image-less card and its status rows take the tinted arm, and Weekend Warriors stays uncoloured', async () => {
    await runSeed();
    const squad = await Group.findOne({ where: { group_id: 'strategy-squad' } });
    expect(squad).not.toBeNull();
    expect(squad.color_preset).toBe('green');
    expect(squad.background_image_url).toBeNull();
    // The validator's own preset list.
    const { GROUP_COLOUR_PRESET_IDS } = require('../../utils/groupColourPresets');
    expect(GROUP_COLOUR_PRESET_IDS).toContain('green');
    const alice = await seededUser('Alice');
    expect(await UserGroup.count({ where: { group_id: squad.id, user_uuid: alice.id, status: 'active' } })).toBe(1);
    // e2e-fixtures.js "DECISION Phase 88.3 (OQ-1)": the shared CI journey group stays unmutated.
    const weekend = await Group.findOne({ where: { group_id: 'weekend-warriors' } });
    expect(weekend).not.toBeNull();
    expect(weekend.color_preset).toBeNull();
    expect(weekend.background_image_url).toBeNull();
  }, 120000);

  it('N16: Photo Club is a photo card with NO stored colour that Alice belongs to — the image is the app\'s own /bgg-logo.png, and Dice Dynasty and No Games Yet still have no Alice', async () => {
    // A FRONTEND_URL distinct from the seed's localhost:3000 fallback, so the pin can tell
    // an env read from a hardcoded origin (review L-2). Per test only: parseRsvpLink
    // hardcodes localhost:3000 for the others, and afterEach restores the env snapshot.
    const walkOrigin = 'http://walk.test:3999';
    process.env.FRONTEND_URL = walkOrigin;
    await runSeed();
    const club = await Group.findOne({ where: { group_id: 'photo-club' } });
    expect(club).not.toBeNull();
    expect(club.name).toBe('Photo Club');
    expect(club.color_preset).toBeNull();
    // The FE treats a null or #fff / #ffffff background_color as unset.
    if (club.background_color !== null) {
      expect(club.background_color).toMatch(/^#(?:fff|ffffff)$/i);
    }
    expect(club.background_image_url).toBe(`${walkOrigin}/bgg-logo.png`);

    const alice = await seededUser('Alice');
    const eve = await seededUser('Eve');
    const members = await UserGroup.findAll({ where: { group_id: club.id, status: 'active' } });
    expect(Object.fromEntries(members.map((m) => [m.user_uuid, m.role])))
      .toEqual({ [eve.id]: 'owner', [alice.id]: 'member' });

    // Its "Last Game:" night: the group's only event, past and completed.
    const clubEvents = await Event.findAll({ where: { group_id: club.id } });
    expect(clubEvents).toHaveLength(1);
    expect(clubEvents[0].status).toBe('completed');
    expect(clubEvents[0].start_date.getTime()).toBeLessThanOrEqual(Date.now());

    for (const slug of ['dice-dynasty', 'no-games-yet']) {
      const group = await Group.findOne({ where: { group_id: slug } });
      expect(group).not.toBeNull();
      expect(await UserGroup.count({ where: { group_id: group.id, user_uuid: alice.id }, paranoid: false })).toBe(0);
    }
  }, 120000);

  it('N40: Strategy Squad holds one cancelled night that started earlier on the seed\'s local day, starting at the later of local midnight and seed time minus 2 hours', async () => {
    const before = new Date();
    await runSeed();
    const after = new Date();
    const squad = await Group.findOne({ where: { group_id: 'strategy-squad' } });
    expect(squad).not.toBeNull();
    const started = await Event.findAll({
      where: { group_id: squad.id, status: 'cancelled', start_date: { [Op.lte]: after } },
    });
    expect(started).toHaveLength(1);
    const s = started[0].start_date;
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const localMidnightOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const localMidnight = localMidnightOf(before);
    expect(s.getTime()).toBeGreaterThanOrEqual(localMidnight.getTime());
    expect(s.getTime()).toBeGreaterThanOrEqual(before.getTime() - TWO_HOURS_MS - 1000);
    // Upper bound (review L-1): the seed's now lies in [before, after] and the rule
    // max(local midnight of now, now - 2h) never decreases as now grows, so its value at
    // after caps the start. Without this, a start AT the seed instant would pass. The
    // 1 s tolerance matches the lower bound's.
    const latestAllowed = Math.max(localMidnightOf(after).getTime(), after.getTime() - TWO_HOURS_MS);
    expect(s.getTime()).toBeLessThanOrEqual(latestAllowed + 1000);
    // A run that crosses local midnight may land on either day.
    expect([before.toDateString(), after.toDateString()]).toContain(s.toDateString());
    const gloomhaven = await Game.findOne({ where: { bgg_id: 174430 } });
    expect(started[0].game_id).toBe(gloomhaven.id);
  }, 120000);
});

describe('seed token fixtures (quick 261103-glx)', () => {
  it('group-restore: Retired Raiders is soft-deleted through the service, its link is printed, previews publicly and restores as Alice', async () => {
    const lines = await runSeed();

    // A — exactly one active restore token, for the soft-deleted group.
    const tokens = await SingleUseToken.findAll({ where: { purpose: 'group_restore' } });
    expect(tokens).toHaveLength(1);
    const [token] = tokens;
    expect(token.status).toBe('active');
    expect(token.user_id).toBeNull();

    const group = await Group.findByPk(token.group_id, { paranoid: false });
    expect(group).not.toBeNull();
    expect(group.group_id).toBe('retired-raiders');
    expect(group.name).toBe('Retired Raiders');
    expect(group.deletedAt).toBeInstanceOf(Date);
    const now = Date.now();
    expect(group.purge_after.getTime()).toBeGreaterThan(now + 29 * DAY_MS);
    expect(group.purge_after.getTime()).toBeLessThan(now + 31 * DAY_MS);
    expect(token.expires_at.getTime()).toBeGreaterThan(group.purge_after.getTime());

    // B — the paranoid default hides it, and every child carries the ONE stamp.
    expect(await Group.findOne({ where: { group_id: 'retired-raiders' } })).toBeNull();
    expect(await UserGroup.count({ where: { group_id: group.id } })).toBe(0);
    expect(await Event.count({ where: { group_id: group.id } })).toBe(0);

    const alice = await seededUser('Alice');
    const bob = await seededUser('Bob');
    const eve = await seededUser('Eve');
    const memberships = await UserGroup.findAll({ where: { group_id: group.id }, paranoid: false });
    expect(memberships).toHaveLength(3);
    const roleByUser = Object.fromEntries(memberships.map((m) => [m.user_uuid, m.role]));
    expect(roleByUser).toEqual({ [alice.id]: 'owner', [bob.id]: 'member', [eve.id]: 'member' });
    const hiddenEvents = await Event.findAll({ where: { group_id: group.id }, paranoid: false });
    expect(hiddenEvents).toHaveLength(1);
    for (const row of [...memberships, ...hiddenEvents]) {
      expect(row.deletedAt).toBeInstanceOf(Date);
      expect(row.deletedAt.getTime()).toBe(group.deletedAt.getTime());
    }

    // C — the link is printed (CI unset), in the DELETE route's emailed-link shape.
    expect(lines.some((l) => l.includes(`http://localhost:3000/restore/group/${token.nonce}`))).toBe(true);

    // D — the public preview answers exactly the narrow body; then Alice restores
    // (the restore consumes the token, so the preview runs first).
    const preview = await request(app).get(`/api/groups/restore-preview/${token.nonce}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual({
      group_name: 'Retired Raiders',
      purge_after: group.purge_after.toISOString(),
    });

    const restored = await restoreGroupByToken(token.nonce, alice.user_id);
    expect(restored).toEqual({ ok: true, groupId: group.id, groupName: 'Retired Raiders' });
  }, 120000);

  it('group-restore: a re-seed replaces the restore token and leaves an unrelated oauth_state row alone', async () => {
    await runSeed();
    const first = await SingleUseToken.findAll({ where: { purpose: 'group_restore' } });
    expect(first).toHaveLength(1);

    const unrelated = await SingleUseToken.create({
      nonce: 'glx-test-only-oauth-state-nonce',
      purpose: 'oauth_state',
      user_id: null,
      status: 'active',
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });

    await runSeed();
    const second = await SingleUseToken.findAll({ where: { purpose: 'group_restore' } });
    expect(second).toHaveLength(1);
    expect(second[0].nonce).not.toBe(first[0].nonce);
    expect(await SingleUseToken.findByPk(unrelated.id)).not.toBeNull();
    // The RSVP batch is replaced too, never accumulated (any status). NOT a G2 pin: in
    // this sync-built DB the User.destroy cascade clears the rsvp rows whether or not the
    // G2 clear exists. G2 is pinned by the group_restore count above (user_id NULL, so no
    // cascade reaches it); this line stays as a cheap accumulation guard.
    expect(await SingleUseToken.count({ where: { purpose: 'rsvp' } })).toBe(3);
  }, 120000);

  it('group-restore: with CI set the token is still minted but neither the link nor the nonce is printed', async () => {
    process.env.CI = 'true';
    const lines = await runSeed();

    const tokens = await SingleUseToken.findAll({ where: { purpose: 'group_restore' } });
    expect(tokens).toHaveLength(1);
    const { nonce } = tokens[0];
    expect(lines.filter((l) => l.includes('/restore/group/'))).toEqual([]);
    expect(lines.filter((l) => l.includes(nonce))).toEqual([]);
    expect(lines.some((l) => l.includes('Walk links minted but not printed'))).toBe(true);
  }, 120000);

  it('rsvp: three active links for Alice on the Weekend Warriors Catan night, signed with the route HMAC and printed', async () => {
    const lines = await runSeed();
    const alice = await seededUser('Alice');

    // A — one batch of three active rows for Alice's Auth0 sub, on one event.
    const rows = await SingleUseToken.findAll({ where: { purpose: 'rsvp', status: 'active' } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.user_id).toBe(alice.user_id);
      expect(row.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    }
    const batchIds = new Set(rows.map((r) => r.email_batch_id));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toBeTruthy();
    const eventIds = new Set(rows.map((r) => r.event_id));
    expect(eventIds.size).toBe(1);
    const eventId = [...eventIds][0];
    expect(rows.map((r) => r.rsvp_status).sort()).toEqual(['maybe', 'no', 'yes']);

    const event = await Event.findByPk(eventId);
    expect(event).not.toBeNull();
    expect(event.status).toBe('scheduled');
    expect(event.ballot_status).toBe('open');
    expect(event.start_date.getTime()).toBeGreaterThan(Date.now());
    const eventGroup = await Group.findByPk(event.group_id);
    expect(eventGroup.group_id).toBe('weekend-warriors');

    // B — each nonce is the route's own HMAC, and each URL is printed.
    for (const row of rows) {
      expect(row.nonce).toBe(rsvpLinks.generateRsvpToken(eventId, alice.user_id, row.rsvp_status));
      const url = rsvpLinks.generateRsvpUrl('http://localhost:3000', eventId, alice.user_id, row.rsvp_status);
      expect(lines.some((l) => l.includes(url))).toBe(true);
    }
    // The secret itself never reaches the output.
    expect(lines.filter((l) => l.includes(TEST_SECRET))).toEqual([]);
  }, 120000);

  it('rsvp: the printed yes link answers through GET /api/rsvp/respond, then the maybe link is refused (single-use)', async () => {
    const lines = await runSeed();

    const yes = parseRsvpLink(lines, 'yes');
    const maybe = parseRsvpLink(lines, 'maybe');

    const answered = await request(app).get('/api/rsvp/respond').query(yes);
    expect(answered.status).toBe(200);
    expect(answered.body.success).toBe(true);
    expect(answered.body.group_name).toBe('Weekend Warriors');

    const refused = await request(app).get('/api/rsvp/respond').query(maybe);
    expect(refused.status).toBe(403);
  }, 120000);

  it('rsvp: with MAGIC_TOKEN_SECRET unset the seed still completes, mints no RSVP rows, says why, and still mints the restore link', async () => {
    delete process.env.MAGIC_TOKEN_SECRET;
    const lines = await runSeed();

    expect(await SingleUseToken.count({ where: { purpose: 'rsvp' } })).toBe(0);
    expect(lines.some((l) => l.includes('MAGIC_TOKEN_SECRET is not set'))).toBe(true);
    expect(await SingleUseToken.count({ where: { purpose: 'group_restore' } })).toBe(1);
  }, 120000);

  // Review finding 1 + scoped-check WR-02: the links are signed over the sub Alice was
  // seeded on. When that is the placeholder, the repoint the owner needs to sign in as
  // Alice breaks them, and the seed must say so in its own output, locally only (the
  // same CI rule as the links). Each seed below is loaded through loadSeedWithAliceSub,
  // so the arm it reaches is decided by the sub in effect at module load.
  it('rsvp: the placeholder-sub notice is printed iff the printed link is signed over the placeholder sub', async () => {
    // Placeholder arm: AUTH0_ALICE_SUB unset at load and at run.
    const placeholderLines = await loadSeedWithAliceSub(undefined)();
    expect(expectNoticeTracksLink(placeholderLines)).toBe(ALICE_PLACEHOLDER_SUB);

    // Real-sub arm: AUTH0_ALICE_SUB set at load and at run.
    logLines.length = 0;
    const realSubLines = await loadSeedWithAliceSub(TEST_ALICE_SUB)();
    expect(expectNoticeTracksLink(realSubLines)).toBe(TEST_ALICE_SUB);
  }, 180000);

  it('rsvp: the notice follows the sub the seed used, not AUTH0_ALICE_SUB at run time', async () => {
    // Loaded on the placeholder, var set before the run: the links are still signed over
    // the placeholder, so the notice must still appear.
    const runPlaceholder = loadSeedWithAliceSub(undefined);
    process.env.AUTH0_ALICE_SUB = TEST_ALICE_SUB;
    const placeholderLines = await runPlaceholder();
    expect(expectNoticeTracksLink(placeholderLines)).toBe(ALICE_PLACEHOLDER_SUB);

    // Loaded on a real sub, var unset before the run: the links are signed over the real
    // sub, so no notice.
    const runRealSub = loadSeedWithAliceSub(TEST_ALICE_SUB);
    delete process.env.AUTH0_ALICE_SUB;
    logLines.length = 0;
    const realSubLines = await runRealSub();
    expect(expectNoticeTracksLink(realSubLines)).toBe(TEST_ALICE_SUB);
  }, 180000);

  it('rsvp: no placeholder-sub notice under CI, or when no RSVP link was minted, even when Alice is on the placeholder', async () => {
    const runPlaceholder = loadSeedWithAliceSub(undefined);

    process.env.CI = 'true';
    const underCi = await runPlaceholder();
    // Control: Alice really is on the placeholder, so the absence below is not vacuous.
    expect((await seededUser('Alice')).user_id).toBe(ALICE_PLACEHOLDER_SUB);
    expect(underCi.filter((l) => l.includes(PLACEHOLDER_SUB_NOTICE))).toEqual([]);

    delete process.env.CI;
    delete process.env.MAGIC_TOKEN_SECRET;
    logLines.length = 0;
    const noMint = await runPlaceholder();
    expect((await seededUser('Alice')).user_id).toBe(ALICE_PLACEHOLDER_SUB);
    expect(noMint.filter((l) => l.includes(PLACEHOLDER_SUB_NOTICE))).toEqual([]);
  }, 180000);

  it('rsvp: with CI set the three rows are minted but no RSVP link or nonce is printed', async () => {
    process.env.CI = 'true';
    const lines = await runSeed();

    const rows = await SingleUseToken.findAll({ where: { purpose: 'rsvp' } });
    expect(rows).toHaveLength(3);
    expect(lines.filter((l) => l.includes('/rsvp/'))).toEqual([]);
    for (const { nonce } of rows) {
      expect(lines.filter((l) => l.includes(nonce))).toEqual([]);
    }
  }, 120000);

  it('rsvp: a mint that returns no batch id fails the seed', async () => {
    jest.spyOn(rsvpLinks, 'mintRsvpBatch').mockResolvedValue(null);
    await expect(runSeed()).rejects.toThrow(/RSVP fixture/);
  }, 120000);

  it('rsvp: a mint that throws fails the seed', async () => {
    jest.spyOn(SingleUseToken, 'bulkCreate').mockRejectedValueOnce(new Error('glx simulated bulkCreate failure'));
    // Either message: the raw throw (today) or the seed's own "RSVP fixture" error, if
    // mintRsvpBatch is ever changed to return null on failure (the case G5 anticipates).
    // What must hold is that the seed rejects instead of swallowing the failure.
    await expect(runSeed()).rejects.toThrow(/glx simulated bulkCreate failure|RSVP fixture/);
  }, 120000);

  it('rsvp: under CI a failed seed prints only the error name and message; locally it prints the whole error', async () => {
    process.env.CI = 'true';
    jest.spyOn(SingleUseToken, 'bulkCreate').mockRejectedValueOnce(sqlShapedError());
    await expect(runSeed()).rejects.toThrow('glx simulated token write failure');
    const ciOutput = errorLines.join('\n');
    expect(ciOutput).toContain('glx simulated token write failure');
    expect(ciOutput).not.toContain(LEAK_MARKER);

    errorLines.length = 0;
    delete process.env.CI;
    SingleUseToken.bulkCreate.mockRejectedValueOnce(sqlShapedError());
    await expect(runSeed()).rejects.toThrow('glx simulated token write failure');
    expect(errorLines.join('\n')).toContain(LEAK_MARKER);
  }, 120000);
});
