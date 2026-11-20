# Staging: setting it up, seeding it, and proving the live site was not touched

Written 2026-11-19 (quick task 261119-nv0). This is a step-by-step runbook for the owner.

How to read it:

- Do the steps in order. After each step there is a **You should see** line. If you see something else, stop there.
- Railway, Vercel and Auth0 change their screens. A button may be named slightly differently from what is written here. If a button named here is missing, **stop and ask. Do not guess.**
- No real value is written anywhere in this file, and none should be added to it: variables appear by NAME only. Where a sample address is needed it is `you@example.com`, which stands for your own address.

## Before anything else: what stays on your screen

Some of the commands below print things that must not leave your own screen: the name of the database host, the database user name, and links that sign a person in. So:

1. **Every `railway ssh ...` command in this runbook is run by you, in your own terminal window.** Never type one into the Claude session, and never run one there with the `!` prefix.
2. **Tell Claude what happened in words only.** For example: "it printed staging", "the seed finished", "it refused at lock 3", or the four row counts as numbers. **Never paste the output of a command.** The seed's output names the database host (the "Seed target" line and the app's own "Database connection info" lines, which also show the database user name), and the walk links it prints carry sign-in tokens.
3. **While you are sharing a screen or a session with Claude, never** open a bare `railway ssh` shell and run `printenv` or `env` with no variable name after it, and never run `railway variables` or `railway run`. Each of those prints the values of variables.
4. **Claude never runs** `railway ssh`, `railway run`, `railway variables`, `railway shell` or `railway connect`. If Claude offers to, say no.

The same goes for the secret you make in step (d) and the user ids you copy in step (g): they go from your screen into Railway, and nowhere else.

## 1. What staging is

Staging is a second copy of the backend on Railway, in an environment named `staging`, with **its own** database and **its own** Redis. The preview site talks to it. The live site keeps talking to production.

- Production data is never touched by anything in this runbook.
- The seed (`npm run seed`) empties the database it runs against and refills it with seven sample users and their groups, games and game nights. On staging that is the point. It must never run against production, which is what the four locks below are for.
- Staging runs in production mode (`NODE_ENV=production`, owner ruling G1), so it behaves like the live site: it sends reminder emails and runs the same scheduled jobs. Those emails go only to the people in staging's database, which are your own plus-addresses.
- Staging shares three outside services with the live site: Auth0 (the same logins exist on both), the email sender and the text-message sender.

## 2. The four locks on the seed

In production mode the seed refuses to run unless all four of these are true:

1. **Lock 1:** Railway says the environment is named exactly `staging` (`RAILWAY_ENVIRONMENT_NAME`, which Railway sets itself).
2. **Lock 2:** `ALLOW_STAGING_SEED` is exactly `1`.
3. **Lock 3:** the database host can be read and, if `PROD_DB_HOST_DENY` is set, the host does not contain it.
4. **Lock 4:** the Users table holds nobody except the seed's own seven users and plus-addresses of `SEED_EMAIL_BASE`.

What to know about them:

- **Lock 3 is weak.** Inside Railway, the staging database and the production database very likely have the same host name, letter for letter, so lock 3 cannot tell them apart. It only helps if a staging variable was pointed at a production address that you wrote into `PROD_DB_HOST_DENY`.
- **Lock 4 is the one that protects production.** Production always holds real people, so production always fails lock 4, whatever the variables say. It is one read of the Users table, done before anything is changed.
- **The locks protect the seed only.** They do nothing about the staging *server*. A staging server pointed at the production database would serve and change real data without ever running the seed. That is what the STOP box in step (d) is for.
- **If you change `SEED_EMAIL_BASE` after a seed, the next seed refuses at lock 4**, because the users from the last seed no longer match the new address. Change it back, seed, and only then change it.
- **Sign in on staging only with the test logins from step (g).** If you sign in there with any other address (your Google login, for example), that creates a user who is not staging-owned, and the next seed refuses at lock 4. Delete that account from inside the app (its own Delete account button), then seed again. If lock 4 still refuses, tell Claude in words.

