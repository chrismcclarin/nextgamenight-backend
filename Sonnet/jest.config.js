module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js', '**/?(*.)+(spec|test).js'],
  // BTEST-04 / review HIGH-6: the real-Redis integration ring lives under
  // tests/integration/ and runs via its OWN jest config (jest.integration.config.js,
  // `npm run test:integration`). Exclude it from the default `npm test` run so the
  // unit+DB suite does NOT hard-require Redis and does NOT share the prod keyspace.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/integration/'],
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

