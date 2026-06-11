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
const { User, Group, Event, AvailabilityPrompt, sequelize } = require('../models');
const { generateToken } = require('../services/magicTokenService');

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

  console.log(`E2E_FIXTURES_JSON=${JSON.stringify({
    group_id: group.id,
    availability_token: availabilityToken,
    rsvp_path: rsvpPath,
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
