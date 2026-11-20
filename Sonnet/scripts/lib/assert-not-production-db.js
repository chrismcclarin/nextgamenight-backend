// scripts/lib/assert-not-production-db.js
// Phase 87.8 Plan 02 Task 0 (threat T-87.8-05, round-3 security finding):
// default-deny guard for destructive seed/fixture scripts.
//
// scripts/seed-sample-data.js runs `sequelize.sync({ alter: true })` followed by
// unconditional `destroy({ where: {} })` calls against whatever database the env
// resolves — it is an npm entry point anyone can run with a prod DATABASE_URL.
// This guard throws BEFORE the first destructive statement unless the target is
// provably local (or the caller explicitly opts out via ALLOW_DESTRUCTIVE_SEED=1).
//
// TWO ENTRIES, ON PURPOSE (quick-261119-nv0, owner ruling G1 of 2026-11-19):
//  - assertNotProductionDb(sequelize): synchronous, and it STILL has no override when
//    NODE_ENV is 'production'. scripts/e2e-fixtures.js uses it and gains nothing here.
//  - assertSeedTargetAllowed(sequelize, opts): async, for scripts/seed-sample-data.js ALONE.
//    Outside production mode it is assertNotProductionDb, unchanged. In production mode it
//    is the four-lock staging arm (assertStagingSeedAllowed) further down this file.
//
// This module has no `require` on purpose: tests re-require the seed with the models mocked
// and rely on its lib helpers being dependency-free. The SELECT query type is read from the
// sequelize instance (`sequelize.QueryTypes`), not from the sequelize package.

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
 * "No override" is still true of THIS function for every caller (quick-261119-nv0, NV0-2).
 * The staging arm lives in assertStagingSeedAllowed below and is reachable only through
 * assertSeedTargetAllowed, which only scripts/seed-sample-data.js calls. Do not add a
 * staging branch here: scripts/e2e-fixtures.js calls this function without `await`.
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

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SEED'S STAGING ARM (quick-261119-nv0)
//
// DECISION quick-261119-nv0 G1: the production-mode refusal is amended NARROWLY, for the seed
// only, by owner ruling G1 (2026-11-19). Chosen OVER keeping Phase 87.8's "no override in
// production mode" (T-87.8-05) as it stood, because staging must run with NODE_ENV=production
// to behave like the live site; and OVER running staging under another NODE_ENV value, because
// about 30 backend behaviours key on that value (schedulers, webhook signature checks, origin
// rules, rate limits), so a staging that is not in production mode proves little.
// With NODE_ENV=production the seed is refused unless ALL FOUR locks hold:
//   lock 1  RAILWAY_ENVIRONMENT_NAME is exactly 'staging';
//   lock 2  ALLOW_STAGING_SEED is exactly '1';
//   lock 3  the resolved database host can be read and, when PROD_DB_HOST_DENY is set, does
//           not contain it;
//   lock 4  the Users table holds nobody except the seed's own users and plus-addresses of
//           SEED_EMAIL_BASE, checked by a query BEFORE the first destructive statement.
// All four are required because lock 1 cannot be trusted alone: Railway does not document
// whether a user-defined variable can override RAILWAY_ENVIRONMENT_NAME.
// Lock 3 is WEAK, and known to be (owner ruling S1): the Railway private host of the staging
// database is very likely the same text as production's, so lock 3 catches only a staging
// variable that points at a host named in PROD_DB_HOST_DENY. The PROD_HOST_PATTERNS list in
// scripts/ci/create-sync-db.js is REJECTED here, because 'railway.internal' matches staging
// too and would refuse it always.
// Lock 4 carries the weight: production always holds real users, so production always fails
// it, and it needs no variable to be set correctly. Per owner ruling S2 it counts
// plus-addresses of the staging base address as staging-owned, so the owner's own throwaway
// sign-ups on staging do not block the next seed.
// Changing, reordering or removing any lock is a decision, not a cleanup.
// ─────────────────────────────────────────────────────────────────────────────────────────

const DB_URL_VARIABLES = ['POSTGRES_PRIVATE_URL', 'POSTGRES_URL', 'DATABASE_URL', 'PGDATABASE_URL'];

