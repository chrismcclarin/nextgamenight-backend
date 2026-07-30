#!/usr/bin/env node
'use strict';
//
// scripts/ci/create-sync-db.js
//
// Phase 88.4 (SPEC R2; decision D-06): create the SYNC-SIDE database for the
// migrate-cli-replay CI job. The job needs two databases built from the same commit:
// one by replaying the migration chain through sequelize-cli, one by sync()ing the
// models. This script provisions the second one, empty, so
// `scripts/ci/sync-build-schema.js` can build its schema and
// `scripts/ci/schema-drift-diff.js` can compare the two.
//
// ENV CONTRACT (D-06) -- exactly one variable:
//   ADMIN_DB_URL   an admin connection (the `postgres` maintenance database), NOT the
//                  database being created. Purpose-named on purpose: it is deliberately
//                  absent from the shared runtime precedence chain
//                  `POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL`
//                  (config/database.js:16-19, config/sequelize-cli.config.js:16-20), so a
//                  stray DATABASE_URL in the environment can never steer this DROP.
//
// DROP TARGET IS HARDCODED AND IS NEVER TAKEN FROM ENV (threat T-88.4-10). The database
// dropped and recreated is the module-level const SYNC_DB_NAME below. There is no
// process.env.SYNC_DB_NAME, and the name is NOT derived from ADMIN_DB_URL's path
// component. A mis-set environment variable can change WHICH SERVER this connects to
// (which is why the NODE_ENV refusal AND the production-host deny list below both exist), but
// it cannot redirect the DROP onto a different database name.
//
// DECISION Phase 88.4 D-06: raw `pg` Client OVER Sequelize. `scripts/create-database.js`
// does the same job through a Sequelize admin connection; this script does not, because
// (a) `pg` avoids pulling in the runtime config module and its connection banner, and
// (b) Postgres refuses CREATE DATABASE inside an explicit multi-statement block, so a bare
// single-connection `Client` -- no wrapper, no pool -- is the correct shape. Also NOT
// carried over from that script: its emoji log prefixes (the house convention is a
// bracketed `[88.4...]` tag) and its string-interpolated identifier in the pg_database
// existence probe (parameterized here). Changing any of these is a decision, not a cleanup.
//
// LOCAL PROOF (point this at a throwaway local server, never at prod):
//   ADMIN_DB_URL=postgres://postgres:password@localhost:5432/postgres \
//   node scripts/ci/create-sync-db.js

const { Client } = require('pg');

// The one and only database this script is allowed to DROP. Hardcoded by design
// (T-88.4-10) -- see the header. Never read from env.
const SYNC_DB_NAME = 'schema_sync';

// PRODUCTION-HOST DENY LIST. Transcribed from tests/globalSetup.js:48, which carries the
// reasoning in full: `railway.internal` is REQUIRED because prod connects primarily via
// POSTGRES_PRIVATE_URL (config/database.js:14-19), and omitting it would leave the host arm
// silently missing the documented prod target; `rlwy.net` / `railway.app` are the public proxy
// hosts. `PROD_DB_HOST_DENY` is the escape hatch for a host this list does not know.
//
// DECISION Phase 88.4 (88.4-CODE-REVIEW.md #5): this list is added ALONGSIDE the NODE_ENV
// refusal below, not instead of it. Deliberately DIVERGING from the sibling
// scripts/ci/sync-build-schema.js, whose own DECISION marker rejects this list for ITS failure
// mode -- correctly, because that script's sync-target assert pins the exact database and is
// strictly stronger than a known-bad-host set. THIS script carries `DROP DATABASE`, the most
// destructive verb in the phase, and has no equivalent stronger check available: the hardcoded
// SYNC_DB_NAME bounds WHICH database is dropped but says nothing about WHICH SERVER, and the
// header already concedes that a mis-set ADMIN_DB_URL can point it at a different server. With
// NODE_ENV unset (which CI itself does), a developer shell pointing ADMIN_DB_URL at a remote
// server previously sailed straight through. That sibling marker ends "add the host list
// alongside it if anything" -- this is that. Do not "restore consistency" by deleting it.
const PROD_HOST_PATTERNS = ['railway.internal', 'rlwy.net', 'railway.app'];

/**
 * @param {string} url the admin connection string
 * @returns {string|null} a human-readable refusal reason, or null when the target is acceptable
 */
function prodHostRefusal(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // An unparseable URL is NOT waved through here: `pg` accepts key=value DSNs that `URL`
    // cannot parse, so a prod DSN in that form would bypass a URL-only check. Refuse and make
    // the operator supply a parseable URL -- a loud stop on a legitimate-but-exotic string beats
    // a silent pass on a production one.
    return `ADMIN_DB_URL is not a parseable URL, so its host cannot be checked against the production-host deny list`;
  }
  const denyHost = (process.env.PROD_DB_HOST_DENY || '').toLowerCase();
  const matched =
    PROD_HOST_PATTERNS.find((p) => host.includes(p)) || (denyHost && host.includes(denyHost) ? denyHost : null);
  return matched
    ? `ADMIN_DB_URL host "${host}" matches the production-host deny list ("${matched}")`
    : null;
}

