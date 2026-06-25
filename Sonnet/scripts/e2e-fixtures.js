// scripts/e2e-fixtures.js
// Mints the identifiers/tokens the FE Playwright journeys read from env.
// Run AFTER seed-sample-data.js (needs Alice + Weekend Warriors to exist).
//
// Emits ONE machine-readable line to stdout:
//   E2E_FIXTURES_JSON={"group_id":"...","availability_token":"...","rsvp_path":"..."}
// (Sequelize query logging also writes to stdout — consumers must grep the marker.)
//
// Produces:
// - group_id            → E2E_GROUP_ID  (create-event journey's planning surface)
// - availability_token  → E2E_AVAILABILITY_TOKEN (magic JWT for /availability-form/[token])
// - rsvp_path           → E2E_RSVP_PATH (/rsvp/<hmac>?e=&u=&s=yes for a FUTURE event —
//                         routes/rsvp.js rejects past events, and every seeded event is past)
//
// Requires MAGIC_TOKEN_SECRET in env (same value the booted server uses, or
// token validation will fail server-side).

const crypto = require('crypto');
const { User, Group, UserGroup, Friendship, SingleUseToken, Event, AvailabilityPrompt, sequelize } = require('../models');
const { generateToken } = require('../services/magicTokenService');

// RSVP single-use link lifetime — mirrors routes/rsvp.js RSVP_TOKEN_TTL_MS (30d).
const RSVP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

  // Active prompt for the availability magic link.
  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: 'active',
    week_identifier: `e2e-fixture-${Date.now()}`,
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

  // Invite-to-group journey fixture: Alice must own a group, and have an accepted
  // friend who is NOT in that group (so the friends-screen checkbox is enabled and
  // the invite has a valid target). Seed data creates no friendships, so build one.
  // group_id is NOT NULL + unique with no default — must be supplied. Key the
  // WHERE on it (kebab-case, like seed-sample-data) so re-runs are idempotent.
  const [inviteGroup] = await Group.findOrCreate({
    where: { group_id: 'e2e-invite-group' },
    defaults: { group_id: 'e2e-invite-group', name: 'E2E Invite Group' },
  });
  await UserGroup.findOrCreate({
    where: { user_id: alice.user_id, group_id: inviteGroup.id },
    defaults: { user_id: alice.user_id, group_id: inviteGroup.id, role: 'owner', status: 'active' },
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
    where: { requester_id: alice.user_id, addressee_id: friend.user_id },
    defaults: { requester_id: alice.user_id, addressee_id: friend.user_id, status: 'accepted' },
  });
  // Make sure Bob is NOT in the invite group (so the friend checkbox stays enabled).
  await UserGroup.destroy({ where: { user_id: friend.user_id, group_id: inviteGroup.id } });

  console.log(`E2E_FIXTURES_JSON=${JSON.stringify({
    group_id: group.id,
    availability_token: availabilityToken,
    rsvp_path: rsvpPath,
    invite_group_name: inviteGroup.name,
    invite_friend_name: friend.username,
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
