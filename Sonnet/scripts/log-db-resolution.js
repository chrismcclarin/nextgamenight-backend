// scripts/log-db-resolution.js
//
// Diagnostic for the Phase 74-03 pre-deploy guardrail.
// Prints which DATABASE_URL-family env vars are set in this container
// (with credentials masked), then connects via the same precedence chain
// the runtime uses and reports the SequelizeMeta row count.
//
// Used to verify the pre-deploy container hits the same database as
// the runtime container, since Railway's docs are ambiguous about
// whether pre-deploy has private-network access.
//
// Read-only. Safe to run at deploy time. Exits 0 even on connection
// failure so the pre-deploy continues to migrate:apply (we want migrate
// to surface the real error, not this diagnostic).

require('dotenv').config();
const { Client } = require('pg');

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

console.log('=== Pre-Deploy DB Resolution Diagnostic ===');
['POSTGRES_PRIVATE_URL', 'POSTGRES_URL', 'DATABASE_URL', 'PGDATABASE_URL'].forEach((k) => {
  console.log(`  ${k}: ${mask(process.env[k])}`);
});
console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'unset'}`);
console.log(`  RAILWAY_ENVIRONMENT: ${process.env.RAILWAY_ENVIRONMENT || 'unset'}`);
console.log(`  RAILWAY_SERVICE_NAME: ${process.env.RAILWAY_SERVICE_NAME || 'unset'}`);

const databaseUrl =
  process.env.POSTGRES_PRIVATE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.PGDATABASE_URL;

if (!databaseUrl) {
  console.log('  → No DB URL resolved. Skipping SequelizeMeta probe.');
  process.exit(0);
}

console.log(`  → resolved DB host: ${mask(databaseUrl)}`);

(async () => {
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    const r = await client.query('SELECT COUNT(*)::int AS count FROM "SequelizeMeta"');
    console.log(`  → SequelizeMeta row count from pre-deploy connection: ${r.rows[0].count}`);
  } catch (e) {
    console.log(`  → SequelizeMeta probe failed: ${e.message}`);
  } finally {
    await client.end().catch(() => {});
  }
})();
