# tests/migrations — migration verification harness

Phase 87.1 (BINT-02, Part B) introduced this directory. It proves that the UUID
re-key **EXPAND** migrations (`migrations/20260703000001..07`) do what their prod
run must do: backfill the new `*_uuid` FK columns, apply the correct per-table
orphan disposition, and stay idempotent on re-run.

## Why a harness (and why it looks unusual)

The test DB is built **once** by `tests/globalSetup.js` via `sync({ force: true })`
from the **models** — and the models already declare the `*_uuid` columns + FKs.
So running a migration `up` against the sync-built DB would find everything present
and backfill nothing.

To exercise a real migration, each scenario first calls the migration's own
**`down(queryInterface)`**, which `DROP COLUMN`s the `*_uuid` column. Postgres
auto-drops the sync-built FK and uuid indexes that depend on that column, returning
the table to its **true pre-migration shape**: old Auth0-string column(s) present,
no `*_uuid` column. Rows are then seeded with **raw INSERT** on the old string
columns (the Sequelize model can't be used — it would emit the now-absent `*_uuid`
column). Parent rows (Users/Groups/Events/Games/BallotOptions) are created via
models, since their schema is untouched. Finally `up` runs and the assertions check
the real backfill + orphan logic. Running `up` twice restores the baseline for any
later test file.

## What each scenario asserts

| Table | Disposition | Assertions |
|-------|-------------|------------|
| UserGroups | CASCADE (D-01) | matched `user_uuid` backfilled; orphan DELETEd; logged count == 1; 2nd `up` deletes 0 |
| EventRsvps | CASCADE (D-02) | same shape as above |
| EventBrings | CASCADE (D-02) | same shape as above |
| EventBallotVotes | CASCADE (D-02) | same shape as above |
| SentNotifications | CASCADE (D-03) | same shape (table is `timestamps:false`) |
| GroupInvites | SET NULL (D-04) | matched backfilled; orphan `invited_by_uuid` NULL and **row kept**; idempotent |
| Friendships | CASCADE both endpoints (D-05) | both uuids backfilled; a row with EITHER endpoint unmatched is DELETEd; idempotent |

Idempotency is proven by running `up` a second time and asserting it throws nothing,
leaves matched rows unchanged, and deletes nothing new (the guarded add-column +
`pg_constraint` checks skip on the second pass).

## Running

CI Postgres is the **authoritative** gate — the local sandbox DB is unreachable
(DB suites time out in `beforeAll` on `sequelize.authenticate()`). Run this file
**alone** (it mutates schema, so it must not race other suites):

```bash
npm test -- tests/migrations/rekey.test.js --forceExit --testTimeout=25000
```

## Convention for future migration tests

- One `describe` per table/migration; one self-contained `it` per scenario
  (`tests/setup.js` truncates in `beforeEach`, so never split seed/assert across tests).
- Establish pre-migration state with the migration's own `down`.
- Seed pre-migration rows with raw INSERT; create parent rows with models.
- Capture `console.log` to assert on the migration's own counts.
