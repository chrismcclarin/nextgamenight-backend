'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.4 Plan 01 (SPEC R1, CONTEXT D-01 + D-02) — the PRE-CHAIN BASELINE.
//
// WHY THIS FILE EXISTS
// --------------------
// Until this migration, `npx sequelize-cli db:migrate` against a genuinely EMPTY
// database FAILED on the very first migration: `20260107-create-user-availability.js`
// declares `references: { model: 'Users', key: 'user_id' }`, and `Users` did not exist
// yet. It did not exist because the 8 original tables were never created by a migration
// at all — they were created by `sequelize.sync()` in the pre-migration era (everything
// before 2026-01-07). The migration chain therefore started mid-story, assuming a schema
// that only a sync() had ever produced. That made "replay the chain from empty" — the
// precondition for any schema-drift gate (Plans 02-10) — impossible.
//
// This file closes that gap by creating the sync-era schema as migration #1, so the chain
// is self-contained from `CREATE DATABASE` onward.
//
// HOW THE SQL BELOW WAS DERIVED (mechanically — do not hand-edit it)
// -----------------------------------------------------------------
// It is NOT hand-written. It is a stripped `pg_dump` of `sequelize.sync()` run against
// the models tree as it stood at `a8570366^` (= `a1833fe91adfd08012c0f88c81edfa91ca32b197`,
// the commit immediately BEFORE the first migration was added). That tree's
// `models/index.js` requires exactly 8 models — User, Group, Game, Event,
// EventParticipation, UserGroup, GameReview, UserGame — so sync() built exactly 8 tables.
// `BoardGame.js` sits in that directory but is NOT required by `index.js`; it was orphaned
// then and is still orphaned today, so it is deliberately absent here.
//
// Reproducing the capture (this comment IS the reproducibility record — RESEARCH Open
// Question 5; there is deliberately no committed `baseline.sql` artifact to drift):
//
//   git archive 'a8570366^' Sonnet/models Sonnet/config/database.js \
//     | tar -x -C /tmp/baseline-capture --strip-components=1
//   # sync it into a scratch DB with the HISTORICAL config (DB_*-var-only; NODE_ENV must
//   # NOT be 'test' — that config swaps to TEST_DB_NAME), then:
//   pg_dump --schema-only --no-owner --no-privileges --no-comments \
//           --no-tablespaces --quote-all-identifiers \
//           "postgres://postgres:password@localhost:5432/baseline_capture" \
//           > baseline-raw.sql
//
// The capture ran in CI on the throwaway `baseline-capture.yml` workflow (scratch branch
// `chore/88.4-baseline-capture`, never merged), against `postgres:16` with a `pg_dump` 16
// client, using this repo's own installed Sequelize 6.37.7 (same `^6.35.0` range the
// historical package.json pinned, so the same query generator).
//
// WHAT WAS STRIPPED FROM THE RAW DUMP, AND WHY
// --------------------------------------------
//   * `\restrict <token>` / `\unrestrict <token>` — pg_dump >= 16.10 emits these under the
//     CVE-2025-8714 hardening. They are PSQL META-COMMANDS, not SQL. Left in, they throw
//     `syntax error at or near "\"` on the very first statement inside `sequelize.query()`,
//     which has no meta-command interpreter. `tests/unit/baseline-sql.test.js` asserts
//     ZERO lines match /^\s*\\/m so a future re-capture cannot silently reintroduce them.
//   * The `SET` boilerplate block (statement_timeout, lock_timeout,
//     idle_in_transaction_session_timeout, client_encoding, standard_conforming_strings,
//     check_function_bodies, xmloption, client_min_messages, row_security,
//     default_tablespace, default_table_access_method) — session knobs for a psql restore,
//     irrelevant (and in a migration, actively rude) inside the app's own connection.
//   * `SELECT pg_catalog.set_config('search_path', '', false);` — pg_dump blanks search_path
//     and schema-qualifies everything. Every identifier below is already `"public"."X"`, so
//     the statement is redundant; and blanking search_path on a pooled app connection would
//     leak into whatever ran next on it.
//   * All `--` comment lines / `-- Name: ... Type: ...` banners, and runs of blank lines.
//
// Everything else is VERBATIM: every CREATE TYPE, CREATE TABLE, ALTER TABLE ... ADD
// CONSTRAINT and CREATE [UNIQUE] INDEX, with all quoted identifiers intact. Counts are
// pinned by the unit test: 2 enums, 8 tables, 28 constraints, 12 indexes.
//
// Object NAMES are reproduced faithfully (`users_user_id`, `user_groups_user_id_group_id`,
// `enum_UserGroups_role`, `Users_user_id_key`, ...) for SCHEMA-EQUIVALENCE reasons: Plans
// 04/05 diff this chain's end state against today's `sync()` output, and a renamed index
// would read as drift. (CONTEXT D-01 additionally claimed the names were needed because
// "later migrations assume them", citing the Phase 75-01 `user_availabilities_user_id
// already exists` collision — that reading is WRONG and RESEARCH corrected it: that
// collision was a migration colliding with a sync-created index on a sync-built LOCAL db,
// which cannot happen on an empty one. All 40 `DROP INDEX` statements in migrations/ carry
// `IF EXISTS` and `removeIndex(` has zero hits.)
//
// PROD SEMANTICS — READ THIS BEFORE TOUCHING up()
// -----------------------------------------------
// `railway.json`'s `preDeployCommand` is
// `node scripts/log-db-resolution.js && npm run migrate:apply`, so this file executes
// against the LIVE PRODUCTION DATABASE on the first deploy after it merges — and on every
// deploy after that until it is booked in `SequelizeMeta`. Prod already has all 8 tables
// (plus ~70 migrations of evolution on top). Running the DDL below there would fail at
// best and destroy at worst. The existence guard is therefore not a convenience: it is the
// only thing standing between this file and prod. On prod it MUST take the no-op branch,
// log, and book the filename.
//
// The guard probes `describeTable('Users')` and treats ONLY a missing-relation signal as
// "empty database". Getting that signal right is subtle: Sequelize 6 on Postgres does NOT
// raise SQLSTATE 42P01 for a missing table here — the underlying `information_schema` query
// SUCCEEDS with zero rows, and query-interface.js then throws a plain `Error` whose message
// begins `No description found for` (node_modules/sequelize/lib/dialects/abstract/
// query-interface.js:165-176, verified against the installed 6.37.7). So the empty-DB test
// is that message OR `err.original?.code === '42P01'` (belt-and-braces: a raw-query variant
// of the probe WOULD raise 42P01, and pinning only one of the two is exactly how this guard
// would silently invert). ANY other error — permissions, search_path, connection —
// RETHROWS and fails the deploy, which is the safe direction.
//
// TRANSACTIONALITY — why this file has no `sequelize.transaction()` and every other recent
// migration does
// ------------------------------------------------------------------------------------
// The whole schema goes out in ONE parameterless `sequelize.query(BASELINE_SQL)` call.
// node-postgres uses the SIMPLE query protocol for a parameterless query, which accepts
// multiple semicolon-separated statements and runs them as ONE implicit transaction — so a
// failure on statement 40 rolls back statements 1-39 and leaves no half-built schema. That
// implicit transaction IS the atomicity mechanism here. Do NOT "improve" this by splitting
// the SQL on `;` into separate queries: that is a mini SQL parser (it would have to
// understand quoted identifiers, dollar-quoting and string literals), which is precisely
// what CONTEXT D-03 rejected, and it would also give up the single-transaction property.
//
// DECISION MARKERS
// ----------------
// DECISION Phase 88.4 D-02: runtime existence guard on describeTable('Users') OVER manually
// pre-seeding `SequelizeMeta` with this filename on prod (the Phase 74-02 Branch-B
// precedent) — the seed's failure mode is a human forgetting an ordering-sensitive manual
// prod step, which blocks the deploy (or worse, runs the DDL against prod); this guard's
// failure mode is a code path, so CI can test it and Plan 05 does. Not a cleanup target:
// deleting the guard points the DDL below straight at prod.
//
// DECISION Phase 88.4 G-01: rethrow-on-unexpected-error OVER the house analog's bare
// `describeTable(...).catch(() => null)` (migrations/20260228000001-create-group-invites-
// table.js:10) — that idiom swallows EVERY error, so a permissions or search_path failure
// against prod reads as "table absent" and falls through to `CREATE TABLE "Users"`. This is
// a DELIBERATE divergence from the surrounding convention, not an inconsistency to converge.
//
// DECISION Phase 88.4 D-04: irreversible no-op `down()` OVER a real `down()` that drops the
// 8 tables — a `down()` able to DROP `Users`/`Groups`/`Events` is a loaded gun pointed at
// prod for zero benefit: nothing in CI or prod ever runs it (the replay gate only ever
// migrates UP from empty). This file must never contain a table-drop statement — the unit
// test greps for one and fails if it appears (which is also why this comment does not spell
// the two-word token out: the grep would match its own documentation).