// Verbatim from scripts/log-db-resolution.js:19-33. Credential masking is a security
// control (T-88.4-11), not cosmetics -- never log an unmasked connection string. The
// "verbatim" claim is load-bearing: review #6's username fix was applied to all FOUR copies
// (that source, this file, verify-migration-chain.js, schema-drift-diff.js) in ONE commit so
// it stays true. If you change one, change all four.
const mask = (url) => {
  if (!url) return 'unset';
  try {
    const u = new URL(url);
    // DECISION Phase 88.4 (88.4-CODE-REVIEW.md #6): the USERNAME is redacted too, over the
    // long-standing `${u.username}:***@` form. The username is not a credential, but these
    // scripts document a LOCAL PROOF mode in which a developer's own connection string is
    // logged, and a real username is identifying (and often environment-revealing) in a public
    // repo's CI log. Nothing needs it: every log line here already prefers the side LABEL
    // ("migration side" / "sync side") and the host+database are what a reader diagnoses from.
    return `${u.protocol}//***:***@${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`;
  } catch {
    return '<unparseable>';
  }
};

(async () => {
  // Non-production refusal, BEFORE the client is opened. This script runs the most
  // destructive verb in the phase (DROP DATABASE), so it carries the refusal at least as
  // firmly as its sync-side sibling -- wording mirrors the retired provision script
  // (retired in Plan 88.4-05; see the DECISION Phase 88.4 D-05 marker in ci.yml's
  // migrate-cli-replay job) and the first guard in tests/globalSetup.js:68-73.
  // CI leaves NODE_ENV unset; local proof may set test.
  if (process.env.NODE_ENV === 'production') {
    console.error(
      `[88.4-createdb] refusing to run: NODE_ENV=production ` +
        `(DROP DATABASE "${SYNC_DB_NAME}" would destroy a database on a production server)`
    );
    process.exitCode = 1;
    return;
  }

  const adminUrl = process.env.ADMIN_DB_URL;
  if (!adminUrl) {
    console.error(
      '[88.4-createdb] ADMIN_DB_URL is not set. It must point at an admin/maintenance ' +
        'database (e.g. postgres://user:pw@host:5432/postgres) on the throwaway CI server.'
    );
    process.exitCode = 1;
    return;
  }

  // SECOND destructive-op guard, and it fires where the NODE_ENV one cannot: NODE_ENV is unset
  // in CI and is routinely unset in a developer shell, so it protects nothing against an
  // ADMIN_DB_URL that has been pointed at a real server. Checked BEFORE the client is opened,
  // so a refused run makes no connection at all.
  const refusal = prodHostRefusal(adminUrl);
  if (refusal) {
    console.error(
      `[88.4-createdb] refusing to run: ${refusal}. This script issues ` +
        `DROP DATABASE "${SYNC_DB_NAME}" and must only ever target a throwaway server. ` +
        `Point ADMIN_DB_URL at the CI service container or a local Postgres.`
    );
    process.exitCode = 1;
    return;
  }

  // Defense in depth against a future edit that wires SYNC_DB_NAME to env or to a URL
  // path component: identifiers cannot be parameterized in SQL, so the const is
  // interpolated below. Assert it is a plain lowercase identifier first, so such an edit
  // fails loudly here rather than becoming an injection point in the DROP.
  if (!/^[a-z][a-z0-9_]*$/.test(SYNC_DB_NAME)) {
    console.error(
      `[88.4-createdb] SYNC_DB_NAME "${SYNC_DB_NAME}" is not a plain lowercase identifier. ` +
        'It must be a hardcoded literal, never env-derived.'
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 10000 });

  try {
    console.log(`[88.4-createdb] admin connection: ${mask(adminUrl)}`);
    await client.connect();

    // Existence probe kept from scripts/create-database.js:29-40, but parameterized.
    // Informational only -- the DROP below is unconditional (IF EXISTS) so a leftover
    // database from a previous run cannot leak schema into this one.
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      SYNC_DB_NAME,
    ]);
    console.log(
      existing.rows.length
        ? `[88.4-createdb] "${SYNC_DB_NAME}" already exists -- dropping it for a clean build.`
        : `[88.4-createdb] "${SYNC_DB_NAME}" does not exist yet.`
    );

    await client.query(`DROP DATABASE IF EXISTS "${SYNC_DB_NAME}"`);
    await client.query(`CREATE DATABASE "${SYNC_DB_NAME}"`);
    console.log(`[88.4-createdb] created empty database "${SYNC_DB_NAME}".`);
  } catch (err) {
    console.error(
      `[88.4-createdb] failed: ${err && err.message ? err.message : err}`
    );
    // process.exitCode (NOT process.exit) so the finally below can close the client.
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
})();
