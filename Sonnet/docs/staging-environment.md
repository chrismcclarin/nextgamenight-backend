# Staging: setting it up, seeding it, and proving the live site was not touched

Written 2026-11-19 (quick task 261119-nv0). Amended 2026-11-19 (quick task 261119-w61): the off switch for background jobs, `DISABLE_BACKGROUND_JOBS`. Corrected 2026-11-20 after the first real walk of it (seven places where the screens or the facts differed from what was written). This is a step-by-step runbook for the owner.

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
- On the **first** staging deploy only, one extra variable, `DISABLE_BACKGROUND_JOBS`, keeps every scheduled job and background worker switched off until you have done the log check in step (f). After that check you delete it, and staging runs its jobs like the live site does.
- Staging shares three outside services with the live site: Auth0 (the same logins exist on both), the email sender and the text-message sender.
- Because the logins are shared, **staging must never be able to delete or change a login in Auth0.** That is why two variables are deleted on staging before its first deploy (step (d) and section 4), and why Delete account on staging has its own rules (section 7).

## 2. The four locks on the seed

In production mode the seed refuses to run unless all four of these are true:

1. **Lock 1:** Railway says the environment is named exactly `staging` (`RAILWAY_ENVIRONMENT_NAME`, which Railway sets itself).
2. **Lock 2:** `ALLOW_STAGING_SEED` is exactly `1`.
3. **Lock 3:** the database host can be read and, if `PROD_DB_HOST_DENY` is set, the host does not contain it.
4. **Lock 4:** the Users table holds nobody except the seed's own seven users and plus-addresses of `SEED_EMAIL_BASE`. If the Users table holds nobody at all, the Groups and Events tables must be empty too.

What to know about them:

- **Lock 3 is weak.** Inside Railway, the staging database and the production database very likely have the same host name, letter for letter, so lock 3 cannot tell them apart. It only helps if a staging variable was pointed at a production address that you wrote into `PROD_DB_HOST_DENY`.
- **Lock 4 is the one that protects production.** Production always holds real people, so production always fails lock 4, whatever the variables say. It only reads, before anything is changed: one read of the Users table, and, when that table is empty, a count of the Groups table and of the Events table. The counts are there because a database with no users in it can still hold real groups and game nights (a half-finished copy of production, for example), and the seed must not empty that either.
- **Inside Railway the four locks always decide.** The seed treats any run inside Railway as production mode, whatever `NODE_ENV` holds, and it also treats a mistyped `NODE_ENV` (`Production`, or `production` with a space) as production mode. `ALLOW_DESTRUCTIVE_SEED` never opens the seed inside Railway.
- **The locks protect the seed only.** They do nothing about the staging *server*. A staging server pointed at the production database would serve and change real data without ever running the seed. That is what the STOP box in step (d) is for.
- **If you change `SEED_EMAIL_BASE` after a seed, the next seed refuses at lock 4**, because the users from the last seed no longer match the new address. Change it back, seed, and only then change it.
- **Sign in on staging only with the test logins from step (g).** If you sign in there with any other address (your Google login, for example), that creates a user who is not staging-owned, and the next seed refuses at lock 4. Removing that user has its own steps: "Removing a stray user" in section 7. **Do not press Delete account on staging before you have read them.**

## 3. Order of work

**(a) The two backend pull requests are merged, each on your go.** There are two: the seed guard, and the off switch for background jobs (`DISABLE_BACKGROUND_JOBS`). Production redeploys after each one, and behaves exactly as before:

- The seed guard adds scripts, tests and documents, and the server never loads the seed.
- The off switch does nothing unless `DISABLE_BACKGROUND_JOBS` is set, and production never has that variable.

- You should see: the production deploy goes Active in Railway, and the live site works as usual.
- You should see, after the off-switch pull request: production's deploy log shows the same "started" lines as before (`Deadline scheduler started (node-cron)` and the others) and **no** line beginning `Background jobs are OFF`.
- If production's log ever does show a line beginning `Background jobs are OFF`, that variable is on production by mistake. Delete it there, deploy, and tell Claude in words.

