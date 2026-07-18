// workers/promptWorker.js
// Processes scheduled prompt sending jobs
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { Op } = require('sequelize');
const { AvailabilityPrompt, Group, GroupPromptSettings, UserGroup, User, Game } = require('../models');
const magicTokenService = require('../services/magicTokenService');
const emailService = require('../services/emailService');
const { scheduleReminders, scheduleDeadlineJob } = require('../services/reminderService');
const { isUuid } = require('../utils/resolveTargetUser');

function buildPromptEmailHtml({ recipientName, groupName, gameName, weekDescription, responseDeadline, formUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:600px;width:100%">
        <tr><td style="padding:32px 40px">
          <h1 style="margin:0 0 16px;font-size:24px;font-weight:bold;color:#111827">Hey ${recipientName}!</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333">${groupName} is planning a ${gameName} session! Let us know when you're free ${weekDescription}.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;text-align:center">
            <tr><td align="center">
              <a href="${formUrl}" target="_blank" style="display:inline-block;padding:12px 24px;background:#4F46E5;color:#fff;text-decoration:none;border-radius:5px;font-weight:bold;font-size:16px">When Can You Play?</a>
            </td></tr>
          </table>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333">Please respond by ${responseDeadline} so we can find a time that works for everyone.</p>
        </td></tr>
        <tr><td style="padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center">
          <p style="margin:0;font-size:12px;color:#6b7280">Sent by NextGameNight on behalf of ${groupName}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// Optional Sentry integration
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
  } catch (err) {
    console.warn('[PromptWorker] Sentry not available:', err.message);
  }
}

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

// Helper: Get ISO week identifier (e.g., "2026-W07")
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Helper: Calculate deadline from hours
function calculateDeadline(deadlineHours) {
  return new Date(Date.now() + deadlineHours * 60 * 60 * 1000);
}

/**
 * Prompt job handler — extracted from the inline anonymous Worker callback so it
 * is directly unit-testable against the real test DB (invokable without a live
 * BullMQ/Redis runtime). Exported as `module.exports.processPromptJob`. This is
 * the load-bearing surface for the A1 selected-member-subset proof (Pitfall 4):
 * a mock could not catch a silent zero-match on the UserGroup→User join.
 *
 * @param {import('bullmq').Job} job
 */
