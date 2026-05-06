// services/pollService.js
// Business logic for member-created availability polls (POLL-01).
//
// Locked CONTEXT decisions implemented here:
//   D-POLL-CREATE-02 — active members only on create (createPoll)
//   D-POLL-CREATE-04 — lifecycle = manual close OR deadline OR 100% consensus,
//                      whichever first (closePoll + checkAutoClose)
//   D-POLL-CREATE-05 — consensus = 100% of all active group members responded
//                      (checkAutoClose)
//   D-POLL-CREATE-06 — creator picks deadline (default 24h before earliest day in
//                      window — defaulting is handled by the caller / route layer
//                      since the service layer expects the final value)
//   D-POLL-CREATE-07 — close-notification dismissal lives server-side
//                      (dismissCloseNotification)
//   D-POLL-CREATE-09 — 1-14 day window, default 7 (createPoll validates 1..14)
//   D-POLL-CREATE-10 — one open poll per group (DB partial unique index;
//                      createPoll catches 23505 and translates to 409)
//   D-POLL-CREATE-12 — close-notification surfaces ALL tied top slots
//                      (notifyPollClosed)
//   D-POLL-CREATE-13 — close button labelled "End poll" — UI label, frontend's
//                      job in Plan 71-05; this layer just exposes closePoll.
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const { Poll, PollResponse, UserGroup, User, Group } = require('../models');
const notificationService = require('./notificationService');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Create a new poll.
 *
 * @param {Object} params
 * @param {string} params.groupId
 * @param {string} params.userId Auth0 user_id of the creator
 * @param {string|Date} params.dateWindowStart   YYYY-MM-DD or Date
 * @param {string|Date} params.dateWindowEnd     YYYY-MM-DD or Date
 * @param {string|Date} params.responseDeadline  ISO datetime
 * @returns {Promise<Poll>}
 */
