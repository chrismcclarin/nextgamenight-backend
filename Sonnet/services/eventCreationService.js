// services/eventCreationService.js
// Service for converting availability suggestions into confirmed events

const {
  AvailabilitySuggestion,
  AvailabilityPrompt,
  Event,
  EventParticipation,
  User,
  Group,
  Game,
  sequelize
} = require('../models');
const emailService = require('./emailService');
const tentativeHoldService = require('./tentativeHoldService');

/**
 * Calculate duration in minutes between two dates
 * @param {Date|string} start - Start date
 * @param {Date|string} end - End date
 * @returns {number} Duration in minutes, defaults to 60 if calculation fails
 */
function calculateDuration(start, end) {
  try {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const durationMs = endDate.getTime() - startDate.getTime();
    const durationMinutes = Math.round(durationMs / 60000);

    // Sanity check: return 60 if result is invalid
    if (isNaN(durationMinutes) || durationMinutes <= 0) {
      console.warn('Invalid duration calculated, defaulting to 60 minutes');
      return 60;
    }

    return durationMinutes;
  } catch (error) {
    console.error('Error calculating duration:', error);
    return 60;
  }
}

/**
 * Format date for email display
 * @param {Date|string} date - Date to format
 * @param {string} [timezone] - Optional IANA timezone string
 * @returns {string} Formatted date string (e.g., "Saturday, February 15, 2026")
 */
function formatDateForEmail(date, timezone) {
  const d = new Date(date);
  const options = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  };
  if (timezone) {
    options.timeZone = timezone;
    options.timeZoneName = 'short';
  }
  return d.toLocaleDateString('en-US', options);
}

/**
 * Format time for email display
 * @param {Date|string} date - Date to format
 * @param {string} [timezone] - Optional IANA timezone string
 * @returns {string} Formatted time string (e.g., "7:00 PM EST")
 */
function formatTimeForEmail(date, timezone) {
  const d = new Date(date);
  const options = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  if (timezone) {
    options.timeZone = timezone;
    options.timeZoneName = 'short';
  }
  return d.toLocaleTimeString('en-US', options);
}

/**
 * Convert an availability suggestion to a confirmed event
 *
 * This function atomically:
 * 1. Creates the Event record
 * 2. Creates EventParticipation records for all available participants
 * 3. Marks the suggestion as converted
 * 4. Sends confirmation emails (fire-and-forget)
 *
 * @param {string} suggestionId - UUID of the AvailabilitySuggestion to convert
 * @param {string} creatorUserId - Auth0 user_id of the user creating the event
 * @param {Object} options - Optional configuration
 * @param {string} [options.comments] - Override comments for the event
 * @param {boolean} [options.sendEmails=true] - Whether to send confirmation emails
 * @returns {Promise<{success: boolean, event_id?: string, message: string, event?: Object}>}
 */
