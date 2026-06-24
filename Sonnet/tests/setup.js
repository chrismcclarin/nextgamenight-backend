// tests/setup.js
// Load test environment variables
require('dotenv').config({ path: '.env.test' });

// Set NODE_ENV to test
process.env.NODE_ENV = 'test';

const { sequelize } = require('../models');
const truncateAll = require('./helpers/truncateAll');

// Setup before all tests (per worker). Schema is built ONCE by tests/globalSetup.js
// in the parent process — we only authenticate here.
beforeAll(async () => {
  try {
    await sequelize.authenticate();
    console.log('Test database connection established.');
  } catch (error) {
    console.error('Unable to connect to test database:', error);
    throw error;
  }
});

// Per-test data wipe. Runs BEFORE any block-local beforeEach, so a suite that
// re-seeds rows in its own beforeEach lands on the already-truncated,
// schema-intact DB. We use beforeEach (not afterEach) so the DB is inspectable
// after a failure.
beforeEach(async () => {
  await truncateAll(sequelize);
});

// NOTE: NO afterAll(sequelize.close()). The connection lifecycle is owned solely
// by tests/globalTeardown.js. Closing here would kill the shared connection for
// every later serial suite (BTEST-02).
