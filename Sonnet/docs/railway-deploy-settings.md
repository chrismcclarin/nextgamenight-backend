# Railway deploy settings (pre-deploy command, health check)

The backend's deploy settings live in `Sonnet/.railway/railway.ts` (Railway "Infrastructure as Code").

**Railway does not read that file when it deploys.** Merging a change to it does nothing by itself.
A change takes effect only when someone applies it from this folder:

1. `railway config plan` — shows what would change on Railway. It changes nothing. Read it.
2. `railway config apply` — applies exactly that plan, after a confirmation.

Rules:

- Apply only a plan you have read. A plan that says anything is to be **destroyed**, or that touches the
  domain or the replicas, is not routine: stop and check before confirming.
- Variables are unmanaged (`variables: { managed: false }`). Keep it that way; never use an option
  that pulls variables into the file. Variables are set in the Railway dashboard only.
- Keep the `partial` export. It limits what this file owns to the backend service.
- The pre-deploy command is what runs the database migrations before each deploy
  (`node scripts/log-db-resolution.js && npm run migrate:apply`). Do not remove it.

## Until `railway.json` is deleted

`Sonnet/railway.json` is the old way of setting the same three values. Railway stops reading it on
2026-12-01. While it is still in the repo, Railway reads it on every deploy and it wins over the service's
own settings, so there are two sources of truth: a change applied from `railway.ts` is silently overridden
by `railway.json` on the next deploy. Until `railway.json` is deleted, change a setting in BOTH files or
in neither. The deletion is a follow-up change, made only after the cutover
(`railway config migrate cutover`), as Railway's migration guide requires.
