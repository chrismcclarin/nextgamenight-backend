# Runbook: Production Schema Drift

**Last updated:** 2026-05-09 (Phase 74)

You're here because: an incident hints that production schema doesn't match the repo, OR you want to confirm parity before a risky deploy.

## Step 0 — Check platform config FIRST (per project memory)

Before debugging code:

1. **Railway dashboard → backend service → Settings → Deploy.** Confirm:
   - **Pre-Deploy Command** is `npm run migrate:apply` (NOT empty, NOT a one-off script).
   - **Start Command** is `npm start` (NOT chaining migrations).
2. If either is wrong, fix it in the dashboard and trigger a redeploy. That alone may resolve the symptom.

The 2026-05-08 incident root cause was upstream of code: pre-deploy migrations weren't running between merge and deploy. Always rule out config-level causes before writing code.

## Step 1 — Run the audit

From your local machine, with the Railway CLI linked to the prod project + Postgres service:

```bash
cd periodictabletopbackend_v2/Sonnet
railway run -- npm run audit:migrations
```

If `railway run` can't reach the prod DB host (e.g., `postgres.railway.internal` not resolving from a laptop), use the TCP-proxy public URL path documented for Phase 74-04:

```bash
railway run -- bash -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" npm run audit:migrations'
```

The script (`scripts/audit-migrations.js`) is read-only. It prints:

- Three migration buckets (pending in repo, orphan in DB, matched count)
- Schema sweep findings (undeclared tables/columns)
- A verdict line: `CLEAN` or `DRIFT DETECTED`

It also writes `/tmp/migration-audit-{date}.json` with full detail. Copy that JSON into the phase directory if this run is part of a tracked phase.

## Step 2 — If drift detected

**Always snapshot first:**

```bash
railway run -- pg_dump "$DATABASE_PUBLIC_URL" -Fc -f /tmp/pre-replay-$(date +%F).dump
```

**Review each pending migration manually** before running it (additive vs destructive, locks taken, indexes added). For each, decide go/no-go.

**If any pending migration contains destructive DDL** (`DROP TABLE`, `DROP COLUMN`, `ALTER COLUMN` with type-rewrite, large data migrations, `NOT NULL` on populated column without `DEFAULT`): pause and announce a brief maintenance window before proceeding. Otherwise replay live.

**Replay** (Railway shell — atomic SequelizeMeta tracking via sequelize-cli):

```bash
railway run -- npx sequelize-cli db:migrate
# OR per-file (recommended when reviewing one at a time):
railway run -- npx sequelize-cli db:migrate --to <migration-filename>
```

(Note: `scripts/run-migration-prod.js` exists in the repo for emergency one-off use, but does NOT update SequelizeMeta — using it for routine replay leaves the migration eternally "pending" in subsequent audits. Prefer `sequelize-cli` for normal drift response.)

Watch Sentry + UptimeRobot during the replay. If anything escalates, restore from the snapshot:

```bash
railway run -- pg_restore --clean --if-exists -d "$DATABASE_PUBLIC_URL" /tmp/pre-replay-{date}.dump
```

**Re-run the audit** to confirm the verdict is now `CLEAN`.

## Step 3 — Document

Append the audit + replay log to `.planning/phases/<current-phase>/MIGRATION-AUDIT.md` (or create a new one for this incident). Include:

- Verdict before/after
- Snapshot file path + disposition
- Per-migration go/no-go log
- Whether the destructive-DDL gate triggered (live replay vs brief maintenance window)

## Why this happens (root cause from the 2026-05-08 incident)

A migration was committed to the repo but never ran against production for ~2.5 months. Event creation broke when newer code assumed the schema change was live. Root cause: no automation between merge and deploy actually applied migrations. The pre-deploy step (Step 0) was the fix; this runbook + the audit script are the safety nets.

## Related files

- `scripts/audit-migrations.js` — the audit script (read-only)
- `scripts/run-migration-prod.js` — single-migration runner via Railway public URL (emergency-only; does NOT update SequelizeMeta)
- `.sequelizerc` + `config/sequelize-cli.config.js` — sequelize-cli wiring (added in Phase 74)
- `.github/workflows/ci.yml` (repo ROOT, not `Sonnet/`) — the `migrate-cli-replay` job is the
  PR-time check that migrations apply cleanly and are idempotent on a second run
- `railway.json` — the Railway deploy contract, including the pre-deploy command (config-as-code)

> **Parked CI idea — not yet wired up:** [`docs/migrations-check.ci.yml.disabled`](migrations-check.ci.yml.disabled)
> is a GitHub Actions workflow that smoke-tests migrations on PRs (fresh Postgres → apply all
> migrations from scratch → re-run for idempotency). It was written in phase 74-03 but never ran
> (it lived in the remote-less umbrella repo). If you're doing migration work and want an extra
> automated safety net beyond `ci.yml`'s `migrate-cli-replay` job, see that file's header for the
> ~6-step "to activate" checklist. Otherwise leave it parked.
>
> Salvaged 2026-07-25 from `RAILWAY_MIGRATION_INSTRUCTIONS.md` before that file was deleted — its
> body documented migrating `UserGroups.user_id` UUID → VARCHAR, which Phase 87.1 reversed.
