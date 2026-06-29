// workers/reminderWorker.js
// Processes reminder email jobs with frequency limit (max 2 per user per prompt)
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { AvailabilityPrompt, AvailabilityResponse, UserGroup, User, Group, GroupPromptSettings } = require('../models');
const { Op } = require('sequelize');
const emailService = require('../services/emailService');
const notificationService = require('../services/notificationService');
const magicTokenService = require('../services/magicTokenService');

function buildReminderEmailHtml({ recipientName, groupName, weekDescription, responseDeadline, formUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f6f9fc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:20px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;max-width:600px;width:100%">
        <tr><td style="padding:32px 40px">
          <h1 style="margin:0 0 16px;font-size:24px;font-weight:bold;color:#111827">Reminder: Hey ${recipientName}!</h1>
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#333">${groupName} is still waiting for your availability ${weekDescription}. Don't forget to submit!</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;text-align:center">
            <tr><td align="center">
              <a href="${formUrl}" target="_blank" style="display:inline-block;padding:12px 24px;background:#4F46E5;color:#fff;text-decoration:none;border-radius:5px;font-weight:bold;font-size:16px">Submit Your Availability</a>
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
    console.warn('[ReminderWorker] Sentry not available:', err.message);
  }
}

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
});

const MAX_REMINDERS_PER_USER = 2;

