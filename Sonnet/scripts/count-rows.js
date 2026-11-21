// scripts/count-rows.js
//
// Owner-run proof that seeding STAGING left PRODUCTION alone (quick-261119-nv0, NV0-8).
//
// What it does: counts the rows in four tables (Users, Groups, UserGroups, Events) and prints
// four numbers. The owner runs it in production before the first staging seed and again
// after, and compares. The seed empties those tables and refills them with seven users, so a
// seed that had hit the wrong database would show at once: seven users.
//
// It only reads. Every statement it sends is a counting SELECT; it never writes a row or
// touches the schema. tests/unit/count-rows.test.js pins that, and also pins that this file
// contains no writing verb at all, comments included, so keep such words out of this text.
//
// The counts are raw SQL on purpose. Three of the four models hide rows that the app has
// marked as removed; a raw count sees every row, so a wipe shows. Small moves between two
// runs are normal and are not a wipe: people join, leave a group, cancel a game night or
// close an account, and those rows are gone at once; the daily group purge also clears the
// groups whose 30-day recovery window has closed (docs/staging-environment.md, step (j)).
//
// What it prints: the app's own "Database connection info" lines (printed by
// config/database.js whenever it loads), then one line naming the database (host, port and
// database name; never a user name or a password), then four lines of the form
// `<table>: <number>`. Nothing from any row is printed. On a failure it prints the kind of
// error only, never the driver's message.
//
// How to run it: docs/staging-environment.md gives the exact command, and says to read the
// numbers off your own screen instead of pasting the output anywhere.

const COUNTED_TABLES = ['Users', 'Groups', 'UserGroups', 'Events'];

/**
 * Counts the rows of each table in COUNTED_TABLES, in order.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {Promise<{ table: string, count: number }[]>}
 * @throws when a query fails or a count does not come back as a whole number
 */
async function countRows(sequelize) {
  const results = [];
  for (const table of COUNTED_TABLES) {
    const rows = await sequelize.query(`SELECT count(*) AS count FROM "${table}"`, {
      type: sequelize.QueryTypes.SELECT,
    });
    // Postgres hands count(*) back as text (it is a bigint).
    const raw = Array.isArray(rows) && rows[0] ? rows[0].count : undefined;
    const count = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
    if (!Number.isInteger(count) || String(count) !== String(raw).trim()) {
      throw new Error(`The count for ${table} did not come back as a whole number.`);
    }
    results.push({ table, count });
  }
  return results;
}

if (require.main === module) {
  // Loaded here, not at the top, so requiring this file (the unit test does) opens no
  // connection.
  const { describeResolvedDb } = require('./lib/assert-not-production-db');
  const sequelize = require('../config/database');

  (async () => {
    try {
      console.log(`\nRow counts for ${describeResolvedDb(sequelize)}`);
      const results = await countRows(sequelize);
      for (const { table, count } of results) {
        console.log(`${table}: ${count}`);
      }
      await sequelize.close();
      process.exit(0);
    } catch (error) {
      const code =
        (error && error.parent && error.parent.code) || (error && error.original && error.original.code) || '';
      const kind = [error && error.name, code].filter(Boolean).join(', ') || 'unknown error';
      console.error(`count-rows could not finish (${kind}). No numbers above are complete; nothing was changed.`);
      process.exit(1);
    }
  })();
}

module.exports = { COUNTED_TABLES, countRows };