async function processPromptJob(job) {
  const { groupId, settingsId, scheduleId, timezone, deadlineMinutes } = job.data;
  console.log(`[PromptWorker] Processing job for group ${groupId} schedule ${scheduleId || '(legacy)'}`);

  // Get settings first — we need the nested schedule object before we can
  // build a per-schedule dedup key.
  const settings = await GroupPromptSettings.findByPk(settingsId);
  if (!settings) {
    throw new Error(`GroupPromptSettings ${settingsId} not found`);
  }

  // Resolve the specific nested schedule that fired this job.
  const allSchedules = settings.template_config?.schedules || [];
  let triggeringSchedule = null;
  if (scheduleId) {
    triggeringSchedule = allSchedules.find(s => s.id === scheduleId) || null;
    if (!triggeringSchedule) {
      // Schedule was deleted between fire and process — idempotent no-op.
      console.log(`[PromptWorker] Schedule ${scheduleId} no longer exists in settings ${settingsId}, skipping`);
      return { skipped: true, reason: 'schedule_deleted', scheduleId };
    }
    if (triggeringSchedule.deleted_at || triggeringSchedule.is_active === false) {
      console.log(`[PromptWorker] Schedule ${scheduleId} is deleted/inactive, skipping`);
      return { skipped: true, reason: 'schedule_inactive', scheduleId };
    }
  } else {
    // Legacy job (pre-fix) lacking scheduleId — fall back to "first active
    // schedule on today's day-of-week", same heuristic as before. Logged so
    // we can confirm legacy jobs drain after one cycle.
    console.warn(`[PromptWorker] Legacy job without scheduleId for group ${groupId} — using day-of-week heuristic`);
    const currentDayOfWeek = new Date().getDay();
    const activeSchedules = allSchedules.filter(s => s.is_active !== false && !s.deleted_at);
    triggeringSchedule = activeSchedules.find(s => s.schedule_day_of_week === currentDayOfWeek) || activeSchedules[0] || null;
  }

  // Per-schedule dedup key — prevents two schedules in the same group/week
  // (e.g., Tue Catan + Sat Wingspan) from colliding on the existing-prompt check.
  const weekIdentifier = getISOWeek(new Date());
  const dedupScheduleKey = triggeringSchedule?.id || scheduleId || 'legacy';
  const dedupKey = `${weekIdentifier}-${dedupScheduleKey}`;

  const existingPrompt = await AvailabilityPrompt.findOne({
    where: { group_id: groupId, week_identifier: dedupKey }
  });

  if (existingPrompt) {
    console.log(`[PromptWorker] Prompt already exists for ${dedupKey}, skipping`);
    return { skipped: true, reason: 'duplicate_week', promptId: existingPrompt.id };
  }

  const scheduleGameId = triggeringSchedule?.game_id || null;
  const selectedMemberIds = Array.isArray(triggeringSchedule?.selected_member_ids)
    ? triggeringSchedule.selected_member_ids
    : [];

  // Look up game name if game_id exists
  let gameName = 'Game TBD';
  if (scheduleGameId) {
    const game = await Game.findByPk(scheduleGameId);
    if (game) {
      gameName = game.name;
    }
    // If game not found (deleted), gameName stays 'Game TBD'
  }

  // Deadline: prefer schedule's own override, then settings, then 72h default.
  const effectiveDeadlineHours = triggeringSchedule?.default_deadline_hours
    || settings.default_deadline_hours
    || 72;
  const deadline = deadlineMinutes
    ? new Date(Date.now() + deadlineMinutes * 60 * 1000)
    : calculateDeadline(effectiveDeadlineHours);

  const tokenExpiryHours = triggeringSchedule?.default_token_expiry_hours
    || settings.default_token_expiry_hours
    || 168;

  // Create the prompt — week_identifier uses the per-schedule dedup key so
  // multiple weekly schedules per group don't collide.
  const prompt = await AvailabilityPrompt.create({
    group_id: groupId,
    game_id: scheduleGameId,
    prompt_date: new Date(),
    deadline,
    status: 'pending',
    week_identifier: dedupKey,
    auto_schedule_enabled: true,
    blind_voting_enabled: settings.template_config?.blind_voting || false
  });

  // Get active group members. If the schedule targets a specific subset of
  // members (selected_member_ids), filter to those — otherwise email everyone.
  //
  // A1 (Pitfall 4): selected_member_ids now stores Users.id UUIDs. The Plan 04
  // backfill + Plan 11 PR-2 re-sweep converted the stored keyspace, the FE writes
  // UUIDs, and BOTH groupPromptSettings write handlers normalize any stale-tab sub
  // residue to UUID before persist — so a sub-shaped entry is stale. The
  // UserGroup→User join resolves on user_uuid (the flipped association).
  const userInclude = {
    // BSEC-01 (D-03): withContactInfo — user.email is read in the prompt
    // send loop; defaultScope would strip it and silently skip everyone.
    model: User.scope('withContactInfo'),
    required: true
  };
  if (selectedMemberIds.length > 0) {
    // PR-2 contract (D-07): the dual-read window is CLOSED. Filter selectedMemberIds
    // through the UUID shape check BEFORE the [Op.in] clause — a stale sub-shaped
    // entry is silently EXCLUDED rather than compared against the UUID `id` column
    // (that comparison throws Postgres 22P02 and would crash the WHOLE group's
    // fanout, not just the stale entry). The whole-group guard above is evaluated on
    // the ORIGINAL, unfiltered selectedMemberIds array, so an all-stale-sub row still
    // takes THIS selected-members branch (filtered [Op.in] list empty → matches
    // nobody) rather than falling back to the whole group. BOTH fanout sites contract
    // together (Pitfall 4) — services/promptInvitationService.js has the identical clause.
    userInclude.where = { id: { [Op.in]: selectedMemberIds.filter(isUuid) } };
  }
  const memberships = await UserGroup.findAll({
    where: { group_id: groupId, status: 'active' },
    include: [userInclude]
  });

  const group = await Group.findByPk(groupId);
  let emailsSent = 0;

  // Send emails to each member
  for (const membership of memberships) {
    const user = membership.User;
    if (!user.email || user.email.includes('@auth0')) continue;

    try {
      // Generate magic token for this user (per-schedule expiry override).
      const token = await magicTokenService.generateToken(
        { user_id: user.user_id, username: user.username },
        { id: prompt.id },
        tokenExpiryHours
      );
      const availabilityUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/availability-form/${token}`;

      const recipientName = user.username || 'there';
      const deadlineStr = prompt.deadline
        ? prompt.deadline.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
          })
        : 'soon';
      const html = buildPromptEmailHtml({ recipientName, groupName: group.name, gameName, weekDescription: weekIdentifier, responseDeadline: deadlineStr, formUrl: availabilityUrl });
      const text = `Hi ${recipientName},\n\n${group.name} is planning a ${gameName} session! Let us know when you're free ${weekIdentifier}.\n\nRespond here: ${availabilityUrl}\n\nPlease respond by ${deadlineStr}.\n\nSent by NextGameNight on behalf of ${group.name}`;

      await emailService.send({
        to: user.email,
        subject: `${group.name} - ${gameName} - When are you available?`,
        html,
        text,
        groupName: group.name,
        promptId: prompt.id,
        emailType: 'availability_prompt'
      });
      emailsSent++;
      if (Sentry) {
        Sentry.metrics.count('availability_email.sent', 1, {
          attributes: { group_id: String(groupId), email_type: 'availability_prompt' }
        });
      }
    } catch (err) {
      console.error(`[PromptWorker] Failed to send email to ${user.email}:`, err.message);
    }
  }

  // Update prompt status to active
  await prompt.update({ status: 'active' });
  if (Sentry) {
    Sentry.metrics.count('availability_prompt.created', 1, {
      attributes: { group_id: String(groupId) }
    });
  }

  // Schedule reminder and deadline jobs now that the prompt is active
  try {
    await scheduleReminders(prompt);
    await scheduleDeadlineJob(prompt);
  } catch (scheduleErr) {
    // Log but don't fail the job — emails were already sent
    console.error(`[PromptWorker] Failed to schedule reminders/deadline for ${prompt.id}:`, scheduleErr.message);
  }

  console.log(`[PromptWorker] Created prompt ${prompt.id}, sent ${emailsSent} emails`);
  return { promptId: prompt.id, recipientCount: emailsSent };
}

const promptWorker = new Worker('prompts', processPromptJob, {
  connection,
  concurrency: 3 // Process up to 3 prompt jobs simultaneously
});

/**
 * BullMQ `failed` event hook — also exported so tests can assert the
 * Sentry escalation path without invoking the real Worker/Redis.
 *
 * @param {object} job - BullMQ job (may be undefined in some failure modes)
 * @param {Error} err
 */
function handleJobFailed(job, err) {
  console.error(`[PromptWorker] Job ${job && job.id} failed:`, err && err.message);

  // Escalate to Sentry so async job failures aren't silent (DSN-gated).
  if (Sentry) {
    Sentry.captureException(err, {
      tags: { worker: 'prompt', job_id: job && job.id }
    });
  }
}

promptWorker.on('failed', handleJobFailed);

promptWorker.on('completed', (job, result) => {
  console.log(`[PromptWorker] Job ${job.id} completed:`, result);
});

module.exports = promptWorker;
module.exports.handleJobFailed = handleJobFailed;
// Exported for unit tests: the extracted handler is double-invokable without a
// live BullMQ/Redis runtime so the A1 selected-member-subset bridge (Pitfall 4)
// can be proven against the real test DB.
module.exports.processPromptJob = processPromptJob;