**(b) Count production, before.** In your own terminal, in the backend folder on your Mac (`periodictabletopbackend_v2/Sonnet`), run:

```
railway ssh -e production -s GameCalendarbackendv2 -- node scripts/count-rows.js
```

If Railway says the folder is not linked to a project, run `railway link` there, pick the project, and run the command again. The first use of `railway ssh` may ask you to set up an SSH key; follow its prompt. Your Mac then asks once whether you are sure you want to connect, because it has never met Railway's SSH server before. Read the host name in that question: it must be `ssh.railway.com`. If it is, type `yes` in full. If it names any other host, type `no` and tell Claude in words. Railway's documentation pages checked on 2026-11-20 publish no fingerprint to compare against, so do this on a network you trust, not on public wifi.

- You should see: the app's "Database connection info" lines, then a line starting `Row counts for database`, then four lines: `Users: <number>`, `Groups: <number>`, `UserGroups: <number>`, `Events: <number>`.
- Write the four numbers down. Tell Claude the four numbers, not the output.
- This command only counts. It changes nothing.

**(c) Duplicate production into a new environment.** In Railway, open the project. Click the environment name in the top bar, then **+ New Environment**, then **Duplicate Environment**. Choose production as the one to copy. Name the new environment exactly `staging`, all lowercase. Lock 1 compares the name letter for letter.

- You should see: a new environment named `staging` with the same services.
- **Railway may start building the copy straight away, without waiting for you.** It did on the first walk (2026-11-20): the backend began building and the new Postgres and Redis came online. The new Postgres and Redis are staging's own and can stay. **The backend must not finish deploying before step (d) is done,** so if it is building: make sure the top bar says `staging`, click the backend service, open **Deployments**, click the three-dot menu on the deployment that is building, and choose **Abort**. If it already shows Active, choose **Remove** from the same menu, then stop and tell Claude in words how long it was Active before going on to step (d).
- You should then see: the staging backend service offline, with no active deployment.
- **Do not press Deploy yet.** Step (d) comes first.

**(d) Set the staging variables, starting with the STOP box.** Make sure the top bar says `staging`. Click the backend service (`GameCalendarbackendv2`), then **Variables**.

