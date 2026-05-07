// Read-only diagnostic: prints what the leave-group cascade would have targeted,
// plus any orphaned rows currently in the DB for a given group.
//
// Usage:
//   node scripts/diagnose-leave-cascade.js <group_id> [auth0_user_id]
//
// If you pass auth0_user_id (e.g., 'google-oauth2|123...'), the script also
// shows that user's current EventRsvp / EventBring / EventParticipation /
// UserGroup rows for the group's future events.
//
// No writes. Safe to run against prod or local.

require('dotenv').config();
const { Op } = require('sequelize');
const sequelize = require('../config/database');
require('../models'); // load associations

const Event = require('../models/Event');
const EventParticipation = require('../models/EventParticipation');
const EventRsvp = require('../models/EventRsvp');
const EventBring = require('../models/EventBring');
const EventBallotVote = require('../models/EventBallotVote');
const EventBallotOption = require('../models/EventBallotOption');
const User = require('../models/User');
const UserGroup = require('../models/UserGroup');

async function main() {
  const groupId = process.argv[2];
  const authUserId = process.argv[3] || null;
  if (!groupId) {
    console.error('Usage: node scripts/diagnose-leave-cascade.js <group_id> [auth0_user_id]');
    process.exit(1);
  }

  console.log(`\n=== Group ${groupId} — leave-cascade diagnostic ===\n`);

  // 1. All events in the group + their start_date + status (so we can see if scope filter excluded the test event)
  const allEvents = await Event.findAll({
    where: { group_id: groupId },
    attributes: ['id', 'game_id', 'start_date', 'status'],
    order: [['start_date', 'ASC']],
  });
  console.log(`[1] All ${allEvents.length} events in this group:`);
  const now = new Date();
  for (const e of allEvents) {
    const future = e.start_date > now ? 'FUTURE' : 'past';
    const inScope = future === 'FUTURE' && ['scheduled', 'in_progress'].includes(e.status);
    console.log(`    ${inScope ? '*' : ' '} ${e.id}  ${e.start_date.toISOString()}  status=${e.status}  ${future}  game=${e.game_id || '(none)'}`);
  }
  console.log(`    (* = would be in cascade scope)\n`);

  const futureScopedEvents = allEvents.filter(
    (e) => e.start_date > now && ['scheduled', 'in_progress'].includes(e.status),
  );
  const futureEventIds = futureScopedEvents.map((e) => e.id);

  if (futureScopedEvents.length === 0) {
    console.log(`[!] futureScopedEvents is EMPTY — cascade would have skipped at the early return.`);
    console.log(`    Likely cause: the test event status is not 'scheduled'/'in_progress', or start_date is in the past.\n`);
  }

  // 2. If user provided, show all their rows tied to this group
  if (authUserId) {
    const user = await User.findOne({ where: { user_id: authUserId } });
    if (!user) {
      console.log(`[2] No User row found for auth0_user_id=${authUserId}`);
      await sequelize.close();
      return;
    }
    console.log(`[2] User ${authUserId}  →  User.id (UUID) = ${user.id}\n`);

    const ug = await UserGroup.findOne({ where: { user_id: authUserId, group_id: groupId } });
    console.log(`[3] UserGroup row for this user in this group:`);
    console.log(`    ${ug ? `EXISTS  status=${ug.status}  role=${ug.role}` : 'absent (user has left or was never a member)'}\n`);

    const allEventIds = allEvents.map((e) => e.id);

    const ep = await EventParticipation.findAll({
      where: { event_id: { [Op.in]: allEventIds }, user_id: user.id },
      attributes: ['id', 'event_id', 'is_guest', 'score', 'placement'],
    });
    console.log(`[4] EventParticipation rows (UUID-keyed, in this group):  ${ep.length}`);
    for (const r of ep) {
      const inFuture = futureEventIds.includes(r.event_id);
      console.log(`    ${inFuture ? 'FUTURE' : 'past  '}  event=${r.event_id}  is_guest=${r.is_guest}  score=${r.score}  placement=${r.placement}`);
    }

    const rsvp = await EventRsvp.findAll({
      where: { event_id: { [Op.in]: allEventIds }, user_id: authUserId },
      attributes: ['id', 'event_id', 'response'],
    });
    console.log(`\n[5] EventRsvp rows (Auth0-string-keyed, in this group):  ${rsvp.length}`);
    for (const r of rsvp) {
      const inFuture = futureEventIds.includes(r.event_id);
      console.log(`    ${inFuture ? 'FUTURE' : 'past  '}  event=${r.event_id}  response=${r.response}`);
    }

    const brings = await EventBring.findAll({
      where: { event_id: { [Op.in]: allEventIds }, user_id: authUserId },
      attributes: ['id', 'event_id', 'game_id'],
    });
    console.log(`\n[6] EventBring rows (Auth0-string-keyed, in this group):  ${brings.length}`);
    for (const r of brings) {
      const inFuture = futureEventIds.includes(r.event_id);
      console.log(`    ${inFuture ? 'FUTURE' : 'past  '}  event=${r.event_id}  game=${r.game_id}`);
    }

    const ballotOptions = await EventBallotOption.findAll({
      where: { event_id: { [Op.in]: allEventIds } },
      attributes: ['id'],
    });
    const ballotOptionIds = ballotOptions.map((o) => o.id);
    const votes = ballotOptionIds.length === 0 ? [] : await EventBallotVote.findAll({
      where: { option_id: { [Op.in]: ballotOptionIds }, user_id: authUserId },
      attributes: ['id', 'option_id'],
    });
    console.log(`\n[7] EventBallotVote rows (Auth0-string-keyed, in this group):  ${votes.length}`);
    for (const v of votes) {
      console.log(`    option=${v.option_id}`);
    }

    // What WOULD the cascade have deleted if it ran NOW?
    const futureEp = ep.filter((r) => futureEventIds.includes(r.event_id));
    const futureRsvp = rsvp.filter((r) => futureEventIds.includes(r.event_id));
    const futureBrings = brings.filter((r) => futureEventIds.includes(r.event_id));
    console.log(`\n[8] Cascade would target (if leave fired right now):`);
    console.log(`    EventParticipation: ${futureEp.length}`);
    console.log(`    EventRsvp:          ${futureRsvp.length}`);
    console.log(`    EventBring:         ${futureBrings.length}`);
    console.log(`    EventBallotVote:    ${votes.length} (across all events; cascade only future)`);

    if (!ug && (futureEp.length || futureRsvp.length || futureBrings.length)) {
      console.log(`\n[!] User has left the group but orphaned rows EXIST on future events.`);
      console.log(`    Either the cascade did not fire (route never called, or returned early),`);
      console.log(`    or the leave happened BEFORE the cascade was deployed.`);
    }
  } else {
    console.log(`[2] (No auth0_user_id provided — skipping per-user breakdown)`);
    console.log(`    Pass it as 2nd arg to see EventParticipation / EventRsvp / EventBring / EventBallotVote rows for that user.\n`);
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
