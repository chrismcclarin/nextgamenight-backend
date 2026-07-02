// workers/reminderWorker.js
// Processes reminder email jobs with frequency limit (max 2 per user per prompt)
const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { AvailabilityPrompt, AvailabilityResponse, UserGroup, User, Group, GroupPromptSettings } = require('../models');
const { Op, UniqueConstraintError } = require('sequelize');
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

/**
 * Reminder job handler — extracted from the inline anonymous Worker callback so
 * it is directly unit-testable (double-invokable in a test without a live
 * BullMQ/Redis runtime). Exported as `module.exports.processReminderJob`.
 *
 * Idempotency (T-87-12): the DB claim is moved BEFORE the email side effect
 * (D-04 claim-then-send). For each eligible non-responder we advance
 * reminder_count from the immediately-prior value to THIS reminder's expected
 * value with an atomic conditional UPDATE, and only send if we won exactly one
 * row. A same-job BullMQ retry after a crash finds the row already at the
 * expected value, claims 0 rows, and skips the send — so a retry never
 * double-sends the same reminder. The MAX_REMINDERS_PER_USER cap remains as an
 * additional cumulative ceiling on top of the per-reminder claim.
 *
 * @param {import('bullmq').Job} job
 */
async function processReminderJob(job) {
  const { promptId, reminderType, groupId } = job.data;
  console.log(`[ReminderWorker] Processing ${reminderType} reminder for prompt ${promptId}`);

  // Derive the expected post-claim reminder_count for THIS reminder from the
  // job's reminderType. The scheduler only ever emits the literal strings
  // '50-percent' and '90-percent' (services/reminderService.js:36,50):
  //   '50-percent' → 1st reminder  → expected reminder_count 1
  //   '90-percent' → 2nd/final     → expected reminder_count 2
  // NOTE: 'final' is ONLY a human display label (see reminderLabel below), it is
  // NEVER a reminderType value — the claim must NOT be keyed off it (mapping the
  // 90-percent reminder to expected=1 would make its claim WHERE count=0 miss the
  // already-advanced row and silently never send).
  let expectedCount;
  if (reminderType === '50-percent') {
    expectedCount = 1;
  } else if (reminderType === '90-percent') {
    expectedCount = 2;
  } else {
    console.warn(`[ReminderWorker] Unknown reminderType "${reminderType}" for prompt ${promptId}; skipping`);
    return { skipped: true, reason: 'unknown_reminder_type' };
  }

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

    // Check reminder count (max 2 per prompt per user) — cumulative ceiling.
    let existingResponse = await AvailabilityResponse.findOne({
      where: { prompt_id: promptId, user_id: userId }
    });

    const reminderCount = existingResponse?.reminder_count || 0;
    if (reminderCount >= MAX_REMINDERS_PER_USER) {
      console.log(`[ReminderWorker] User ${userId} already received ${reminderCount} reminders, skipping`);
      skipped++;
      continue;
    }

    // CLAIM-BEFORE-SEND (T-87-12, D-04). Monotonic-below-target claim keyed to
    // THIS specific reminder: advance reminder_count → :expected with an atomic
    // conditional UPDATE guarded by `reminder_count < :expected`, and only send
    // if we won exactly one row. A same-job retry finds the row already at
    // :expected (WHERE reminder_count < :expected matches 0 rows) and skips —
    // never double-sending — and the MAX(2) ceiling holds because :expected is
    // capped at 2. Using `< :expected` (not `= :expected-1`) also correctly
    // claims a row stuck below the prior rung — e.g. a 90-percent job (expected
    // 2) reaching a genuine non-responder whose row is still at 0 because the
    // admin manual-remind placeholder seeded it at 0 and the 50-percent job
    // never advanced it (adversarial review #2). This is schema-free (no new
    // sent_* columns / migration): the predicate rides the existing
    // reminder_count column.
    let claimed = false;
    if (existingResponse) {
      const [claimCount] = await AvailabilityResponse.update(
        { reminder_count: expectedCount, last_reminded_at: new Date() },
        { where: { prompt_id: promptId, user_id: userId, reminder_count: { [Op.lt]: expectedCount } } }
      );
      claimed = claimCount === 1;
    } else {
      // No prior row — create the placeholder AT this reminder's expected value
      // (1 for 50-percent, 2 for 90-percent), NOT unconditionally 1. A
      // 90-percent no-row placeholder created at 2 means a same-job retry
      // re-finds the row at 2 (>= MAX) and never double-sends. submitted_at
      // stays null: this is a not-yet-submitted placeholder, so it must not
      // count as a response (consensus + respondedUserIds filter submitted_at
      // != null). (Requires the submitted_at NULL-able schema fix shipped in
      // this plan.)
      try {
        await AvailabilityResponse.create({
          prompt_id: promptId,
          user_id: userId,
          time_slots: [],
          user_timezone: 'UTC',
          submitted_at: null, // Not submitted yet - this is a placeholder
          last_reminded_at: new Date(),
          reminder_count: expectedCount
        });
        claimed = true;
      } catch (createErr) {
        if (createErr instanceof UniqueConstraintError) {
          // A concurrent worker inserted the row first — re-apply the same
          // expected-prior-value claim so we don't double-send.
          const [claimCount] = await AvailabilityResponse.update(
            { reminder_count: expectedCount, last_reminded_at: new Date() },
            { where: { prompt_id: promptId, user_id: userId, reminder_count: { [Op.lt]: expectedCount } } }
          );
          claimed = claimCount === 1;
        } else {
          throw createErr;
        }
      }
    }

    if (!claimed) {
      // Retry / concurrent double-fire: this reminder was already claimed by a
      // prior (possibly crashed-then-retried) invocation. Skip the send.
      console.log(`[ReminderWorker] Reminder ${reminderType} for user ${userId} already claimed (row not below ${expectedCount}); skipping send`);
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

      // reminder_count / last_reminded_at were already advanced by the
      // claim-before-send step above (D-04) — no post-send tracking here.
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
}

const reminderWorker = new Worker('reminders', processReminderJob, {
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
// Exported for unit tests: the extracted handler is double-invokable without a
// live BullMQ/Redis runtime so the claim-before-send idempotency can be proven.
module.exports.processReminderJob = processReminderJob;
