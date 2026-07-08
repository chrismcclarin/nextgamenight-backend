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
// LOCKED recipient resolution rule (D-ADAPT-05 + D-SCHEMA-06):
//   Manual:  recipient = User.findByPk(prompt.created_by_user_id)
//   Auto:    settings = GroupPromptSettings.findByPk(prompt.created_by_settings_id)
//            recipient = settings.created_by_user_id
//              ? User.findByPk(settings.created_by_user_id)
//              : <group owner via UserGroup role='owner' → User.user_id Auth0 sub>
//
// Note: the Group model has NO owner_id column in this codebase. Group ownership
// is determined by `UserGroup.role === 'owner', status='active'`. UserGroup.user_id
// is an Auth0 sub STRING, NOT a User.id UUID, so the owner-fallback path uses
// User.findOne({ where: { user_id } }) NOT User.findByPk. See INVESTIGATION.md
// step (d) for the full reasoning.
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
    // (id, group_id, created_by_user_id, created_by_settings_id, game_id) and
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
 *   - recipient cannot be resolved or has no email
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
    let recipient = null;
    if (prompt.created_by_user_id) {
      // Manual poll — recipient is the poll creator.
      // BSEC-01 (D-03): withContactInfo — recipient.email is read to send the email.
      recipient = await User.scope('withContactInfo').findByPk(prompt.created_by_user_id);
    } else if (prompt.created_by_settings_id) {
      // Auto-prompt — recipient is the schedule creator, falling back to the
      // group owner if the settings row is gone or has NULL created_by_user_id
      // (legacy / pre-Plan-01 row).
      // D-ADAPT-03: do NOT touch GroupPromptSettings — recurring schedule
      // survives the close. Reading settings.created_by_user_id is read-only
      // and allowed.
      const settings = await GroupPromptSettings.findByPk(prompt.created_by_settings_id);
      if (settings && settings.created_by_user_id) {
        // BSEC-01 (D-03): withContactInfo — recipient.email read below.
        recipient = await User.scope('withContactInfo').findByPk(settings.created_by_user_id);
      } else {
        // Group-owner fallback — see INVESTIGATION.md step (d).
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
    }

    if (!recipient || !recipient.email) {
      console.warn(`[promptLifecycle] no recipient resolved for prompt ${prompt.id}; skipping email`);
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
    console.log(`[promptLifecycle] prompt ${prompt.id} resolved ${suggestions.length} suggestion(s); top score=${suggestions[0].score}; recipient=${recipient.email}`);
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
  }
}

module.exports = {
  checkConsensusAndClose,
  handlePromptClosed,
};
