// tests/globalTeardown.js
//
// Jest globalTeardown: runs ONCE in the PARENT process after the whole run.
// Defensively closes the sequelize connection. This is the CENTRALIZED
// connection lifecycle for the test suite — individual suites must NOT call
// sequelize.close() (doing so kills the shared connection for every serial
// suite that runs after them — BTEST-02).
//
// LIFECYCLE NOTE (for plan 05's close gate): this file legitimately calls
// sequelize.close() and lives under tests/ — plan 05's close gate MUST EXCLUDE
// tests/globalTeardown.js. Do not flag it.
module.exports = async function globalTeardown() {
  try {
    const { sequelize } = require('../models');
    await sequelize.close();
  } catch (e) {
    // Connection may already be closed; teardown is best-effort.
  }
};
