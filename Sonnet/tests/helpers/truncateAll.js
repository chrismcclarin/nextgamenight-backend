// tests/helpers/truncateAll.js
//
// Registry-driven per-test data wipe. Enumerates every registered Sequelize
// model and issues a single truncate (with restart-identity + cascade) so that
// each test starts against an empty-but-intact schema (data wiped, tables kept).
//
//   - The model registry (sequelize.models) is authoritative — do NOT hardcode
//     the ~27 table names. New models are picked up automatically.
//   - The cascade option resolves FK ordering automatically.
//   - Restarting identity resets serial/sequence PKs so ID-dependent assertions
//     are stable. User.id is a UUID and is unaffected.
//
// Issued as ONE query so it is a single atomic statement per test.

/**
 * @param {import('sequelize').Sequelize} sequelize
 */
async function truncateAll(sequelize) {
  const tableNames = Object.values(sequelize.models).map((model) => {
    let name = model.getTableName();
    // getTableName() can return either a string or { tableName, schema } (A2).
    if (name && typeof name === 'object' && name.tableName) {
      name = name.tableName;
    }
    return `"${name}"`;
  });

  if (tableNames.length === 0) return;

  await sequelize.query(
    `TRUNCATE TABLE ${tableNames.join(', ')} RESTART IDENTITY CASCADE;`
  );
}

module.exports = truncateAll;
module.exports.truncateAll = truncateAll;
