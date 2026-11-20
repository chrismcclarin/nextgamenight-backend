// tests/unit/staging-seed-guard.test.js
// quick-261119-nv0 (owner rulings G1, S1, S2 of 2026-11-19): refusal tests for the seed's
// four-lock staging arm in scripts/lib/assert-not-production-db.js.
//
// WHY THIS FILE EXISTS. scripts/seed-sample-data.js alters the schema and mass-deletes rows in
// whatever database the environment resolves. Until this task it could never run with
// NODE_ENV=production. Staging runs with NODE_ENV=production (G1), so the seed gained one
// narrow way through that refusal, and it opens only when ALL FOUR locks hold:
//   lock 1  RAILWAY_ENVIRONMENT_NAME is exactly "staging";
//   lock 2  ALLOW_STAGING_SEED is exactly "1";
//   lock 3  the resolved database host is parseable and, when PROD_DB_HOST_DENY is set, does
//           not contain it (weak on purpose, S1);
//   lock 4  the Users table holds nobody except the seed's own users and plus-addresses of
//           SEED_EMAIL_BASE (S2). Production always fails this one, because it holds real users.
// The four locks are what stands between `npm run seed` and the production data.
//
// A RED TEST HERE MEANS THE GUARD LOST A LOCK. That is the finding. It is never a reason to
// relax the test.
//
// DB-free lane (jest.unit.config.js): no models, no Postgres. sequelize is a plain stub, so
// lock 4's query is a jest.fn and nothing here can touch a real database.
//
// Every address and host below is an RFC 2606 reserved name (example.com / .org / .net) and
// every password is an obvious fake. This repository is public.

const guard = require('../../scripts/lib/assert-not-production-db');

const {
  resolveDbHost,
  assertNotProductionDb,
  describeResolvedDb,
  parseStagingEmailBase,
  isStagingOwnedEmail,
  assertStagingSeedAllowed,
  assertSeedTargetAllowed,
} = guard;

// Every variable the guard reads. Cleared before each test and restored after, so neither
// CI's own DATABASE_URL nor one test's NODE_ENV can leak into another file or test (the
// default `npm test` lane runs this file too).
const GUARD_ENV = [
  'NODE_ENV',
  'POSTGRES_PRIVATE_URL',
  'POSTGRES_URL',
  'DATABASE_URL',
  'PGDATABASE_URL',
  'ALLOW_DESTRUCTIVE_SEED',
  'ALLOW_STAGING_SEED',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_PROJECT_ID',
  'PROD_DB_HOST_DENY',
];

const STAGING_URL = 'postgres://dbuser:s3cretpw@host.example.net:5432/railway';
const LOCAL_URL = 'postgres://dbuser:s3cretpw@localhost:5433/boardgame_db';

const BASE = 'owner@example.com';
const SEED_EMAILS = [
  'owner+alice@example.com',
  'owner+bob@example.com',
  'owner+charlie@example.com',
];
const DEFAULT_SEED_EMAILS = ['alice@example.com', 'bob@example.com'];

let envSnapshot;

function makeSequelize(rows = [], config = { host: 'localhost', port: 5432, database: 'boardgame_db' }) {
  return {
    config,
    QueryTypes: { SELECT: 'SELECT' },
    query: jest.fn().mockResolvedValue(rows),
  };
}

// "Every variable right": production mode, the staging environment name, the staging flag and
// a parseable remote database URL. Each lock test then breaks exactly one thing.
function setEveryVariableRight() {
  process.env.NODE_ENV = 'production';
  process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
  process.env.ALLOW_STAGING_SEED = '1';
  process.env.DATABASE_URL = STAGING_URL;
}

const opts = (over = {}) => ({ seedEmails: SEED_EMAILS, stagingEmailBase: BASE, ...over });