## 3. Order of work

**(a) The backend pull request is merged, on your go.** Production redeploys. It behaves exactly as before: the change adds scripts, tests and documents, and the server never loads the seed.

- You should see: the production deploy goes Active in Railway, and the live site works as usual.

**(b) Count production, before.** In your own terminal, in the backend folder on your Mac (`periodictabletopbackend_v2/Sonnet`), run:

```
railway ssh -e production -s GameCalendarbackendv2 -- node scripts/count-rows.js
```

If Railway says the folder is not linked to a project, run `railway link` there, pick the project, and run the command again. The first use of `railway ssh` may ask you to set up an SSH key; follow its prompt.

- You should see: the app's "Database connection info" lines, then a line starting `Row counts for database`, then four lines: `Users: <number>`, `Groups: <number>`, `UserGroups: <number>`, `Events: <number>`.
- Write the four numbers down. Tell Claude the four numbers, not the output.
- This command only counts. It changes nothing.

**(c) Duplicate production into a new environment.** In Railway, open the project. Click the environment name in the top bar, then **+ New Environment**, then **Duplicate Environment**. Choose production as the one to copy. Name the new environment exactly `staging`, all lowercase. Lock 1 compares the name letter for letter.

- You should see: a new environment named `staging` with the same services, and a banner saying there are staged changes. **Nothing has been deployed yet.** Railway waits for you to press Deploy on that banner.
- **Do not press Deploy yet.** Step (d) comes first.
- If any service in `staging` starts building or deploying by itself, stop and tell Claude in words.

**(d) Set the staging variables, starting with the STOP box.** Make sure the top bar says `staging`. Click the backend service (`GameCalendarbackendv2`), then **Variables**.

