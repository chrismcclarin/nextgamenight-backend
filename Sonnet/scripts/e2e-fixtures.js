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
//
// Requires MAGIC_TOKEN_SECRET in env (same value the booted server uses, or
// token validation will fail server-side).

const crypto = require('crypto');
const { User, Group, UserGroup, Friendship, SingleUseToken, Event, AvailabilityPrompt, GroupInvite, sequelize } = require('../models');
const { generateToken } = require('../services/magicTokenService');

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
  // Accepted, bidirectional friendship Alice <-> Bob.
  await Friendship.findOrCreate({
    where: { requester_uuid: alice.id, addressee_uuid: friend.id },
    defaults: { requester_uuid: alice.id, addressee_uuid: friend.id, status: 'accepted' },
  });
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
  await Friendship.findOrCreate({
    where: { requester_uuid: alice.id, addressee_uuid: friendPhone.id },
    defaults: { requester_uuid: alice.id, addressee_uuid: friendPhone.id, status: 'accepted' },
  });
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
  // Task 0's assert-not-production-db guard is defence-in-depth against
  // wrong-database runs — it is NOT a substitute for this.
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
  })}`);

  await sequelize.close();
  // Belt-and-braces: exit explicitly so no lingering handle (pool, timer from
  // any transitively-required module) can keep the process alive after success.
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ e2e-fixtures failed:', err);
  process.exit(1);
});
