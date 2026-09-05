// config/database.js
const { Sequelize } = require('sequelize');
require('dotenv').config();

// LOAD TESTING NOTE: Increase pool.max to 20 when running Artillery load tests
// Default max:5 causes p99 spikes at 50 concurrent requests (45 requests wait for connection)
// Override via: SEQUELIZE_POOL_MAX=20 LOAD_TEST_TARGET=http://localhost:4000 npx artillery run tests/load/availability-pipeline.yml
// See config/db-config.js for per-environment pool presets
const POOL_MAX = parseInt(process.env.SEQUELIZE_POOL_MAX || '5', 10);

let sequelize;

// Railway and many hosting platforms provide DATABASE_URL
// Railway provides POSTGRES_PRIVATE_URL for internal service-to-service connections (no SSL needed)
// Prefer private URL for Railway internal connections
const databaseUrl = process.env.POSTGRES_PRIVATE_URL ||
                    process.env.POSTGRES_URL || 
                    process.env.DATABASE_URL || 
                    process.env.PGDATABASE_URL;

// Log connection info (without sensitive data)
if (databaseUrl) {
  try {
    const urlObj = new URL(databaseUrl);
    console.log(`Database connection info:`);
    console.log(`  Protocol: ${urlObj.protocol}`);
    console.log(`  Host: ${urlObj.hostname}`);
    console.log(`  Port: ${urlObj.port || '5432'}`);
    console.log(`  Database: ${urlObj.pathname.slice(1)}`);
    console.log(`  User: ${urlObj.username || 'not set'}`);
  } catch (e) {
    console.log('Could not parse DATABASE_URL:', e.message);
  }
} else {
  console.log('No DATABASE_URL found, using individual environment variables');
  console.log('Available env vars:', Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('POSTGRES')));
}