// The same target resolveDbHost resolves (same variable order), with the detail the staging
// arm needs: which variable it came from, and whether that variable could be read as a URL.
// Only the URL's hostname, port and pathname are ever copied out. The username, password and
// query string are never touched, so no credential can reach a log line or an error message
// and there is nothing to mask.
function resolveDbTarget(sequelize) {
  const variable = DB_URL_VARIABLES.find((name) => process.env[name]);
  if (variable) {
    let parsed = null;
    try {
      parsed = new URL(process.env[variable]);
    } catch (e) {
      parsed = null;
    }
    // A string such as "postgres:user:password@host/db" (no "//") parses WITHOUT a hostname
    // and with the credentials inside the pathname. No hostname means "could not be parsed",
    // and the pathname is never read in that case.
    if (!parsed || !parsed.hostname) {
      return { variable, readable: false, host: '', port: '', database: '' };
    }
    return {
      variable,
      readable: true,
      host: parsed.hostname,
      port: parsed.port || '5432',
      database: parsed.pathname.replace(/^\/+/, ''),
    };
  }
  const config = (sequelize && sequelize.config) || {};
  return {
    variable: null,
    readable: true,
    host: config.host || '',
    port: config.port || '5432',
    database: config.database || '',
  };
}

/**
 * One line naming the database the environment resolves: host, port, database name and the
 * variable it came from. Never a username, a password or a query string.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {string}
 */
function describeResolvedDb(sequelize) {
  const target = resolveDbTarget(sequelize);
  if (!target.readable) {
    return (
      `a database that could not be identified (the connection string from ` +
      `${target.variable} could not be parsed)`
    );
  }
  const source = target.variable ? target.variable : resolveDbHostSource();
  return (
    `database "${target.database || '(not named)'}" on host "${target.host || '(unresolvable)'}" ` +
    `port ${target.port} (resolved from ${source})`
  );
}

/**
 * Reads SEED_EMAIL_BASE: the one plain address whose plus-addresses the staging seed writes
 * and lock 4 accepts. The seed's address builder and lock 4 both go through this parser, so
 * the addresses the seed writes and the addresses lock 4 accepts cannot disagree.
 *
 * The messages never repeat the value: it is a real address and these lines reach logs.
 *
 * @param {string|undefined|null} value
 * @returns {{ local: string, domain: string } | null} null when unset or blank
 */
function parseStagingEmailBase(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === '') return null;

  const broken = (rule) =>
    new Error(
      `SEED_EMAIL_BASE is set but cannot be used: ${rule}. It must be one plain address ` +
        `(name@domain, with no "+" tag and no spaces).`
    );

  if (/\s/.test(text)) throw broken('it contains a space');
  const parts = text.split('@');
  if (parts.length !== 2) throw broken('it must contain exactly one "@"');
  const [local, domain] = parts;
  if (local === '') throw broken('nothing comes before the "@"');
  if (domain === '') throw broken('nothing comes after the "@"');
  if (text.includes('+')) throw broken('it contains a "+"');

  return { local: local.toLowerCase(), domain: domain.toLowerCase() };
}

/**
 * Lock 4's test for one Users row: is this address the staging environment's own?
 *  - true when it equals one of the seed's own addresses (any letter case);
 *  - true when `base` is given and it is a plus-address of the base: same domain, and a local
 *    part that is the base's local part, then "+", then a non-empty tag (owner ruling S2);
 *  - false for everything else, including the bare base address, a missing address, and
 *    anything that is not a string.
 *
 * @param {unknown} email
 * @param {{ seedEmails?: string[], base?: { local: string, domain: string } | null }} owned
 * @returns {boolean}
 */
function isStagingOwnedEmail(email, { seedEmails, base } = {}) {
  if (typeof email !== 'string' || email === '') return false;
  const lower = email.toLowerCase();

  if (
    Array.isArray(seedEmails) &&
    seedEmails.some((seedEmail) => typeof seedEmail === 'string' && seedEmail.toLowerCase() === lower)
  ) {
    return true;
  }

  if (!base || !base.local || !base.domain) return false;
  const at = lower.lastIndexOf('@');
  if (at <= 0) return false;
  const local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  const prefix = `${String(base.local).toLowerCase()}+`;
  return (
    domain === String(base.domain).toLowerCase() &&
    local.startsWith(prefix) &&
    local.length > prefix.length
  );
}

function seedRefusal(sequelize, detail) {
  return new Error(
    `[assert-not-production-db] Refusing to seed ${describeResolvedDb(sequelize)}. ${detail}`
  );
}

