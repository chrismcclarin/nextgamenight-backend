// scripts/e2e-fixtures.js
// Mints the identifiers/tokens the FE Playwright journeys read from env.
// Run AFTER seed-sample-data.js (needs Alice + Weekend Warriors to exist).
//
// Emits ONE machine-readable line to stdout:
//   E2E_FIXTURES_JSON={"group_id":"...","availability_token":"...","rsvp_path":"...",...}
// (Sequelize query logging also writes to stdout — consumers must grep the marker.)
//
// Emitted keys — this list MUST enumerate every key in the emit object literal at
// the bottom of this file, no more and no fewer (round-3 ML#22: this header is
// documentation, not a contract the code enforces, and it HAD silently drifted):
// - group_id                 → E2E_GROUP_ID (create-event journey's planning surface)
// - availability_token       → E2E_AVAILABILITY_TOKEN (magic JWT for /availability-form/[token])
// - rsvp_path                → E2E_RSVP_PATH (/rsvp/<hmac>?e=&u=&s=yes for a FUTURE event —
//                              routes/rsvp.js rejects past events, and every seeded event is past)
// - invite_group_name        → group Alice owns, the invite journey's target group
// - invite_friend_name       → accepted friend NOT in that group (desktop journeys target)
// - invite_friend_name_phone → second accepted friend, --project=phone target (D-07)
// - rsvp_path_phone          → second future event's RSVP link, --project=phone target (D-07)
// - restore_path             → /restore/group/<nonce> for the restore-preview spec (R7)
// - event_detail_path        → /gameDetail?event_id=&group_id= for the touch-target
//                              add-friend specs (R4/D-13) — the RsvpSection surface;
//                              rows below make Diana (not-yet-friend) + Bob (friend)
//                              render there
// - coloured_group_id        → E2E_COLOURED_GROUP_ID (Phase 88.3 Req 9(ii), the
//                              light-mode contrast probe — it needs a group that
//                              actually carries a preset colour, because every other
//                              fixture group is left at the models/Group.js '#ffffff'
//                              default and the frontend treats that as UNSET)
//
// Requires MAGIC_TOKEN_SECRET in env (same value the booted server uses, or
// token validation will fail server-side).

const crypto = require('crypto');
const { Op } = require('sequelize');
const { User, Group, UserGroup, Friendship, SingleUseToken, Event, EventRsvp, AvailabilityPrompt, GroupInvite, UserAvailability, sequelize } = require('../models');
const { generateToken } = require('../services/magicTokenService');
const { assertNotProductionDb } = require('./lib/assert-not-production-db');

/**
 * Assert an ACCEPTED friendship for a pair, direction-agnostic.
 *
 * A directional findOrCreate is NOT idempotent against this table: the unique
 * index is symmetric — (LEAST(requester,addressee), GREATEST(...)) — so a row
 * seeded in the OPPOSITE direction is invisible to the directional find, the
 * insert then 23505s, and Sequelize's directional re-find misses too. That is
 * exactly how BE 88-34's seed (Charlie -> Alice PENDING, `4ff570f`) broke the
 * FE e2e fixture mint on 2026-08-21. Fixtures OWN their invariants (same rule
 * as the UserGroup/GroupInvite teardowns below), so an existing row in either
 * direction is normalized to 'accepted' rather than trusted.
 */
async function assertAcceptedFriendship(aId, bId) {
  const existing = await Friendship.findOne({
    where: {
      [Op.or]: [
        { requester_uuid: aId, addressee_uuid: bId },
        { requester_uuid: bId, addressee_uuid: aId },
      ],
    },
  });
  if (existing) {
    if (existing.status !== 'accepted') await existing.update({ status: 'accepted' });
    return;
  }
  await Friendship.create({ requester_uuid: aId, addressee_uuid: bId, status: 'accepted' });
}

// RSVP single-use link lifetime — mirrors routes/rsvp.js RSVP_TOKEN_TTL_MS (30d).
const RSVP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Group-restore fixture lifetimes — mirror services/groupRecoveryService.js:
// RECOVERY_WINDOW_DAYS = 30 (:119) stamps purge_after, and the token's expires_at
// deliberately outlives purge_after by a 2-day margin (:122-135) so the window
// check, not token expiry, is what a near-deadline preview reports.
const RESTORE_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RESTORE_TOKEN_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

