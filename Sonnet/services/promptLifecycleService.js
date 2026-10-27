// services/promptLifecycleService.js
// Phase 71.2 / Plan 02 — Single source of truth for AvailabilityPrompt lifecycle
// side-effects (consensus check + close-notification dispatch).
//
// Two functions:
//   - checkConsensusAndClose(promptId): called after every response submit.
//     If all active members responded, close the prompt and run the close
//     side-effects.
//   - handlePromptClosed(prompt): called after every status='closed' transition
//     (PATCH-close, deadline, consensus). Resolves the recipient per the LOCKED
//     rule (D-ADAPT-05 + D-SCHEMA-06), builds the top-slot list, sends the
//     close-notification email. Best-effort — errors logged, never thrown.
//
// LOCKED recipient resolution rule (D-ADAPT-05 as amended 2026-10-26 by the owner
// ruling on quick-261025-rl3 review R1, + D-SCHEMA-06):
//   Manual:  candidate = prompt.created_by_user_id
//   Auto:    settings = GroupPromptSettings.findByPk(prompt.created_by_settings_id)
//            firing   = settings.template_config.schedules[] entry whose id equals
//                       prompt.schedule_id (case-insensitive)
//            candidate = firing.created_by_user_id
//                        (none → settings.created_by_user_id, none → group owner)
//   recipient = candidate, ONLY while the candidate holds an ACTIVE UserGroup
//              membership in prompt.group_id (quick-261025-rl3 BE-1); a
//              candidate who left or was removed falls back to the group owner
//              <UserGroup role='owner', status='active' → User.findByPk(user_uuid)>.
//
// Note: the Group model has NO owner_id column in this codebase. Group ownership
// is determined by `UserGroup.role === 'owner', status='active'`. Since Phase 87.1
// D-11 UserGroup is keyed on user_uuid (= Users.id), so the owner-fallback path
// uses User.findByPk(ownerUg.user_uuid); the pre-87.1 text here said the opposite
// (an Auth0-sub user_id read via User.findOne), which the code stopped doing then.
// See INVESTIGATION.md step (d) for the original reasoning.
//
// D-ADAPT-03 invariant: this service NEVER writes to GroupPromptSettings —
// closing an auto-prompt MUST NOT cancel the parent recurring schedule.

const { Op } = require('sequelize');
const {
  AvailabilityPrompt,
  AvailabilityResponse,
  AvailabilitySuggestion,
  UserGroup,
  Group,
  GroupPromptSettings,
  User,
  Game,
} = require('../models');
const emailService = require('./emailService');

// Optional Sentry integration (review 261025-rl3 R6). DSN-gated require copied
// from services/notificationService.js (Phase 85 / BAPI-02) — not a third idiom;
// Phase 91 consolidates them. Additive only: the console logging stays.
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[promptLifecycle] Sentry not available:', err.message);
  }
}

/**
 * Check whether all active group members have submitted responses for this
 * prompt. Closes the prompt and dispatches the close-notification side-effects
 * if so. Idempotent — safe to call from the response-submit handler on every
 * submission. Best-effort — errors logged, never thrown.
 *
 * @param {string} promptId UUID
 * @returns {Promise<{closed: boolean, respondedCount: number, totalActive: number, reason?: string}>}
 */
