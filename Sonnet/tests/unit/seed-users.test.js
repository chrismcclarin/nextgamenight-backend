// tests/unit/seed-users.test.js
// quick-261119-nv0: the seed's user table (scripts/lib/seed-users.js) and the seed's wiring
// to the staging guard (scripts/seed-sample-data.js).
//
// WHY THIS FILE EXISTS. Three things have to stay true together:
//   1. With no new variable set, the seed writes exactly the seven users and the pending
//      invite it wrote before this task (same subs, same names, same reserved addresses).
//      Local development, CI and the frontend's e2e job all depend on that.
//   2. With SEED_EMAIL_BASE set (staging), every seeded address is a plus-address of that one
//      base, and lock 4 of the staging guard accepts every one of them. The writer and the
//      lock use ONE parser, and S6 below is the test that they cannot drift apart.
//   3. The seed awaits the guard before it touches the database. That is an ORDERING property,
//      and the seed cannot be loaded in this DB-free lane (its `require('../models')` opens a
//      Sequelize connection), so S7 reads the source, the same shape and the same argument as
//      tests/unit/e2e-fixtures-guard.test.js.
//
// If S7 goes red, do NOT relax it: the seed has lost its guard, or something now runs ahead
// of it. That is the finding.
//
// Every address below is on an RFC 2606 reserved domain. This repository is public.

const fs = require('fs');
const path = require('path');

const seedUsers = require('../../scripts/lib/seed-users');
const { parseStagingEmailBase, isStagingOwnedEmail } = require('../../scripts/lib/assert-not-production-db');

const { ALICE_PLACEHOLDER_SUB, SEED_USER_TAGS, seedAddress, buildSampleUsers } = seedUsers;

const SEED_PATH = path.join(__dirname, '..', '..', 'scripts', 'seed-sample-data.js');
const seedSource = fs.readFileSync(SEED_PATH, 'utf8');

// The seven users exactly as scripts/seed-sample-data.js wrote them on origin/main before
// this task (its sampleUsers table), in order.
const TODAY = [
  { user_id: 'auth0|6959f749afc6f7d1e7fb1635', username: 'Alice', email: 'alice@example.com' },
  { user_id: 'auth0|695a019d225a2081ca41297b', username: 'Bob', email: 'bob@example.com' },
  { user_id: 'auth0|695a0258225a2081ca4129d5', username: 'Charlie', email: 'charlie@example.com' },
  { user_id: 'auth0|695a02a92c3ca58370cd94c0', username: 'Diana', email: 'diana@example.com' },
  { user_id: 'auth0|695a02f2f066d9582838c311', username: 'Eve', email: 'eve@example.com' },
  { user_id: 'auth0|695a0327b7305395a05774dc', username: 'Frank', email: 'frank@example.com' },
  {
    user_id: 'auth0|695a0399c0ffee0000000001',
    username: 'Bartholomew Featherstonehaugh-Cholmondeley',
    email: 'bartholomew@example.com',
  },
];
const TAGS = ['alice', 'bob', 'charlie', 'diana', 'eve', 'frank', 'bartholomew'];

let envSnapshot;

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in envSnapshot)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(envSnapshot)) process.env[name] = value;
});

describe('buildSampleUsers: with no new variable set, the seed is unchanged', () => {
  test("S1: seven users in today's order, with today's names, fallback subs and addresses", () => {
    const users = buildSampleUsers({});

    expect(users).toHaveLength(7);
    expect(users.map(({ user_id, username, email }) => ({ user_id, username, email }))).toEqual(TODAY);
  });

  test('S1: every user has sms_enabled false, and no user has a phone key', () => {
    for (const user of buildSampleUsers({})) {
      expect(user.sms_enabled).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(user, 'phone')).toBe(false);
      expect(Object.keys(user).sort()).toEqual(['email', 'sms_enabled', 'user_id', 'username']);
    }
  });

  test('S1: the tags are the seven local parts, in table order, and Alice keeps her placeholder sub', () => {
    expect(SEED_USER_TAGS).toEqual(TAGS);
    expect(ALICE_PLACEHOLDER_SUB).toBe('auth0|6959f749afc6f7d1e7fb1635');
    expect(buildSampleUsers({})[0].user_id).toBe(ALICE_PLACEHOLDER_SUB);
  });

  test('S2: AUTH0_ALICE_SUB and AUTH0_BART_SUB replace the matching fallback subs, and only those', () => {
    const users = buildSampleUsers({
      AUTH0_ALICE_SUB: 'auth0|unit-test-only-alice',
      AUTH0_BART_SUB: 'auth0|unit-test-only-bart',
    });

    expect(users[0].user_id).toBe('auth0|unit-test-only-alice');
    expect(users[6].user_id).toBe('auth0|unit-test-only-bart');
    expect(users.slice(1, 6).map((u) => u.user_id)).toEqual(TODAY.slice(1, 6).map((u) => u.user_id));
  });

  test('S2: every user has its own sub variable (BOB, CHARLIE, DIANA, EVE, FRANK too)', () => {
    const env = {};
    for (const name of ['ALICE', 'BOB', 'CHARLIE', 'DIANA', 'EVE', 'FRANK', 'BART']) {
      env[`AUTH0_${name}_SUB`] = `auth0|unit-test-only-${name.toLowerCase()}`;
    }

    expect(buildSampleUsers(env).map((u) => u.user_id)).toEqual([
      'auth0|unit-test-only-alice',
      'auth0|unit-test-only-bob',
      'auth0|unit-test-only-charlie',
      'auth0|unit-test-only-diana',
      'auth0|unit-test-only-eve',
      'auth0|unit-test-only-frank',
      'auth0|unit-test-only-bart',
    ]);
  });

  test('reads process.env when no env is passed', () => {
    delete process.env.SEED_EMAIL_BASE;
    delete process.env.SEED_SMS_USER;
    process.env.AUTH0_ALICE_SUB = 'auth0|unit-test-only-alice';

    expect(buildSampleUsers()[0].user_id).toBe('auth0|unit-test-only-alice');
    expect(buildSampleUsers()[1].email).toBe('bob@example.com');
  });
});