> ## STOP: do this before the first staging deploy
>
> **Why.** Production's database and Redis addresses were typed in as plain text, not as references (owner answer O1). Duplicating an environment copies variables exactly as they are. So right now the staging backend is holding **production's** database address and **production's** Redis address. If it were deployed like this, the staging server would run its migration step against the live database, show real people's data on the preview site, and send every real user a second copy of each reminder. The four seed locks would not stop any of that: they guard the seed, not the server.
>
> **What to do, on the STAGING backend service, before pressing Deploy:**
>
> 1. Find every one of these variable names that exists there: `POSTGRES_PRIVATE_URL`, `POSTGRES_URL`, `DATABASE_URL`, `PGDATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `REDIS_URL`.
> 2. For each database one: either delete it, or replace what it holds with a **reference** to staging's own Postgres service. In the value box, type `${{` and pick staging's Postgres service and its variable from the list Railway offers. At least one of the four `..._URL` names must remain, as a reference. The backend uses the first of those four that is set, in the order written above, so none of them may be left holding pasted text.
> 3. For `REDIS_URL`: replace what it holds with a reference to staging's own Redis service, the same way.
> 4. Look at each one again. **Each must show the `${{ ... }}` form**, not a pasted address. Count them off against the list in point 1.
> 5. Only then go on to the rest of step (d), and then to steps (e) and (f).
>
> **After the first deploy, before doing anything else,** open that deployment's log and find the block that starts `=== Pre-Deploy DB Resolution Diagnostic ===`. On the very first staging deploy you should see a line saying the `SequelizeMeta probe failed`. That is the good sign: staging's database is brand new and empty, so the table that check looks for does not exist yet. The migration step right after it then creates the tables.
>
> If instead that block shows a `SequelizeMeta row count` with a number above zero **on the first deploy**, staging is connected to a database that already holds the app's tables: production, or a copy of it. **Stop at once: remove that staging deployment** (the three-dot menu on the deployment, then Remove), and tell Claude in words. Do not seed, and do not open the preview site.
>
> The host name in that block is worth reading, but it does not settle the question by itself: staging's and production's private host names are very likely the same text (see lock 3).
>
> **One thing that is not settled yet. Do not start step (f) until Claude has told you how it was settled.** The plan was to keep the scheduled jobs and the background workers switched off for the first staging deploy, using `ENABLE_SCHEDULER` and `ENABLE_WORKERS`, and to switch them on after the log check. In the code as it stands that is not possible: in production mode the jobs and workers always start, and those two variables are only looked at outside production mode (`server.js`, every `NODE_ENV === 'production' || ...` check where the jobs start). So today the variable check in points 1 to 4 is the **only** thing between a first staging deploy and production's data. There is no second safety net behind it.

Then set the rest. See section 4 for the full table. Two of them need care:

- `MAGIC_TOKEN_SECRET`: make a new random value in your own terminal with `openssl rand -hex 32`, and paste it straight into Railway. Never show it to anyone, and never type that command into the Claude session. A new value means a sign-in link made on staging can never work on the live site.
- Anything that shows empty: Railway does not copy sealed variables into a duplicate. Enter those again by hand.

- You should see: every row of the table in section 4 done, and the staged-changes banner still waiting.

**(e) Give the staging backend its own address.** Still in `staging`, on the backend service: **Settings**, then **Networking**, then **Generate Domain**. Railway applies networking changes straight away, without waiting for Deploy.

- You should see: a new Railway address for the staging backend. That is the "staging backend address" used in step (h).
- If the staging service lists the live API's custom domain (the one named in `.railway/railway.ts`), **stop, remove nothing, and tell Claude in words.**

**(f) Deploy staging for the first time.** Only after the STOP box is fully done and the open point in it has been settled. Click **Details** on the staged-changes banner, read the list, then **Deploy**.

- You should see: the staging services build and go Active. In the backend's deploy log, the `=== Pre-Deploy DB Resolution Diagnostic ===` block with `SequelizeMeta probe failed` (see the STOP box), then the migrations running.
- Then open the staging backend address followed by `/health` in a browser. You should see the health response.
- From now on, staging redeploys by itself each time the backend's `main` branch changes, and its pre-deploy step runs the migrations on staging's database. The seed is never run automatically.

**(g) Make the Auth0 test logins.** Auth0 Dashboard, **User Management**, **Users**, **Create User**. Connection: **Username-Password-Authentication**. Make one for each seed user you want to sign in as, each with that user's plus-address from the table in section 5 (for Alice, `you+alice@example.com` with your own address in place of `you@example.com`). These are password logins on purpose: a Google login and a password login with the same address are two different users to Auth0.

Then open each new user in Auth0, copy its **user_id**, and paste it into the matching `AUTH0_<NAME>_SUB` variable on the staging backend (section 5 says which). Deploy that change.

- You should see: one new Auth0 user per seed user, and the matching variables filled in on staging.
- These logins also work on the live site, where signing in would create a real account. **Use them on the preview site only.**

**(h) Point the preview site at staging.** In Vercel, open the frontend project, **Settings**, **Environment Variables**. Give `NEXT_PUBLIC_API_URL` a value for the **Preview** environment only: the staging backend address from step (e), followed by `/api`. Leave the Production value exactly as it is. Then redeploy the preview deployment: this value is fixed into the site when it is built, so a change does nothing until the preview is rebuilt.

- You should see: two separate values for `NEXT_PUBLIC_API_URL` in Vercel, one for Production (unchanged) and one for Preview; and a fresh preview deployment.

**(i) Seed staging.** Section 6.

**(j) Count production, after.** Run the command from step (b) again.

- You should see: the same four numbers as before, or slightly higher ones, because real people may have joined or scheduled something in between. A seed that had hit production would show `Users: 7`.
- Tell Claude the four numbers.

**(k) Walk the proof list.** Section 8.

## 4. Staging variables

All of these are set on the **staging** backend service. Names only; the values never go anywhere but Railway.

| Name | What to set on staging | Why |
| --- | --- | --- |
| `NODE_ENV` | Leave as `production` | Staging must behave like the live site (owner ruling G1). |
| `POSTGRES_PRIVATE_URL`, `POSTGRES_URL`, `DATABASE_URL`, `PGDATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Each one that exists: a `${{ ... }}` reference to **staging's own** Postgres, or deleted. Never pasted text. | The STOP box in step (d). A pasted production address runs the staging server on real data. |
| `REDIS_URL` | A `${{ ... }}` reference to **staging's own** Redis | The STOP box. Production's Redis holds the live site's queued reminders. |
| `MAGIC_TOKEN_SECRET` | A new random value, made in your own terminal | So a staging link can never work on production. |
| `FRONTEND_URL`, `ALLOWED_ORIGINS` | The preview site's address | The backend only answers the site named here, and builds its links from it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Delete on staging | Connect Google Calendar fails on staging with a Google error, on purpose: Google Calendar stays off on staging (owner decision C1, 2026-11-19); it is tested on the local copy and on the live site. Do not report it as a bug. |
| `SENTRY_DSN` | Delete on staging | Errors are labelled with `NODE_ENV`, so staging's errors would be mixed into the live site's reports. |
| `GITHUB_TOKEN` | Delete on staging | Feedback sent from staging is then kept in staging's database and never opens an issue in the real queue. |
| `ENABLE_SCHEDULER`, `ENABLE_WORKERS` | Leave as copied | In production mode these do nothing: the scheduled jobs and workers always run. See the open point in the STOP box. |
| `ALLOW_STAGING_SEED` | `1` | Lock 2. **Staging only. Never add `ALLOW_STAGING_SEED` to production.** |
| `SEED_EMAIL_BASE` | Your own plain address, with no `+` in it | Every seeded user gets a plus-address of it, so all staging mail lands in your mailbox. |
| `SEED_SMS_USER` | One seed tag; `alice` is recommended | The one seeded user who is allowed to receive texts. |
| `PROD_DB_HOST_DENY` | Optional. Production Postgres's public address, if you already know it; otherwise leave it out | Lock 3. Weak; see section 2. |
| `AUTH0_ALICE_SUB` and the other six | The user ids from step (g) | So signing in as a test login lands on that seeded user. |
| Anything showing empty | Enter it again | Sealed variables are not copied into a duplicate. |

`RAILWAY_ENVIRONMENT_NAME` is set by Railway. Do not create it yourself.

## 5. The seed users

With `SEED_EMAIL_BASE` set to `you@example.com` (your own address in its place), the seed writes:

| Tag | Sub variable | Address it gets |
| --- | --- | --- |
| `alice` | `AUTH0_ALICE_SUB` | `you+alice@example.com` |
| `bob` | `AUTH0_BOB_SUB` | `you+bob@example.com` |
| `charlie` | `AUTH0_CHARLIE_SUB` | `you+charlie@example.com` |
| `diana` | `AUTH0_DIANA_SUB` | `you+diana@example.com` |
| `eve` | `AUTH0_EVE_SUB` | `you+eve@example.com` |
| `frank` | `AUTH0_FRANK_SUB` | `you+frank@example.com` |
| `bartholomew` | `AUTH0_BART_SUB` | `you+bartholomew@example.com` |
| `pending-invitee` (an invitation, not a user) | none | `you+pending-invitee@example.com` |

The tag for the seventh user is `bartholomew` and his variable is `AUTH0_BART_SUB`. They differ on purpose.

## 6. Seeding staging

All three commands are run by you, in your own terminal, in the backend folder. Do the two checks first.

**Check 1: you are in staging.**

```
railway ssh -e staging -s GameCalendarbackendv2 -- printenv RAILWAY_ENVIRONMENT_NAME
```

- You should see: `staging`, and nothing else. (This prints one named variable, the environment's name. Never run `printenv` without a name after it.)

**Check 2: you are in the backend's folder.**

```
railway ssh -e staging -s GameCalendarbackendv2 -- ls package.json
```

- You should see: `package.json`.

**Then the seed.**

```
railway ssh -e staging -s GameCalendarbackendv2 -- npm run seed
```

- You should see, in this order: the app's "Database connection info" lines; a line starting `Seed target:` that names the database; four lines, one for each lock, each saying it passed (lock 3 says it is "not armed" if you left `PROD_DB_HOST_DENY` out); the seeding steps; `Seeding complete!`; and a list of walk links built from the preview site's address.
- The first time, lock 4's line says there are 0 rows in the Users table.
- Tell Claude "the seed finished", or which lock refused. Do not paste the output: it names the database host and the walk links sign a person in.

If Railway says SSH is not available, or either check prints something else, **stop and tell Claude in words.** There is no workaround through a public database address, and none should be tried.

Seeding again later wipes staging and refills it. That includes the phone number the SMS user added: add and verify it again afterwards.

## 7. If the seed refuses

A refused seed changes nothing in the database. The message starts with `Refusing to seed`, names the database, and names the lock.

| It says | What it means | What to do |
| --- | --- | --- |
| Lock 1 of 4 failed | Railway does not say this environment is named `staging`. | Check the top bar and the `-e staging` in your command. If the environment has another name, stop and tell Claude. |
| Lock 2 of 4 failed | `ALLOW_STAGING_SEED` is not `1` on this service. | Set it on the **staging** backend service, deploy the change, run the seed again. Never set it on production. |
| Lock 3 of 4 failed | The database address could not be read, or the host matches `PROD_DB_HOST_DENY`. | Stop. This service may be pointed at production's database. Go back to the STOP box in step (d) and tell Claude. |
| Lock 4 of 4 failed, with a count of users | The database holds that many people who are not seed users and not your plus-addresses. | If you signed in on staging with another address, delete that account in the app and seed again. If you did not, **stop: this database may hold real people.** Tell Claude the count. Do not try to get around it. |
| The Users table does not exist | The staging backend has not been deployed yet, so its tables were never created; or this is not the database you think it is. | Finish step (f) first. |
| `SEED_EMAIL_BASE` cannot be used, or `SEED_SMS_USER` does not name a seed user | A typing mistake in that variable. | Fix it on the staging service (section 4), deploy the change, run the seed again. |

## 8. The proof list

1. Signed in on the preview site as one of the test logins, you see the seeded groups (Weekend Warriors and the others).
2. A change you make there (rename a group, add a game night) does not appear on the live site.
3. The production counts from steps (b) and (j) match, or went up slightly. They did not drop, and Users is not 7.
4. An email arrives at one of your plus-addresses (reminders are sent for the seeded upcoming game nights).
5. Texts: signed in as the SMS user, add your phone number in the app. A verification text arrives. Enter the code and turn on one text notification. No other seed user can receive notification texts.
6. Connect Google Calendar fails on staging with a Google error. That is expected (section 4, owner decision C1).

## 9. Never

- Never add `ALLOW_STAGING_SEED` to production.
- Never run the seed with `-e production`.
- Never point staging's database or Redis variables at production, and never leave a pasted address in them.
- Never run `railway config plan` or `railway config apply` without `--environment production` (see `docs/railway-deploy-settings.md`).
- Never add the seed to a pre-deploy command, on staging or anywhere. It would wipe staging on every deploy.
- Never paste command output into the Claude session, and never run the commands in section 6 there (see the top of this file).
- Never try to get around a refused lock. A refusal is the guard working.

## 10. Cost

- Railway's Hobby plan is $5 a month and includes $5 of usage.
- A second backend, Postgres and Redis were estimated at roughly $5 a month more. That estimate was made by an agent from Railway's published prices, not by Railway.
- Your real usage is on Railway's **Usage** page.
- Railway's Serverless setting is unlikely to put a backend to sleep while it holds database connections, so do not count on it to lower the bill.