async function convertSuggestionToEvent(suggestionId, creatorUserId, options = {}) {
  const transaction = await sequelize.transaction();

  try {
    // 1. Fetch suggestion with FOR UPDATE lock to prevent race conditions
    const suggestion = await AvailabilitySuggestion.findByPk(suggestionId, {
      include: [{
        model: AvailabilityPrompt,
        include: [
          { model: Group },
          { model: Game, required: false }
        ]
      }],
      lock: transaction.LOCK.UPDATE,
      transaction
    });

    // Validate suggestion exists
    if (!suggestion) {
      await transaction.rollback();
      return {
        success: false,
        message: 'Suggestion not found'
      };
    }

    // Check if already converted
    if (suggestion.converted_to_event_id) {
      await transaction.rollback();
      return {
        success: false,
        message: 'Suggestion already converted to event',
        event_id: suggestion.converted_to_event_id
      };
    }

    const prompt = suggestion.AvailabilityPrompt;
    if (!prompt) {
      await transaction.rollback();
      return {
        success: false,
        message: 'Associated prompt not found'
      };
    }

    const group = prompt.Group;
    const game = prompt.Game;

    // 2. Calculate duration from suggested time slot
    const durationMinutes = calculateDuration(
      suggestion.suggested_start,
      suggestion.suggested_end
    );

    // 3. Create Event within transaction
    const eventComments = options.comments ||
      prompt.custom_message ||
      'Created from availability poll';

    const event = await Event.create({
      group_id: prompt.group_id,
      game_id: prompt.game_id,
      start_date: suggestion.suggested_start,
      duration_minutes: durationMinutes,
      status: 'scheduled',
      comments: eventComments
    }, { transaction });

    // 4. Fetch users from participant_user_ids
    // These are Auth0 user_id strings stored in the suggestion
    const participantUserIds = suggestion.participant_user_ids || [];

    let users = [];
    if (participantUserIds.length > 0) {
      // BSEC-01 (D-03): withContactInfo — these users flow into
      // sendConfirmationEmails which reads u.email to send confirmations.
      users = await User.scope('withContactInfo').findAll({
        where: { user_id: participantUserIds },
        transaction
      });
    }

    // 5. Create EventParticipation records for each user
    // Note: EventParticipation.user_id is UUID (User.id), not Auth0 user_id
    if (users.length > 0) {
      await EventParticipation.bulkCreate(
        users.map(u => ({
          event_id: event.id,
          user_id: u.id  // Use internal UUID, not Auth0 user_id
        })),
        {
          transaction,
          ignoreDuplicates: true  // Prevent errors if somehow duplicated
        }
      );
    }

    // 6. Mark suggestion as converted
    await suggestion.update(
      { converted_to_event_id: event.id },
      { transaction }
    );

    // 7. Update prompt status if this is the first conversion
    if (prompt.status !== 'converted') {
      await prompt.update(
        { status: 'converted' },
        { transaction }
      );
    }

    // 8. Commit transaction
    await transaction.commit();

    console.log(`Successfully converted suggestion ${suggestionId} to event ${event.id}`);

    // 9. Post-commit cleanup: Remove tentative calendar holds (fire-and-forget)
    // Clean up all tentative holds for this prompt since the event is now confirmed
    tentativeHoldService.cleanupHoldsOnEventCreation(suggestionId, prompt.id)
      .catch(error => console.error('Tentative hold cleanup error:', error.message));

    // 10. Post-commit: Send confirmation emails (fire-and-forget)
    if (options.sendEmails !== false && users.length > 0) {
      sendConfirmationEmails(event, users, group, game).catch(err => {
        console.error('Error sending event confirmation emails:', err);
      });
    }

    return {
      success: true,
      event_id: event.id,
      message: `Event created with ${users.length} participants`,
      event: {
        id: event.id,
        group_id: event.group_id,
        game_id: event.game_id,
        start_date: event.start_date,
        duration_minutes: event.duration_minutes,
        status: event.status,
        participant_count: users.length
      }
    };

  } catch (error) {
    await transaction.rollback();
    console.error('Error converting suggestion to event:', error);
    throw error;
  }
}

/**
 * Send confirmation emails to event participants
 * Fire-and-forget - errors are logged but don't fail the operation
 *
 * @param {Object} event - The created Event record
 * @param {Array<User>} users - Array of User records to notify
 * @param {Object} group - The Group record
 * @param {Object|null} game - The Game record (optional)
 */
async function sendConfirmationEmails(event, users, group, game) {
  if (!emailService.isConfigured()) {
    console.log('Email service not configured, skipping confirmation emails');
    return;
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || process.env.AUTH0_BASE_URL || 'http://localhost:3000';
    // POLL-04 (D-SMS-LINK-01): use the canonical /gameDetail?event_id={id}
    // path. The previous /groups/{gid}/events/{eid} route does not exist on
    // the frontend (no app/groups/[id]/events/ directory), so the prior
    // SMS-body link 404'd. The gameDetail page already handles the
    // event_id query param (event-only branch at line 693-ish) and now
    // also renders a friendly "Event not found" state for missing/cancelled
    // event IDs (D-SMS-LINK-04).
    const eventUrl = `${frontendUrl}/gameDetail?event_id=${event.id}`;

    // Send individual emails per recipient to respect each user's timezone
    const validUsers = users.filter(u => u.email);
    if (validUsers.length === 0) {
      console.log('No valid email recipients for event confirmation');
      return;
    }

    let sent = 0;
    for (const user of validUsers) {
      const recipientTz = user.timezone || 'UTC';

      const { html, text } = generateEventConfirmationEmailTemplate({
        gameName: game?.name || 'Game Night',
        groupName: group?.name || 'Your Group',
        startDate: event.start_date,
        durationMinutes: event.duration_minutes,
        participants: users.map(u => u.username || u.name || 'Anonymous'),
        eventUrl,
        comments: event.comments,
        timezone: recipientTz,
      });

      const result = await emailService.send({
        to: user.email,
        subject: `Game Night Confirmed: ${game?.name || 'Game Night'} - ${formatDateForEmail(event.start_date, recipientTz)}`,
        html,
        text,
        groupName: group?.name,
      });

      if (result.success) sent++;
    }

    console.log(`Event confirmation emails: ${sent}/${validUsers.length} sent`);

  } catch (error) {
    console.error('Error sending confirmation emails:', error);
    // Don't throw - this is fire-and-forget
  }
}

