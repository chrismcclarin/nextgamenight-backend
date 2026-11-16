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
const { User, Group, UserGroup, Event, SingleUseToken, Game, EventParticipation, EventRsvp, GroupPromptSettings } = models;
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

  it('N16: Photo Club is a photo card with NO stored colour that Alice belongs to — the image is the app\'s own game-table picture /seed/photo-club-table.jpg (a busy picture, not a logo), and Dice Dynasty and No Games Yet still have no Alice', async () => {
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
    expect(club.background_image_url).toBe(`${walkOrigin}/seed/photo-club-table.jpg`);

    const alice = await seededUser('Alice');
    const eve = await seededUser('Eve');
    const members = await UserGroup.findAll({ where: { group_id: club.id, status: 'active' } });
    expect(Object.fromEntries(members.map((m) => [m.user_uuid, m.role])))
      .toEqual({ [eve.id]: 'owner', [alice.id]: 'member' });

    // Its "Last Game:" night: the club's LATEST past night, completed, Ticket to Ride.
    // AMENDED quick 261115-seed-r3: this pin read "the group's only event" until the capture
    // fixtures gave the club two more nights (an older past one and a future one; see the
    // 'seed capture fixtures' block below). What N16 needs is unchanged: the newest past
    // night that is not cancelled is the one the "Last Game:" row names.
    const clubPast = await Event.findAll({
      where: { group_id: club.id, start_date: { [Op.lte]: new Date() }, status: { [Op.ne]: 'cancelled' } },
      order: [['start_date', 'DESC']],
    });
    expect(clubPast.length).toBeGreaterThanOrEqual(1);
    expect(clubPast[0].status).toBe('completed');
    const ticketToRide = await Game.findOne({ where: { bgg_id: 9209 } });
    expect(clubPast[0].game_id).toBe(ticketToRide.id);

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

describe('seed friend fixtures (88.9 round 2, quick 261111-frd)', () => {
  // The 88.9-51 glance rows N45 (invite panel bulk invite: tick two friends, tick a third
  // while the first send is held) and N54 (Friends page, Invite to Group mid-send) need
  // THREE accepted friends Alice can still invite to a group she may invite to. Weekend
  // Warriors is the only live seeded group Alice owns (Retired Raiders is soft-deleted); Diana, her one earlier accepted friend,
  // is already a member there, so the panel offered one disabled checkbox. See the
  // DECISION quick-261111-frd marker in scripts/seed-sample-data.js.
  it('N45 / N54: Alice has three accepted friends (Eve, Frank, Bartholomew) who are not Weekend Warriors members and have no pending invite there, Bob keeps no friendship row, and Charlie\'s incoming request stays pending', async () => {
    await runSeed();
    const { Friendship, GroupInvite } = models;
    const alice = await seededUser('Alice');
    const warriors = await Group.findOne({ where: { group_id: 'weekend-warriors' } });
    expect(warriors).not.toBeNull();
    expect(await UserGroup.count({ where: { group_id: warriors.id, user_uuid: alice.id, role: 'owner', status: 'active' } })).toBe(1);
    const accepted = await Friendship.findAll({
      where: { status: 'accepted', [Op.or]: [{ requester_uuid: alice.id }, { addressee_uuid: alice.id }] },
    });
    const friendIds = accepted.map((f) => (f.requester_uuid === alice.id ? f.addressee_uuid : f.requester_uuid));
    const invitable = [];
    for (const name of ['Eve', 'Frank', 'Bartholomew Featherstonehaugh-Cholmondeley']) {
      const friend = await seededUser(name);
      expect(friendIds).toContain(friend.id);
      expect(await UserGroup.count({ where: { group_id: warriors.id, user_uuid: friend.id } })).toBe(0);
      const withEmail = await User.scope('withContactInfo').findByPk(friend.id);
      expect(await GroupInvite.count({ where: { group_id: warriors.id, invited_email: withEmail.email, status: 'pending' } })).toBe(0);
      invitable.push(friend.id);
    }
    expect(invitable).toHaveLength(3);
    // Diana stays an accepted friend (the friend who is already a member: the disabled box).
    const diana = await seededUser('Diana');
    expect(friendIds).toContain(diana.id);
    expect(accepted).toHaveLength(4);
    // Bob keeps NO friendship row with Alice: he is the member whose popover offers Add friend.
    const bob = await seededUser('Bob');
    expect(await Friendship.count({
      where: { [Op.or]: [{ requester_uuid: alice.id, addressee_uuid: bob.id }, { requester_uuid: bob.id, addressee_uuid: alice.id }] },
    })).toBe(0);
    const charlie = await seededUser('Charlie');
    expect(await Friendship.count({ where: { requester_uuid: charlie.id, addressee_uuid: alice.id, status: 'pending' } })).toBe(1);
  }, 120000);
});

describe('seed capture fixtures (88.9 after-build capture, quick 261115-seed-r3)', () => {
  // The states the 88.9 after-build capture pass (rows P57-1 to P69-6) reads on the local walk
  // DB after a fresh reseed. Each pin names its capture row; see sub-block (f) in
  // scripts/seed-sample-data.js and its DECISION quick-261115-seed-r3 markers for why each
  // fixture is shaped as it is.
  const localDayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // Whole local days from `from` to `d`; rounded, so a 23 or 25 hour DST day still counts as one.
  const localDayOffset = (d, from) => Math.round((localDayStart(d).getTime() - localDayStart(from).getTime()) / DAY_MS);
  const aliceCalendar = async (alice) => {
    // Built the way GET /events/user/:user_id builds it (her active groups' events OR the
    // events she participates in, no status filter).
    const groupIds = (await UserGroup.findAll({ where: { user_uuid: alice.id, status: 'active' } }))
      .map((m) => m.group_id);
    const eventIds = (await EventParticipation.findAll({ where: { user_id: alice.id } }))
      .map((p) => p.event_id);
    return Event.findAll({
      where: { [Op.or]: [{ group_id: { [Op.in]: groupIds } }, { id: { [Op.in]: eventIds } }] },
    });
  };
  const squadSaturdayTrio = async () => {
    const squad = await Group.findOne({ where: { group_id: 'strategy-squad' } });
    expect(squad).not.toBeNull();
    const byDay = new Map();
    for (const e of await Event.findAll({ where: { group_id: squad.id } })) {
      if (e.start_date.getDay() !== 6) continue; // local Saturday
      const key = e.start_date.toDateString();
      byDay.set(key, [...(byDay.get(key) || []), e]);
    }
    const trios = [...byDay.values()].filter((rows) => rows.length >= 3);
    expect(trios).toHaveLength(1);
    return { squad, trio: trios[0].sort((a, b) => a.start_date - b.start_date) };
  };

  it('P57-4 (X46): Weekend Warriors keeps an ACTIVE and a PAUSED prompt schedule and Alice is its owner, so her Plan Game Session schedule list shows Edit / Pause / Delete and Edit / Resume / Delete', async () => {
    await runSeed();
    const warriors = await Group.findOne({ where: { group_id: 'weekend-warriors' } });
    expect(warriors).not.toBeNull();
    const alice = await seededUser('Alice');
    // The schedule manager mounts for owner and admin only (FE PromptScheduleSection).
    expect(await UserGroup.count({ where: { group_id: warriors.id, user_uuid: alice.id, role: 'owner', status: 'active' } })).toBe(1);
    const settings = await GroupPromptSettings.findAll({ where: { group_id: warriors.id } });
    expect(settings).toHaveLength(1);
    const live = (settings[0].template_config?.schedules || []).filter((s) => !s.deleted_at);
    expect(live.filter((s) => s.is_active === true)).toHaveLength(1);
    expect(live.filter((s) => s.is_active === false)).toHaveLength(1);
    for (const s of live) {
      expect(typeof s.id).toBe('string');
      expect(s.template_name).toBeTruthy();
    }
  }, 120000);

  it('P68-2 (X36b) / P59-4: Alice alone carries the SMS entitlement with a verified phone on a reserved fictional number, has opted in to no SMS, and the welcome text is already stamped, so the Profile phone Remove renders and nothing can be texted', async () => {
    await runSeed();
    const alice = await User.scope('withContactInfo').findOne({ where: { username: 'Alice' } });
    expect(alice).not.toBeNull();
    expect(alice.sms_enabled).toBe(true);
    expect(alice.phone_verified).toBe(true);
    // +1 NXX 555 01XX: the North American block reserved for fictional use, never a real line.
    expect(alice.phone).toMatch(/^\+1[2-9]\d{2}55501\d{2}$/);
    // No SMS preference is opted in (null = defaults: email on, SMS off), so
    // notificationService never selects the SMS channel for her.
    expect(alice.notification_preferences).toBeNull();
    // Stamped, so a later opt-in during a walk cannot fire the one-time welcome text either.
    expect(alice.sms_welcome_sent_at).toBeInstanceOf(Date);
    const others = await User.scope('withContactInfo').findAll({ where: { username: { [Op.ne]: 'Alice' } } });
    expect(others.length).toBeGreaterThanOrEqual(6);
    for (const user of others) {
      expect(user.sms_enabled).toBe(false);
      expect(user.phone).toBeNull();
      expect(user.phone_verified).toBe(false);
    }
  }, 120000);

  it('P62-3: Strategy Squad holds three Gloomhaven nights (13:00, 16:00, 19:00 local) on ONE Saturday of the seed\'s local month, never the seed day or the local days 3 and 12 days out, all scheduled when ahead and all completed when behind, so that Saturday cell shows "+1 more"', async () => {
    const before = new Date();
    await runSeed();
    const after = new Date();
    const { trio } = await squadSaturdayTrio();
    expect(trio).toHaveLength(3);
    const day = trio[0].start_date;
    expect(trio.map((e) => [e.start_date.getHours(), e.start_date.getMinutes()])).toEqual([[13, 0], [16, 0], [19, 0]]);
    // The visible month: the local month of the seed run (either side of a month-crossing run).
    expect([before, after].map((d) => `${d.getFullYear()}-${d.getMonth()}`))
      .toContain(`${day.getFullYear()}-${day.getMonth()}`);
    // Hard-reserved local days: 0 (the started-today cancelled night, N40), 3 (the Weekend
    // Warriors Catan night and CI's own fixture night, whose two tiles FE e2e measures) and
    // 12 (the two status nights; the W57 pin above wants exactly two rows on that day). The
    // seed's own clock lies in [before, after], so one of the two offsets is the seed's.
    const HARD = [0, 3, 12];
    expect([localDayOffset(day, before), localDayOffset(day, after)].some((o) => !HARD.includes(o))).toBe(true);
    const ahead = day.getTime() > after.getTime();
    expect(trio.map((e) => e.status)).toEqual(Array(3).fill(ahead ? 'scheduled' : 'completed'));
    const gloomhaven = await Game.findOne({ where: { bgg_id: 174430 } });
    for (const night of trio) expect(night.game_id).toBe(gloomhaven.id);
    // Alice's own calendar holds all three on that day: more than the two tiles a day cell
    // renders (FE CalendarMonthView), which is what prints "+N more".
    const alice = await seededUser('Alice');
    const onDay = (await aliceCalendar(alice)).filter((e) => e.start_date.toDateString() === day.toDateString());
    expect(onDay.length).toBeGreaterThanOrEqual(3);
  }, 120000);

  it('P63-2 (X27): Alice is a GUEST on one night of a tinted group and one night of a picture group she belongs to (Strategy Squad\'s middle Saturday night, Photo Club\'s night 8 days out), and still a guest at Dice Dynasty, which she does not belong to', async () => {
    await runSeed();
    const alice = await seededUser('Alice');
    const eve = await seededUser('Eve');
    const guestRows = await EventParticipation.findAll({ where: { user_id: alice.id, is_guest: true } });
    const guestEvents = await Event.findAll({ where: { id: { [Op.in]: guestRows.map((p) => p.event_id) } } });
    const slugById = Object.fromEntries((await Group.findAll()).map((g) => [g.id, g.group_id]));
    expect(guestEvents.map((e) => slugById[e.group_id]).sort()).toEqual(['dice-dynasty', 'photo-club', 'strategy-squad']);

    // Tinted: the 16:00 night of the Saturday trio, in a group that stores a colour and no image.
    const { squad, trio } = await squadSaturdayTrio();
    expect(squad.color_preset).toBe('green');
    expect(squad.background_image_url).toBeNull();
    const squadGuestNight = guestEvents.find((e) => e.group_id === squad.id);
    expect(squadGuestNight.id).toBe(trio[1].id);
    expect(await UserGroup.count({ where: { group_id: squad.id, user_uuid: alice.id, status: 'active' } })).toBe(1);

    // Picture: a scheduled Ticket to Ride night about 8 days out, the club's only future night.
    const club = await Group.findOne({ where: { group_id: 'photo-club' } });
    expect(club.background_image_url).toMatch(/\/seed\/photo-club-table\.jpg$/);
    const clubFuture = await Event.findAll({ where: { group_id: club.id, start_date: { [Op.gt]: new Date() } } });
    expect(clubFuture).toHaveLength(1);
    const clubGuestNight = guestEvents.find((e) => e.group_id === club.id);
    expect(clubGuestNight.id).toBe(clubFuture[0].id);
    expect(clubGuestNight.status).toBe('scheduled');
    const aheadMs = clubGuestNight.start_date.getTime() - Date.now();
    expect(aheadMs).toBeGreaterThan(7.5 * DAY_MS);
    expect(aheadMs).toBeLessThan(8.5 * DAY_MS);
    const ticketToRide = await Game.findOne({ where: { bgg_id: 9209 } });
    expect(clubGuestNight.game_id).toBe(ticketToRide.id);
    expect(await UserGroup.count({ where: { group_id: club.id, user_uuid: alice.id, status: 'active' } })).toBe(1);
    // Eve, the owner, is there as a member, so the row is not a guest-only night.
    expect(await EventParticipation.count({ where: { event_id: clubGuestNight.id, user_id: eve.id, is_guest: false } })).toBe(1);

    // Plain: the Dice Dynasty night, as before, in a group with no Alice.
    const dice = await Group.findOne({ where: { group_id: 'dice-dynasty' } });
    expect(await UserGroup.count({ where: { group_id: dice.id, user_uuid: alice.id }, paranoid: false })).toBe(0);
  }, 120000);

  it('P60-3 (Q3 chip) / P65-1 (X50): Photo Club\'s older past night carries going, maybe and can\'t RSVPs all above zero and the stored scores 57.50 and 57.00, while its Last Game night keeps no RSVP at all', async () => {
    await runSeed();
    const club = await Group.findOne({ where: { group_id: 'photo-club' } });
    expect(club).not.toBeNull();
    const past = await Event.findAll({
      where: { group_id: club.id, start_date: { [Op.lte]: new Date() } },
      order: [['start_date', 'DESC']],
    });
    expect(past).toHaveLength(2);
    const [lastGame, older] = past;
    // "No RSVPs yet": the row the RSVP chip prints its zero state on.
    expect(await EventRsvp.count({ where: { event_id: lastGame.id } })).toBe(0);
    // All three counts above zero, counted the way routes/events.js attachRsvpSummaries does.
    const counts = { yes: 0, maybe: 0, no: 0 };
    for (const r of await EventRsvp.findAll({ where: { event_id: older.id } })) counts[r.status] += 1;
    expect(counts).toEqual({ yes: 2, maybe: 1, no: 1 });
    expect(older.status).toBe('completed');
    const behindMs = Date.now() - older.start_date.getTime();
    expect(behindMs).toBeGreaterThan(10.5 * DAY_MS);
    expect(behindMs).toBeLessThan(11.5 * DAY_MS);
    // Same game as the Last Game night, so the club's games list does not grow.
    expect(older.game_id).toBe(lastGame.game_id);
    // Every RSVP belongs to a participant (the RSVP route's own gate), and Alice is not one,
    // so none of her history or stats surfaces move.
    const participants = await EventParticipation.findAll({ where: { event_id: older.id } });
    const participantIds = participants.map((p) => p.user_id);
    for (const r of await EventRsvp.findAll({ where: { event_id: older.id } })) {
      expect(participantIds).toContain(r.user_uuid);
    }
    const alice = await seededUser('Alice');
    expect(participantIds).not.toContain(alice.id);
    // The two scores as the wire carries them: a DECIMAL(10,2) arrives as a string.
    const scores = participants.map((p) => p.score).filter((s) => s !== null).map(String);
    expect(scores).toContain('57.50');
    expect(scores).toContain('57.00');
  }, 120000);

  it('P61-1: Alice\'s calendar holds one completed night dated in the previous local calendar year (Casual Gamers, 20 December, 19:00), so a Past row prints its year', async () => {
    const before = new Date();
    await runSeed();
    const alice = await seededUser('Alice');
    const casual = await Group.findOne({ where: { group_id: 'casual-gamers' } });
    // Matched on its own date, not on "anything last year": a seed run in January puts the
    // now-relative past nights in the previous year as well.
    const lastYear = (await aliceCalendar(alice)).filter((e) => (
      e.group_id === casual.id
      && e.start_date.getFullYear() === before.getFullYear() - 1
      && e.start_date.getMonth() === 11 && e.start_date.getDate() === 20
    ));
    expect(lastYear).toHaveLength(1);
    const [night] = lastYear;
    expect(night.status).toBe('completed');
    expect([night.start_date.getHours(), night.start_date.getMinutes()]).toEqual([19, 0]);
    // A game the group has already played, so its games list does not grow.
    const played = await Event.findAll({ where: { group_id: casual.id, id: { [Op.ne]: night.id }, status: 'completed' } });
    expect(played.map((e) => e.game_id)).toContain(night.game_id);
  }, 120000);

  it('P63-1 / P65-3 (See all): the Weekend Warriors Catan night has six participants, two of them guests (Eve and Frank), so its strip shows five chips and "See all (6)"', async () => {
    await runSeed();
    const warriors = await Group.findOne({ where: { group_id: 'weekend-warriors' } });
    const future = await Event.findAll({ where: { group_id: warriors.id, start_date: { [Op.gt]: new Date() } } });
    expect(future).toHaveLength(1);
    const participants = await EventParticipation.findAll({ where: { event_id: future[0].id } });
    const STRIP_LIMIT = 5; // FE gameDetail page: participants.length > 5 renders "See all (N)"
    expect(participants.length).toBe(STRIP_LIMIT + 1);
    const eve = await seededUser('Eve');
    const frank = await seededUser('Frank');
    expect(participants.filter((p) => p.is_guest).map((p) => p.user_id).sort()).toEqual([eve.id, frank.id].sort());
    // Neither guest is a member: Frank stays tickable in the invite panel (N45 / N54).
    for (const guest of [eve, frank]) {
      expect(await UserGroup.count({ where: { group_id: warriors.id, user_uuid: guest.id } })).toBe(0);
    }
  }, 120000);

  it('P64-1: Amber Aces stores colour preset amber and no image, Alice is a plain member, and Weekend Warriors is still the only live group she owns or administers', async () => {
    await runSeed();
    const amber = await Group.findOne({ where: { group_id: 'amber-aces' } });
    expect(amber).not.toBeNull();
    expect(amber.name).toBe('Amber Aces');
    expect(amber.color_preset).toBe('amber');
    expect(amber.background_image_url).toBeNull();
    const { GROUP_COLOUR_PRESET_IDS } = require('../../utils/groupColourPresets');
    expect(GROUP_COLOUR_PRESET_IDS).toContain('amber');
    const alice = await seededUser('Alice');
    const diana = await seededUser('Diana');
    const charlie = await seededUser('Charlie');
    const members = await UserGroup.findAll({ where: { group_id: amber.id, status: 'active' } });
    expect(Object.fromEntries(members.map((m) => [m.user_uuid, m.role])))
      .toEqual({ [diana.id]: 'owner', [alice.id]: 'member', [charlie.id]: 'member' });
    // No event of its own: nothing joins any calendar.
    expect(await Event.count({ where: { group_id: amber.id } })).toBe(0);
    // The N45 / N54 premise (quick 261111-frd): one live group Alice may invite to.
    const managed = await UserGroup.findAll({
      where: { user_uuid: alice.id, status: 'active', role: { [Op.in]: ['owner', 'admin'] } },
    });
    const warriors = await Group.findOne({ where: { group_id: 'weekend-warriors' } });
    expect(managed.map((m) => m.group_id)).toEqual([warriors.id]);
  }, 120000);

  it('a re-seed replaces the RSVP rows instead of adding to them', async () => {
    await runSeed();
    const first = await EventRsvp.count();
    expect(first).toBe(4);
    await runSeed();
    expect(await EventRsvp.count()).toBe(first);
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