// Runs the guard and returns the refusal message, failing the test if it did not refuse.
async function refusalOf(promiseFactory) {
  let error = null;
  try {
    await promiseFactory();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(Error);
  return error.message;
}

beforeEach(() => {
  envSnapshot = { ...process.env };
  for (const name of GUARD_ENV) delete process.env[name];
});

afterEach(() => {
  for (const name of Object.keys(process.env)) {
    if (!(name in envSnapshot)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(envSnapshot)) process.env[name] = value;
});

describe('assertNotProductionDb: unchanged for every caller (characterization, NV0-2)', () => {
  test('C1: NODE_ENV=production throws the "NO override" message even with every staging variable set', () => {
    setEveryVariableRight();
    process.env.ALLOW_DESTRUCTIVE_SEED = '1';
    const sequelize = makeSequelize();

    expect(() => assertNotProductionDb(sequelize)).toThrow(/NODE_ENV==='production'/);
    expect(() => assertNotProductionDb(sequelize)).toThrow(/There is NO override for this arm/);
    // The synchronous guard never queries: e2e-fixtures.js calls it un-awaited.
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('C2: NODE_ENV=test with DATABASE_URL on localhost returns without throwing', () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = LOCAL_URL;

    expect(assertNotProductionDb(makeSequelize())).toBeUndefined();
  });

  test('C3: a remote host without ALLOW_DESTRUCTIVE_SEED throws, naming the source variable', () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = STAGING_URL;

    expect(() => assertNotProductionDb(makeSequelize())).toThrow(/non-local database host/);
    expect(() => assertNotProductionDb(makeSequelize())).toThrow(/host\.example\.net/);
    expect(() => assertNotProductionDb(makeSequelize())).toThrow(/resolved from DATABASE_URL/);
  });

  test('C4: a remote host with ALLOW_DESTRUCTIVE_SEED=1 returns', () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = STAGING_URL;
    process.env.ALLOW_DESTRUCTIVE_SEED = '1';

    expect(assertNotProductionDb(makeSequelize())).toBeUndefined();
  });

  test('C5: resolveDbHost prefers POSTGRES_PRIVATE_URL, and an unparseable URL falls back to sequelize.config.host', () => {
    process.env.POSTGRES_PRIVATE_URL = 'postgres://dbuser:s3cretpw@private.example.org:5432/railway';
    process.env.DATABASE_URL = STAGING_URL;
    expect(resolveDbHost(makeSequelize())).toBe('private.example.org');

    delete process.env.POSTGRES_PRIVATE_URL;
    process.env.DATABASE_URL = 'not a url';
    expect(resolveDbHost(makeSequelize([], { host: 'fallback.example.net' }))).toBe('fallback.example.net');
  });
});

describe('assertSeedTargetAllowed: outside production mode the seed is unchanged', () => {
  test('N1: NODE_ENV=test on localhost resolves and runs no query', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = LOCAL_URL;
    const sequelize = makeSequelize();

    const result = await assertSeedTargetAllowed(sequelize, opts());

    expect(sequelize.query).not.toHaveBeenCalled();
    expect(result.database).toContain('localhost');
    expect(result.database).toContain('boardgame_db');
    expect(result.database).not.toContain('s3cretpw');
    expect(result.locks).toHaveLength(1);
    expect(result.locks[0]).toMatch(/production mode is off/);
  });

  test('R2: outside production mode the result says so (productionMode false), so the seed keeps its schema sync', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = LOCAL_URL;

    const result = await assertSeedTargetAllowed(makeSequelize(), opts());

    expect(result.productionMode).toBe(false);
  });

  test('N1: NODE_ENV unset (the CI seed) on localhost resolves and runs no query', async () => {
    process.env.DATABASE_URL = LOCAL_URL;
    const sequelize = makeSequelize();

    await expect(assertSeedTargetAllowed(sequelize, opts())).resolves.toEqual(
      expect.objectContaining({ locks: [expect.stringMatching(/production mode is off/)] })
    );
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('N2: NODE_ENV=test on a remote host rejects with the message assertNotProductionDb throws', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = STAGING_URL;
    const sequelize = makeSequelize();

    let syncMessage = null;
    try {
      assertNotProductionDb(sequelize);
    } catch (e) {
      syncMessage = e.message;
    }
    expect(syncMessage).toMatch(/non-local database host/);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));
    expect(message).toBe(syncMessage);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('N2: ALLOW_STAGING_SEED does not stand in for ALLOW_DESTRUCTIVE_SEED outside production mode', async () => {
    // No Railway variable here. Since R-3 any of them puts the run in production mode (the
    // R3 block below), where the four locks decide and neither flag stands in for the other.
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = STAGING_URL;
    process.env.ALLOW_STAGING_SEED = '1';
    process.env.PROD_DB_HOST_DENY = 'prod-db.example.org';

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize(), opts()));
    expect(message).toMatch(/non-local database host/);
  });
});

