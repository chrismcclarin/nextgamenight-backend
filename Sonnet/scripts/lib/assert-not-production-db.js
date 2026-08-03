// scripts/lib/assert-not-production-db.js
// Phase 87.8 Plan 02 Task 0 (threat T-87.8-05, round-3 security finding):
// default-deny guard for destructive seed/fixture scripts.
//
// scripts/seed-sample-data.js runs `sequelize.sync({ alter: true })` followed by
// unconditional `destroy({ where: {} })` calls against whatever database the env
// resolves — it is an npm entry point anyone can run with a prod DATABASE_URL.
// This guard throws BEFORE the first destructive statement unless the target is
// provably local (or the caller explicitly opts out via ALLOW_DESTRUCTIVE_SEED=1).

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

// Copied VERBATIM from tests/globalSetup.js:49-65 (resolveDbHost).
// The env-var order below MUST match config/database.js:14-19
// (POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL),
// so this guard resolves the SAME target Sequelize actually connects to.
// Do NOT copy scripts/ci/create-sync-db.js's resolution instead — its order
// differs and would let the guard check a different database than the one
// the destructive statements hit.
function resolveDbHost(sequelize) {
  // Prefer the connection URL host (matches how prod actually connects), then
  // fall back to sequelize.config.host for the individual-var path.
  const url =
    process.env.POSTGRES_PRIVATE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.PGDATABASE_URL;
  if (url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      // fall through to config.host
    }
  }
  return (sequelize && sequelize.config && sequelize.config.host) || '';
}

// Names which source supplied the host, so a refused run is self-explanatory.
// Mirrors resolveDbHost's order exactly (config/database.js:14-19).
function resolveDbHostSource() {
  if (process.env.POSTGRES_PRIVATE_URL) return 'POSTGRES_PRIVATE_URL';
  if (process.env.POSTGRES_URL) return 'POSTGRES_URL';
  if (process.env.DATABASE_URL) return 'DATABASE_URL';
  if (process.env.PGDATABASE_URL) return 'PGDATABASE_URL';
  return 'sequelize config (DB_HOST individual var or default)';
}

/**
 * Throws unless the resolved database target is safe to destroy:
 *  - ALWAYS throws when NODE_ENV === 'production' (no override).
 *  - Throws when the resolved host is not localhost/127.0.0.1/::1, unless
 *    ALLOW_DESTRUCTIVE_SEED=1 is explicitly set.
 *
 * Outcomes by environment (stated so none is discovered in CI):
 *  (a) local dev — host resolves to localhost, guard passes silently;
 *  (b) CI — ci.yml leaves NODE_ENV unset and the Postgres service container is
 *      localhost (frontend ci.yml:256), guard passes;
 *  (c) prod / any remote DB — guard throws before a single row is deleted;
 *      override requires the explicit ALLOW_DESTRUCTIVE_SEED=1 env var.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function assertNotProductionDb(sequelize) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      "[assert-not-production-db] Refusing to run: NODE_ENV==='production'. " +
        'This script sync({alter:true})s the schema and mass-deletes rows; it must ' +
        'never run against a production database. There is NO override for this arm.'
    );
  }

  const host = (resolveDbHost(sequelize) || '').toLowerCase();
  const isLocal = LOCAL_HOSTS.includes(host);

  if (!isLocal && process.env.ALLOW_DESTRUCTIVE_SEED !== '1') {
    const source = resolveDbHostSource();
    throw new Error(
      `[assert-not-production-db] Refusing to run against non-local database host ` +
        `"${host || '(unresolvable)'}" (resolved from ${source}). This script ` +
        `sync({alter:true})s the schema and mass-deletes rows. If this remote target ` +
        `is genuinely disposable, re-run with ALLOW_DESTRUCTIVE_SEED=1 set explicitly.`
    );
  }
}

module.exports = { resolveDbHost, assertNotProductionDb };