if (databaseUrl) {
  // Railway PostgreSQL connection configuration
  // Railway services on the same project can communicate internally without SSL
  const isRailway = process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_NAME;
  const isProduction = process.env.NODE_ENV === 'production';
  const isPrivateUrl = databaseUrl === process.env.POSTGRES_PRIVATE_URL;
  
  // Check if DATABASE_URL explicitly requires SSL (contains ?sslmode=)
  const requiresSSL = databaseUrl.includes('sslmode=require') || databaseUrl.includes('ssl=true');
  
  console.log(`Connection settings: Railway=${!!isRailway}, Production=${isProduction}, PrivateURL=${isPrivateUrl}, RequiresSSL=${requiresSSL}`);
  
  // Parse DATABASE_URL for Railway/Heroku-style connection strings
  // Railway internal networking (POSTGRES_PRIVATE_URL) doesn't require SSL
  sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgresql',
    logging: process.env.NODE_ENV === 'test' ? false : (msg) => {
      // Only log non-query messages to avoid spam
      if (!msg.includes('SELECT') && !msg.includes('INSERT') && !msg.includes('UPDATE') && !msg.includes('DELETE')) {
        console.log(msg);
      }
    },
    dialectOptions: {
      // Private URLs (internal Railway networking) don't need SSL
      // Public URLs or explicit SSL requirements do need SSL
      ssl: (isPrivateUrl) ? false : (requiresSSL || (isProduction && !isRailway)) ? {
        require: true,
        rejectUnauthorized: false, // Railway uses self-signed certificates
      } : false,
      connectTimeout: 30000, // Increased timeout for Railway
      // Additional connection options
      application_name: 'boardgame-backend',
    },
    pool: {
      max: POOL_MAX,
      min: 0,
      acquire: 60000, // Increased for Railway
      idle: 10000,
      evict: 10000, // Check for idle connections
    },
    /* DECISION Phase 88.8 (code review wave-8 CI, 2026-09-05): the query retry is
       RESTRICTED to connection-level errors — chosen OVER the bare `{ max: 3 }` that
       shipped here, and OVER removing the block.

       WHAT THE BARE BLOCK DID, verified in the library source: Sequelize's default is
       `retry: { max: 5, match: ['SQLITE_BUSY: database is locked'] }`; a user-supplied
       `retry` object REPLACES it wholesale (lib/sequelize.js constructor), and
       retry-as-promised treats an EMPTY `match` as "retry on every error"
       (retry-as-promised/dist/index.js `shouldRetry = options.match.length === 0 || ...`).
       So on THIS branch — Railway production and CI, both of which set DATABASE_URL — every
       failing statement was re-run up to three times. Inside a transaction the first
       failure (e.g. a unique violation, SQLSTATE 23505) aborts the transaction, the two
       retries answer 25P02 "current transaction is aborted", and the error that finally
       propagates is a generic SequelizeDatabaseError — so every handler that maps a
       unique violation to a designed outcome (email-change `address_taken`, the account-
       deletion tombstone race → 410, the provisioning collision branches inside a
       transaction) answered 500 in production, while passing locally on the DB_* branch,
       which has no retry block. Found by the FIRST CI run of Phase 88.8 (five
       deterministic failures, all of this class). Blind retry also re-executes WRITES
       whose first attempt failed after the server acted (e.g. on a lost response).

       KEPT, narrowed: the comment's stated intent was connection resilience, and
       `Sequelize.ConnectionError` is the base class of every connection-time failure
       (refused, host not found / unreachable, invalid connection, timed out) — those are
       raised BEFORE a statement executes, so retrying them cannot double-execute a write.
       retry-as-promised matches a function entry by `instanceof`. Anything else — query
       errors, constraint violations, timeouts — surfaces on the first attempt exactly as
       it does on the local branch. Widening this list is a decision, not a cleanup. */
    retry: {
      max: 3,
      match: [Sequelize.ConnectionError],
    },
    // Add query timeout
    query: {
      timeout: 30000,
    },
  });
} else {
  // Fallback to individual environment variables for local development
  const getDatabaseName = () => {
    if (process.env.NODE_ENV === 'test') {
      return process.env.TEST_DB_NAME || 'boardgame_test_db';
    }
    return process.env.DB_NAME || 'boardgame_db';
  };

  // Require database credentials in production
  if (process.env.NODE_ENV === 'production' && (!process.env.DB_USER || !process.env.DB_PASSWORD)) {
    throw new Error('DB_USER and DB_PASSWORD must be set in production environment (or use DATABASE_URL)');
  }

  sequelize = new Sequelize(
    getDatabaseName(),
    process.env.DB_USER || 'postgres',
    process.env.DB_PASSWORD || (process.env.NODE_ENV === 'production' ? '' : 'password'),
    {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      dialect: 'postgresql',
      // DECISION Phase 88.3-cr (CR-05, code-adversarial-review 2026-08-27): THIS BRANCH
      // LOGS EVERY QUERY UNFILTERED, unlike the DATABASE_URL branch above, whose custom
      // logger drops any message containing SELECT/INSERT/UPDATE/DELETE. That asymmetry
      // is a latent secret-disclosure coupling with the frontend repo: `scripts/
      // e2e-fixtures.js` bulk-inserts rows carrying single-use token nonces, and the FE
      // CI job (`.github/workflows/ci.yml`, "Seed e2e fixtures") tails the last 40 lines
      // of that script's output into a PUBLIC Actions log on failure. CI selects the URL
      // branch because it sets DATABASE_URL — but it ALSO sets DB_HOST/DB_NAME/DB_USER,
      // so dropping DATABASE_URL would silently switch to this branch and print those
      // INSERTs verbatim. DO NOT run the e2e fixture step against this branch.
      // The FE tail no longer depends on this: CR-05 also made its `sed` drop lines
      // beginning with `Executing (`, so the redaction holds whichever branch is live.
      // REJECTED: converging the two loggers here — the URL branch's filter is tuned to
      // Railway's log volume and changing it is a deploy-visible decision, not a
      // cleanup. Fixing it at the consumer is the layer that fails independently.
      logging: process.env.NODE_ENV === 'test' ? false : console.log,
      dialectOptions: {
        ssl: false,
        connectTimeout: 10000,
      },
      pool: {
        max: POOL_MAX,
        min: 0,
        acquire: 30000,
        idle: 10000,
      },
    }
  );
}

module.exports = sequelize;