async function checkConsensusAndClose(promptId) {
  try {
    const prompt = await AvailabilityPrompt.findByPk(promptId);
    if (!prompt) {
      return { closed: false, respondedCount: 0, totalActive: 0, reason: 'not_found' };
    }

    // Count distinct active group members and submitted responses.
    const totalActive = await UserGroup.count({
      where: { group_id: prompt.group_id, status: 'active' },
    });
    const respondedCount = await AvailabilityResponse.count({
      where: { prompt_id: promptId, submitted_at: { [Op.ne]: null } },
    });

    if (totalActive === 0 || respondedCount < totalActive) {
      return { closed: false, respondedCount, totalActive };
    }

    // Consensus reached → CLAIM-then-send (T-87-11, D-04). Replace the old
    // read-status-then-update TOCTOU with a single atomic conditional UPDATE:
    // only the caller whose UPDATE actually flips status active→closed (exactly
    // one row) is allowed to run the close side-effects (email). A concurrent
    // close (consensus race, PATCH-close, deadline) or a BullMQ/handler retry
    // finds the row already closed/converted, claims 0 rows, and MUST NOT
    // re-send. The email is a side effect AFTER the claim is won, never before.
    const [affectedCount, rows] = await AvailabilityPrompt.update(
      { status: 'closed' },
      {
        where: { id: promptId, status: { [Op.notIn]: ['closed', 'converted'] } },
        returning: true,
      }
    );

    if (affectedCount === 0) {
      // Lost the race — someone else already closed/converted this prompt.
      // Do NOT emit a second close-notification email.
      return { closed: false, respondedCount, totalActive, reason: 'already_closed' };
    }

    // Won the claim → run the close side-effects on the freshly-updated row.
    // NOTE: a bare `update(...).returning` row carries only table columns, not
    // eager-loaded associations. handlePromptClosed reads only plain columns
    // (id, group_id, created_by_user_id, created_by_settings_id, schedule_id,
    // game_id) and
    // re-queries every association itself, so the RETURNING row is sufficient
    // and no re-fetch-with-include is required here.
    await handlePromptClosed(rows[0]);
    return { closed: true, respondedCount, totalActive };
  } catch (err) {
    console.error('[promptLifecycle] checkConsensusAndClose error:', err.message);
    return { closed: false, respondedCount: 0, totalActive: 0, reason: 'error' };
  }
}

/**
 * Run the close-notification side-effects for a prompt that just transitioned
 * to status='closed'. Called from PATCH-close, deadline expiry, and consensus
 * close. Best-effort — errors logged, never thrown.
 *
 * Skips email send if:
 *   - response count === 0 (D-CLOSE-03 silent close)
 *   - top-slot list is empty (no viable suggestion to put in CTA)
 *   - recipient cannot be resolved or has no email. The stored creator
 *     (manual poll creator, or the schedule creator for an auto-prompt) is
 *     the recipient only while they hold an ACTIVE membership in the poll's
 *     group; otherwise the group owner is, and if no active owner resolves
 *     either, the send is skipped (quick-261025-rl3 BE-1)
 *
 * D-ADAPT-03: do NOT touch GroupPromptSettings — recurring schedule survives
 * the close. Reading settings.created_by_user_id is a READ, not a write —
 * explicitly distinct.
 *
 * @param {Object} prompt - AvailabilityPrompt model instance (post-close)
 */