/**
 * Generate HTML and text email templates for event confirmation
 * Uses green accent color (#10B981) to distinguish from availability prompts
 *
 * @param {Object} data - Email template data
 * @param {string} data.gameName - Name of the game
 * @param {string} data.groupName - Name of the group
 * @param {Date|string} data.startDate - Event start date/time
 * @param {number} data.durationMinutes - Event duration in minutes
 * @param {string[]} data.participants - List of participant names
 * @param {string} data.eventUrl - URL to view event details
 * @param {string} [data.comments] - Optional event comments
 * @returns {{html: string, text: string}}
 */
function generateEventConfirmationEmailTemplate(data) {
  const {
    gameName,
    groupName,
    startDate,
    durationMinutes,
    participants,
    eventUrl,
    comments,
    timezone
  } = data;

  const formattedDate = formatDateForEmail(startDate, timezone);
  const startTime = formatTimeForEmail(startDate, timezone);

  // Calculate end time
  const endDate = new Date(new Date(startDate).getTime() + (durationMinutes * 60000));
  const endTime = formatTimeForEmail(endDate, timezone);

  // Format participant list
  const participantList = participants && participants.length > 0
    ? participants.join(', ')
    : 'TBD';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1F2937; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #10B981; color: white; padding: 24px; text-align: center; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
    .header p { margin: 8px 0 0; opacity: 0.9; font-size: 14px; }
    .content { background-color: #F9FAFB; padding: 32px; border-radius: 0 0 8px 8px; }
    .event-card { background-color: white; padding: 24px; margin: 20px 0; border-radius: 8px; border-left: 4px solid #10B981; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .event-detail { margin: 12px 0; display: flex; }
    .event-label { font-weight: 600; color: #6B7280; min-width: 100px; }
    .event-value { color: #1F2937; }
    .participants-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid #E5E7EB; }
    .participants-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .participant-badge { background-color: #D1FAE5; color: #065F46; padding: 4px 12px; border-radius: 16px; font-size: 14px; }
    .button { display: inline-block; padding: 14px 28px; background-color: #10B981; color: white; text-decoration: none; border-radius: 8px; margin: 24px 0; font-weight: 600; text-align: center; }
    .button:hover { background-color: #059669; }
    .footer { text-align: center; color: #6B7280; font-size: 12px; margin-top: 24px; padding-top: 24px; border-top: 1px solid #E5E7EB; }
    .footer a { color: #10B981; text-decoration: none; }
    .checkmark { display: inline-block; width: 24px; height: 24px; background-color: white; border-radius: 50%; margin-right: 8px; vertical-align: middle; }
    .checkmark::after { content: '\\2713'; color: #10B981; font-weight: bold; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><span class="checkmark"></span> Game Night Confirmed!</h1>
      <p>Your session has been scheduled</p>
    </div>
    <div class="content">
      <p>Great news! A game night has been confirmed for <strong>${groupName}</strong>.</p>

      <div class="event-card">
        <div class="event-detail">
          <span class="event-label">Game</span>
          <span class="event-value"><strong>${gameName}</strong></span>
        </div>
        <div class="event-detail">
          <span class="event-label">Date</span>
          <span class="event-value">${formattedDate}</span>
        </div>
        <div class="event-detail">
          <span class="event-label">Time</span>
          <span class="event-value">${startTime} - ${endTime}</span>
        </div>
        <div class="event-detail">
          <span class="event-label">Duration</span>
          <span class="event-value">${durationMinutes} minutes</span>
        </div>
        ${comments ? `
        <div class="event-detail">
          <span class="event-label">Notes</span>
          <span class="event-value">${comments}</span>
        </div>
        ` : ''}

        <div class="participants-section">
          <span class="event-label">Who's Playing</span>
          <div class="participants-list">
            ${participants.map(p => `<span class="participant-badge">${p}</span>`).join('')}
          </div>
        </div>
      </div>

      <div style="text-align: center;">
        <a href="${eventUrl}" class="button">View Event Details</a>
      </div>

      <p style="color: #6B7280; font-size: 14px;">
        This event was created based on everyone's availability. See you there!
      </p>

      <div class="footer">
        <p>This is an automated notification from NextGameNight.</p>
        <p><a href="${eventUrl}">Manage this event</a></p>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();

  const text = `
Game Night Confirmed!

Great news! A game night has been confirmed for ${groupName}.

EVENT DETAILS
-------------
Game: ${gameName}
Date: ${formattedDate}
Time: ${startTime} - ${endTime}
Duration: ${durationMinutes} minutes
${comments ? `Notes: ${comments}\n` : ''}
Who's Playing: ${participantList}

View event details: ${eventUrl}

This event was created based on everyone's availability. See you there!

---
This is an automated notification from NextGameNight.
  `.trim();

  return { html, text };
}

module.exports = {
  convertSuggestionToEvent,
  calculateDuration,
  generateEventConfirmationEmailTemplate
};