// DECISION quick-261119-nv0 A1: the staging arm is a SEPARATE async function, chosen OVER
// making assertNotProductionDb async. Lock 4 needs a query, so the arm has to be awaited; but
// scripts/e2e-fixtures.js calls assertNotProductionDb(sequelize) as a bare statement with no
// `await`, and an async guard there would become a floating promise that blocks nothing: the
// fixture writes would start before the guard had answered. Keeping the old function
// synchronous and untouched is what keeps that caller guarded. Do not merge the two.
/**
 * The production-mode arm for the seed (owner ruling G1). Resolves only when all four locks
 * hold; rejects at the first one that does not, before any later lock is looked at. The
 * lock-4 query runs only after locks 1 to 3 have passed.
 *
 * Every refusal names the database (never a credential), the lock, and what would make it
 * pass. A lock-4 refusal gives a COUNT of users and never an address, a username or an id.
 *
 * NAMES VARIABLES, NEVER THEIR VALUES (owner requirement, 2026-11-19). A refusal and a
 * passing line name the variable and the rule; neither repeats what a variable holds, not
 * even a wrong RAILWAY_ENVIRONMENT_NAME. The one thing taken from the environment and
 * printed is the database line (host, port, database name; see describeResolvedDb). Do not
 * add a "found: <value>" to a message to make it friendlier: these lines reach logs.
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {{ seedEmails: string[], stagingEmailBase?: string }} opts
 *   seedEmails: the seed's own addresses. stagingEmailBase: the raw SEED_EMAIL_BASE value.
 * @returns {Promise<{ database: string, locks: string[], productionMode: true }>} one plain
 *   line per lock
 */
async function assertStagingSeedAllowed(sequelize, { seedEmails, stagingEmailBase } = {}) {
  if (!Array.isArray(seedEmails) || seedEmails.length === 0) {
    throw seedRefusal(
      sequelize,
      'The guard was called without seedEmails (the list of the seed\'s own addresses), so it ' +
        'cannot tell seed users from real ones. To pass, the seed must hand the guard its own ' +
        'addresses as a non-empty list.'
    );
  }

  const locks = [];

  // Lock 1: the Railway environment is named staging.
  const environmentName = process.env.RAILWAY_ENVIRONMENT_NAME;
  if (environmentName !== 'staging') {
    // Says only whether the variable is set. What it holds is never repeated (see the
    // "names variables, never their values" note above assertStagingSeedAllowed).
    const found = environmentName === undefined ? 'it is not set' : 'it holds something else';
    throw seedRefusal(
      sequelize,
      'Lock 1 of 4 failed. It checks that this is the Railway environment named staging: ' +
        `RAILWAY_ENVIRONMENT_NAME must be exactly "staging" and ${found}. To pass, run ` +
        'the seed inside the Railway environment whose name is exactly "staging".'
    );
  }
  locks.push('lock 1 passed: RAILWAY_ENVIRONMENT_NAME names the staging environment');

  // Lock 2: seeding staging was switched on deliberately. ALLOW_DESTRUCTIVE_SEED plays no part
  // in production mode.
  if (process.env.ALLOW_STAGING_SEED !== '1') {
    throw seedRefusal(
      sequelize,
      'Lock 2 of 4 failed. It checks that seeding staging was switched on deliberately: ' +
        'ALLOW_STAGING_SEED must be exactly "1" (ALLOW_DESTRUCTIVE_SEED does not count in ' +
        'production mode). To pass, set ALLOW_STAGING_SEED to 1 on the staging service only.'
    );
  }
  locks.push('lock 2 passed: ALLOW_STAGING_SEED is switched on');

  // Lock 3: the host can be read and is not the one named in PROD_DB_HOST_DENY. Weak on
  // purpose (see the G1 marker above): same contains-match as scripts/ci/create-sync-db.js,
  // without its pattern list.
  const target = resolveDbTarget(sequelize);
  if (!target.readable) {
    throw seedRefusal(
      sequelize,
      'Lock 3 of 4 failed. It checks that the database host can be read and is not the host ' +
        `named in PROD_DB_HOST_DENY: the connection string from ${target.variable} could not ` +
        'be parsed, so its host cannot be checked. To pass, that variable must hold a ' +
        'connection URL of the form postgres://user:password@host:port/database.'
    );
  }
  const host = (target.host || '').toLowerCase();
  if (host === '') {
    throw seedRefusal(
      sequelize,
      'Lock 3 of 4 failed. It checks that the database host can be read and is not the host ' +
        'named in PROD_DB_HOST_DENY: no database host could be resolved. To pass, the staging ' +
        'service must have a database connection URL set.'
    );
  }
  const denyHost = (process.env.PROD_DB_HOST_DENY || '').trim().toLowerCase();
  if (denyHost && host.includes(denyHost)) {
    throw seedRefusal(
      sequelize,
      'Lock 3 of 4 failed. It checks that the database host can be read and is not the host ' +
        'named in PROD_DB_HOST_DENY: the resolved host contains the text set in ' +
        'PROD_DB_HOST_DENY, which names the production database host. To pass, the staging ' +
        'service\'s database variable must point at the staging database.'
    );
  }
  locks.push(
    denyHost
      ? 'lock 3 passed: the database host does not contain the text set in PROD_DB_HOST_DENY'
      : 'lock 3: PROD_DB_HOST_DENY not set; lock 3 not armed (the host could be read, and it was compared with nothing)'
  );

  let base;
  try {
    base = parseStagingEmailBase(stagingEmailBase);
  } catch (error) {
    throw seedRefusal(
      sequelize,
      `Lock 4 of 4 was not run: ${error.message} To pass, correct SEED_EMAIL_BASE on the ` +
        'staging service, or remove it to seed the default addresses.'
    );
  }

  // Lock 4: the database holds no real user. A raw query, because the User model's default
  // scope hides the email column. It is the only statement the guard ever runs, and it reads.
  let rows;
  try {
    rows = await sequelize.query('SELECT "email" FROM "Users"', {
      type: sequelize.QueryTypes.SELECT,
    });
  } catch (error) {
    const code =
      (error && error.parent && error.parent.code) ||
      (error && error.original && error.original.code) ||
      null;
    if (code === '42P01') {
      throw seedRefusal(
        sequelize,
        'Lock 4 of 4 could not run: the Users table does not exist; staging\'s pre-deploy runs ' +
          'the migrations, so this database is not the one expected. To pass, deploy the ' +
          'staging service once so its pre-deploy step creates the tables, and check which ' +
          'database its variables point at.'
      );
    }
    // The driver's own message is not repeated: it can carry a username or a host.
    const kind = [error && error.name, code].filter(Boolean).join(', ') || 'unknown error';
    throw seedRefusal(
      sequelize,
      'Lock 4 of 4 could not run: the query that reads the Users table failed ' +
        `(${kind}). The seed does not run unless that check succeeds. To pass, fix the ` +
        'database connection and run the seed again.'
    );
  }
  if (!Array.isArray(rows)) {
    throw seedRefusal(
      sequelize,
      'Lock 4 of 4 could not run: the query that reads the Users table did not return a list ' +
        'of rows. The seed does not run unless that check succeeds.'
    );
  }

  const notOwned = rows.filter((row) => !isStagingOwnedEmail(row && row.email, { seedEmails, base })).length;
  if (notOwned > 0) {
    throw seedRefusal(
      sequelize,
      'Lock 4 of 4 failed. It checks that the database holds no real users: ' +
        `${notOwned} ${notOwned === 1 ? 'user' : 'users'} out of ${rows.length} in the Users ` +
        `table ${notOwned === 1 ? 'is' : 'are'} neither one of the seed's own users nor a ` +
        'plus-address of SEED_EMAIL_BASE. Production always fails this lock. To pass, this ' +
        'must be the staging database, holding only seed users and your own plus-address ' +
        'sign-ups.'
    );
  }
  locks.push(
    `lock 4 passed: ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} in the Users table, ` +
      'all staging-owned (' +
      (base
        ? 'seed users or plus-addresses of SEED_EMAIL_BASE'
        : 'seed users; SEED_EMAIL_BASE is not set, so no plus-address counts') +
      ')'
  );

  // productionMode: true tells the seed that this run went through the four-lock arm, where
  // the migrations own the schema, so it must not sync (the R2 marker in the seed).
  return { database: describeResolvedDb(sequelize), locks, productionMode: true };
}