// Mirrors routes/rsvp.js generateRsvpToken EXACTLY (same payload + HMAC).
// Inlined rather than required: pulling in the route module drags rate
// limiters / services whose timers keep the event loop alive forever —
// the script printed its output but never exited (hung CI run 27309008729).
function generateRsvpToken(eventId, userId, status) {
  const payload = `${eventId}:${userId}:${status}`;
  return crypto
    .createHmac('sha256', process.env.MAGIC_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
}

async function main() {
  // FIRST statement, deliberately — not merely before the first destroy at `:182`. main()
  // does an `alice.update` and an `Event.create` well before that, and a guard that lets a
  // write through is not a guard. Shared helper, never a second copy: it resolves the host in
  // config/database.js's env-var order, so it checks the database these statements actually
  // hit. Local dev passes silently, CI's localhost service container passes, any remote target
  // throws before a row moves (override only via an explicit ALLOW_DESTRUCTIVE_SEED=1).
  assertNotProductionDb(sequelize);

  const alice = await User.findOne({ where: { username: 'Alice' } });
  const group = await Group.findOne({ where: { name: 'Weekend Warriors' } });
  if (!alice || !group) {
    throw new Error('Seed data missing (Alice / Weekend Warriors) — run seed-sample-data.js first');
  }

  // Mark the E2E login identity tutorial-complete — TutorialProvider shows a
  // click-blocking overlay whenever tutorial_version < CURRENT_TUTORIAL_VERSION,
  // which swallowed every journey click on '/' (run 27317492586 screenshot).
  await alice.update({ tutorial_version: 999 });

  // Future event so the RSVP respond endpoint accepts it.
  const event = await Event.create({
    group_id: group.id,
    start_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    duration_minutes: 120,
    status: 'scheduled',
    comments: 'E2E fixture event (created by scripts/e2e-fixtures.js)',
  });

  // Active prompt for the availability magic link — CI-only token minting (DEC-4,
  // owner-ruled 2026-08-02): this prompt exists SOLELY so generateToken(alice, prompt)
  // below has something to mint against for the availability-submit journey. It
  // carries NO response data — R8's populated heatmap lives entirely in
  // scripts/seed-sample-data.js. Idempotent on re-run: findOrCreate on a stable
  // business key (group + fixed literal week identifier, distinct from any real ISO
  // week and from anything the R8 seed uses), then an explicit reactivating update so
  // a re-run refreshes status/deadline/prompt_date instead of accumulating one row
  // per run (the old `e2e-fixture-${Date.now()}` key was unique per run).
  // AvailabilityPrompt is not paranoid, so findOrCreate is safe here (a paranoid
  // model's findOrCreate would miss soft-deleted rows and collide on re-create).
  const [prompt] = await AvailabilityPrompt.findOrCreate({
    where: { group_id: group.id, week_identifier: 'e2e-ci-magic-link' },
    defaults: {
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: 'e2e-ci-magic-link',
    },
  });
  await prompt.update({
    status: 'active',
    deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
    prompt_date: new Date(),
  });

  const availability = await generateToken(alice, prompt);
  const availabilityToken = typeof availability === 'string' ? availability : availability.token;

  const rsvpToken = generateRsvpToken(event.id, alice.user_id, 'yes');
  const rsvpPath = `/rsvp/${rsvpToken}?e=${event.id}&u=${encodeURIComponent(alice.user_id)}&s=yes`;

  // 83-04 single-use gate: GET /rsvp/respond consumes a pre-existing active
  // SingleUseToken row by nonce. Mint the three-row batch (yes/maybe/no) exactly
  // as routes/rsvp.js mintRsvpBatch does, so the journey's ?s=yes link is
  // consumable once (the e2e DB is freshly seeded per CI run). Without this the
  // RSVP journey lands on the ERROR state and never renders "You're in!".
  const rsvpBatchId = crypto.randomUUID();
  const rsvpExpiresAt = new Date(Date.now() + RSVP_TOKEN_TTL_MS);
  await SingleUseToken.bulkCreate(
    ['yes', 'maybe', 'no'].map((status) => ({
      nonce: generateRsvpToken(event.id, alice.user_id, status),
      user_id: alice.user_id,
      purpose: 'rsvp',
      event_id: event.id,
      email_batch_id: rsvpBatchId,
      rsvp_status: status,
      status: 'active',
      expires_at: rsvpExpiresAt,
      used_at: null,
    })),
    // Idempotent on re-run: the nonce is deterministic + UNIQUE, so UPSERT
    // (reactivate) rather than collide — mirrors routes/rsvp.js mintRsvpBatch.
    { updateOnDuplicate: ['email_batch_id', 'rsvp_status', 'status', 'expires_at', 'used_at', 'updatedAt'] }
  );

  // Touch-target add-friend surface (R4/D-13, plan 87.8-12): gameDetail's
  // RsvpSection renders a member row ONLY per EventRsvp row (RsvpSection.js
  // buckets data.rsvps by status — no RSVP, no row, no add-friend "+"). Seed two:
  // Diana (Weekend Warriors member, NOT Alice's friend — the Friendship rows this
  // script creates below cover Bob and Charlie only) carries the "+" the specs
  // measure, and
  // Bob (already-friend) renders without it, giving the D-13 tap-isolation probe
  // its vertically adjacent row. Keyed user_uuid → Users.id (87.1 rekey).
  // Idempotent on re-run: findOrCreate on the natural (event_id, user_uuid) key.
  const diana = await User.findOne({ where: { username: 'Diana' } });
  const bob = await User.findOne({ where: { username: 'Bob' } });
  if (!diana || !bob) {
    throw new Error('Seed data missing (Diana / Bob) — run seed-sample-data.js first');
  }
  // RE-ASSERT Diana is NOT Alice's friend: her RSVP row's add-friend "+" is the
  // element touch-targets.spec.ts:365/:423 measures ("fixture must seed a
  // not-yet-friend RSVP row"). BE 88-34's seed (`4ff570f`) now creates
  // Alice <-> Diana ACCEPTED for the walk env, which would silently remove the
  // "+" here — so the fixture deletes the pair in either direction, the same
  // fixtures-own-their-invariants rule as the UserGroup teardown below.
  await Friendship.destroy({
    where: {
      [Op.or]: [
        { requester_uuid: alice.id, addressee_uuid: diana.id },
        { requester_uuid: diana.id, addressee_uuid: alice.id },
      ],
    },
    force: true,
  });
  for (const member of [diana, bob]) {
    const [row] = await EventRsvp.findOrCreate({
      where: { event_id: event.id, user_uuid: member.id },
      defaults: { event_id: event.id, user_uuid: member.id, status: 'yes' },
    });
    if (row.status !== 'yes') await row.update({ status: 'yes' });
  }
  // Same URL shape EventCalendar/GroupGamesList build for this surface.
  const eventDetailPath = `/gameDetail?event_id=${event.id}&group_id=${group.id}`;

  // ── Group-availability invariant for the create-event scheduler e2e spec ────
  //
  // WHAT DEPENDS ON IT: `e2e/event-scheduler-touch.spec.ts` asserts
  // UNCONDITIONALLY that the visual scheduler opens scrolled to peak availability
  // (createEvent.js's `peakScrollTime` -> EventScheduler's `scrollToTime`), and
  // its touch cases read availability-annotated gridcells. `peakScrollTime` is
  // null the moment the group has no availability, so a skip-if-absent version of
  // that assertion would be green forever. This block is what lets the spec assert
  // rather than skip — fixtures OWN their invariants here, the same rule the
  // Friendship / UserGroup / GroupInvite teardowns in this file follow.
  //
  // PREMISE CORRECTED 2026-08-22 (plan 88.1-14 verified this against the code, and
  // the plan's own text was wrong): the group heatmap is NOT built from
  // AvailabilityResponse rows. `getGroupHeatmap` -> `calculateGroupOverlaps` ->
  // `calculateUserAvailability` reads members' **UserAvailability** patterns
  // (services/availabilityService.js:351), and scripts/seed-sample-data.js:699-763
  // seeds 16 recurring patterns for Alice/Bob/Charlie/Diana — who are exactly the
  // Weekend Warriors roster (seed-sample-data.js:249-253), i.e. THIS fixture group.
  // So on a normal run the check below finds data and seeds NOTHING; the note above
  // this prompt ("carries NO response data") is still true and still irrelevant to
  // the heatmap.
  //
  // WHY IT EXISTS ANYWAY: the seed's patterns were added for a different purpose
  // (88-34 WI-B4, the check-in prefill), so nothing stops a future edit from
  // dropping them. When that happens the failure must surface HERE, with a message
  // naming the cause, rather than three steps later as an unexplained Playwright
  // red. The fallback seeds a DAY-VARYING shape (see the block below); the throw is
  // the backstop if even that fails.
  //
  // Idempotent: fallback rows are keyed on a sentinel `start_date` no other
  // producer uses, and are converged (destroy-then-create) rather than accumulated.
  const FIXTURE_AVAILABILITY_START = '2020-01-01';
  const fixtureRoster = await UserGroup.findAll({
    where: { group_id: group.id },
    attributes: ['user_uuid'],
  });
  const fixtureRosterUuids = fixtureRoster.map((r) => r.user_uuid);
  if (fixtureRosterUuids.length === 0) {
    throw new Error('Fixture group has no members — the create-event heatmap would be empty (run seed-sample-data.js first)');
  }
  const rosterAvailabilityCount = await UserAvailability.count({
    where: { user_uuid: { [Op.in]: fixtureRosterUuids } },
  });
  if (rosterAvailabilityCount === 0) {
    /* DECISION Phase 88.1-20 (WR-04): the fallback's peaks now VARY BY WEEKDAY, and the
       comment that used to sit here has been CORRECTED rather than extended. It claimed this
       fallback was what kept CI green; that claim was FALSE. The old block seeded one identical
       pattern for all seven days, and a day-invariant fixture is precisely what plan 18's
       non-vacuity guard rejects (`periodictabletop/e2e/event-scheduler-touch.spec.ts`, "the
       seeded availability is DAY-INVARIANT ... Fix the FIXTURE, never this assertion" — it
       names THIS block by path). So the fallback firing would have turned the Req 13 case red
       while blaming the fixture. Day-invariance is not an option here; that is the whole point.

       The shape MIRRORS seed-sample-data.js's per-user weekday distribution, which is what the
       guard's own failure message points at as the correct shape. THE TIMEZONE IS NOT MIRRORED,
       deliberately: seed-sample-data uses America/Los_Angeles, but these fixture users have no
       profile timezone, so availabilityService.js:518 interprets a pattern in UTC and UTC hours
       are what the grid shows. Copying the seed's timezone across would shift every hour and
       break the evening-peak premise.

       Resulting peaks — THREE distinct hours across the week, comfortably above the guard's
       >= 2 threshold, and all well down the 10:00-23:59 grid so "the column did not open at the
       top" stays a real assertion:
         Tue / Thu  -> 19:00 (Alice + Diana, two members)
         Mon/Wed/Fri -> 13:00 (a one-member tie, resolved to the earliest maximal hour)
         Sat / Sun  -> 18:00 (Alice alone)
       Flattening these back to one pattern per user re-breaks the guard; it is a decision. */
    const fallback = [
      { user: alice, startTime: '18:00', endTime: '22:00', days: [0, 1, 2, 3, 4, 5, 6] },
      { user: bob, startTime: '13:00', endTime: '17:00', days: [1, 2, 3, 4, 5] },
      { user: diana, startTime: '19:00', endTime: '21:00', days: [2, 4] },
    ];
    // alice, bob and diana are all resolved above (`:85`, `:172`, `:171`) and the lookups there
    // already throw on a miss for diana/bob — re-assert for alice so a null `user.id` can never
    // reach UserAvailability.create as a silent null FK.
    for (const { user } of fallback) {
      if (!user || !user.id) {
        throw new Error('Fallback availability seed: expected Alice, Bob and Diana to exist — run seed-sample-data.js first');
      }
    }
    // Covers all THREE users now (it covered only the two in the old `fallback`), so a re-run
    // converges instead of accumulating.
    await UserAvailability.destroy({
      where: { user_uuid: { [Op.in]: fallback.map((f) => f.user.id) }, start_date: FIXTURE_AVAILABILITY_START },
      force: true,
    });
    for (const { user, startTime, endTime, days } of fallback) {
      for (const dayOfWeek of days) {
        await UserAvailability.create({
          user_uuid: user.id, // Phase 87.5 UUID re-key: Users.id, never the Auth0 sub.
          type: 'recurring_pattern',
          pattern_data: { dayOfWeek, startTime, endTime, timezone: 'UTC' },
          start_date: FIXTURE_AVAILABILITY_START,
          end_date: null,
          is_available: null,
          timezone: 'UTC',
        });
      }
    }
    console.log('   ↳ fixture group had no availability data — seeded the fallback day-varying patterns (peaks: Tue/Thu 19:00, Mon/Wed/Fri 13:00, Sat/Sun 18:00)');
  }
  const finalAvailabilityCount = await UserAvailability.count({
    where: { user_uuid: { [Op.in]: fixtureRosterUuids } },
  });
  if (finalAvailabilityCount === 0) {
    throw new Error(
      'Fixture group has no availability data after seeding — the create-event scheduler heatmap would be empty and e2e/event-scheduler-touch.spec.ts cannot assert scrollToTime',
    );
  }

  // D-07 (Phase 87.8): arming --project=phone alongside --project=journeys runs
  // every e2e/*.spec.ts twice per CI job, concurrently, and the RSVP journey is
  // single-use — GET /rsvp/respond atomically consumes its token. Do NOT relax
  // the atomic single-use consume in models/SingleUseToken.js to make the second
  // run pass (that atomicity is a security control pinned by
  // tests/routes/singleUseToken.test.js, T-87.8-06); minting a SECOND target is
  // the correct fix. The nonce is an HMAC
  // over (event id, user id, status), so a distinct event id yields distinct
  // nonces automatically. Unlike the desktop event above (whose per-run
  // Event.create behaviour is deliberately unchanged), this one is keyed
  // idempotently on its comments string — findOrCreate costs nothing here, and
  // the reactivating start_date refresh keeps a reused row in the future so
  // routes/rsvp.js never rejects it as past.
  const PHONE_EVENT_COMMENTS = 'E2E fixture event for --project=phone (created by scripts/e2e-fixtures.js)';
  const [eventPhone] = await Event.findOrCreate({
    where: { group_id: group.id, comments: PHONE_EVENT_COMMENTS },
    defaults: {
      group_id: group.id,
      start_date: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
      duration_minutes: 120,
      status: 'scheduled',
      comments: PHONE_EVENT_COMMENTS,
    },
  });
  await eventPhone.update({
    start_date: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000),
    status: 'scheduled',
  });

  const rsvpTokenPhone = generateRsvpToken(eventPhone.id, alice.user_id, 'yes');
  const rsvpPathPhone = `/rsvp/${rsvpTokenPhone}?e=${eventPhone.id}&u=${encodeURIComponent(alice.user_id)}&s=yes`;

  const rsvpBatchIdPhone = crypto.randomUUID();
  await SingleUseToken.bulkCreate(
    ['yes', 'maybe', 'no'].map((status) => ({
      nonce: generateRsvpToken(eventPhone.id, alice.user_id, status),
      user_id: alice.user_id,
      purpose: 'rsvp',
      event_id: eventPhone.id,
      email_batch_id: rsvpBatchIdPhone,
      rsvp_status: status,
      status: 'active',
      expires_at: rsvpExpiresAt,
      used_at: null,
    })),
    // Same deterministic-nonce UPSERT idempotency as the desktop batch above.
    { updateOnDuplicate: ['email_batch_id', 'rsvp_status', 'status', 'expires_at', 'used_at', 'updatedAt'] }
  );

  // Invite-to-group journey fixture: Alice must own a group, and have an accepted
  // friend who is NOT in that group (so the friends-screen checkbox is enabled and
  // the invite has a valid target). Seed data creates no friendships, so build one.
  // group_id is NOT NULL + unique with no default — must be supplied. Key the
  // WHERE on it (kebab-case, like seed-sample-data) so re-runs are idempotent.
  const [inviteGroup] = await Group.findOrCreate({
    where: { group_id: 'e2e-invite-group' },
    defaults: { group_id: 'e2e-invite-group', name: 'E2E Invite Group' },
  });
  // Phase 87.1 (BINT-02, Plan 09 cutover): UserGroup/Friendship are keyed on the
  // Users.id UUID (*_uuid columns); the old Auth0-string columns were removed from the
  // models. This script runs against the FE e2e CI DB, which is sync()-built from the
  // models (no migrations), so it MUST key the UUID columns via the User rows it holds.
  await UserGroup.findOrCreate({
    where: { user_uuid: alice.id, group_id: inviteGroup.id },
    defaults: { user_uuid: alice.id, group_id: inviteGroup.id, role: 'owner', status: 'active' },
  });

  // ── Light-mode contrast fixture (Phase 88.3 Req 9(ii)): a group that actually
  // carries a preset colour. Every other fixture group leaves background_color at
  // models/Group.js's '#ffffff' default, and the frontend's `isUnsetBackgroundColor`
  // (exported from periodictabletop/src/lib/colorUtils.js — cited BY SYMBOL on purpose;
  // CR-07, 88.3-cr 2026-08-27: this said ":106-109", which is the SUBTEXT pole comment,
  // and a cross-repo line number drifts on every edit in the other repo with nothing
  // here to catch it) treats #fff/#ffffff as UNSET —
  // so a Navy-preset probe pointed at any of them would assert against an unset group
  // and pass without ever seeing a tint. Hence the colour is set EXPLICITLY here.
  //
  // DECISION Phase 88.3 (OQ-1): a DEDICATED coloured fixture group, chosen OVER two
  // named alternatives. (1) OVER mutating the shared 'Weekend Warriors' seed group
  // from inside the spec — it is reused by the create-event, padding-budget and
  // touch-target journeys, and a failed restore poisons every later run. (2) OVER
  // narrowing Req 9's acceptance to vitest maths plus the unset group only — that is
  // exactly the "gate that cannot red" failure this codebase has recorded fourteen
  // times (ci.yml:203-215, src/test-utils/sourceScan.ts:41-58).
  // The invariant the frontend depends on: the value stored here is the RAW Navy
  // preset hex #172554 (GroupSettings.js:47-56) — the group's identity colour. The
  // light tint is a RENDERING transform living in
  // periodictabletop/src/lib/colorUtils.js and must NEVER reach this column.
  // Changing this hex, or "tidying" it to a lighter value to match what light mode
  // renders, is a decision, not a cleanup.
  //
  // AMENDED Phase 88.3.1 (plan 02, CONTEXT D-01): the invariant above now reads
  // "a preset ID, with the Navy hex RETAINED through the expand window". This row
  // DUAL-WRITES the preset id AND the legacy Navy hex. It is not a
  // swap, and the hex is not redundant.
  //
  // WHY THE HEX STAYS. This backend change is BE PR-1 and merges FIRST; frontend
  // `main` has never heard of color_preset and still reads background_color only.
  // e2e/contrast.spec.ts:667-673 carries a vacuity guard that REDS if this
  // coloured group's rendered ground equals the unset group's — so swapping the
  // hex out for the preset id would break frontend `main`'s e2e run before the
  // frontend PR even opens (88.3.1-RESEARCH Pitfall 3). Dual-writing means BOTH
  // the pre-cutover frontend (reads the hex) and the post-cutover frontend
  // (reads the preset, which wins) render a colour, at every point in the
  // sequence, with no window.
  //
  // Navy #172554 is also the exact legacy value the remap migration maps to
  // `blue` (UI-SPEC 4.2, deltaE 4.81), so the pair here is self-consistent: the
  // preset id written is the one the migration would have produced.
  //
  // Removing the hex once the frontend cutover has shipped is a DECISION for a
  // follow-up (it retires the pre-cutover half of the guarantee above) — not a
  // cleanup for whoever notices the duplication first.
  //
  // findOrCreate alone is NOT sufficient: `defaults` apply only on INSERT, so a re-run
  // against a database that already holds this row would keep a stale
  // background_color. The explicit update below reconverges every run on the same
  // state — the same idiom the availability-prompt block above uses. Group IS
  // paranoid, but unlike restoreGroup this fixture never soft-deletes its own row, so
  // findOrCreate is the correct shape here, matching e2e-invite-group above.
  const [colouredGroup] = await Group.findOrCreate({
    where: { group_id: 'e2e-coloured-group' },
    defaults: {
      group_id: 'e2e-coloured-group',
      name: 'E2E Coloured Group',
      background_color: '#172554',
      color_preset: 'blue',
    },
  });
  // BOTH here as well as in `defaults`, per the findOrCreate note above: defaults
  // apply only on INSERT, so a re-run against an existing row (one seeded before
  // 88.3.1) would keep color_preset null and never reach the post-cutover path.
  await colouredGroup.update({ background_color: '#172554', color_preset: 'blue' });
  // Alice is the SOLE member, as owner: /groupHomePage?id=... does not render for an
  // authenticated identity that is not a member. Nobody else is added, deliberately —
  // the 87.2 account-deletion gate (accountDeletionService.getDeletionBlockers) treats
  // a group the user OWNS with >= 1 OTHER membership row of ANY status as a hard
  // blocker, so a single-member group can never trip it. That is the same property
  // e2e-invite-group above already relies on.
  await UserGroup.findOrCreate({
    where: { user_uuid: alice.id, group_id: colouredGroup.id },
    defaults: { user_uuid: alice.id, group_id: colouredGroup.id, role: 'owner', status: 'active' },
  });

  // Pick a seeded friend (Bob) who is NOT a member of the invite group.
  const friend = await User.findOne({ where: { username: 'Bob' } });
  if (!friend) {
    throw new Error('Seed data missing (Bob) — run seed-sample-data.js first');
  }
  // The invite resolves the friend's email server-side (User.scope withContactInfo);
  // guarantee Bob has one so /invites/send does not 404 on a null email.
  if (!friend.email) {
    await friend.update({ email: 'e2e-invite-friend@example.com' });
  }
  // Accepted, bidirectional friendship Alice <-> Bob (direction-agnostic upsert
  // — see assertAcceptedFriendship for why findOrCreate cannot be trusted here).
  await assertAcceptedFriendship(alice.id, friend.id);
  // Make sure Bob is NOT in the invite group (so the friend checkbox stays enabled).
  // F-02: hard delete — a soft-deleted membership row still occupies the roster from
  // the fixture's point of view on the next run, so the teardown must really remove it.
  await UserGroup.destroy({ where: { user_uuid: friend.id, group_id: inviteGroup.id }, force: true });

  // D-07 (Phase 87.8): second, per-project invite target. The invite journey is
  // also non-re-entrant — routes/invites.js 409s while a pending invite exists for
  // the same email+group — so running --project=phone concurrently with
  // --project=journeys needs a DISTINCT friend to invite. Desktop keeps Bob;
  // phone gets Charlie, a seeded user who is likewise not a member of the invite
  // group. Same Friendship.findOrCreate shape, same null-email backfill guard,
  // same hard-delete UserGroup teardown as Bob above, so Charlie's friends-screen
  // checkbox also stays enabled.
  const friendPhone = await User.findOne({ where: { username: 'Charlie' } });
  if (!friendPhone) {
    throw new Error('Seed data missing (Charlie) — run seed-sample-data.js first');
  }
  if (!friendPhone.email) {
    await friendPhone.update({ email: 'e2e-invite-friend-phone@example.com' });
  }
  // 88-34's seed creates this pair as Charlie -> Alice PENDING (incoming-request
  // walk surface); the phone invite journey needs it ACCEPTED, and the fixture
  // owns the CI database's state. No e2e spec reads the pending-request surface
  // (verified 2026-08-21 — padding-budget.spec.ts:429 deliberately anchors on a
  // card that renders without it).
  await assertAcceptedFriendship(alice.id, friendPhone.id);
  await UserGroup.destroy({ where: { user_uuid: friendPhone.id, group_id: inviteGroup.id }, force: true });

  // Hard-delete EVERY invite row for the invite group, force: true — mirroring the
  // F-02 reasoning above (a soft-deleted row still occupies the slot from the
  // fixture's point of view). This closes a PRE-EXISTING cross-run leak, not only
  // the new within-run one: invite.spec.ts creates pending invites that were never
  // cleaned up, so a second run against the same database 409'd on the
  // pending-invite check before this teardown existed.
  await GroupInvite.destroy({ where: { group_id: inviteGroup.id }, force: true });

  // ── Restore-preview fixture (SPEC R7): a soft-deleted-but-restorable group plus
  // its active group_restore nonce, so the restore-preview spec has a route to visit.
  //
  // Group is PARANOID (models/Group.js): findOrCreate's internal SELECT is scoped to
  // non-deleted rows, so on a second run it would MISS the row this fixture itself
  // soft-deleted, then crash INSERTing a duplicate group_id. The lookup must be
  // explicitly paranoid-aware — do NOT convert this to findOrCreate.
  let restoreGroup = await Group.findOne({
    where: { group_id: 'e2e-restore-group' },
    paranoid: false,
  });
  if (!restoreGroup) {
    restoreGroup = await Group.create({ group_id: 'e2e-restore-group', name: 'E2E Restore Group' });
  }
  // ZERO UserGroup rows for this group — deliberate and load-bearing:
  // accountDeletionService.getDeletionBlockers (the 87.2 account-deletion gate)
  // treats a group the user OWNS with >= 1 OTHER membership row of ANY status as a
  // hard blocker, and routes/groups.js's restore-preview validates only the token,
  // never membership — so a memberless group satisfies the spec and can never trip
  // the gate. Do not add Alice (or anyone) as a member here.
  //
  // Converge on the same soft-deleted, future-purge state on EVERY run, regardless
  // of what the database already held (this only works because the lookup above is
  // paranoid-aware): re-set purge_after, then paranoid-destroy if deletedAt is null
  // so Sequelize stamps deletedAt itself rather than it being written by hand.
  await Group.update(
    { purge_after: new Date(Date.now() + RESTORE_RECOVERY_WINDOW_MS) },
    { where: { id: restoreGroup.id }, paranoid: false }
  );
  await restoreGroup.reload({ paranoid: false });
  if (!restoreGroup.deletedAt) {
    await restoreGroup.destroy(); // paranoid soft delete
  }

  // DECISION Phase 87.8 (R7): the group_restore SingleUseToken uses LOOKUP-FIRST
  // idempotency — find any existing row for this group (no status filter, so a
  // revoked row is reactivated rather than duplicated), REUSE its nonce, and mint
  // via crypto.randomBytes only when none exists — chosen OVER the deterministic
  // HMAC idiom the RSVP nonces above use (:29-35). group_restore grants restore
  // access to a whole group and must NOT be computable from MAGIC_TOKEN_SECRET, a
  // value this repo already treats as a published CI throwaway (round-3 ML#15+#24):
  // a secret-derived nonce would be a live restore credential re-derivable by
  // anyone holding that secret. The RSVP pattern stays acceptable for its
  // lower-stakes per-event/user/status links; a group-restore credential is not.
  // The assert-not-production-db guard — called by THIS script as main()'s first
  // statement since Phase 88.1-21 (owner ruling `guard`, security O-05), rather
  // than reached transitively through ci.yml step ordering — is defence-in-depth
  // against wrong-database runs. It is NOT a substitute for this: it bounds WHICH
  // database gets written, not what a nonce in that database is derivable from.
  const restoreTokenKey = { purpose: 'group_restore', group_id: restoreGroup.id };
  let restoreToken = await SingleUseToken.findOne({ where: restoreTokenKey });
  const restoreExpiresAt = new Date(Date.now() + RESTORE_RECOVERY_WINDOW_MS + RESTORE_TOKEN_MARGIN_MS);
  if (restoreToken) {
    await restoreToken.update({ status: 'active', expires_at: restoreExpiresAt });
  } else {
    restoreToken = await SingleUseToken.create({
      // Same nonce shape prod mints (services/groupRecoveryService.js:175).
      nonce: crypto.randomBytes(32).toString('hex'),
      ...restoreTokenKey,
      // user_id DELIBERATELY null — DECISION Phase 88.2 D-02
      // (models/SingleUseToken.js:38-50): a populated sub would let
      // accountDeletionService's sub-keyed destroy silently kill the restore token.
      // group_restore rows identify the GROUP, not a user.
      user_id: null,
      status: 'active',
      expires_at: restoreExpiresAt,
      // event_id, email_batch_id, rsvp_status left null — group_restore carries none.
    });
  }
  // Exact emailed-link path shape routes/groups.js:1039 builds.
  const restorePath = `/restore/group/${restoreToken.nonce}`;

  console.log(`E2E_FIXTURES_JSON=${JSON.stringify({
    group_id: group.id,
    availability_token: availabilityToken,
    rsvp_path: rsvpPath,
    invite_group_name: inviteGroup.name,
    invite_friend_name: friend.username,
    invite_friend_name_phone: friendPhone.username,
    rsvp_path_phone: rsvpPathPhone,
    restore_path: restorePath,
    event_detail_path: eventDetailPath,
    coloured_group_id: colouredGroup.id,
  })}`);

  await sequelize.close();
  // Belt-and-braces: exit explicitly so no lingering handle (pool, timer from
  // any transitively-required module) can keep the process alive after success.
  process.exit(0);
}

main().catch((err) => {
  // Log ONLY the error's name and message — never the whole error object. A Sequelize
  // error carries `sql` and `parameters` fields, and this script's own bulkCreate calls
  // inline literal values (including single-use-token nonces) into those parameters, so
  // printing `err` leaks them straight into the CI job's plain-text, retained log.
  // Plan 12's marker-line redaction only touches the emitted marker line and can never
  // reach anything this handler prints, so this is the only mitigation for that leak
  // (T-88.3-07). tests/unit/e2e-fixtures-guard.test.js scans guard ordering only and
  // does not cover this line.
  console.error('e2e-fixtures failed:', err && err.name, err && err.message);
  process.exit(1);
});