describe('R3: production mode is "inside Railway" OR a NODE_ENV that reads as production', () => {
  // Review finding R-3 (quick-261119-nv0). Before it, only NODE_ENV === 'production' (strict)
  // reached the four locks. A Railway service whose NODE_ENV was mistyped ('Production',
  // ' production') and that had ALLOW_DESTRUCTIVE_SEED=1 took the local-host arm instead: the
  // seed ran against a database holding real users and lock 4 never queried.
  const NEAR_PRODUCTION = ['Production', 'PRODUCTION', ' production', 'production ', '\tproduction\n'];
  const RAILWAY_MARKERS = ['RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_PROJECT_ID'];
  const REAL_USER = [{ email: 'real.person@example.org' }];

  test.each(NEAR_PRODUCTION)(
    'NODE_ENV %j with ALLOW_DESTRUCTIVE_SEED=1 and a real user: refused, and no longer waved through',
    async (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;
      process.env.DATABASE_URL = STAGING_URL;
      process.env.ALLOW_DESTRUCTIVE_SEED = '1';
      const sequelize = makeSequelize(REAL_USER);

      const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

      expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
      // No Railway environment name here, so lock 1 is the one that answers.
      expect(message).toMatch(/lock 1\b/i);
    }
  );

  test.each(NEAR_PRODUCTION)(
    'NODE_ENV %j with locks 1 to 3 holding: lock 4 queries and refuses the real user',
    async (nodeEnv) => {
      setEveryVariableRight();
      process.env.NODE_ENV = nodeEnv;
      process.env.ALLOW_DESTRUCTIVE_SEED = '1';
      const sequelize = makeSequelize(REAL_USER);

      const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

      expect(message).toMatch(/lock 4\b/i);
      expect(message).toMatch(/\b1 user\b/);
      expect(sequelize.query).toHaveBeenCalledTimes(1);
    }
  );

  test.each(RAILWAY_MARKERS)(
    '%s set, NODE_ENV=test, ALLOW_DESTRUCTIVE_SEED=1, a real user: the four locks decide and refuse',
    async (marker) => {
      process.env.NODE_ENV = 'test';
      process.env.DATABASE_URL = STAGING_URL;
      process.env.ALLOW_DESTRUCTIVE_SEED = '1';
      process.env[marker] = 'unit-test-only-value';
      const sequelize = makeSequelize(REAL_USER);

      const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

      expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
      expect(message).toMatch(/lock 1\b/i);
      expect(message).not.toContain('unit-test-only-value');
    }
  );

  test.each([[undefined], ['test'], ['development']])(
    'inside the Railway staging environment with NODE_ENV %j: lock 4 queries and refuses the real user',
    async (nodeEnv) => {
      setEveryVariableRight();
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      process.env.ALLOW_DESTRUCTIVE_SEED = '1';
      const sequelize = makeSequelize(REAL_USER);

      const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

      expect(message).toMatch(/lock 4\b/i);
      expect(sequelize.query).toHaveBeenCalledTimes(1);
    }
  );

  test('inside Railway on a local database host the four locks still decide (the host is not an excuse)', async () => {
    process.env.DATABASE_URL = LOCAL_URL;
    process.env.RAILWAY_PROJECT_ID = 'unit-test-only-value';

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize(), opts()));
    expect(message).toMatch(/lock 1\b/i);
  });

  test('inside the Railway staging environment with NODE_ENV=test and all four locks holding: allowed, in production mode', async () => {
    setEveryVariableRight();
    process.env.NODE_ENV = 'test';

    const result = await assertSeedTargetAllowed(makeSequelize([{ email: 'owner+alice@example.com' }]), opts());

    expect(result.locks).toHaveLength(4);
    expect(result.productionMode).toBe(true);
  });

  test.each(RAILWAY_MARKERS)('%s set to an empty value does not count as inside Railway', async (marker) => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = LOCAL_URL;
    process.env[marker] = '';
    const sequelize = makeSequelize();

    const result = await assertSeedTargetAllowed(sequelize, opts());

    expect(result.productionMode).toBe(false);
    expect(result.locks).toHaveLength(1);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test.each([[undefined], ['test'], ['development'], ['prod'], ['production-like'], ['staging'], ['']])(
    'UNCHANGED: with no Railway variable, NODE_ENV %j on localhost takes the local-host arm and runs no query',
    async (nodeEnv) => {
      if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
      process.env.DATABASE_URL = LOCAL_URL;
      const sequelize = makeSequelize(REAL_USER);

      const result = await assertSeedTargetAllowed(sequelize, opts());

      expect(result.productionMode).toBe(false);
      expect(result.locks).toHaveLength(1);
      expect(result.locks[0]).toMatch(/production mode is off/);
      expect(sequelize.query).not.toHaveBeenCalled();
    }
  );

  test('UNCHANGED: with no Railway variable and NODE_ENV=test, a remote host still needs ALLOW_DESTRUCTIVE_SEED=1', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = STAGING_URL;

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize(), opts()));
    expect(message).toMatch(/non-local database host/);

    process.env.ALLOW_DESTRUCTIVE_SEED = '1';
    const result = await assertSeedTargetAllowed(makeSequelize(), opts());
    expect(result.productionMode).toBe(false);
  });

  describe('assertNotProductionDb itself is untouched (scripts/e2e-fixtures.js calls it un-awaited)', () => {
    test.each(NEAR_PRODUCTION)('NODE_ENV %j on localhost still returns, exactly as before', (nodeEnv) => {
      process.env.NODE_ENV = nodeEnv;
      process.env.DATABASE_URL = LOCAL_URL;

      expect(assertNotProductionDb(makeSequelize())).toBeUndefined();
    });

    test.each(RAILWAY_MARKERS)('%s set does not change it: localhost returns, a remote host follows ALLOW_DESTRUCTIVE_SEED', (marker) => {
      process.env.NODE_ENV = 'test';
      process.env[marker] = 'unit-test-only-value';
      const sequelize = makeSequelize();

      process.env.DATABASE_URL = LOCAL_URL;
      expect(assertNotProductionDb(sequelize)).toBeUndefined();

      process.env.DATABASE_URL = STAGING_URL;
      expect(() => assertNotProductionDb(sequelize)).toThrow(/non-local database host/);

      process.env.ALLOW_DESTRUCTIVE_SEED = '1';
      expect(assertNotProductionDb(sequelize)).toBeUndefined();
      expect(sequelize.query).not.toHaveBeenCalled();
    });
  });
});

