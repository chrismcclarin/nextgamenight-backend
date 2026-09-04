// migrations/20260902000007-add-lower-email-unique-index-to-users.js
//
// Phase 88.8 — OWNER-DIRECTED IN-FLIGHT ADDITION to plan 02 (ruling 2026-09-04),
// added after plan 03 shipped in parallel. Creates a UNIQUE index on
// LOWER(email) over Users.
//
// WHY IT EXISTS. `models/User.js` declares `email` as a plain STRING with
// `unique: true`, which is a case-SENSITIVE btree (`Users_email_key`) on the RAW
// column, and there is no citext and no functional unique index anywhere else in
// migrations/ or models/. So `Alice@x.com` and `alice@x.com` could both exist.
// Plan 03 then made friend search compare `lower(email)` against the stored
// column (routes/friendships.js:210), so BOTH rows now match one query — and
// `findOne` is LIMIT 1 with no ORDER BY, so the winner is whichever row the scan
// reaches first. A friend request could reach the wrong account. The ambiguity is
// NEW: the previous as-stored compare matched exactly one row. Plan 03 named this
// as KNOWN GAP 2 at routes/friendships.js:176-197 and marked it "Unrouted —
// needs an owner"; this migration is that routing.
//
// DECISION Phase 88.8 (owner ruling 2026-09-04): a UNIQUE INDEX ON LOWER(email),
// chosen OVER three alternatives.
//   (a) LEAVING THE CASE-SENSITIVE-ONLY CONSTRAINT — REJECTED. That constraint is
//       precisely what permits the two rows to coexist, so it is the thing that
//       makes plan 03's resolution non-deterministic. Keeping it means a friend
//       request can silently reach the wrong person, which is a correctness bug
//       with a privacy edge, not a performance nit.
//   (b) `citext` (a case-insensitive column type) — a REAL alternative, and
//       rejected on two grounds. It needs `CREATE EXTENSION citext` (an operator
//       action on the managed Railway database, outside what a migration should
//       assume it may do) plus an `ALTER COLUMN ... TYPE citext`, which REWRITES
//       the identity column of every row and rebuilds its unique index. This
//       phase is EXPAND-ONLY and additive by SPEC (88.8-SPEC.md:125); a
//       full-table type rewrite of `Users.email` is neither. An additive index
//       gets the same guarantee with no rewrite and a real `down()`.
//   (c) A 409-ON-MULTIPLE-MATCH in the friend-search route — REJECTED. It is a
//       contract change on a shipped endpoint that reports the ambiguity to the
//       SEARCHER instead of preventing it, and it leaves every other reader of
//       `Users.email` (the three invite-acceptance gates at routes/invites.js:593,
//       :664, :757) still ambiguous. Fix the data shape, not one reader.
//
// SUPERSEDES A DEFERRAL, deliberately and on the record. routes/friendships.js:198-210
// says a functional index on `lower(email)` "is deliberately NOT added in this
// phase" and points at `.planning/deferred/phase-91.md`. That deferral was about
// PERFORMANCE only (the `lower(email)` lookup is not covered by `Users_email_key`,
// so it seq-scans). This index is a CORRECTNESS fix that happens to cover that
// lookup too, so the phase-91 performance deferral is satisfied by it rather than
// contradicted. Plan 14 should mark that deferral closed.
//
// REVERSIBLE — say it out loud, because the sibling migration 20260902000004 in
// this same plan is one-way. `down()` DROPs this index and fully restores the
// prior schema. Nothing about this file is irreversible; only the ENUM ADD VALUE
// next door is.
//
// Schema dual-write (Pitfall 1 — model/migration drift): this migration is the
// PROD source (runs under `migrate:apply` -> `npx sequelize-cli db:migrate`,
// tracked in SequelizeMeta); its sync()-built counterpart is the
// `users_email_lower_unique` entry in the `models/User.js` `indexes` array,
// declared via `sequelize.fn('lower', sequelize.col('email'))` and landed in the
// SAME COMMIT as this file. That same-commit rule is a CONSEQUENCE constraint,
// not tidiness: UNLIKE the plain columns in this plan, `migrate-cli-replay` DOES
// diff indexes (scripts/ci/schema-drift-diff.js Q_INDEXES), so a migration-only
// index is a RED drift gate and a sync-only index is equally red. Both paths
// render to the same catalog form — Postgres normalises either spelling to
// `lower((email)::text)` — so they fold to one identity as long as both exist.
const sequelize = require('../config/database');

const INDEX_NAME = 'users_email_lower_unique';

/**
 * Mask an address for an OPERATOR-FACING deploy error.
 *
 * DECISION Phase 88.8: a migration-LOCAL masker, chosen OVER importing one of the
 * three that already exist. services/emailService.js:368-382 records that this
 * repo deliberately keeps three maskers for three jobs (mail-copy display,
 * webhook log scrubbing, Sentry telemetry) and that consolidating them is a
 * decision. This is a fourth job — a pre-deploy operator error — and it is local
 * for a reason that outranks reuse: a migration runs under `sequelize-cli` in the
 * Railway pre-deploy container and must not import route or service modules,
 * which would drag the express/middleware/Resend graph into a migration process.
 * Self-containment is what keeps a migration replayable years later when the app
 * code around it has moved.
 *
 * Masks the local part AND the domain (the webhooks LOG-scrubber posture, not the
 * mail-copy DISPLAY posture) because this string lands in Railway's log
 * retention. Disambiguation is carried by the row UUIDs printed alongside it, so
 * masking the domain costs the operator nothing.
 */