describe('SEED_EMAIL_BASE: every seeded address becomes a plus-address of the base', () => {
  const env = { SEED_EMAIL_BASE: 'Owner@Mail.Example.org' };

  test('S3: the seven users get the base local part, a plus, and their tag', () => {
    expect(buildSampleUsers(env).map((u) => u.email)).toEqual([
      'owner+alice@mail.example.org',
      'owner+bob@mail.example.org',
      'owner+charlie@mail.example.org',
      'owner+diana@mail.example.org',
      'owner+eve@mail.example.org',
      'owner+frank@mail.example.org',
      'owner+bartholomew@mail.example.org',
    ]);
  });

  test('S3: names and subs do not change with the base', () => {
    const users = buildSampleUsers(env);
    expect(users.map((u) => u.username)).toEqual(TODAY.map((u) => u.username));
    expect(users.map((u) => u.user_id)).toEqual(TODAY.map((u) => u.user_id));
  });

  test('S3: the pending invite follows the base, and keeps its reserved address without one', () => {
    expect(seedAddress('pending-invitee', env)).toBe('owner+pending-invitee@mail.example.org');
    expect(seedAddress('pending-invitee', {})).toBe('pending-invitee@example.com');
    expect(seedAddress('pending-invitee', { SEED_EMAIL_BASE: '   ' })).toBe('pending-invitee@example.com');
  });

  test.each([
    ['a "+" in it', 'owner+tag@example.org'],
    ['no "@"', 'owner.example.org'],
  ])('S5: a malformed base (%s) throws, naming SEED_EMAIL_BASE', (_label, value) => {
    expect(() => buildSampleUsers({ SEED_EMAIL_BASE: value })).toThrow(/SEED_EMAIL_BASE/);
    expect(() => seedAddress('pending-invitee', { SEED_EMAIL_BASE: value })).toThrow(/SEED_EMAIL_BASE/);
  });

  test('S6: lock 4 accepts every address the seed derives from a base (the writer and the lock agree)', () => {
    const base = parseStagingEmailBase(env.SEED_EMAIL_BASE);
    const derived = [...buildSampleUsers(env).map((u) => u.email), seedAddress('pending-invitee', env)];

    expect(derived).toHaveLength(8);
    for (const email of derived) {
      // seedEmails is deliberately EMPTY here: each address must pass on the plus-address
      // rule alone, not because it happens to be listed.
      expect(isStagingOwnedEmail(email, { seedEmails: [], base })).toBe(true);
    }
  });

  test('S6: without a base, the reserved addresses pass only because they are the seed list', () => {
    const emails = buildSampleUsers({}).map((u) => u.email);

    for (const email of emails) {
      expect(isStagingOwnedEmail(email, { seedEmails: emails, base: null })).toBe(true);
      expect(isStagingOwnedEmail(email, { seedEmails: ['someone-else@example.net'], base: null })).toBe(false);
    }
  });
});