> ## STOP: do this before the first staging deploy
>
> **Why.** Duplicating an environment copies variables exactly as they are. A variable written as a reference (the `${{ ... }}` form) points at the service of that name inside whichever environment it is read in, so in staging it points at staging's own Postgres or Redis. A variable holding a pasted address still points wherever that address goes, which after a copy is **production**. A staging server deployed with a pasted production address would run its migration step against the live database, show real people's data on the preview site, and send every real user a second copy of each reminder. The four seed locks would not stop any of that: they guard the seed, not the server.
>
> On the first walk (2026-11-20) the database and Redis variables turned out to be references already. Do the check anyway, every time: it is the only thing that stands between a pasted address and the live database.
>
> **What to do, on the STAGING backend service, before pressing Deploy:**
>
> Do point 5 (the off switch) **first**, then points 1 to 4, so that if a save does start a build, the jobs and workers are already off. Each saved variable should only be held as a staged change: a banner appears saying there are staged changes waiting to be deployed, and nothing builds. If saving a variable starts a build by itself, abort it (step (c) says how) and tell Claude in words.
>
> 1. Find every one of these variable names that exists there: `POSTGRES_PRIVATE_URL`, `POSTGRES_URL`, `DATABASE_URL`, `PGDATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `REDIS_URL`.
> 2. For each database one: either delete it, or replace what it holds with a **reference** to staging's own Postgres service. In the value box, type `${{` and pick staging's Postgres service and its variable from the list Railway offers. At least one of the four `..._URL` names must remain, as a reference. The backend uses the first of those four that is set, in the order written above, so none of them may be left holding pasted text.
> 3. For `REDIS_URL`: replace what it holds with a reference to staging's own Redis service, the same way.
> 4. Look at each one again. **Each must show the `${{ ... }}` form**, not a pasted address. Count them off against the list in point 1.
> 5. Add `DISABLE_BACKGROUND_JOBS` with the value `1`: the digit one, no spaces, not `true`. It keeps the scheduled jobs and the background workers off for this first deploy ("What the switch does and does not do", below).
> 6. Only then go on to the rest of step (d), and then to steps (e) and (f).
>
> **After the first deploy, before doing anything else,** open that deployment's log and find the block that starts `=== Pre-Deploy DB Resolution Diagnostic ===`. On the very first staging deploy you should see a line saying the `SequelizeMeta probe failed`. That is the good sign: staging's database is brand new and empty, so the table that check looks for does not exist yet. The migration step right after it then creates the tables.
>
> If instead that block shows a `SequelizeMeta row count` with a number above zero **on the first deploy**, staging is connected to a database that already holds the app's tables: production, or a copy of it. **Stop at once: remove that staging deployment** (the three-dot menu on the deployment, then Remove), and tell Claude in words. Do not seed, and do not open the preview site.
>
> The host name in that block is worth reading, but it does not settle the question by itself: staging's and production's private host names are very likely the same text (see lock 3).
>
> **Then find the off line, in the same log.** After the two lines that start `Server is running on port` and `Environment:`, you should see this line, word for word:
>
> ```
> Background jobs are OFF (DISABLE_BACKGROUND_JOBS): scheduled jobs, sweeps and BullMQ workers are NOT running; Bull Board is not mounted
> ```
>
> If that line is **not** there, the switch did not take (see "exactly `1`" below) and staging's jobs and workers are running. **Stop at once: remove that staging deployment** (the three-dot menu on the deployment, then Remove), and tell Claude in words.
>
> ### What the switch does and does not do
>
> **What `DISABLE_BACKGROUND_JOBS` set to `1` does.** The server starts and answers the preview site as usual, but:
>
> - No scheduled jobs start: the deadline checks, the reminders, the auto-promotion of pending members, the weekly backup.
> - No sweeps start: the two that run every half hour, and the daily group purge.
> - No background workers start. The workers are what send queued emails and texts.
> - The queue dashboard (`/admin/queues`) is not there.
> - The log shows the one line quoted above.
>
> It works **only** when the value is exactly `1`. Anything else (`true`, `yes`, `1` with a space after it) counts as not set, and everything starts. That is why a missing off line means it did not take.
>
> **What it does NOT cover.** The switch is a second safety net behind points 1 to 4. It does not replace them:
>
> 1. **The migration step that runs before the server starts.** It runs against whatever database the variables name, switch or no switch. Only points 1 to 4 protect that.
> 2. **Anything a person sets off by using staging:** sign-in links, invites, poll invitations, verification texts. Those are sent by the server itself when the person presses the button, not by a background job. Nobody uses staging before step (h), because the preview site is not pointed at it until then.
> 3. **Messages that were queued while the switch was on,** such as a poll's reminders or an email-change notice. They wait in Redis, and they are sent after you delete the switch. On staging's own Redis they go to your plus-addresses.
> 4. **Outside services calling staging** (the email and text senders reporting back, for example). Staging still answers them.
> 5. **The seed.** The four locks in section 2 guard that, not this switch.
>
> **Why the order matters.** If production's Redis address were still in `REDIS_URL`, deleting the switch would let staging's workers take the live site's queued reminders. The log check cannot catch that: with the switch on, the server does not connect to Redis when it starts. So the order is: the variable check (points 1 to 4), then the log check, and only then deleting the switch (step (f)).

Then set the rest. See section 4 for the full table. Three of them need care:

- `AUTH0_MANAGEMENT_CLIENT_ID` and `AUTH0_MANAGEMENT_CLIENT_SECRET`: **delete both on the staging backend service now, before the first deploy.** Staging must never be able to delete or change a login in the Auth0 tenant the live site uses. With these two in place, pressing Delete account on the preview site would delete that person's real login. If either one shows empty, do not fill it in: delete it. Section 4 says what staging loses without them.
- `MAGIC_TOKEN_SECRET`: make a new random value in your own terminal with `openssl rand -hex 32`, and paste it straight into Railway. Never show it to anyone, and never type that command into the Claude session. A new value means a sign-in link made on staging can never work on the live site.
- Anything that shows empty: Railway does not copy sealed variables into a duplicate. Enter those again by hand, except the ones the table in section 4 says to delete.

- You should see: every row of the table in section 4 done, neither `AUTH0_MANAGEMENT_CLIENT_ID` nor `AUTH0_MANAGEMENT_CLIENT_SECRET` in the staging backend's variable list, and the staged-changes banner still waiting.

**(e) Give the staging backend its own address.** Still in `staging`, on the backend service: **Settings**, then **Networking**, then **Generate Domain**. Railway applies networking changes straight away, without waiting for Deploy.

- You should see: a new Railway address for the staging backend. That is the "staging backend address" used in step (h).
- If the staging service lists the live API's custom domain (the one named in `.railway/railway.ts`), **stop, remove nothing, and tell Claude in words.**

**(f) Deploy staging for the first time.** Only after the STOP box is fully done, all six points, `DISABLE_BACKGROUND_JOBS` included. Click **Details** on the staged-changes banner, read the list, then **Deploy**.

- You should see: the staging services build and go Active. In the backend's deploy log, the `=== Pre-Deploy DB Resolution Diagnostic ===` block with `SequelizeMeta probe failed` (see the STOP box), then the migrations running.
- You should see, after the migrations: a line starting `Server is running on port`, a line starting `Environment:`, then the off line (it begins `Background jobs are OFF (DISABLE_BACKGROUND_JOBS)`; the STOP box quotes it in full).
- You should **not** see any line that begins with `Deadline scheduler started`, `Backup scheduler started`, `Auto-promotion scheduler started`, `Reminder scheduler started`, `Scheduler anomaly sweep started`, `PendingAuth0Deletion reconciliation sweep started`, `Group purge sweep started` or `BullMQ workers started`.
- If the off line is missing, or one of those "started" lines shows: **remove that staging deployment** (the three-dot menu on the deployment, then Remove), and tell Claude in words.
- Then open the staging backend address followed by `/health` in a browser. You should see the health response.
- Then leave it alone, switch still on, until the deployment has been up for ten minutes, and read the log once more. There must be no line containing `Running deadline check`, `Running reminder check` or `Running auto-promotion check`. A scheduled job prints one of those each time it actually runs: the first two every five minutes, the third every fifteen. Ten minutes is enough only with those default timings: if the staging variable list has `DEADLINE_CHECK_INTERVAL`, `REMINDER_CHECK_INTERVAL` or `AUTO_PROMOTE_INTERVAL`, tell Claude which of those names are there (the names only, never what they hold) before relying on this check. If one of the lines is there, a job is running in spite of the switch: **remove that staging deployment** (the three-dot menu on the deployment, then Remove), and tell Claude in words.

**Switch the background jobs on.** Do this only once the three log checks have passed (the database block, the off line, and no job line after ten minutes) and `/health` answers.

1. On the staging backend service, open **Variables** and look at `REDIS_URL` one more time. It must show the `${{ ... }}` form (point 3 of the STOP box). The log check could not see Redis: with the switch on, the server does not connect to it when it starts.
2. Delete `DISABLE_BACKGROUND_JOBS` there, then **Deploy**.

- You should see, in the new deployment's log: no off line, and lines such as `Deadline scheduler started (node-cron)` and `BullMQ workers started (prompts, deadlines, reminders, gcal-sync, auth0-cleanup, email-notice)`.
- If the off line is still there, the variable was not deleted or the change was not deployed. Staging is safe in that state, but its reminders do not run. Check the variable list again.
- From now on, staging redeploys by itself each time the backend's `main` branch changes, and its pre-deploy step runs the migrations on staging's database. The seed is never run automatically.

**(g) Make the Auth0 test logins.** Auth0 Dashboard, **User Management**, **Users**, **Create User**. Connection: **Username-Password-Authentication**. Make one for each seed user you want to sign in as, each with that user's plus-address from the table in section 5 (for Alice, `you+alice@example.com` with your own address in place of `you@example.com`). These are password logins on purpose: a Google login and a password login with the same address are two different users to Auth0.

If the Create User form asks you to pick a domain, pick your custom login domain, the one the app signs people in through. Both choices are the same Auth0 tenant, and the user is the same whichever you pick.

Then open each new user in Auth0, copy its **user_id**, and paste it into that user's variable on the staging backend. The seven names are exactly: `AUTH0_ALICE_SUB`, `AUTH0_BOB_SUB`, `AUTH0_CHARLIE_SUB`, `AUTH0_DIANA_SUB`, `AUTH0_EVE_SUB`, `AUTH0_FRANK_SUB` and `AUTH0_BART_SUB`. **The last one is `AUTH0_BART_SUB`, not `AUTH0_BARTHOLOMEW_SUB`**, although his email tag is the full `bartholomew` (section 5). The seed reads only these names: a variable under any other name is skipped, and that seed user is created with a built-in stand-in id instead of your test login's, so signing in as that test login will not land on that seeded user. Deploy that change.

- You should see: one new Auth0 user per seed user, and the matching variables filled in on staging.
- These logins also work on the live site, where signing in would create a real account. **Use them on the preview site only.**
- **Never press Delete account while signed in as one of these test logins**, on the preview site or anywhere. Section 7 says why.

**(h) Point the preview site at staging.** In Vercel, open the frontend project, **Settings**, **Environment Variables**. Give `NEXT_PUBLIC_API_URL` a value for the **Preview** environment only: the staging backend address from step (e), followed by `/api`. Add it as a new entry with only **Preview** ticked. If Vercel asks for a type, choose the plain, readable one (Config), not Secret: the value is a public address that is built into the site. Leave the Production value exactly as it is.

If Vercel refuses because the name already exists for Preview, open the existing entry and see which boxes are ticked. If it shows only **Preview**, change its value to the staging address followed by `/api` and save, and skip the rest of this paragraph. If it also shows **Production**, edit that entry and untick **Preview** (that one box only), leaving Production ticked and the value alone; save; then add the new Preview-only entry. Afterwards look at the list: the original entry must still show Production. A Production variable that goes missing here breaks the live site at its next deploy, not today, so tell Claude this split was made.

Then redeploy the preview deployment: this value is fixed into the site when it is built, so a change does nothing until the preview is rebuilt.

- You should see: two separate values for `NEXT_PUBLIC_API_URL` in Vercel, one for Production (unchanged) and one for Preview; and a fresh preview deployment.

**(i) Seed staging.** Section 6.

**(j) Count production, after.** Run the command from step (b) again.

- You should see: the same four numbers as before, or close to them. They can be slightly higher, because real people may have joined or scheduled something in between. They can also be slightly lower, for two ordinary reasons: real people may have deleted a game night, left a group or deleted their account in between (those are removed for good at once); and once a day, at 03:00 UTC (7:00 PM Pacific in winter, 8:00 PM Pacific in summer), production erases for good the groups that were deleted more than 30 days ago, with their memberships and game nights. If that time fell between the two counts, production's log at that time says how many groups it erased, in a line containing `Sweep completed`.
- What a seed on production would look like is different: `Users: 7` exactly. The other three numbers may barely move (the seed makes only a few groups and about two dozen memberships), so Users is the number that tells. If Users is not 7, a small drop of one or two in the others is not a seed.
- If Users is 7, or any number fell by more than a handful, **stop and tell Claude in words.**
- Tell Claude the four numbers.

**(k) Walk the proof list.** Section 8.

## 4. Staging variables

All of these are set on the **staging** backend service. Names only; the values never go anywhere but Railway.

| Name | What to set on staging | Why |
| --- | --- | --- |
| `NODE_ENV` | Leave as `production` | Staging must behave like the live site (owner ruling G1). |
| `POSTGRES_PRIVATE_URL`, `POSTGRES_URL`, `DATABASE_URL`, `PGDATABASE_URL`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Each one that exists: a `${{ ... }}` reference to **staging's own** Postgres, or deleted. Never pasted text. | The STOP box in step (d). A pasted production address runs the staging server on real data. |
| `REDIS_URL` | A `${{ ... }}` reference to **staging's own** Redis | The STOP box. Production's Redis holds the live site's queued reminders. |
| `AUTH0_MANAGEMENT_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_SECRET` | **Delete both on staging, before the first deploy. Never add them back** (adding them back later deletes, for real, every login whose account was ever deleted on staging; see section 9). | Staging must never be able to delete or change a login in the Auth0 tenant the live site uses. With them in place, Delete account on staging deletes the real login. What staging loses without them is written under this table. |
| `MAGIC_TOKEN_SECRET` | A new random value, made in your own terminal | So a staging link can never work on production. |
| `FRONTEND_URL`, `ALLOWED_ORIGINS` | The preview site's address | The backend only answers the site named here, and builds its links from it. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Delete on staging | Connect Google Calendar fails on staging with a Google error, on purpose: Google Calendar stays off on staging (owner decision C1, 2026-11-19); it is tested on the local copy and on the live site. Do not report it as a bug. |
| `SENTRY_DSN` | Delete on staging | Errors are labelled with `NODE_ENV`, so staging's errors would be mixed into the live site's reports. |
| `GITHUB_TOKEN` | Delete on staging | Feedback sent from staging is then kept in staging's database and never opens an issue in the real queue. |
| `DISABLE_BACKGROUND_JOBS` | `1` (the digit one) **before the first deploy**. Deleted after the log check in step (f). | Keeps the scheduled jobs, sweeps and workers off for the first deploy (the STOP box in step (d)). **Staging only, and only for that first deploy. Never on production:** there it stops the live reminders, the sweeps and the alarm for silent jobs. |
| `ENABLE_SCHEDULER`, `ENABLE_WORKERS` | Leave as copied | In production mode these do nothing: the scheduled jobs and workers run unless `DISABLE_BACKGROUND_JOBS` is set. |
| `ALLOW_STAGING_SEED` | `1` | Lock 2. **Staging only. Never add `ALLOW_STAGING_SEED` to production.** |
| `SEED_EMAIL_BASE` | Your own plain address, with no `+` in it | Every seeded user gets a plus-address of it, so all staging mail lands in your mailbox. |
| `SEED_SMS_USER` | One seed tag; `alice` is recommended | The one seeded user who is allowed to receive texts. |
| `PROD_DB_HOST_DENY` | Optional. Production Postgres's public address, if you already know it; otherwise leave it out | Lock 3. Weak; see section 2. |
| `AUTH0_ALICE_SUB`, `AUTH0_BOB_SUB`, `AUTH0_CHARLIE_SUB`, `AUTH0_DIANA_SUB`, `AUTH0_EVE_SUB`, `AUTH0_FRANK_SUB`, `AUTH0_BART_SUB` | The user ids from step (g). The seventh is `AUTH0_BART_SUB`, not `AUTH0_BARTHOLOMEW_SUB`. | So signing in as a test login lands on that seeded user. |
| Anything showing empty | Enter it again, unless a row above says to delete it | Sealed variables are not copied into a duplicate. |

`RAILWAY_ENVIRONMENT_NAME` is set by Railway. Do not create it yourself.

### What staging loses without the two Auth0 Management variables

Those two variables are the key the backend uses to ask Auth0 about a login, or to delete one. Without them staging has no such key, and it does not even try to reach Auth0 for those things. Signing in is not affected: checking a sign-in does not use them.

What changes, on staging only:

- **Delete account** removes the account from staging's database and leaves the Auth0 login alone. The details, and the rules for using it, are in section 7 ("Removing a stray user").
- **A first sign-in whose login carries no email address** is stored with a made-up address ending in `@auth0.local`, because staging cannot look the real one up. The test logins from step (g) are not affected: the seed has already created their users. A user with a made-up address is not staging-owned, so the next seed refuses at lock 4, the same as for any other stray user.
- **If a new sign-in's address is already held by another staging user**, staging cannot check whether that other login still exists. So it always gives the newcomer a made-up address, even when the other login is long gone and the address could have been handed over.
- The account-hygiene report (`scripts/report-account-hygiene.js`) cannot run on staging. It is not part of this runbook.

Expect lines in staging's log that say the Auth0 Management API credentials are not configured. On staging that is the intended state. Do not report it as a bug, and do not fix it by adding the variables back.

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

- You should see, in this order: the app's "Database connection info" lines; a line starting `Seed target:` that names the database; four lines, one for each lock, each saying it passed (lock 3 says it is "not armed" if you left `PROD_DB_HOST_DENY` out); a line saying the schema sync was skipped (on staging the tables belong to the migrations, so the seed fills them and never reshapes them); the seeding steps; `Seeding complete!`; and a list of walk links built from the preview site's address.
- The first time, lock 4's line says there are 0 rows in the Users table, and that the Groups and Events tables are empty too.
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
| Lock 4 of 4 failed, with a count of users | The database holds that many people who are not seed users and not your plus-addresses. | If you signed in on staging with another address, follow "Removing a stray user" under this table. **Do not press Delete account before you have read it.** If you did not sign in with another address, **stop: this database may hold real people.** Tell Claude the count. Do not try to get around it. |
| Lock 4 of 4 failed, and it says the Users table is empty but Groups or Events holds rows | The database has no users in it, but it does have groups or game nights. A fresh staging database has neither, so this may be a partial copy of real data. | **Stop.** Tell Claude the two counts. Do not try to get around it. |
| The Users table does not exist (or the Groups table, or the Events table) | The staging backend has not been deployed yet, so its tables were never created; or this is not the database you think it is. | Finish step (f) first. |
| `SEED_EMAIL_BASE` cannot be used, or `SEED_SMS_USER` does not name a seed user | A typing mistake in that variable. | Fix it on the staging service (section 4), deploy the change, run the seed again. |

### Removing a stray user

This is for one case only: lock 4 refused because you signed in on the preview site with a login that is not one of the test logins from step (g), your everyday Google login for example.

> **STOP: never use Delete account on staging while `AUTH0_MANAGEMENT_CLIENT_ID` or `AUTH0_MANAGEMENT_CLIENT_SECRET` exists on the staging backend service.**
>
> Staging and the live site share one set of Auth0 logins. With those two variables in place, Delete account on staging deletes that login in Auth0 itself, which is the login you use on the live site, and deleting a login in Auth0 cannot be undone. Without the two variables staging cannot reach Auth0 to delete anything, and Delete account only removes the account from staging's database.

Do these in order:

1. **Check the two variables are gone.** In Railway, make sure the top bar says `staging`. Click the backend service, then **Variables**. Look for `AUTH0_MANAGEMENT_CLIENT_ID` and `AUTH0_MANAGEMENT_CLIENT_SECRET`.
   - You should see: neither name anywhere in the list, and no staged-changes banner waiting to be deployed.
   - If either name is there, or a banner is waiting: **stop. Do not press Delete account.** Tell Claude in words.
2. **Delete the stray account.** On the preview site, sign in with the stray login, and use the app's own Delete account button (the Danger Zone card on your profile page).
   - You should see: the app signs you out and shows its goodbye page. An email arrives at that login's address saying "Your Nextgamenight account has been deleted". That email is about the staging copy only. Your account on the live site has not been touched.
   - If the app refuses because that account owns a group other people are in, stop and tell Claude in words.
3. **Seed again** (section 6). If lock 4 still refuses, tell Claude in words, with the count.

What to expect afterwards, all of it on staging only:

- **That login cannot be used on staging again.** Staging keeps a note that the login was deleted, and anyone signing in with it on the preview site is told the account was deleted. Seeding again does not clear the note. It still works on the live site as before.
- **Staging keeps trying to finish the Auth0 step and keeps failing, for good.** It tries about ten times over the first 17 hours and then once every half hour, and each try leaves an error line in staging's log about the Auth0 Management API. That is expected. Do not report it as a bug, and do not add the two variables back to make it stop.

**Never use Delete account while signed in as one of the test logins from step (g).** The same note would shut that test login out of staging for good, and staging would then remove that seed user again within half an hour of every seed. If that has already happened, tell Claude in words. Nothing in the app can undo it.

If you want to try the Delete account feature itself on staging, tell Claude first. It needs a design that does not exist yet.

## 8. The proof list

1. Signed in on the preview site as one of the test logins, you see the seeded groups (Weekend Warriors and the others).
2. A change you make there does not reach production. The test logins have no account on the live site, so there is nothing to look at there, and you must not sign in on the live site as one of them to look. Do this instead: run the count from step (b); straight away, on the preview site, create a new group; then run the count again at once. Production's Groups and UserGroups are the same both times. If the change had reached production, each would be exactly one higher.
3. The production counts from steps (b) and (j) match, or moved only slightly for the ordinary reasons step (j) gives. Users is not 7.
4. An email arrives at one of your plus-addresses (reminders are sent for the seeded upcoming game nights). This needs the background jobs switched on, the last part of step (f).
5. Texts: signed in as the SMS user, add your phone number in the app. A verification text arrives. Enter the code and turn on one text notification. No other seed user can receive notification texts.
6. Connect Google Calendar fails on staging with a Google error. That is expected (section 4, owner decision C1).

## 9. Never

- Never add `ALLOW_STAGING_SEED` to production.
- Never add `DISABLE_BACKGROUND_JOBS` to production. It stops the live site's reminders, its sweeps and the alarm that reports silent jobs.
- Never run the seed with `-e production`.
- Never point staging's database or Redis variables at production, and never leave a pasted address in them.
- Never run `railway config plan` or `railway config apply` without `--environment production` (see `docs/railway-deploy-settings.md`).
- Never add the seed to a pre-deploy command, on staging or anywhere. It would wipe staging on every deploy.
- Never paste command output into the Claude session, and never run the commands in section 6 there (see the top of this file).
- Never try to get around a refused lock. A refusal is the guard working.
- Never add `AUTH0_MANAGEMENT_CLIENT_ID` or `AUTH0_MANAGEMENT_CLIENT_SECRET` back to the staging backend service. Every Delete account ever pressed on staging leaves a deletion that staging keeps retrying every half hour and never gives up on. Add the two variables back and, within about half an hour, every one of those logins is deleted for real in Auth0, including any login you also use on the live site.
- Never use Delete account on staging while either of those two variables exists there. It would delete the login in the Auth0 tenant the live site uses.
- Never use Delete account on staging while signed in as one of the test logins from step (g).

## 10. Cost

- Railway's Hobby plan is $5 a month and includes $5 of usage.
- A second backend, Postgres and Redis were estimated at roughly $5 a month more. That estimate was made by an agent from Railway's published prices, not by Railway.
- Your real usage is on Railway's **Usage** page.
- Railway's Serverless setting is unlikely to put a backend to sleep while it holds database connections, so do not count on it to lower the bill.
