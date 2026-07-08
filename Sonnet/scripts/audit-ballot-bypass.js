// scripts/audit-ballot-bypass.js
//
// Audit-only per D-BALLOT-03/D-BALLOT-05 — NO vote deletion, NO winner recount mutation.
// Reads all EventBallotVote rows, joins to EventRsvp, counts votes by users
// whose RSVP for the parent event is NOT yes/maybe (i.e. potential POLL-06 bypass).
//
// For each affected ballot computes:
//   - winner BEFORE (by total votes, current persisted state)
//   - winner AFTER excluding bypass votes (recount only — never written back)
//   - whether the winner changed
//
// Output:
//   - /tmp/ballot-audit-{YYYY-MM-DD}.json (full per-ballot detail)
//   - console.log summary
//
// Run with: node scripts/audit-ballot-bypass.js
// (DATABASE_URL or POSTGRES_URL must point at the DB you want to audit.)

const fs = require('fs');
const path = require('path');
const sequelize = require('../config/database');
const {
  EventBallotVote,
  EventBallotOption,
  EventRsvp,
  Event,
  User,
} = require('../models');

function isoDateStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function main() {
  const auditRunAt = new Date().toISOString();
  console.log(`[audit-ballot-bypass] starting audit at ${auditRunAt}`);

  // 1. Load every vote with its option (needed for event_id + game_name)
  const allVotes = await EventBallotVote.findAll({
    include: [
      {
        model: EventBallotOption,
        attributes: ['id', 'event_id', 'game_id', 'game_name'],
      },
    ],
    order: [['createdAt', 'ASC']],
  });

  if (allVotes.length === 0) {
    console.log('[audit-ballot-bypass] no votes in database; nothing to audit');
    const outPath = path.join('/tmp', `ballot-audit-${isoDateStr()}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          audit_run_at: auditRunAt,
          totals: { votes: 0, bypass_votes: 0, affected_ballots: 0, winner_changed_ballots: 0 },
          ballots: [],
        },
        null,
        2
      )
    );
    console.log(`[audit-ballot-bypass] empty report written to: ${outPath}`);
    await sequelize.close();
    return;
  }

  // Phase 87.1 (BINT-02, Plan 09 cutover): EventBallotVote / EventRsvp are keyed on the
  // Users.id UUID (user_uuid); the old Auth0-string user_id columns were removed from the
  // models. This audit joins votes -> RSVPs -> users all on the UUID keyspace.

  // 2. Build (event_id -> Set<user_uuid>) of voters per event so we can batch-load
  //    the relevant EventRsvp rows in one query per event (cheaper than per-vote).
  const eventToVoters = new Map(); // event_id -> Set of voter user_uuids
  for (const vote of allVotes) {
    const eventId = vote.EventBallotOption?.event_id;
    if (!eventId) continue; // orphaned vote (option deleted) — skip
    if (!eventToVoters.has(eventId)) eventToVoters.set(eventId, new Set());
    eventToVoters.get(eventId).add(vote.user_uuid);
  }

  // 3. Load events (for start_date + rsvp_deadline + game_id resolution) in one query
  //    Note: Event has no `title` column — the frontend reads game.name as the
  //    display title (with 'Game Night' fallback).
  const eventIds = Array.from(eventToVoters.keys());
  const events = await Event.findAll({
    where: { id: eventIds },
    attributes: ['id', 'group_id', 'start_date', 'rsvp_deadline', 'game_id', 'ballot_status'],
  });
  const eventById = new Map(events.map((e) => [e.id, e]));

  // 4. Load EventRsvps for every (event, voter) pair in one query per event.
  //    Build map: rsvpKey = `${event_id}|${user_uuid}` -> { status, exists }
  const rsvpMap = new Map();
  for (const [eventId, voterSet] of eventToVoters.entries()) {
    const rsvps = await EventRsvp.findAll({
      where: { event_id: eventId, user_uuid: Array.from(voterSet) },
      attributes: ['event_id', 'user_uuid', 'status'],
    });
    for (const r of rsvps) {
      rsvpMap.set(`${r.event_id}|${r.user_uuid}`, r.status);
    }
  }

  // 5. Resolve usernames/emails for bypass voters in one User query (keyed on Users.id UUID)
  const bypassUserUuids = new Set();
  for (const vote of allVotes) {
    const eventId = vote.EventBallotOption?.event_id;
    if (!eventId) continue;
    const status = rsvpMap.get(`${eventId}|${vote.user_uuid}`);
    if (!status || !['yes', 'maybe'].includes(status)) {
      bypassUserUuids.add(vote.user_uuid);
    }
  }
  const bypassUsers = bypassUserUuids.size === 0
    ? []
    : await User.findAll({
        where: { id: Array.from(bypassUserUuids) },
        attributes: ['id', 'user_id', 'username', 'email'],
      });
  const userById = new Map(bypassUsers.map((u) => [u.id, u]));

  // 6. Walk votes, classify, group by ballot/event, compute winners
  const perEvent = new Map(); // event_id -> { allVotesByOption, bypassVotesByOption, bypassVoters }
  for (const vote of allVotes) {
    const opt = vote.EventBallotOption;
    if (!opt || !opt.event_id) continue;
    const eventId = opt.event_id;
    const status = rsvpMap.get(`${eventId}|${vote.user_uuid}`);
    const isBypass = !status || !['yes', 'maybe'].includes(status);

    if (!perEvent.has(eventId)) {
      perEvent.set(eventId, {
        allVotesByOption: new Map(), // option_id -> count
        bypassVotesByOption: new Map(), // option_id -> count
        optionMeta: new Map(), // option_id -> { game_id, game_name }
        bypassVoters: [],
      });
    }
    const bucket = perEvent.get(eventId);
    bucket.allVotesByOption.set(
      opt.id,
      (bucket.allVotesByOption.get(opt.id) || 0) + 1
    );
    bucket.optionMeta.set(opt.id, { game_id: opt.game_id, game_name: opt.game_name });
    if (isBypass) {
      bucket.bypassVotesByOption.set(
        opt.id,
        (bucket.bypassVotesByOption.get(opt.id) || 0) + 1
      );
      const u = userById.get(vote.user_uuid);
      bucket.bypassVoters.push({
        user_uuid: vote.user_uuid,
        user_id: u?.user_id || null, // Auth0 sub (for human-readable cross-reference)
        username: u?.username || null,
        email: u?.email || null,
        rsvp_status_or_null: status || null,
        option_id: opt.id,
        game_name: opt.game_name,
      });
    }
  }

  // 7. Build per-ballot report rows + totals
  function pickWinner(byOption, optionMeta) {
    if (byOption.size === 0) return null;
    let maxVotes = 0;
    for (const v of byOption.values()) if (v > maxVotes) maxVotes = v;
    if (maxVotes === 0) return null;
    const tied = [];
    for (const [oid, count] of byOption.entries()) {
      if (count === maxVotes) tied.push({ option_id: oid, votes: count, ...(optionMeta.get(oid) || {}) });
    }
    return { tied, maxVotes };
  }

  const ballots = [];
  let totalBypassVotes = 0;
  let totalAffectedBallots = 0;
  let winnerChangedBallots = 0;

  for (const [eventId, bucket] of perEvent.entries()) {
    const event = eventById.get(eventId);
    const bypassCount = Array.from(bucket.bypassVotesByOption.values()).reduce((a, b) => a + b, 0);
    if (bypassCount === 0) continue; // not affected

    totalAffectedBallots += 1;
    totalBypassVotes += bypassCount;

    // Compute winner BEFORE (raw current counts — what production sees today)
    const before = pickWinner(bucket.allVotesByOption, bucket.optionMeta);

    // Compute winner AFTER excluding bypass votes
    const cleanByOption = new Map();
    for (const [oid, count] of bucket.allVotesByOption.entries()) {
      const bypass = bucket.bypassVotesByOption.get(oid) || 0;
      const clean = count - bypass;
      if (clean > 0) cleanByOption.set(oid, clean);
    }
    const after = pickWinner(cleanByOption, bucket.optionMeta);

    // Winner-changed iff the (deterministic) tied[0] option_id differs, OR
    // one side has a winner and the other does not.
    let winnerChanged = false;
    if (before && after) {
      const beforeIds = new Set(before.tied.map((t) => t.option_id));
      const afterIds = new Set(after.tied.map((t) => t.option_id));
      // Different leader sets = winner changed (handles tie shifts too)
      winnerChanged =
        beforeIds.size !== afterIds.size ||
        Array.from(beforeIds).some((x) => !afterIds.has(x));
    } else if (!!before !== !!after) {
      winnerChanged = true;
    }
    if (winnerChanged) winnerChangedBallots += 1;

    ballots.push({
      event_id: eventId,
      group_id: event?.group_id || null,
      event_start_date: event?.start_date || null,
      rsvp_deadline: event?.rsvp_deadline || null,
      ballot_status: event?.ballot_status || null,
      total_votes:
        Array.from(bucket.allVotesByOption.values()).reduce((a, b) => a + b, 0),
      bypass_votes: bypassCount,
      winner_before: before
        ? {
            tied_options: before.tied,
            max_votes: before.maxVotes,
            is_tie: before.tied.length > 1,
          }
        : null,
      winner_after_excluding_bypass: after
        ? {
            tied_options: after.tied,
            max_votes: after.maxVotes,
            is_tie: after.tied.length > 1,
          }
        : null,
      winner_changed: winnerChanged,
      bypass_voters: bucket.bypassVoters,
    });
  }

  // 8. Sort ballots: winner-changed first, then by bypass count desc
  ballots.sort((a, b) => {
    if (a.winner_changed !== b.winner_changed) return a.winner_changed ? -1 : 1;
    return b.bypass_votes - a.bypass_votes;
  });

  const report = {
    audit_run_at: auditRunAt,
    totals: {
      votes: allVotes.length,
      bypass_votes: totalBypassVotes,
      affected_ballots: totalAffectedBallots,
      winner_changed_ballots: winnerChangedBallots,
    },
    ballots,
  };

  // 9. Write JSON output + console summary
  const outPath = path.join('/tmp', `ballot-audit-${isoDateStr()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log('=== Ballot Bypass Audit Summary ===');
  console.log(`Total votes:            ${report.totals.votes}`);
  console.log(`Bypass votes:           ${report.totals.bypass_votes}`);
  console.log(`Affected ballots:       ${report.totals.affected_ballots}`);
  console.log(`Winner-changed ballots: ${report.totals.winner_changed_ballots}`);
  console.log(`Output written to:      ${outPath}`);
  console.log('');

  // Per-ballot one-liners (only the worst offenders to keep console readable)
  const topN = ballots.slice(0, 10);
  if (topN.length > 0) {
    console.log('Top affected ballots:');
    for (const b of topN) {
      const flag = b.winner_changed ? '[WINNER CHANGED]' : '[no winner change]';
      console.log(
        `  ${flag} event=${b.event_id} start=${b.event_start_date || '(unknown)'} ` +
          `bypass=${b.bypass_votes}/${b.total_votes}`
      );
    }
    if (ballots.length > topN.length) {
      console.log(`  ... and ${ballots.length - topN.length} more in the JSON file`);
    }
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error('[audit-ballot-bypass] FATAL:', err);
  process.exit(1);
});