describe('SEED_SMS_USER: exactly one SMS-entitled user', () => {
  test.each(['alice', 'ALICE', '  Alice  '])('S4: %j gives exactly one user with sms_enabled true (Alice)', (value) => {
    const users = buildSampleUsers({ SEED_SMS_USER: value });

    expect(users.filter((u) => u.sms_enabled === true).map((u) => u.username)).toEqual(['Alice']);
    expect(users.filter((u) => u.sms_enabled === false)).toHaveLength(6);
  });

  test('S4: "bartholomew" picks the seventh user', () => {
    const users = buildSampleUsers({ SEED_SMS_USER: 'bartholomew' });

    expect(users.filter((u) => u.sms_enabled).map((u) => u.username)).toEqual([
      'Bartholomew Featherstonehaugh-Cholmondeley',
    ]);
  });

  test.each([[undefined], [''], ['   ']])('S4: %j gives no SMS-entitled user', (value) => {
    const users = buildSampleUsers({ SEED_SMS_USER: value });

    expect(users.filter((u) => u.sms_enabled !== false)).toHaveLength(0);
  });

  test.each(['bart', 'nobody', 'alice,bob', 'a-pasted-value-that-is-not-a-tag'])(
    'S4: %j throws a message that lists the seven tags and does not repeat the value',
    (value) => {
      let error = null;
      try {
        buildSampleUsers({ SEED_SMS_USER: value });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('SEED_SMS_USER');
      for (const tag of TAGS) expect(error.message).toContain(tag);
      // The value is never repeated: someone could paste a phone number into this variable,
      // and the message reaches a log. ('bart' is a prefix of a listed tag, so it is checked
      // in its quoted form.)
      expect(error.message).not.toContain(`"${value}"`);
      if (value !== 'bart') expect(error.message).not.toContain(value);
    }
  );

  test('no phone number is ever seeded, with or without the SMS user', () => {
    for (const env of [{}, { SEED_SMS_USER: 'alice' }, { SEED_SMS_USER: 'alice', SEED_EMAIL_BASE: 'owner@example.org' }]) {
      for (const user of buildSampleUsers(env)) {
        expect(Object.prototype.hasOwnProperty.call(user, 'phone')).toBe(false);
      }
    }
  });
});

describe('S7: scripts/seed-sample-data.js awaits the guard before it touches the database', () => {
  // The seed function's body: from its declaration to the end of the file.
  const fnIndex = seedSource.indexOf('async function seedDatabase(');
  const body = fnIndex > -1 ? seedSource.slice(fnIndex) : '';

  test('requires the user table and the guard from the shared lib files', () => {
    expect(seedSource).toMatch(/require\(\s*['"]\.\/lib\/seed-users['"]\s*\)/);
    expect(seedSource).toMatch(/require\(\s*['"]\.\/lib\/assert-not-production-db['"]\s*\)/);
    expect(seedSource).toMatch(/assertSeedTargetAllowed/);
  });

  test('builds its users from the lib, once, at module load (above seedDatabase)', () => {
    const buildIndex = seedSource.indexOf('const sampleUsers = buildSampleUsers(process.env);');

    expect(fnIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeGreaterThan(-1);
    expect(buildIndex).toBeLessThan(fnIndex);
  });

  test('the first statement of the try is the awaited guard call', () => {
    expect(fnIndex).toBeGreaterThan(-1);
    const tryIndex = body.indexOf('try {');
    expect(tryIndex).toBeGreaterThan(-1);

    // The first line after `try {` that is neither blank nor a comment.
    const firstStatement = body
      .slice(tryIndex + 'try {'.length)
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.startsWith('//'));

    expect(firstStatement).toMatch(/await assertSeedTargetAllowed\(sequelize,/);
  });

  test('the guard call comes before the connection, the schema sync, and every write', () => {
    const callIndex = body.indexOf('await assertSeedTargetAllowed(');

    // ANTI-VACUITY: every index must actually be found. A rename that removed a marker would
    // otherwise turn "callIndex < -1" into a silent pass or a misleading failure.
    expect(callIndex).toBeGreaterThan(-1);
    for (const marker of ['sequelize.authenticate(', 'sequelize.sync(', '.destroy(', 'findOrCreate(', '.create(']) {
      const markerIndex = body.indexOf(marker);
      expect({ marker, found: markerIndex > -1 }).toEqual({ marker, found: true });
      expect({ marker, guardFirst: callIndex < markerIndex }).toEqual({ marker, guardFirst: true });
    }
  });

  test('nothing above seedDatabase connects or writes', () => {
    expect(fnIndex).toBeGreaterThan(-1);
    const preamble = seedSource.slice(0, fnIndex);

    for (const marker of ['sequelize.authenticate(', 'sequelize.sync(', '.destroy(', 'findOrCreate(', '.create(', 'sequelize.query(']) {
      expect({ marker, inPreamble: preamble.includes(marker) }).toEqual({ marker, inPreamble: false });
    }
  });

  test('the seed no longer calls the synchronous guard itself', () => {
    expect(seedSource).not.toMatch(/assertNotProductionDb\s*\(/);
  });

  test("the call passes the seed's own addresses, built from sampleUsers, and the base", () => {
    const callIndex = body.indexOf('await assertSeedTargetAllowed(');
    expect(callIndex).toBeGreaterThan(-1);
    const call = body.slice(callIndex, body.indexOf(');', callIndex));

    expect(call).toMatch(/seedEmails:\s*sampleUsers\.map\(/);
    expect(call).toMatch(/stagingEmailBase/);
  });

  test('holds no literal address: users and the pending invite come from the lib', () => {
    expect(seedSource).not.toMatch(/email:\s*['"]/);
    expect(seedSource).toMatch(/seedAddress\(\s*['"]pending-invitee['"]/);
  });

  test('still exports seedDatabase and ALICE_PLACEHOLDER_SUB', () => {
    expect(seedSource).toMatch(/module\.exports\s*=\s*\{\s*seedDatabase,\s*ALICE_PLACEHOLDER_SUB\s*\};/);
  });
});