function maskForOperator(value) {
  if (typeof value !== 'string' || !value) return '(unreadable)';
  const at = value.lastIndexOf('@'); // LAST @ — a quoted local part cannot smuggle a domain
  if (at <= 0) return '(unreadable)';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!local || !domain) return '(unreadable)';
  const maskedLocal = local.length > 1 ? `${local[0]}***` : '*';
  const dot = domain.lastIndexOf('.');
  const maskedDomain = dot > 0
    ? `${domain[0]}***${domain.slice(dot)}`
    : `${domain[0]}***`;
  return `${maskedLocal}@${maskedDomain}`;
}

async function up() {
  const queryInterface = sequelize.getQueryInterface();

  // Idempotent: if the index is already here, do nothing — and skip the duplicate
  // scan too, because its answer cannot change while the index exists. A throwing
  // migration blocks the Railway deploy at preDeployCommand before /health is ever
  // reached (T-88.8-09), and this project has a two-failed-deploys circuit breaker.
  const [existing] = await sequelize.query(
    `SELECT 1 FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'i' AND n.nspname = 'public' AND c.relname = '${INDEX_NAME}';`
  );
  if (existing && existing.length > 0) {
    console.log(`[88.8] Index ${INDEX_NAME} already exists on Users. Skipping.`);
    return;
  }

  // PRE-FLIGHT. `CREATE UNIQUE INDEX` FAILS if conflicting rows already exist, and
  // a raw Postgres unique-violation at deploy time is an opaque failed production
  // deploy. Detect the conflict ourselves FIRST and throw something the operator
  // can act on: WHICH rows, by primary key, not just "something failed".
  //
  // This runs BEFORE any DDL, and the DDL below is a single statement, so there is
  // no half-migrated state to recover from on either path: either we throw having
  // changed nothing, or one atomic CREATE INDEX succeeds.
  const [dupes] = await sequelize.query(
    `SELECT lower(email) AS norm,
            count(*)::int AS n,
            array_agg(id::text ORDER BY id) AS ids
       FROM "Users"
      GROUP BY lower(email)
     HAVING count(*) > 1
      ORDER BY 1;`
  );

  if (dupes && dupes.length > 0) {
    const detail = dupes
      .map((row) => {
        const ids = Array.isArray(row.ids) ? row.ids.join(', ') : String(row.ids);
        return `  - ${maskForOperator(row.norm)} (${row.n} rows) -> Users.id: ${ids}`;
      })
      .join('\n');

    throw new Error(
      `[88.8] REFUSING to create ${INDEX_NAME}: ${dupes.length} address(es) exist in more than one case variant, ` +
      `so a UNIQUE index on lower(email) cannot be built.\n` +
      `Addresses are MASKED; the Users.id values are exact and are the handle to fix them:\n${detail}\n` +
      `To resolve, inspect each group and keep exactly one row per address:\n` +
      `  SELECT id, user_id, email, "createdAt", orphaned_at FROM "Users" WHERE id IN (<ids above>) ORDER BY "createdAt";\n` +
      `Then either merge/delete the redundant row, or release its address the way the ` +
      `Phase 88.8 orphan rule does (synthetic address + orphaned_at = now()). ` +
      `NOTHING HAS BEEN CHANGED by this migration — it threw before any DDL, so the ` +
      `database is not half-migrated and re-running it after the fix is safe.`
    );
  }

  // Byte-identical to what `sequelize.sync()` emits for the model's
  // `users_email_lower_unique` entry (verified: sequelize renders
  // `CREATE UNIQUE INDEX "users_email_lower_unique" ON "Users" (lower("email"))`).
  // Postgres normalises both spellings to `lower((email)::text)` in the catalog, so
  // the migration-built and sync-built schemas fold to one identity under
  // migrate-cli-replay's index diff.
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS "${INDEX_NAME}" ON "Users" (lower("email"));`
  );
  console.log(`[88.8] Created unique index ${INDEX_NAME} on Users (lower(email)).`);
}

async function down() {
  // Genuinely reversible, unlike the ENUM ADD VALUE in
  // 20260902000004-single-use-tokens-email-change-verify.js. Dropping the index
  // restores the prior schema exactly: `Users_email_key` (the case-sensitive
  // unique on the raw column) is untouched by this migration and remains in place
  // throughout, so email uniqueness never lapses — only its case-insensitivity does.
  await sequelize.query(`DROP INDEX IF EXISTS "${INDEX_NAME}";`);
  console.log(`[88.8] Dropped unique index ${INDEX_NAME} from Users.`);
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down, INDEX_NAME, maskForOperator };