describe('lock 1: RAILWAY_ENVIRONMENT_NAME is exactly "staging"', () => {
  test('N3: every variable right and an empty Users table, but the environment is named production', async () => {
    setEveryVariableRight();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    const sequelize = makeSequelize([]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toMatch(/lock 1\b/i);
    expect(message).toContain('RAILWAY_ENVIRONMENT_NAME');
    expect(message).toContain('host.example.net');
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('N3: unset rejects', async () => {
    setEveryVariableRight();
    delete process.env.RAILWAY_ENVIRONMENT_NAME;

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));
    expect(message).toMatch(/lock 1\b/i);
  });

  test.each(['Staging', 'STAGING', ' staging', 'staging ', 'staging-2', ''])(
    'N3: %j is not "staging" and rejects',
    async (name) => {
      setEveryVariableRight();
      process.env.RAILWAY_ENVIRONMENT_NAME = name;

      const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));
      expect(message).toMatch(/lock 1\b/i);
    }
  );
});

describe('the guard names variables and never repeats what they hold', () => {
  // Owner requirement (2026-11-19): nothing this work prints may reveal a variable's value.
  // A refusal names the variable and the rule; a passing line names the variable. The one
  // thing printed from the environment is the database line (host, port, database name).
  test('a lock 1 refusal does not repeat the value of RAILWAY_ENVIRONMENT_NAME', async () => {
    setEveryVariableRight();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'some-other-environment-name';

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));

    expect(message).toMatch(/lock 1\b/i);
    expect(message).toContain('RAILWAY_ENVIRONMENT_NAME');
    expect(message).not.toContain('some-other-environment-name');
  });

  test('a lock 2 refusal does not repeat the value of ALLOW_STAGING_SEED', async () => {
    setEveryVariableRight();
    process.env.ALLOW_STAGING_SEED = 'not-the-switch-value';

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));

    expect(message).toMatch(/lock 2\b/i);
    expect(message).not.toContain('not-the-switch-value');
  });

  test('the passing lock lines quote no value at all', async () => {
    setEveryVariableRight();
    process.env.PROD_DB_HOST_DENY = 'prod-db.example.org';

    const result = await assertSeedTargetAllowed(makeSequelize([{ email: 'owner+alice@example.com' }]), opts());

    expect(result.locks).toHaveLength(4);
    for (const line of result.locks) {
      expect(line).not.toMatch(/"/);
      expect(line).not.toContain('prod-db.example.org');
      expect(line).not.toContain('owner');
      expect(line).not.toContain('example.com');
    }
  });

  test('outside production mode the single line quotes no value either', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = LOCAL_URL;

    const result = await assertSeedTargetAllowed(makeSequelize(), opts());

    expect(result.locks).toHaveLength(1);
    expect(result.locks[0]).not.toMatch(/"/);
  });
});

describe('lock 2: ALLOW_STAGING_SEED is exactly "1"', () => {
  test('N4: unset rejects', async () => {
    setEveryVariableRight();
    delete process.env.ALLOW_STAGING_SEED;
    const sequelize = makeSequelize([]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toMatch(/lock 2\b/i);
    expect(message).toContain('ALLOW_STAGING_SEED');
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test.each(['0', 'true', 'yes', '1 ', '01'])('N4: %j rejects', async (value) => {
    setEveryVariableRight();
    process.env.ALLOW_STAGING_SEED = value;

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));
    expect(message).toMatch(/lock 2\b/i);
  });

  test('N4: ALLOW_DESTRUCTIVE_SEED=1 does not stand in for it', async () => {
    setEveryVariableRight();
    delete process.env.ALLOW_STAGING_SEED;
    process.env.ALLOW_DESTRUCTIVE_SEED = '1';

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));
    expect(message).toMatch(/lock 2\b/i);
  });
});

