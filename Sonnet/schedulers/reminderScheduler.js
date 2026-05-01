// schedulers/reminderScheduler.js
// SMS reminder scheduler for upcoming events
const cron = require('node-cron');
const { Event, EventRsvp, User, Game, Group } = require('../models');
const { Op } = require('sequelize');
const smsService = require('../services/smsService');
const { recordRun } = require('../services/schedulerHealthService');

// Check interval - default every 5 minutes, configurable via env
const REMINDER_CHECK_INTERVAL = process.env.REMINDER_CHECK_INTERVAL || '*/5 * * * *';
const DEFAULT_REMINDER_WINDOW_HOURS = 1;

/**
 * Compute a human-friendly "time until" string
 * @param {Date} eventStart - Event start date
 * @param {Date} now - Current time
 * @param {string} [timezone='UTC'] - IANA timezone for "today/tomorrow at" formatting
 * @returns {string} Friendly relative time string
 */
function formatTimeUntil(eventStart, now, timezone = 'UTC') {
  const diffMs = eventStart.getTime() - now.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);

  if (diffMinutes < 60) {
    return `in about ${diffMinutes} minutes`;
  }
  if (diffMinutes < 120) {
    return 'in about 1 hour';
  }
  if (diffHours <= 6) {
    return `in ${diffHours} hours`;
  }

  // 6-24 hours: "today at HH:MM TZ" or "tomorrow at HH:MM TZ"
  // Use Intl API to format in the recipient's timezone
  const eventDayStr = eventStart.toLocaleDateString('en-CA', { timeZone: timezone });
  const nowDayStr = now.toLocaleDateString('en-CA', { timeZone: timezone });

  const timeStr = eventStart.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
    timeZoneName: 'short',
  });

  if (eventDayStr === nowDayStr) {
    return `today at ${timeStr}`;
  }
  return `tomorrow at ${timeStr}`;
}

/**
 * Process upcoming events and send SMS reminders to RSVP'd users
 */
async function processUpcomingReminders() {
  const now = new Date();
  const maxWindow = new Date(now.getTime() + 24 * 3600000); // 24 hours from now

  // Find all upcoming events with un-reminded RSVP'd users who have SMS enabled
  const upcomingEvents = await Event.findAll({
    where: {
      start_date: {
        [Op.gt]: now,
        [Op.lte]: maxWindow
      }
    },
    include: [
      { model: Game, attributes: ['name'] },
      { model: Group, attributes: ['id', 'name'] },
      {
        model: EventRsvp,
        where: {
          status: { [Op.in]: ['yes', 'maybe'] },
          reminder_sent_at: null
        },
        required: true,
        include: [{
          model: User,
          attributes: ['user_id', 'phone', 'phone_verified', 'sms_enabled', 'notification_preferences', 'timezone'],
          where: {
            sms_enabled: true,
            phone: { [Op.ne]: null }
          },
          required: true
        }]
      }
    ]
  });

  let sentCount = 0;
  let skippedCount = 0;

  for (const event of upcomingEvents) {
    const eventName = event.Game ? event.Game.name : 'Game Night';
    const groupName = event.Group ? event.Group.name : 'your group';
    const groupId = event.Group ? event.Group.id : null;
    const eventUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/groupHomePage?group_id=${groupId}`;

    for (const rsvp of event.EventRsvps) {
      const user = rsvp.User;

      // Determine user's reminder window (default 1 hour)
      const windowHours = user.notification_preferences?.reminder?.window_hours
        || DEFAULT_REMINDER_WINDOW_HOURS;

      // Check if event is within this user's reminder window
      const timeDiffMs = event.start_date.getTime() - now.getTime();
      if (timeDiffMs > windowHours * 3600000) {
        skippedCount++;
        continue; // Event is outside this user's window, skip
      }

      // Only send if SMS service is configured
      if (!smsService.isConfigured()) {
        skippedCount++;
        continue;
      }

      try {
        const timeUntil = formatTimeUntil(event.start_date, now, user.timezone || 'UTC');

        const result = await smsService.send({
          to: user.phone,
          type: 'reminder',
          data: {
            eventName,
            groupName,
            timeUntil,
            eventUrl,
            rsvpPrompt: true
          }
        });

        // Only mark as sent if SMS was actually delivered successfully
        if (result.success) {
          await rsvp.update({ reminder_sent_at: new Date() });
          sentCount++;
        } else {
          // result.success === false -- leave reminder_sent_at null for retry
          skippedCount++;
        }
      } catch (error) {
        // Log but don't throw -- leave reminder_sent_at null for retry
        console.error(`[reminderScheduler] Failed to send reminder to ${user.user_id}:`, error.message);
        skippedCount++;
      }
    }
  }

  console.log(`[reminderScheduler] Sent ${sentCount} reminders for ${upcomingEvents.length} events`);
  return { sent: sentCount, skipped: skippedCount };
}

/**
 * Main scheduler job - runs every 5 minutes by default
 * Finds upcoming events and sends SMS reminders to RSVP'd users
 */
const reminderJob = cron.schedule(REMINDER_CHECK_INTERVAL, async () => {
  console.log(`[${new Date().toISOString()}] Running reminder check...`);
  try {
    // recordRun persists telemetry + sends Sentry events on throw, then re-throws
    await recordRun('reminder', () => processUpcomingReminders());
  } catch (error) {
    // recordRun already logged + reported to Sentry; preserve scheduler-level
    // log line so existing operational tooling still sees it.
    console.error('Reminder scheduler error:', error);
  }
}, {
  scheduled: false, // Don't start automatically - server.js will start it
  timezone: 'UTC'
});

module.exports = {
  reminderJob,
  processUpcomingReminders, // Export for testing
  formatTimeUntil           // Export for testing
};