/**
 * The seed's single entry (scripts/seed-sample-data.js awaits it as its first statement).
 *  - NODE_ENV strictly 'production': the four-lock staging arm above.
 *  - Any other value: assertNotProductionDb, unchanged, and NO query. Local and CI seeds
 *    behave exactly as before.
 *
 * `productionMode` in the result says which of the two it was. The seed reads it to decide
 * whether it may sync the schema (it may not in the four-lock arm).
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @param {{ seedEmails: string[], stagingEmailBase?: string }} opts
 * @returns {Promise<{ database: string, locks: string[], productionMode: boolean }>}
 */
async function assertSeedTargetAllowed(sequelize, opts) {
  if (process.env.NODE_ENV === 'production') {
    return assertStagingSeedAllowed(sequelize, opts);
  }
  assertNotProductionDb(sequelize);
  return {
    database: describeResolvedDb(sequelize),
    locks: [
      'production mode is off (NODE_ENV is not production), so the staging locks do not ' +
        'apply; the local-host guard passed',
    ],
    productionMode: false,
  };
}

module.exports = {
  resolveDbHost,
  assertNotProductionDb,
  describeResolvedDb,
  parseStagingEmailBase,
  isStagingOwnedEmail,
  assertStagingSeedAllowed,
  assertSeedTargetAllowed,
};
