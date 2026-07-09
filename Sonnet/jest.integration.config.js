// jest.integration.config.js
// BTEST-04 / review HIGH-6: a SEPARATE Jest config for the real-Redis integration
// ring (tests/integration/). Split out from the default `npm test` run so:
//   - `npm test` (the unit+DB suite, jest.config.js) does NOT hard-require Redis,
//   - the ring does NOT pull in tests/setup.js (no DB globalSetup, no per-test
//     TRUNCATE beforeEach) — the ring is pure-Redis, no Postgres.
//
// Run via: `npm run test:integration` (jest --config jest.integration.config.js).
// CI provides a redis:7 service + REDIS_URL; locally it targets redis://localhost:6379.
module.exports = {
  testEnvironment: 'node',
  // Target ONLY the real-Redis integration ring — nothing from the default unit/DB
  // suite. Phase 87.2 Plan 06 added tests/integration/accountDeletion.integrity.test.js,
  // which is a REAL-POSTGRES (no Redis) test that needs the default config's globalSetup
  // schema build + per-test TRUNCATE — it runs under `npm test`, NOT here. So this
  // config matches ONLY the Redis-ring file, not the whole tests/integration/ tree
  // (a directory-wide match would run the DB test here with no Postgres provisioning).
  testMatch: ['<rootDir>/tests/integration/queues.integration.test.js'],
  // No globalSetup/globalTeardown (those provision Postgres for the unit suite) and
  // no setupFilesAfterEnv tests/setup.js (its per-test TRUNCATE needs the DB).
  verbose: true,
  testTimeout: 25000
};