describe('lock 3: the resolved host parses and is not named by PROD_DB_HOST_DENY', () => {
  test('N5: PROD_DB_HOST_DENY contained in the resolved host rejects', async () => {
    setEveryVariableRight();
    process.env.PROD_DB_HOST_DENY = 'host.example.net';
    const sequelize = makeSequelize([]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toMatch(/lock 3\b/i);
    expect(message).toContain('PROD_DB_HOST_DENY');
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('N5: the match is a contains-match and ignores letter case', async () => {
    setEveryVariableRight();
    process.env.PROD_DB_HOST_DENY = 'EXAMPLE.NET';

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));
    expect(message).toMatch(/lock 3\b/i);
  });

  test('N5: a URL variable that is set but unparseable rejects, even when sequelize.config has a host', async () => {
    setEveryVariableRight();
    process.env.DATABASE_URL = 'not a url';
    const sequelize = makeSequelize([], { host: 'host.example.net', port: 5432, database: 'railway' });

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    expect(message).toMatch(/lock 3\b/i);
    expect(message).toMatch(/could not be parsed, so its host cannot be checked/);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('N5: no URL and no config host rejects (the host cannot be resolved)', async () => {
    setEveryVariableRight();
    delete process.env.DATABASE_URL;
    const sequelize = makeSequelize([], {});

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));
    expect(message).toMatch(/lock 3\b/i);
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('N5: with PROD_DB_HOST_DENY unset lock 3 passes and its line says it was not armed', async () => {
    setEveryVariableRight();

    const result = await assertSeedTargetAllowed(makeSequelize([]), opts());

    expect(result.locks[2]).toContain('PROD_DB_HOST_DENY not set; lock 3 not armed');
  });

  test('N5: with PROD_DB_HOST_DENY set to another host lock 3 passes and says it was checked', async () => {
    setEveryVariableRight();
    process.env.PROD_DB_HOST_DENY = 'prod-db.example.org';

    const result = await assertSeedTargetAllowed(makeSequelize([]), opts());

    expect(result.locks[2]).not.toContain('not armed');
    expect(result.locks[2]).toMatch(/lock 3\b/i);
  });
});

describe('lock 4: the Users table holds only staging-owned users', () => {
  test('N6: every variable right, one real user present: rejects with the count and never the address', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([
      { email: 'owner+alice@example.com' },
      { email: 'real.person@example.org' },
    ]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toMatch(/lock 4\b/i);
    expect(message).toMatch(/\b1 user\b/);
    expect(message).not.toContain('real.person');
    expect(message).not.toContain('example.org');
    expect(message).not.toContain('owner+alice');
    expect(message).toContain('host.example.net');
  });

  test('N6: the count is the number of users that are not staging-owned', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([
      { email: 'first.person@example.org' },
      { email: 'owner+bob@example.com' },
      { email: 'second.person@example.org' },
      { email: 'third.person@example.net' },
    ]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));
    expect(message).toMatch(/\b3 users\b/);
    expect(message).not.toContain('person');
  });

  test('N6: lock 4 reads the table with one raw SELECT and nothing else', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([]);

    await assertSeedTargetAllowed(sequelize, opts());

    expect(sequelize.query).toHaveBeenCalledTimes(1);
    expect(sequelize.query).toHaveBeenCalledWith('SELECT "email" FROM "Users"', { type: 'SELECT' });
  });

  test.each([[null], [''], [undefined], [42]])('N6: a row whose email is %j rejects', async (email) => {
    setEveryVariableRight();
    const sequelize = makeSequelize([{ email }]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));
    expect(message).toMatch(/lock 4\b/i);
    expect(message).toMatch(/\b1 user\b/);
  });

  test.each(['parent', 'original'])(
    'N6: a missing Users table (42P01 on the error %s) rejects with the migrations message',
    async (key) => {
      setEveryVariableRight();
      const sequelize = makeSequelize([]);
      const error = new Error('relation "Users" does not exist');
      error[key] = { code: '42P01' };
      sequelize.query.mockRejectedValue(error);

      const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

      expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
      expect(message).toContain('the Users table does not exist');
      expect(message).toMatch(/migrations/);
    }
  );

  test('N6: any other query error rejects naming lock 4, without repeating the driver message', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([]);
    sequelize.query.mockRejectedValue(new Error('password authentication failed for user "dbuser"'));

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toMatch(/lock 4\b/i);
    expect(message).not.toContain('dbuser');
    expect(message).not.toContain('the Users table does not exist');
  });

  test('N6: a query result that is not a list of rows rejects naming lock 4', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([]);
    // Set on the mock itself: passing undefined to makeSequelize would fall back to its
    // default of an empty list, which is a passing table.
    sequelize.query.mockResolvedValue(undefined);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));
    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toMatch(/lock 4\b/i);
  });

  test('N7: an empty table passes', async () => {
    setEveryVariableRight();

    const result = await assertSeedTargetAllowed(makeSequelize([]), opts());
    expect(result.locks).toHaveLength(4);
  });

  test("N7: the seed's own addresses pass in a different letter case", async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([{ email: 'Alice@Example.COM' }, { email: 'BOB@example.com' }]);

    await expect(
      assertSeedTargetAllowed(sequelize, opts({ seedEmails: DEFAULT_SEED_EMAILS, stagingEmailBase: undefined }))
    ).resolves.toEqual(expect.objectContaining({ locks: expect.any(Array) }));
  });

  test('N7: a plus-address of the base passes in a different letter case (S2: his own staging sign-ups)', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([
      { email: 'owner+alice@example.com' },
      { email: 'Owner+Walk-Two@Example.COM' },
    ]);

    await expect(assertSeedTargetAllowed(sequelize, opts())).resolves.toEqual(
      expect.objectContaining({ locks: expect.any(Array) })
    );
  });

  test.each([
    ['the base address itself, with no plus', 'owner@example.com'],
    ['the same local part at another domain', 'owner+walk@example.org'],
    ['a local part that only starts with the base local part', 'ownerx+walk@example.com'],
    ['a plus with an empty tag', 'owner+@example.com'],
    ['a domain that only ends with the base domain', 'owner+walk@mail.example.com'],
    ['a domain that only starts with the base domain', 'owner+walk@example.com.example.org'],
  ])('N7: lock 4 still rejects %s', async (_label, email) => {
    setEveryVariableRight();
    const sequelize = makeSequelize([{ email }]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));
    expect(message).toMatch(/lock 4\b/i);
    expect(message).toMatch(/\b1 user\b/);
  });

  test('N7: with no base configured a plus-address is not staging-owned', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([{ email: 'owner+walk@example.com' }]);

    const message = await refusalOf(() =>
      assertSeedTargetAllowed(sequelize, opts({ seedEmails: DEFAULT_SEED_EMAILS, stagingEmailBase: undefined }))
    );
    expect(message).toMatch(/lock 4\b/i);
  });

  test('a SEED_EMAIL_BASE that cannot be parsed refuses before the query, without repeating the value', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([]);

    const message = await refusalOf(() =>
      assertSeedTargetAllowed(sequelize, opts({ stagingEmailBase: 'owner+tag@example.com' }))
    );

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toContain('SEED_EMAIL_BASE');
    expect(message).not.toContain('owner+tag');
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});

