// Bare-node DB connectivity probe (Plans 03/04 pattern). Confirms whether the
// jest hang is harness-specific or a genuine DB-unreachable condition.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env.test') });
process.env.NODE_ENV = 'test';

const { sequelize } = require('../../models');

(async () => {
  const timeout = setTimeout(() => {
    console.error('PROBE: authenticate() did not resolve within 12s — hang confirmed.');
    process.exit(2);
  }, 12000);
  try {
    await sequelize.authenticate();
    clearTimeout(timeout);
    console.log('PROBE: authenticate OK. host=', sequelize.config.host, 'db=', sequelize.config.database);
    await sequelize.close();
    process.exit(0);
  } catch (e) {
    clearTimeout(timeout);
    console.error('PROBE: authenticate FAILED:', e.message);
    process.exit(1);
  }
})();
