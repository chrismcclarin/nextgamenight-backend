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

## History

Until November 2026 these three values lived in `Sonnet/railway.json` (Railway "Config as Code"), which
Railway stops reading on 2026-12-01. They were applied to the service with `railway config apply` on
2026-11-19 and the old file was deleted afterwards. Do not add a `railway.json` back: until 2026-12-01
Railway would read it again and it would override the service's settings; after that date it is ignored. Older comments in the code that say "railway.json's preDeployCommand" mean the pre-deploy
command described above.