const reminderWorker = new Worker('reminders', async (job) => {
  const { promptId, reminderType, groupId } = job.data;
  console.log(`[ReminderWorker] Processing ${reminderType} reminder for prompt ${promptId}`);

  // Verify prompt is still active
  const prompt = await AvailabilityPrompt.findByPk(promptId);
  if (!prompt || prompt.status !== 'active') {
    console.log(`[ReminderWorker] Prompt ${promptId} not active, skipping`);
    return { skipped: true, reason: 'prompt_not_active' };
  }

  // Get group info
  const group = await Group.findByPk(prompt.group_id);
  if (!group) {
    return { skipped: true, reason: 'group_not_found' };
  }

  // Load group prompt settings for token expiry configuration
  const settings = await GroupPromptSettings.findOne({
    where: { group_id: prompt.group_id }
  });
  const expiryHours = settings?.default_token_expiry_hours || 168;

  // Get active group members only (exclude pending/declined invites).
  // DB-level filter narrows the load to users with email globally enabled;
  // notificationService.getPreference below enforces the final per-type
  // routing decision (defense-in-depth -- master toggle + per-type toggle).
  const memberships = await UserGroup.findAll({
    where: { group_id: prompt.group_id, status: 'active' },
    include: [{
      // BSEC-01 (D-03): withContactInfo — user.email is read in the reminder
      // send loop; defaultScope would strip it and silently skip everyone.
      model: User.scope('withContactInfo'),
      where: { email_notifications_enabled: { [Op.ne]: false } },
      required: true
    }]
  });

  // Phase 61 / MAIL-02: honor the per-user `reminder.email` preference set in
  // the profile UI. If a user toggled "Event Reminders" -> email OFF, we skip
  // them here. New users (notification_preferences=null) fall through to the
  // default "true" branch in getPreference, so they're included by default.
  const eligibleMemberships = memberships.filter(m =>
    notificationService.getPreference(m.User, 'reminder', 'email')
  );
  const optedOutCount = memberships.length - eligibleMemberships.length;
  if (optedOutCount > 0) {
    console.log(`[ReminderWorker] Filtered out ${optedOutCount} users who disabled reminder.email`);
  }

  // Find who has already responded (submitted_at is not null)
  const responses = await AvailabilityResponse.findAll({
    where: {
      prompt_id: promptId,
      submitted_at: { [Op.ne]: null }
    }
  });
  const respondedUserIds = new Set(responses.map(r => r.user_id));

  let remindersSent = 0;
  let skipped = 0;

  for (const membership of eligibleMemberships) {
    const user = membership.User;
    const userId = membership.user_id;

    // Skip if already responded
    if (respondedUserIds.has(userId)) {
      continue;
    }

    // Skip invalid emails
    if (!user.email || user.email.includes('@auth0')) {
      continue;
    }

    // Check reminder count (max 2 per prompt per user)
    let existingResponse = await AvailabilityResponse.findOne({
      where: { prompt_id: promptId, user_id: userId }
    });

    const reminderCount = existingResponse?.reminder_count || 0;
    if (reminderCount >= MAX_REMINDERS_PER_USER) {
      console.log(`[ReminderWorker] User ${userId} already received ${reminderCount} reminders, skipping`);
      skipped++;
      continue;
    }

    try {
      // Generate new magic token for reminder email
      const token = await magicTokenService.generateToken(
        { user_id: user.user_id, username: user.username },
        { id: prompt.id },
        expiryHours
      );
      const availabilityUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/availability-form/${token}`;

      // Send reminder email
      const reminderLabel = reminderType === '50-percent' ? 'halfway' : 'final';
      const recipientName = user.username || 'there';
      const deadlineStr = prompt.deadline
        ? prompt.deadline.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
          })
        : 'soon';
      const weekDescription = `(${reminderLabel} reminder)`;
      const html = buildReminderEmailHtml({ recipientName, groupName: group.name, weekDescription, responseDeadline: deadlineStr, formUrl: availabilityUrl });
      const text = `Hi ${recipientName},\n\nReminder: ${group.name} is still waiting for your availability ${weekDescription}.\n\nSubmit here: ${availabilityUrl}\n\nPlease respond by ${deadlineStr}.\n\nSent by NextGameNight on behalf of ${group.name}`;

      await emailService.send({
        to: user.email,
        subject: `Reminder: ${group.name} - Submit your availability`,
        html,
        text,
        groupName: group.name,
        promptId: promptId,
        emailType: 'reminder'
      });

      // Track reminder (upsert to create or update placeholder record)
      if (existingResponse) {
        await existingResponse.update({
          last_reminded_at: new Date(),
          reminder_count: reminderCount + 1
        });
      } else {
        await AvailabilityResponse.create({
          prompt_id: promptId,
          user_id: userId,
          time_slots: [],
          user_timezone: 'UTC',
          submitted_at: null, // Not submitted yet - this is a placeholder
          last_reminded_at: new Date(),
          reminder_count: 1
        });
      }

      remindersSent++;
      if (Sentry) {
        Sentry.metrics.count('reminder_email.sent', 1, {
          attributes: { reminder_type: reminderType }
        });
      }
    } catch (err) {
      console.error(`[ReminderWorker] Failed to send reminder to ${user.email}:`, err.message);
    }
  }

  console.log(`[ReminderWorker] Sent ${remindersSent} reminders, skipped ${skipped} (max reached)`);
  return { promptId, reminderType, remindersSent, skipped };
}, {
  connection,
  concurrency: 2 // Lower concurrency for reminders to avoid email rate limits
});

/**
 * BullMQ `failed` event hook — also exported so tests can assert the
 * Sentry escalation path without invoking the real Worker/Redis.
 *
 * @param {object} job - BullMQ job (may be undefined in some failure modes)
 * @param {Error} err
 */
function handleJobFailed(job, err) {
  console.error(`[ReminderWorker] Job ${job && job.id} failed:`, err && err.message);

  // Escalate to Sentry so async job failures aren't silent (DSN-gated).
  if (Sentry) {
    Sentry.captureException(err, {
      tags: { worker: 'reminder', job_id: job && job.id }
    });
  }
}

reminderWorker.on('failed', handleJobFailed);

reminderWorker.on('completed', (job, result) => {
  console.log(`[ReminderWorker] Job ${job.id} completed:`, result);
});

module.exports = reminderWorker;
module.exports.handleJobFailed = handleJobFailed;