describe('N8: no query runs until locks 1, 2 and 3 have all passed', () => {
  test.each([
    ['lock 1', () => { process.env.RAILWAY_ENVIRONMENT_NAME = 'production'; }],
    ['lock 2', () => { delete process.env.ALLOW_STAGING_SEED; }],
    ['lock 3', () => { process.env.PROD_DB_HOST_DENY = 'example.net'; }],
  ])('%s failing: sequelize.query is never called', async (_label, breakOne) => {
    setEveryVariableRight();
    breakOne();
    // A table holding a real user: had the query run, lock 4 would have been the one refusing.
    const sequelize = makeSequelize([{ email: 'real.person@example.org' }]);

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    // ANTI-VACUITY: it must be the guard's own refusal. Without this line the two assertions
    // below also hold for any unrelated error (for example the function not existing at all).
    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(sequelize.query).not.toHaveBeenCalled();
    expect(message).not.toMatch(/lock 4\b/i);
  });

  test('the locks refuse in order: with locks 1 and 2 both wrong, lock 1 is the one named', async () => {
    setEveryVariableRight();
    process.env.RAILWAY_ENVIRONMENT_NAME = 'production';
    delete process.env.ALLOW_STAGING_SEED;

    const message = await refusalOf(() => assertSeedTargetAllowed(makeSequelize([]), opts()));
    expect(message).toMatch(/lock 1\b/i);
    expect(message).not.toMatch(/lock 2\b/i);
  });
});

