// tests/scripts/seedSampleData.test.js
// Quick task 261103-glx (Phase 88.9 round 2) — the seed's two walk-link fixtures:
// a group-restore link for the soft-deleted group Retired Raiders, and Alice's three
// single-use RSVP links on the Weekend Warriors Catan night.
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
const { User, Group, UserGroup, Event, SingleUseToken } = require('../../models');
const groupRoutes = require('../../routes/groups');
const { restoreGroupByToken } = require('../../services/groupRecoveryService');
const { seedDatabase } = require('../../scripts/seed-sample-data');

// The restore preview is public, so the router is mounted bare (same mounting as
// tests/routes/groups.restore.test.js, minus the auth stub nothing here needs).
const app = express();
app.use(express.json());
app.use('/api/groups', groupRoutes);

// An obviously fake, test-only value — never a real secret.
const TEST_SECRET = 'glx-test-only-not-a-secret-000000000000';
const ENV_KEYS = ['CI', 'MAGIC_TOKEN_SECRET', 'FRONTEND_URL'];
const DAY_MS = 24 * 60 * 60 * 1000;

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
});