async function handlePromptClosed(prompt) {
  try {
    if (!prompt) {
      console.warn('[promptLifecycle] handlePromptClosed called with null prompt');
      return;
    }

    // Step 1 — silent-close gate (D-CLOSE-03).
    const responseCount = await AvailabilityResponse.count({
      where: { prompt_id: prompt.id, submitted_at: { [require('sequelize').Op.ne]: null } },
    });
    if (responseCount === 0) {
      // No responses → no top slot to suggest → no email (D-CLOSE-03).
      console.log(`[promptLifecycle] prompt ${prompt.id} closed with 0 submitted responses; skipping email per D-CLOSE-03`);
      return;
    }
    console.log(`[promptLifecycle] prompt ${prompt.id} has ${responseCount} submitted response(s); continuing close-notification dispatch`);

    // Step 2 — resolve recipient per the LOCKED rule (D-ADAPT-05).
    // 2a: the candidate is the stored creator — the manual poll's creator, or
    //     for an auto-prompt the creator of the schedule that fired it, falling
    //     back to the settings row's creator.
    let candidateUserId = null;
    let useOwnerFallback = false;
    if (prompt.created_by_user_id) {
      // Manual poll — candidate is the poll creator.
      candidateUserId = prompt.created_by_user_id;
    } else if (prompt.created_by_settings_id) {
      // Auto-prompt — candidate is the schedule creator. The settings row may be
      // gone or carry a NULL created_by_user_id (legacy / pre-Plan-01 row); then
      // there is no candidate and the group-owner fallback below applies.
      // D-ADAPT-03: do NOT touch GroupPromptSettings — recurring schedule
      // survives the close. Reading settings.created_by_user_id is read-only
      // and allowed.
      const settings = await GroupPromptSettings.findByPk(prompt.created_by_settings_id);
      // DECISION quick-261025-rl3 R1 (owner ruling 2026-10-26, D-ADAPT-05 amended in
      // the parent repo): the candidate is the creator of the schedule that FIRED
      // this poll, OVER the settings-row created_by_user_id (whoever first set up
      // scheduling for the group, which mailed one admin the results of another
      // admin's schedule). The schedule is matched by prompt.schedule_id with the
      // same case-insensitive comparison as decoratePromptForWire in
      // routes/availabilityPrompt.js. Residual: schedules created before this
      // change carry no created_by_user_id and fall back to the settings-row
      // creator, then the group owner. Reading the settings column first is a
      // decision, not a cleanup.
      const schedules = Array.isArray(settings?.template_config?.schedules)
        ? settings.template_config.schedules
        : [];
      const pollScheduleId = typeof prompt.schedule_id === 'string' ? prompt.schedule_id.toLowerCase() : null;
      const firingSchedule = pollScheduleId
        ? schedules.find(s => s && typeof s.id === 'string' && s.id.toLowerCase() === pollScheduleId)
        : null;
      if (firingSchedule && firingSchedule.created_by_user_id) {
        candidateUserId = firingSchedule.created_by_user_id;
      } else if (settings && settings.created_by_user_id) {
        candidateUserId = settings.created_by_user_id;
      } else {
        useOwnerFallback = true;
      }
    }
    // A prompt with neither creator column set has no candidate and no fallback
    // (unchanged): the "no recipient resolved" skip below applies.

    // 2b: keep the candidate only while they hold an ACTIVE membership in the
    //     poll's group.
    // DECISION quick-261025-rl3 BE-1: recipient must hold an active membership, OVER
    // trusting the stored creator id (a leaver keeps receiving the group's poll
    // results) and OVER clearing GroupPromptSettings.created_by_user_id on leave
    // (D-ADAPT-03 forbids writes there, and the manual-poll creator column has the
    // same gap). Leaving or removal hard-deletes the UserGroup row
    // (routes/groups.js, userGroup.destroy force: true) and clears neither creator
    // column, so the stored id alone cannot tell a member from a former member.
    let recipient = null;
    if (candidateUserId) {
      const membership = await UserGroup.findOne({
        where: { group_id: prompt.group_id, user_uuid: candidateUserId, status: 'active' },
      });
      if (membership) {
        // BSEC-01 (D-03): withContactInfo — recipient.email is read to send the email.
        recipient = await User.scope('withContactInfo').findByPk(candidateUserId);
      } else {
        console.log(`[promptLifecycle] creator of prompt ${prompt.id} is no longer an active member of group ${prompt.group_id}; falling back to the group owner`);
        useOwnerFallback = true;
      }
    }

    // 2c: group-owner fallback — see INVESTIGATION.md step (d). Reached for an
    //     auto-prompt with no candidate, or for either kind of poll whose
    //     candidate is no longer an active member. The owner is by definition an
    //     active member; if even the owner lookup fails, the "no recipient
    //     resolved" skip below applies.
    if (useOwnerFallback) {
      const ownerUg = await UserGroup.findOne({
        where: { group_id: prompt.group_id, role: 'owner', status: 'active' },
      });
      if (ownerUg && ownerUg.user_uuid) {
        // D-11 (Phase 87.1, BINT-02): UserGroup is re-keyed onto the Users.id UUID
        // surrogate (user_uuid). Reading the OLD user_id here would be undefined
        // after Plan 09 strips the column — a SILENT failure that skips the owner's
        // close email. user_uuid IS Users.id, so resolve the owner via findByPk.
        // BSEC-01 (D-03): withContactInfo — recipient.email read below.
        recipient = await User.scope('withContactInfo').findByPk(ownerUg.user_uuid);
      }
    }

    if (!recipient || !recipient.email) {
      console.warn(`[promptLifecycle] no recipient resolved for prompt ${prompt.id}; skipping email`);
      // DECISION quick-261025-rl3 R6: report to Sentry only when a creator column is
      // set (a recipient was expected and none resolved: a broken invariant), OVER
      // reporting every skip. A legacy prompt with neither creator column is a
      // normal skip and would only be noise.
      if (Sentry && (prompt.created_by_user_id || prompt.created_by_settings_id)) {
        Sentry.captureMessage('[promptLifecycle] recipient expected but none resolved', {
          level: 'warning',
          tags: { service: 'promptLifecycle' },
          extra: { promptId: prompt.id },
        });
      }
      return;
    }
    if (recipient.email_notifications_enabled === false) {
      console.log(`[promptLifecycle] recipient has email notifications disabled (prompt ${prompt.id}); skipping`);
      return;
    }

    // Step 3 — load group + (optional) game for email body.
    const group = await Group.findByPk(prompt.group_id);
    if (!group) {
      console.warn(`[promptLifecycle] group ${prompt.group_id} not found for prompt ${prompt.id}; skipping email`);
      return;
    }
    let gameName = null;
    if (prompt.game_id) {
      const game = await Game.findByPk(prompt.game_id);
      gameName = game ? game.name : null;
    }

    // Step 4a — aggregate responses into AvailabilitySuggestion rows. Idempotent
    // (heatmapService destroys + recreates per prompt). Auto-prompts pre-aggregate
    // via the suggestions API when admins open the heatmap, but manual polls
    // never had a trigger, so the close-notification email always silently
    // skipped on the "no viable suggestions" gate. Running aggregation here
    // covers all close paths uniformly.
    try {
      const heatmapService = require('./heatmapService');
      await heatmapService.aggregateResponses(prompt.id);
    } catch (aggErr) {
      console.error(`[promptLifecycle] aggregateResponses failed for prompt ${prompt.id} (continuing): ${aggErr.message}`);
    }

    // Step 4b — build top-slot list (ties allowed). Don't filter on
    // meets_minimum: true — that gate exists for the standard heatmap to hide
    // un-hostable slots, but for the close-notification email we want the
    // poll creator to see the best signal we have, even if the participant
    // count is below the game's min_players. With 1 response in a 2-person
    // group, every slot is "below minimum" but the creator still wants to
    // know the top time their one respondent picked.
    const suggestions = await AvailabilitySuggestion.findAll({
      where: { prompt_id: prompt.id },
      order: [['score', 'DESC'], ['suggested_start', 'ASC']],
    });
    if (!suggestions || suggestions.length === 0) {
      // No viable slot (no AvailabilitySuggestion rows with meets_minimum=true).
      // The suggestion engine generates these from responses; if it hasn't run
      // or the responses don't pass min-attendance threshold, there's no top
      // slot to recommend in the CTA. Skip the email.
      console.log(`[promptLifecycle] prompt ${prompt.id} has no viable AvailabilitySuggestion rows (meets_minimum=true); skipping email`);
      return;
    }
    // No PII in logs: the recipient is named by User UUID only (T-71.2-02 least exposure; Phase 91 owns the Sentry scrub).
    console.log(`[promptLifecycle] prompt ${prompt.id} resolved ${suggestions.length} suggestion(s); top score=${suggestions[0].score}; recipient user ${recipient.id}`);
    const topScore = suggestions[0].score;
    // Render all ties at the top score, sorted ascending by start time so the
    // earliest tie is rendered first.
    const topSlots = suggestions
      .filter((s) => s.score === topScore)
      .sort((a, b) => new Date(a.suggested_start) - new Date(b.suggested_start));

    // Step 5 — build the email body and send.
    const { html, text, subject } = emailService.generatePollClosedEmailTemplate({
      recipientName: recipient.username || 'there',
      groupName: group.name,
      gameName,
      topSlots,
      scheduleItBaseUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/groupPlanning`,
      promptId: prompt.id,
      groupId: prompt.group_id,
      timezone: recipient.timezone || 'UTC',
    });

    await emailService.send({
      to: recipient.email,
      subject,
      html,
      text,
      groupName: group.name,
      promptId: prompt.id,
      // D-ADAPT-01: reuse the existing `availability_prompt` email channel —
      // single mute knob covers all prompt-channel emails. NOT a new channel.
      emailType: 'availability_prompt',
    });
  } catch (err) {
    // Best-effort — close already committed. Log and swallow.
    console.error('[promptLifecycle] handlePromptClosed error (non-fatal):', err.message);
    if (Sentry) Sentry.captureException(err, { tags: { service: 'promptLifecycle' }, extra: { promptId: prompt?.id } });
  }
}

module.exports = {
  checkConsensusAndClose,
  handlePromptClosed,
};
