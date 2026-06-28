// jest.unit.config.js
// A SEPARATE Jest config for DB-FREE pure-unit tests (tests/unit/). Mirrors the
// jest.integration.config.js split so these tests:
//   - do NOT pull in tests/setup.js (its per-test TRUNCATE beforeEach needs Postgres),
//   - do NOT run globalSetup/globalTeardown (those force-sync/provision Postgres for
//     the unit+DB suite in jest.config.js),
//   - therefore run green in TRUE isolation with no database, no Redis, no network.
//
// Run via: `npm run test:unit` (jest --config jest.unit.config.js).
// The default `npm test` (jest.config.js) still matches tests/unit/ too, so in a
// DB-provisioned environment `npm test -- tests/unit/errors.test.js` also works; this
// config is the environment-independent path (CI without a DB, local without Postgres).
module.exports = {
  testEnvironment: 'node',
  // Target ONLY the pure-unit tree — nothing that opens a DB/Redis connection.
  testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
  // No globalSetup/globalTeardown (those provision Postgres) and no setupFilesAfterEnv
  // tests/setup.js (its beforeAll authenticate + per-test TRUNCATE need the DB).
  verbose: true,
  testTimeout: 25000,
};
