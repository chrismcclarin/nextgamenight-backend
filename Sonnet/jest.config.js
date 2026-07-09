module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  // BTEST-04 / review HIGH-6: the real-Redis integration ring
  // (tests/integration/queues.integration.test.js) runs via its OWN jest config
  // (jest.integration.config.js, `npm run test:integration`). Exclude ONLY that file
  // from the default `npm test` run so the unit+DB suite does NOT hard-require Redis
  // and does NOT share the prod keyspace.
  //
  // Phase 87.2 Plan 06: the account-deletion integrity test also lives under
  // tests/integration/ but is a REAL-POSTGRES / NO-REDIS test — it MUST run under
  // THIS default config so it inherits the globalSetup schema build + per-test
  // TRUNCATE (tests/setup.js). So we ignore the specific Redis-ring file, NOT the
  // whole directory (a directory-wide ignore would strand the DB integrity test with
  // no schema provisioning). Verified via `npm test -- tests/integration/accountDeletion.integrity.test.js`.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/queues.integration.test.js'],
  collectCoverageFrom: [
    'routes/**/*.js',
    'models/**/*.js',
    'services/**/*.js',
    '!**/node_modules/**',
    '!**/migrations/**'
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  globalSetup: '<rootDir>/tests/globalSetup.js',
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testTimeout: 25000
};