// The captured pre-chain schema. Exported (as an extra key sequelize-cli ignores) so
// tests/unit/baseline-sql.test.js can assert on it with no database.
const BASELINE_SQL = `
CREATE TYPE "public"."enum_Events_status" AS ENUM (
    'scheduled',
    'in_progress',
    'completed',
    'cancelled'
);

CREATE TYPE "public"."enum_UserGroups_role" AS ENUM (
    'member',
    'admin',
    'owner'
);

CREATE TABLE "public"."EventParticipations" (
    "id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "score" numeric(10,2),
    "faction" character varying(255),
    "is_new_player" boolean DEFAULT false,
    "placement" integer,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."Events" (
    "id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "game_id" "uuid" NOT NULL,
    "start_date" timestamp with time zone NOT NULL,
    "duration_minutes" integer,
    "winner_id" "uuid",
    "picked_by_id" "uuid",
    "winner_name" character varying(255),
    "picked_by_name" character varying(255),
    "custom_participants" "jsonb" DEFAULT '[]'::"jsonb",
    "is_group_win" boolean DEFAULT false,
    "comments" "text",
    "status" "public"."enum_Events_status" DEFAULT 'completed'::"public"."enum_Events_status",
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."GameReviews" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "game_id" "uuid" NOT NULL,
    "rating" numeric(3,1),
    "review_text" "text",
    "is_recommended" boolean,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."Games" (
    "id" "uuid" NOT NULL,
    "bgg_id" integer,
    "name" character varying(255) NOT NULL,
    "year_published" integer,
    "min_players" integer,
    "max_players" integer,
    "playing_time" integer,
    "description" "text",
    "image_url" character varying(255),
    "thumbnail_url" character varying(255),
    "is_custom" boolean DEFAULT false,
    "theme" character varying(255),
    "url" character varying(255),
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."Groups" (
    "id" "uuid" NOT NULL,
    "name" character varying(255) NOT NULL,
    "group_id" character varying(255) NOT NULL,
    "profile_picture_url" character varying(255),
    "background_color" character varying(255) DEFAULT '#ffffff'::character varying,
    "background_image_url" character varying(255),
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."UserGames" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "game_id" "uuid" NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."UserGroups" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "group_id" "uuid" NOT NULL,
    "role" "public"."enum_UserGroups_role" DEFAULT 'member'::"public"."enum_UserGroups_role",
    "joined_at" timestamp with time zone,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

CREATE TABLE "public"."Users" (
    "id" "uuid" NOT NULL,
    "username" character varying(255) NOT NULL,
    "email" character varying(255) NOT NULL,
    "user_id" character varying(255) NOT NULL,
    "google_calendar_token" "text",
    "google_calendar_refresh_token" "text",
    "google_calendar_enabled" boolean DEFAULT false,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);

ALTER TABLE ONLY "public"."EventParticipations"
    ADD CONSTRAINT "EventParticipations_event_id_user_id_key" UNIQUE ("event_id", "user_id");

ALTER TABLE ONLY "public"."EventParticipations"
    ADD CONSTRAINT "EventParticipations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."Events"
    ADD CONSTRAINT "Events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."GameReviews"
    ADD CONSTRAINT "GameReviews_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."Games"
    ADD CONSTRAINT "Games_bgg_id_key" UNIQUE ("bgg_id");

ALTER TABLE ONLY "public"."Games"
    ADD CONSTRAINT "Games_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."Groups"
    ADD CONSTRAINT "Groups_group_id_key" UNIQUE ("group_id");

ALTER TABLE ONLY "public"."Groups"
    ADD CONSTRAINT "Groups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."UserGames"
    ADD CONSTRAINT "UserGames_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."UserGames"
    ADD CONSTRAINT "UserGames_user_id_game_id_key" UNIQUE ("user_id", "game_id");

ALTER TABLE ONLY "public"."UserGroups"
    ADD CONSTRAINT "UserGroups_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."UserGroups"
    ADD CONSTRAINT "UserGroups_user_id_group_id_key" UNIQUE ("user_id", "group_id");

ALTER TABLE ONLY "public"."Users"
    ADD CONSTRAINT "Users_email_key" UNIQUE ("email");

ALTER TABLE ONLY "public"."Users"
    ADD CONSTRAINT "Users_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."Users"
    ADD CONSTRAINT "Users_user_id_key" UNIQUE ("user_id");

CREATE INDEX "event_participations_event_id" ON "public"."EventParticipations" USING "btree" ("event_id");

CREATE UNIQUE INDEX "event_participations_event_id_user_id" ON "public"."EventParticipations" USING "btree" ("event_id", "user_id");

CREATE INDEX "events_group_id" ON "public"."Events" USING "btree" ("group_id");

CREATE INDEX "events_group_id_start_date" ON "public"."Events" USING "btree" ("group_id", "start_date");

CREATE UNIQUE INDEX "game_reviews_user_id_group_id_game_id" ON "public"."GameReviews" USING "btree" ("user_id", "group_id", "game_id");

CREATE INDEX "games_name" ON "public"."Games" USING "btree" ("name");

CREATE INDEX "groups_group_id" ON "public"."Groups" USING "btree" ("group_id");

CREATE INDEX "user_games_user_id" ON "public"."UserGames" USING "btree" ("user_id");

CREATE UNIQUE INDEX "user_games_user_id_game_id" ON "public"."UserGames" USING "btree" ("user_id", "game_id");

CREATE INDEX "user_groups_user_id" ON "public"."UserGroups" USING "btree" ("user_id");

CREATE UNIQUE INDEX "user_groups_user_id_group_id" ON "public"."UserGroups" USING "btree" ("user_id", "group_id");

CREATE INDEX "users_user_id" ON "public"."Users" USING "btree" ("user_id");

ALTER TABLE ONLY "public"."EventParticipations"
    ADD CONSTRAINT "EventParticipations_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."Events"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."EventParticipations"
    ADD CONSTRAINT "EventParticipations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."Users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."Events"
    ADD CONSTRAINT "Events_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."Games"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."Events"
    ADD CONSTRAINT "Events_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."Groups"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."Events"
    ADD CONSTRAINT "Events_picked_by_id_fkey" FOREIGN KEY ("picked_by_id") REFERENCES "public"."Users"("id") ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY "public"."Events"
    ADD CONSTRAINT "Events_winner_id_fkey" FOREIGN KEY ("winner_id") REFERENCES "public"."Users"("id") ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY "public"."GameReviews"
    ADD CONSTRAINT "GameReviews_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."Games"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."GameReviews"
    ADD CONSTRAINT "GameReviews_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."Groups"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."GameReviews"
    ADD CONSTRAINT "GameReviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."Users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."UserGames"
    ADD CONSTRAINT "UserGames_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."Games"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."UserGames"
    ADD CONSTRAINT "UserGames_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."Users"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."UserGroups"
    ADD CONSTRAINT "UserGroups_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "public"."Groups"("id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY "public"."UserGroups"
    ADD CONSTRAINT "UserGroups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."Users"("id") ON UPDATE CASCADE ON DELETE CASCADE;
`;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    // --- existence guard (see PROD SEMANTICS above) --------------------------------
    let usersExists = false;
    try {
      await queryInterface.describeTable('Users');
      usersExists = true;
    } catch (err) {
      const missingRelation =
        (typeof err.message === 'string' && err.message.startsWith('No description found for')) ||
        (err.original && err.original.code === '42P01') ||
        (err.parent && err.parent.code === '42P01');
      // Anything that is NOT the missing-relation signal (permissions, search_path,
      // connection) must fail the deploy rather than fall through to CREATE TABLE.
      if (!missingRelation) throw err;
    }

    if (usersExists) {
      console.log(
        '[88.4-baseline] "Users" already present — pre-chain schema exists; no-op, booking filename only.'
      );
      return;
    }

    console.log(
      '[88.4-baseline] empty database — building the 2026-01-07 pre-migration schema (8 tables).'
    );
    // ONE call, on purpose — the simple-query protocol's implicit transaction is this
    // migration's atomicity. Do not split on ';'.
    await sequelize.query(BASELINE_SQL);
    console.log('[88.4-baseline] pre-chain schema created (2 enums, 8 tables, 28 constraints, 12 indexes).');
  },

  async down() {
    // Deliberately irreversible — see DECISION Phase 88.4 D-04. Dropping the 8 core
    // tables is never the right move, and nothing runs this.
    console.log(
      '[88.4-baseline] down() is a documented no-op: the pre-chain baseline is irreversible by design (it would DROP "Users"/"Groups"/"Events"). Nothing dropped.'
    );
  },
};

module.exports.BASELINE_SQL = BASELINE_SQL;