async function createPoll({ groupId, userId, dateWindowStart, dateWindowEnd, responseDeadline }) {
  // 1. Validate active membership (D-POLL-CREATE-02)
  const membership = await UserGroup.findOne({
    where: { group_id: groupId, user_id: userId, status: 'active' },
  });
  if (!membership) {
    const err = new Error('Only active group members can create polls');
    err.status = 403;
    throw err;
  }

  // 2. Validate window (D-POLL-CREATE-09: 1..14 days inclusive)
  const start = new Date(dateWindowStart);
  const end = new Date(dateWindowEnd);
  if (isNaN(start) || isNaN(end)) {
    const err = new Error('Invalid date_window_start or date_window_end');
    err.status = 400;
    throw err;
  }
  // Use midnight-to-midnight UTC date math to avoid timezone-induced off-by-one
  const startMs = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endMs = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  if (days < 1 || days > 14) {
    const err = new Error('Date window must be between 1 and 14 days');
    err.status = 400;
    throw err;
  }

  // 3. Validate deadline is before earliest day in window (D-POLL-CREATE-06)
  const deadline = new Date(responseDeadline);
  if (isNaN(deadline)) {
    const err = new Error('Invalid response_deadline');
    err.status = 400;
    throw err;
  }
  if (deadline >= start) {
    const err = new Error('Response deadline must be before the date window starts');
    err.status = 400;
    throw err;
  }

  // 4. Create — DB partial unique index enforces one-open-per-group (D-POLL-CREATE-10).
  let poll;
  try {
    poll = await Poll.create({
      group_id: groupId,
      created_by_user_id: userId,
      status: 'open',
      date_window_start: dateWindowStart,
      date_window_end: dateWindowEnd,
      response_deadline: responseDeadline,
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError' || err.original?.code === '23505') {
      const conflictErr = new Error('There is already an open poll for this group');
      conflictErr.status = 409;
      throw conflictErr;
    }
    throw err;
  }

  // 5. Fan out poll_created notifications (D-POLL-CREATE-03). Best-effort —
  //    notification failures must not roll back the poll.
  notifyPollCreated(poll, groupId, userId).catch((e) => {
    console.error('[pollService] poll_created fan-out failed:', e.message);
  });

  return poll;
}

/**
 * Fan out the create-poll notification to all active group members except the creator.
 * Uses notificationService.send() so per-user `poll_created` prefs are respected.
 */
async function notifyPollCreated(poll, groupId, creatorUserId) {
  const group = await Group.findByPk(groupId);
  const creator = await User.findOne({ where: { user_id: creatorUserId } });
  const frontend = process.env.FRONTEND_URL || '';

  // Members tap and land on the group page with the active poll surface.
  // Same query-param contract as notifyPollClosed (minus prefillStart) for consistency.
  const respondUrl = `${frontend}/groupHomePage?groupId=${groupId}&pollId=${poll.id}`;
  const deadlineStr = new Date(poll.response_deadline).toLocaleString();
  const groupName = group?.name || 'your group';
  const creatorName = creator?.username || 'A member';

  const memberships = await UserGroup.findAll({
    where: { group_id: groupId, status: 'active', user_id: { [Op.ne]: creatorUserId } },
    include: [{ model: User }],
  });

  for (const m of memberships) {
    if (!m.User) continue;
    const body = [
      `${creatorName} started an availability poll in ${groupName}.`,
      ``,
      `Date window: ${poll.date_window_start} → ${poll.date_window_end}`,
      `Respond by: ${deadlineStr}`,
      ``,
      `Submit your availability: ${respondUrl}`,
    ].join('\n');

    await notificationService.send(m.User, 'poll_created', {
      emailParams: {
        to: m.User.email,
        subject: `New availability poll for ${groupName}`,
        body,
      },
      // SMS body kept short — Twilio SMS preview window
      smsBody: `New poll for ${groupName}. Respond by ${new Date(poll.response_deadline).toLocaleDateString()}: ${respondUrl}`,
    });
  }
}

/**
 * Submit (or update — upsert) a user's response to a poll.
 *
 * @param {Object} params
 * @param {string} params.pollId
 * @param {string} params.userId
 * @param {Array}  params.slotData
 */
async function submitResponse({ pollId, userId, slotData }) {
  const poll = await Poll.findByPk(pollId);
  if (!poll) {
    const err = new Error('Poll not found'); err.status = 404; throw err;
  }
  if (poll.status !== 'open') {
    const err = new Error('Poll is closed'); err.status = 400; throw err;
  }
  // Active member of this poll's group
  const membership = await UserGroup.findOne({
    where: { group_id: poll.group_id, user_id: userId, status: 'active' },
  });
  if (!membership) {
    const err = new Error('Only active group members can respond to this poll'); err.status = 403; throw err;
  }

  // Upsert — (poll_id, user_id) is unique. The `[response, created]` shape
  // varies by Postgres dialect; we don't need the boolean.
  await PollResponse.upsert({
    poll_id: pollId,
    user_id: userId,
    slot_data: slotData,
    submitted_at: new Date(),
  });

  // Re-fetch the upserted row so we return the canonical shape.
  const response = await PollResponse.findOne({ where: { poll_id: pollId, user_id: userId } });

  // Lifecycle check post-submit (D-POLL-CREATE-04). Best-effort — don't fail the
  // submit if the close fan-out throws.
  checkAutoClose(pollId).catch((e) => {
    console.error('[pollService] checkAutoClose failed for', pollId, ':', e.message);
  });

  return response;
}

/**
 * Evaluate D-POLL-CREATE-04 lifecycle: deadline OR consensus, whichever first.
 * Manual close is initiated by closePoll() directly, not here.
 *
 * Used in two contexts:
 *   1. After every PollResponse upsert.
 *   2. Lazy-on-read: every GET that returns a poll calls this first to
 *      auto-close polls past their deadline. Guarantees inactive groups still
 *      auto-close without a worker (D-POLL-CREATE-04 deadline path is REQUIRED).
 */
async function checkAutoClose(pollId) {
  const poll = await Poll.findByPk(pollId);
  if (!poll || poll.status !== 'open') return null;

  // Deadline path (REQUIRED — guarantees inactive groups auto-close)
  if (new Date() >= new Date(poll.response_deadline)) {
    return closePoll({ pollId, reason: 'deadline' });
  }

  // Consensus path — 100% of active members responded
  const activeCount = await UserGroup.count({
    where: { group_id: poll.group_id, status: 'active' },
  });
  const responseCount = await PollResponse.count({ where: { poll_id: pollId } });

  if (activeCount > 0 && responseCount >= activeCount) {
    return closePoll({ pollId, reason: 'consensus' });
  }

  return null;
}

/**
 * Close a poll. Called by:
 *   - manual close (POST /api/polls/:id/close) — creator/admin/owner only
 *   - checkAutoClose (deadline or consensus)
 *
 * @param {Object} params
 * @param {string} params.pollId
 * @param {('manual'|'deadline'|'consensus')} params.reason
 * @param {string|null} params.byUserId Required when reason === 'manual'
 */
async function closePoll({ pollId, reason, byUserId = null }) {
  const poll = await Poll.findByPk(pollId);
  if (!poll || poll.status !== 'open') return poll;

  // Manual-close authorization: creator OR admin OR owner
  if (reason === 'manual') {
    if (!byUserId) {
      const err = new Error('byUserId is required for manual close'); err.status = 400; throw err;
    }
    if (byUserId !== poll.created_by_user_id) {
      const membership = await UserGroup.findOne({
        where: { group_id: poll.group_id, user_id: byUserId, status: 'active' },
      });
      if (!membership || !['admin', 'owner'].includes(membership.role)) {
        const err = new Error('Only the creator, admins, or owners can end this poll');
        err.status = 403;
        throw err;
      }
    }
  }

  poll.status = 'closed';
  poll.closed_at = new Date();
  poll.close_reason = reason;
  await poll.save();

  // Best-effort close-notification fan-out
  notifyPollClosed(poll).catch((e) => {
    console.error('[pollService] poll-closed notification failed:', e.message);
  });

  return poll;
}

/**
 * Email the creator with the close summary + top-slot CTA.
 *
 * D-POLL-CREATE-12: surface ALL tied top slots — one CTA per slot.
 *
 * LOCKED URL CONTRACT (also consumed by Plan 71-05 bell-side):
 *   ${FRONTEND_URL}/groupHomePage?groupId=X&pollId=Y&prefillStart=ISO-DATETIME
 * Plan 71-05's NotificationBell reads the SAME shape.
 */
async function notifyPollClosed(poll) {
  const responses = await PollResponse.findAll({ where: { poll_id: poll.id } });
  const tally = new Map(); // key=`${date}|${slot}` → count
  for (const r of responses) {
    for (const s of (r.slot_data || [])) {
      if (s && s.available) {
        const key = `${s.date}|${s.slot}`;
        tally.set(key, (tally.get(key) || 0) + 1);
      }
    }
  }
  let max = 0;
  let topSlots = [];
  for (const [key, count] of tally) {
    if (count > max) { max = count; topSlots = [key]; }
    else if (count === max) topSlots.push(key);
  }

  const creator = await User.findOne({ where: { user_id: poll.created_by_user_id } });
  if (!creator) return;
  const group = await Group.findByPk(poll.group_id);
  const frontend = process.env.FRONTEND_URL || '';

  // Locked URL contract — Plan 71-05 reads this exact shape.
  // slotKey is `${date}|${slot}` where slot is the ISO datetime start.
  const slotToUrl = (slotKey) => {
    const [, slotIso] = slotKey.split('|');
    const params = new URLSearchParams({
      groupId: poll.group_id,
      pollId: poll.id,
      prefillStart: slotIso,
    });
    return `${frontend}/groupHomePage?${params.toString()}`;
  };

  const groupName = group?.name || 'your group';
  let bodyLines;
  let subject;
  let smsBody;

  if (topSlots.length === 0) {
    subject = `Poll closed (${poll.close_reason}) — no responses for ${groupName}`;
    bodyLines = [
      `The "${groupName}" availability poll closed (${poll.close_reason}).`,
      `No availability was submitted, so there's no top slot to suggest.`,
      ``,
      `Open the group: ${frontend}/groupHomePage?groupId=${poll.group_id}`,
    ];
    smsBody = `Poll closed for ${groupName} — no responses. Open the group to plan manually.`;
  } else if (topSlots.length === 1) {
    subject = `Poll closed (${poll.close_reason}) — top slot ready for ${groupName}`;
    bodyLines = [
      `The "${groupName}" availability poll closed (${poll.close_reason}).`,
      ``,
      `Top slot: ${topSlots[0].replace('|', ' at ')} (${max} available)`,
      ``,
      `Schedule it: ${slotToUrl(topSlots[0])}`,
    ];
    smsBody = `Poll closed for ${groupName}. Schedule top slot: ${slotToUrl(topSlots[0])}`;
  } else {
    subject = `Poll closed (${poll.close_reason}) — ${topSlots.length} slots tied for ${groupName}`;
    bodyLines = [
      `The "${groupName}" availability poll closed (${poll.close_reason}).`,
      ``,
      `${topSlots.length} slots tied for top availability (${max} each):`,
      ...topSlots.map((s) => `  - ${s.replace('|', ' at ')}  →  ${slotToUrl(s)}`),
      ``,
      `Pick one of the links above to schedule.`,
    ];
    smsBody = `Poll closed for ${groupName}. ${topSlots.length} slots tied — see email or open the group.`;
  }

  await notificationService.send(creator, 'poll_created', {
    emailParams: {
      to: creator.email,
      subject,
      body: bodyLines.join('\n'),
    },
    smsBody,
  });
}

/**
 * Creator-only — sets closed_notification_dismissed_at = NOW() so the
 * close-notification CTA disappears from the bell across all the creator's
 * devices (D-POLL-CREATE-07 cross-device guarantee).
 */
async function dismissCloseNotification({ pollId, userId }) {
  const poll = await Poll.findByPk(pollId);
  if (!poll) {
    const err = new Error('Poll not found'); err.status = 404; throw err;
  }
  if (poll.created_by_user_id !== userId) {
    const err = new Error('Only the poll creator can dismiss this notification'); err.status = 403; throw err;
  }
  poll.closed_notification_dismissed_at = new Date();
  await poll.save();
  return poll;
}

/**
 * Returns open polls in any group where the user is an active member AND has
 * not yet submitted a PollResponse. Consumed by Plan 71-05 NotificationBell.
 *
 * Lazy-on-read deadline auto-close runs on every poll before deciding whether
 * to include it (D-POLL-CREATE-04 REQUIRED deadline path).
 */
async function getPollsPendingForUser(userId) {
  const memberships = await UserGroup.findAll({
    where: { user_id: userId, status: 'active' },
    attributes: ['group_id'],
  });
  if (memberships.length === 0) return [];
  const groupIds = memberships.map((m) => m.group_id);

  // Run lazy auto-close on any open poll past deadline before we filter
  const openPollsForCheck = await Poll.findAll({
    where: { group_id: { [Op.in]: groupIds }, status: 'open' },
    attributes: ['id', 'response_deadline'],
  });
  const now = Date.now();
  for (const p of openPollsForCheck) {
    if (new Date(p.response_deadline).getTime() <= now) {
      // Will close with reason='deadline' if still open.
      await checkAutoClose(p.id);
    }
  }

  // Final fetch — open polls + creator + group
  const polls = await Poll.findAll({
    where: { group_id: { [Op.in]: groupIds }, status: 'open' },
    include: [
      { model: Group, attributes: ['id', 'name', 'group_id'] },
      { model: User, as: 'Creator', attributes: ['user_id', 'username'] },
    ],
    order: [['response_deadline', 'ASC']],
  });
  if (polls.length === 0) return [];

  const pollIds = polls.map((p) => p.id);
  const myResponses = await PollResponse.findAll({
    where: { poll_id: { [Op.in]: pollIds }, user_id: userId },
    attributes: ['poll_id'],
  });
  const respondedSet = new Set(myResponses.map((r) => r.poll_id));
  return polls.filter((p) => !respondedSet.has(p.id));
}

/**
 * Fetch the active poll for a group + responses + creator.
 * Intentionally returns only the OPEN poll (or null) — `closed` polls live in
 * history. Plan 71-05's group home page reads this for the live heatmap surface.
 */
async function getActivePoll(groupId) {
  return Poll.findOne({
    where: { group_id: groupId, status: 'open' },
    include: [
      { model: PollResponse },
      { model: User, as: 'Creator', attributes: ['user_id', 'username'] },
    ],
  });
}

/**
 * Fetch a single poll by id (open or closed) + responses + creator.
 */
async function getPoll(pollId) {
  return Poll.findByPk(pollId, {
    include: [
      { model: PollResponse },
      { model: User, as: 'Creator', attributes: ['user_id', 'username'] },
    ],
  });
}

module.exports = {
  createPoll,
  submitResponse,
  closePoll,
  checkAutoClose,
  getActivePoll,
  getPoll,
  dismissCloseNotification,
  getPollsPendingForUser,
  // Exported for test isolation
  notifyPollCreated,
  notifyPollClosed,
};
