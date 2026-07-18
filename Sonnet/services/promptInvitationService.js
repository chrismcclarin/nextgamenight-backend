// services/promptInvitationService.js
//
// Phase 71.2 / Plan 03 hotfix — Fan out availability-prompt invitation emails
// to all active group members for a given prompt. Extracted from
// workers/promptWorker.js (the auto-prompt cron path) so manual polls can
// invite members through the same code path.
//
// Single source of truth for "this prompt exists, please vote" emails.
// Works for both auto-prompts and manual polls. Errors per-recipient are
// logged but do not stop the fanout.

const { Op } = require('sequelize');
const { UserGroup, User, Group, Game } = require('../models');
const magicTokenService = require('./magicTokenService');
const emailService = require('./emailService');
const { isUuid } = require('../utils/resolveTargetUser');

let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    // Sentry optional — silent fall-through.
  }
}

function buildInvitationHtml({ recipientName, groupName, gameName, weekDescription, responseDeadline, formUrl, customMessage }) {
  // HTML-escape all user-supplied strings before HTML interpolation (BSEC-04
  // / BE-111). Reuse the shared emailService.escapeHtml primitive — no new
  // escaper. weekDescription/responseDeadline are server-derived strings.
  const safeRecipientName = emailService.escapeHtml(recipientName);
  const safeGroupName = emailService.escapeHtml(groupName);
  const safeGameName = emailService.escapeHtml(gameName);
  const safeCustomMessage = emailService.escapeHtml(customMessage);
  const customBlock = customMessage
    ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#444;background:#f3f4f6;padding:12px 16px;border-radius:6px;font-style:italic">"${safeCustomMessage}"</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:600px;width:100%">
        <tr><td style="padding:32px 40px">
          <h1 style="margin:0 0 16px;font-size:24px;font-weight:bold;color:#111827">Hey ${safeRecipientName}!</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333">${safeGroupName} is planning a ${safeGameName} session! Let us know when you're free ${weekDescription}.</p>
          ${customBlock}
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;text-align:center">
            <tr><td align="center">
              <a href="${formUrl}" target="_blank" style="display:inline-block;padding:12px 24px;background:#4F46E5;color:#fff;text-decoration:none;border-radius:5px;font-weight:bold;font-size:16px">When Can You Play?</a>
            </td></tr>
          </table>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333">Please respond by ${responseDeadline} so we can find a time that works for everyone.</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center">
          <p style="margin:0;font-size:12px;color:#6b7280">Sent by NextGameNight on behalf of ${safeGroupName}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Fan out invitation emails to active members of the group for the given prompt.
 *
 * @param {Object} prompt - Hydrated AvailabilityPrompt instance.
 * @param {Object} [options]
 * @param {string[]} [options.selectedMemberIds] - If set, only these Auth0
 *   user_ids are invited (matches auto-prompt schedule.selected_member_ids).
 *   Manual polls leave this undefined → all active members.
 * @param {number} [options.tokenExpiryHours=168] - Magic-token TTL in hours.
 * @returns {Promise<{sent: number, failed: number}>}
 */
async function notifyMembersOfPrompt(prompt, { selectedMemberIds, tokenExpiryHours = 168 } = {}) {
  if (!prompt) {
    return { sent: 0, failed: 0 };
  }

  if (!emailService.isConfigured()) {
    console.warn(`[promptInvitation] email service not configured; skipping fanout for prompt ${prompt.id}`);
    return { sent: 0, failed: 0 };
  }

  const group = await Group.findByPk(prompt.group_id);
  if (!group) {
    console.warn(`[promptInvitation] group ${prompt.group_id} not found for prompt ${prompt.id}; skipping fanout`);
    return { sent: 0, failed: 0 };
  }

  let gameName = 'Game TBD';
  if (prompt.game_id) {
    const game = await Game.findByPk(prompt.game_id);
    if (game) gameName = game.name;
  }

  // A1 (Phase 87.1, BINT-02): schedule.selected_member_ids now stores Users.id
  // UUIDs (Plan 04 backfill + Plan 11 PR-2 re-sweep; FE writes UUIDs; both write
  // handlers normalize sub residue before persist). Keep UserGroup keyed on the
  // group and scope the selected subset through the User include's UUID `id`.
  const userInclude = {
    model: User.scope('withContactInfo'),
    required: true,
  };
  if (Array.isArray(selectedMemberIds) && selectedMemberIds.length > 0) {
    // PR-2 contract (D-07): the dual-read window is CLOSED. Filter selectedMemberIds
    // through the UUID shape check BEFORE the [Op.in] clause — a stale sub-shaped
    // entry is silently EXCLUDED rather than compared against the UUID `id` column
    // (that comparison throws Postgres 22P02 and would crash the WHOLE group's
    // fanout, not just the stale entry). The whole-group guard above is evaluated on
    // the ORIGINAL, unfiltered selectedMemberIds array, so an all-stale-sub row still
    // takes THIS selected-members branch (filtered [Op.in] list empty → matches
    // nobody) rather than falling back to the whole group. BOTH fanout sites contract
    // together (Pitfall 4) — workers/promptWorker.js has the identical clause.
    userInclude.where = { id: { [Op.in]: selectedMemberIds.filter(isUuid) } };
  }
  const memberships = await UserGroup.findAll({
    where: { group_id: prompt.group_id, status: 'active' },
    // BSEC-01 (D-03): include the contact-info scope so user.email is present
    // for the invitation send loop; defaultScope would strip it (Pitfall 4).
    include: [userInclude],
  });

  const weekDescription = prompt.week_identifier || 'this week';

  // Per-recipient deadline format — applied inside the loop so each user sees
  // the deadline in their own profile timezone (Plan 03 hotfix).
  const formatDeadlineForUser = (userTz) => {
    if (!prompt.deadline) return 'soon';
    return new Date(prompt.deadline).toLocaleString('en-US', {
      timeZone: userTz || 'UTC',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  };

  let sent = 0;
  let failed = 0;
  for (const membership of memberships) {
    const user = membership.User;
    if (!user || !user.email || user.email.includes('@auth0')) continue;
    if (user.email_notifications_enabled === false) continue;
    const deadlineStr = formatDeadlineForUser(user.timezone);

    try {
      const token = await magicTokenService.generateToken(
        { user_id: user.user_id, username: user.username },
        { id: prompt.id },
        tokenExpiryHours
      );
      const formUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/availability-form/${token}`;
      const recipientName = user.username || 'there';
      const html = buildInvitationHtml({
        recipientName,
        groupName: group.name,
        gameName,
        weekDescription,
        responseDeadline: deadlineStr,
        formUrl,
        customMessage: prompt.custom_message || null,
      });
      const customBlockText = prompt.custom_message ? `\n\n"${prompt.custom_message}"` : '';
      const text = `Hi ${recipientName},\n\n${group.name} is planning a ${gameName} session! Let us know when you're free ${weekDescription}.${customBlockText}\n\nRespond here: ${formUrl}\n\nPlease respond by ${deadlineStr}.\n\nSent by NextGameNight on behalf of ${group.name}`;

      const result = await emailService.send({
        to: user.email,
        subject: `${group.name} - ${gameName} - When are you available?`,
        html,
        text,
        groupName: group.name,
        promptId: prompt.id,
        emailType: 'availability_prompt',
      });

      if (result && result.success) {
        sent++;
        if (Sentry) {
          Sentry.metrics.count('availability_email.sent', 1, {
            attributes: { group_id: String(prompt.group_id), email_type: 'availability_prompt' },
          });
        }
      } else {
        failed++;
        console.warn(`[promptInvitation] send failed for ${user.email}: ${result?.error || 'unknown'}`);
      }
    } catch (err) {
      failed++;
      console.error(`[promptInvitation] error sending to ${user.email}: ${err.message}`);
    }
  }

  console.log(`[promptInvitation] prompt ${prompt.id} fanout complete: sent=${sent} failed=${failed} of ${memberships.length} members`);
  return { sent, failed };
}

module.exports = { notifyMembersOfPrompt };