describe('N9: parseStagingEmailBase', () => {
  test.each([[undefined], [null], [''], ['   '], ['\t\n']])('returns null for %j', (value) => {
    expect(parseStagingEmailBase(value)).toBeNull();
  });

  test('returns the lower-cased local part and domain for a plain address', () => {
    expect(parseStagingEmailBase('owner@example.com')).toEqual({ local: 'owner', domain: 'example.com' });
    expect(parseStagingEmailBase('  Owner.Name@Example.COM  ')).toEqual({
      local: 'owner.name',
      domain: 'example.com',
    });
  });

  test.each([
    ['no "@"', 'owner.example.com'],
    ['two "@"', 'owner@extra@example.com'],
    ['an empty local part', '@example.com'],
    ['an empty domain', 'owner@'],
    ['a "+" in the base', 'owner+tag@example.com'],
    ['whitespace inside the local part', 'own er@example.com'],
    ['whitespace inside the domain', 'owner@example .com'],
  ])('throws for %s, naming SEED_EMAIL_BASE and never repeating the value', (_label, value) => {
    let error = null;
    try {
      parseStagingEmailBase(value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('SEED_EMAIL_BASE');
    expect(error.message).not.toContain(value);
  });
});

describe('isStagingOwnedEmail', () => {
  const base = { local: 'owner', domain: 'example.com' };
  const owned = (email, over = {}) => isStagingOwnedEmail(email, { seedEmails: DEFAULT_SEED_EMAILS, base, ...over });

  test.each([[null], [undefined], [''], [0], [{}]])('false for %j', (email) => {
    expect(owned(email)).toBe(false);
  });

  test('true for a seed address in any letter case', () => {
    expect(owned('alice@example.com')).toBe(true);
    expect(owned('ALICE@Example.Com')).toBe(true);
  });

  test('true for a plus-address of the base, false for the bare base and for look-alikes', () => {
    expect(owned('owner+walk@example.com')).toBe(true);
    expect(owned('OWNER+Walk@EXAMPLE.com')).toBe(true);
    expect(owned('owner@example.com')).toBe(false);
    expect(owned('owner+@example.com')).toBe(false);
    expect(owned('ownerx+walk@example.com')).toBe(false);
    expect(owned('owner+walk@example.org')).toBe(false);
  });

  test('false for a plus-address when no base is given', () => {
    expect(owned('owner+walk@example.com', { base: null })).toBe(false);
  });
});

describe('N10: all four locks pass', () => {
  test('resolves with a database line and exactly four lock lines, and no credential in any of them', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([
      { email: 'owner+alice@example.com' },
      { email: 'owner+signup-test@example.com' },
    ]);

    const result = await assertSeedTargetAllowed(sequelize, opts());

    expect(result.database).toContain('host.example.net');
    expect(result.database).toContain('railway');
    expect(result.database).toContain('5432');
    expect(result.database).toContain('DATABASE_URL');
    expect(result.database).not.toContain('s3cretpw');
    expect(result.database).not.toContain('dbuser');

    expect(result.locks).toHaveLength(4);
    result.locks.forEach((line, index) => {
      expect(typeof line).toBe('string');
      expect(line).toMatch(new RegExp(`lock ${index + 1}\\b`, 'i'));
      expect(line).not.toContain('s3cretpw');
      expect(line).not.toContain('dbuser');
      // A lock line never names a user: no address appears in the seed's log.
      expect(line).not.toContain('@');
    });
  });

  test('assertStagingSeedAllowed is the production-mode arm itself and returns the same shape', async () => {
    setEveryVariableRight();

    const result = await assertStagingSeedAllowed(makeSequelize([]), opts());

    expect(result.locks).toHaveLength(4);
    expect(result.database).toBe(describeResolvedDb(makeSequelize([])));
  });

  test('R2: the four-lock arm reports productionMode true, which is what makes the seed skip its schema sync', async () => {
    setEveryVariableRight();

    const viaEntry = await assertSeedTargetAllowed(makeSequelize([]), opts());
    const viaArm = await assertStagingSeedAllowed(makeSequelize([]), opts());

    expect(viaEntry.productionMode).toBe(true);
    expect(viaArm.productionMode).toBe(true);
  });
});

describe('describeResolvedDb: names the database, never a credential', () => {
  test('uses the same variable order as resolveDbHost and names the source', () => {
    process.env.POSTGRES_PRIVATE_URL = 'postgres://dbuser:s3cretpw@private.example.org:6543/stagingdb';
    process.env.DATABASE_URL = STAGING_URL;

    const line = describeResolvedDb(makeSequelize());

    expect(line).toContain('private.example.org');
    expect(line).toContain('6543');
    expect(line).toContain('stagingdb');
    expect(line).toContain('POSTGRES_PRIVATE_URL');
    expect(line).not.toContain('host.example.net');
    expect(line).not.toContain('s3cretpw');
    expect(line).not.toContain('dbuser');
  });

  test('defaults the port to 5432 when the URL has none', () => {
    process.env.DATABASE_URL = 'postgres://dbuser:s3cretpw@host.example.net/railway';

    expect(describeResolvedDb(makeSequelize())).toContain('5432');
  });

  test('ignores a query string, where a driver would also accept a password', () => {
    process.env.DATABASE_URL = 'postgres://dbuser@host.example.net:5432/railway?password=s3cretpw&sslmode=require';

    const line = describeResolvedDb(makeSequelize());
    expect(line).toContain('railway');
    expect(line).not.toContain('s3cretpw');
    expect(line).not.toContain('sslmode');
  });

  test('an unparseable URL says so, names the variable, and repeats none of its text', () => {
    process.env.POSTGRES_URL = 'dbuser:s3cretpw at nowhere';

    const line = describeResolvedDb(makeSequelize());

    expect(line).toMatch(/could not be parsed/);
    expect(line).toContain('POSTGRES_URL');
    expect(line).not.toContain('s3cretpw');
    expect(line).not.toContain('dbuser');
  });

  test('a connection string with no "//" parses with the credentials in its path: treated as unparseable', async () => {
    // new URL('postgres:user:password@host/db') does not throw. It returns an empty hostname
    // and a pathname that still holds the user and the password. Printing that pathname as
    // the "database name" would put a credential in the log, so no hostname means unparseable.
    process.env.DATABASE_URL = 'postgres:dbuser:s3cretpw@host.example.net/railway';

    const line = describeResolvedDb(makeSequelize());
    expect(line).toMatch(/could not be parsed/);
    expect(line).not.toContain('s3cretpw');
    expect(line).not.toContain('dbuser');

    // And lock 3 refuses it, even though sequelize.config carries a host.
    process.env.NODE_ENV = 'production';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'staging';
    process.env.ALLOW_STAGING_SEED = '1';
    const sequelize = makeSequelize([], { host: 'host.example.net', port: 5432, database: 'railway' });
    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));
    expect(message).toMatch(/lock 3\b/i);
    expect(message).not.toContain('s3cretpw');
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  // Review finding R-4 (quick-261119-nv0). A password holding an unencoded "/", "?" or "#"
  // ends the URL's host section early: the parser then reads the USER NAME as the host, the
  // leading digits of the password as the port, and the rest of the password plus the REAL
  // host as the path or the query. Printing that as "the database" put part of a password
  // and the real host into the seed's log and into every refusal. Such a string does not
  // read back as host, port and one database name, so it is unparseable: lock 3 refuses,
  // and the line prints none of it. Every value below is a fake on a reserved domain.
  const LEAKY = [
    ['an unencoded "/" in the password', 'postgres://dbuser:1234/SECRETPART@host.example.net:5432/railway'],
    ['an unencoded "?" in the password', 'postgres://dbuser:1234?SECRETPART@host.example.net:5432/railway'],
    ['an unencoded "#" in the password', 'postgres://dbuser:1234#SECRETPART@host.example.net:5432/railway'],
    ['an "@" and then a "/" in the password', 'postgres://dbuser:pa@1234/SECRETPART@host.example.net:5432/railway'],
    ['an "@" and then a "?" in the password', 'postgres://dbuser:pa@1234?SECRETPART@host.example.net:5432/railway'],
    ['a ":" in the database name', 'postgres://dbuser:s3cretpw@host.example.net:5432/rail:way'],
    ['an "@" in the database name', 'postgres://dbuser:s3cretpw@host.example.net:5432/rail@way'],
    ['two path segments', 'postgres://dbuser:s3cretpw@host.example.net:5432/railway/extra'],
    ['a database name with a trailing "/"', 'postgres://dbuser:s3cretpw@host.example.net:5432/railway/'],
  ];
  const PIECES = ['SECRETPART', 's3cretpw', 'dbuser', '1234', 'host.example.net', 'railway', 'rail', 'extra', '5432'];

  test.each(LEAKY)('R4: %s is unparseable, and the line prints none of the string', (_label, url) => {
    process.env.DATABASE_URL = url;

    const line = describeResolvedDb(makeSequelize([], { host: 'config.example.org', port: 6543, database: 'configdb' }));

    expect(line).toMatch(/could not be parsed/);
    expect(line).toContain('DATABASE_URL');
    for (const piece of PIECES) expect({ piece, printed: line.includes(piece) }).toEqual({ piece, printed: false });
    // And it does not fall back to the sequelize config, which is not what the seed would hit.
    expect(line).not.toContain('config.example.org');
  });

  test.each(LEAKY)('R4: %s is refused by lock 3, before any query, and the refusal prints none of it', async (_label, url) => {
    setEveryVariableRight();
    process.env.DATABASE_URL = url;
    const sequelize = makeSequelize([], { host: 'config.example.org', port: 6543, database: 'configdb' });

    const message = await refusalOf(() => assertSeedTargetAllowed(sequelize, opts()));

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toMatch(/lock 3\b/i);
    expect(message).toMatch(/could not be parsed, so its host cannot be checked/);
    for (const piece of PIECES) expect({ piece, printed: message.includes(piece) }).toEqual({ piece, printed: false });
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test.each([
    ['the usual form', 'postgres://dbuser:s3cretpw@host.example.net:5432/railway', 'host.example.net', '5432', 'railway'],
    ['the postgresql scheme', 'postgresql://dbuser:s3cretpw@host.example.net:6543/stagingdb', 'host.example.net', '6543', 'stagingdb'],
    ['no port', 'postgres://dbuser:s3cretpw@host.example.net/railway', 'host.example.net', '5432', 'railway'],
    ['no password', 'postgres://dbuser@host.example.net:5432/railway', 'host.example.net', '5432', 'railway'],
    ['no credentials', 'postgres://localhost:5433/boardgame_db', 'localhost', '5433', 'boardgame_db'],
    ['a query string', 'postgres://dbuser:s3cretpw@host.example.net:5432/railway?sslmode=require', 'host.example.net', '5432', 'railway'],
    ['an encoded "/" and "@" in the password', 'postgres://dbuser:12%2FSECRET%40PART@host.example.net:5432/railway', 'host.example.net', '5432', 'railway'],
    ['an unencoded "@" in the password', 'postgres://dbuser:SECRET@PART@host.example.net:5432/railway', 'host.example.net', '5432', 'railway'],
    ['an upper-case host', 'postgres://dbuser:s3cretpw@HOST.Example.NET:5432/railway', 'host.example.net', '5432', 'railway'],
    ['space around the whole string', '  postgres://dbuser:s3cretpw@host.example.net:5432/railway \n', 'host.example.net', '5432', 'railway'],
  ])('R4 UNCHANGED: %s still reads as host, port and database', (_label, url, host, port, database) => {
    process.env.DATABASE_URL = url;

    const line = describeResolvedDb(makeSequelize()).toLowerCase();

    expect(line).not.toMatch(/could not be parsed/);
    expect(line).toContain(`database "${database}" on host "${host}" port ${port}`);
    expect(line).not.toContain('secret');
    expect(line).not.toContain('s3cretpw');
    expect(line).not.toContain('dbuser');
  });

  test('R4 UNCHANGED: a URL with no database name still reads, and says the database is not named', () => {
    for (const url of ['postgres://dbuser:s3cretpw@host.example.net:5432', 'postgres://dbuser:s3cretpw@host.example.net:5432/']) {
      process.env.DATABASE_URL = url;

      const line = describeResolvedDb(makeSequelize());
      expect(line).toContain('database "(not named)" on host "host.example.net" port 5432');
    }
  });

  test('with no URL it names the sequelize config host, port and database', () => {
    const line = describeResolvedDb(makeSequelize([], { host: 'localhost', port: 5433, database: 'boardgame_db' }));

    expect(line).toContain('localhost');
    expect(line).toContain('5433');
    expect(line).toContain('boardgame_db');
    expect(line).toMatch(/sequelize config/);
  });
});

describe('N11: assertStagingSeedAllowed needs the seed addresses', () => {
  test.each([
    ['missing', undefined],
    ['an empty array', []],
    ['not an array', 'alice@example.com'],
  ])('rejects when seedEmails is %s, before any query', async (_label, seedEmails) => {
    setEveryVariableRight();
    const sequelize = makeSequelize([]);

    const message = await refusalOf(() =>
      assertStagingSeedAllowed(sequelize, { seedEmails, stagingEmailBase: BASE })
    );

    expect(message).toMatch(/^\[assert-not-production-db\] Refusing to seed/);
    expect(message).toContain('seedEmails');
    expect(sequelize.query).not.toHaveBeenCalled();
  });

  test('rejects when the options are missing altogether', async () => {
    setEveryVariableRight();
    const sequelize = makeSequelize([]);

    const message = await refusalOf(() => assertStagingSeedAllowed(sequelize));
    expect(message).toContain('seedEmails');
    expect(sequelize.query).not.toHaveBeenCalled();
  });
});
