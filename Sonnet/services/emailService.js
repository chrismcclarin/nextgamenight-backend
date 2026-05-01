// services/emailService.js
// Email service for sending notifications using Resend API
const { Resend } = require('resend');

class EmailService {
  constructor() {
    this.apiKey = process.env.RESEND_API_KEY;
    this.fromEmail = process.env.FROM_EMAIL || 'schedule@nextgamenight.app';
    this.frontendUrl = process.env.FRONTEND_URL || process.env.AUTH0_BASE_URL || 'http://localhost:3000';

    if (this.apiKey) {
      this.resend = new Resend(this.apiKey);
      console.log('Resend email service initialized.');
      console.log(`   From: ${this.fromEmail}`);
    } else {
      console.warn('Resend email service not configured (RESEND_API_KEY not set).');
      if (process.env.NODE_ENV === 'production') {
        console.warn('WARNING: Email notifications will be disabled in production!');
      }
    }
  }

  /**
   * Check if email service is configured
   * @returns {boolean} True if Resend API key is set
   */
  isConfigured() {
    return !!this.apiKey && !!this.resend;
  }

  /**
   * Send a single email via Resend API
   * @param {Object} options - Email options
   * @param {string|string[]} options.to - Recipient email(s)
   * @param {string} options.subject - Email subject
   * @param {string} [options.html] - HTML content
   * @param {string} [options.text] - Plain text content
   * @param {string} [options.replyTo] - Reply-to address (typically group owner)
   * @param {string} [options.groupName] - Group name for from field
   * @param {string} [options.promptId] - Availability prompt ID for webhook attribution via tags
   * @param {string} [options.emailType] - Email type label (e.g. 'availability_prompt', 'reminder')
   * @returns {Promise<{success: boolean, id?: string, error?: string}>}
   */
  async send({ to, subject, html, text, replyTo, groupName, promptId, emailType, attachments }) {
    if (!this.isConfigured()) {
      console.warn('Email service not configured. Skipping email.');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const fromName = groupName
        ? `${groupName} via NextGameNight`
        : 'NextGameNight';

      // Multipart (text + html) emails score better with spam filters
      const plainText = text || (html ? html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : '');

      const msg = {
        from: `${fromName} <${this.fromEmail}>`,
        to: Array.isArray(to) ? to : [to],
        subject,
        ...(html && { html }),
        ...(plainText && { text: plainText }),
        ...(replyTo && { reply_to: replyTo }),
        headers: {
          'List-Unsubscribe': `<mailto:unsubscribe@nextgamenight.app>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        },
        // Resend tags for analytics and webhook attribution
        tags: [
          { name: 'category', value: emailType || 'notification' },
          ...(promptId ? [{ name: 'prompt_id', value: String(promptId) }] : [])
        ],
        ...(attachments && attachments.length > 0 && { attachments })
      };

      const { data, error } = await this.resend.emails.send(msg);

      if (error) {
        console.error(`Email send failed: ${error.message}`);
        return { success: false, error: error.message };
      }

      console.log(`Email sent successfully. ID: ${data.id}`);
      return { success: true, id: data.id };
    } catch (error) {
      console.error(`Email send failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send emails to multiple recipients (batch send)
   * Sends individually via Resend API, chunked into batches of 100
   * @param {Array<{email: string, name?: string, data?: Object}>} recipients - List of recipients
   * @param {Object} options - Email options (shared across all recipients)
   * @param {string} options.subject - Email subject
   * @param {string} [options.html] - HTML content
   * @param {string} [options.text] - Plain text fallback
   * @param {string} [options.replyTo] - Reply-to address
   * @param {string} [options.groupName] - Group name for from field
   * @returns {Promise<{success: boolean, total: number, successful: number, failed: number, results: Array}>}
   */
  async sendBatch(recipients, { subject, html, text, replyTo, groupName }) {
    if (!this.isConfigured()) {
      console.warn('Email service not configured. Skipping batch email.');
      return {
        success: false,
        error: 'Email service not configured',
        total: recipients.length,
        successful: 0,
        failed: recipients.length,
        results: []
      };
    }

    if (!recipients || recipients.length === 0) {
      return {
        success: true,
        total: 0,
        successful: 0,
        failed: 0,
        results: []
      };
    }

    // Chunk recipients into batches of 100 (being conservative, SendGrid allows 1000)
    const chunks = this.chunk(recipients, 100);
    const allResults = [];
    let totalSuccessful = 0;
    let totalFailed = 0;

    for (const chunk of chunks) {
      // Send emails in parallel within each chunk
      const chunkPromises = chunk.map(async (recipient) => {
        const recipientEmail = typeof recipient === 'string' ? recipient : recipient.email;

        try {
          const result = await this.send({
            to: recipientEmail,
            subject,
            html,
            text,
            replyTo,
            groupName
          });

          if (result.success) {
            totalSuccessful++;
          } else {
            totalFailed++;
          }

          return { recipient: recipientEmail, ...result };
        } catch (error) {
          totalFailed++;
          return {
            recipient: recipientEmail,
            success: false,
            error: error.message
          };
        }
      });

      const chunkResults = await Promise.allSettled(chunkPromises);

      chunkResults.forEach((result) => {
        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          allResults.push({
            recipient: 'unknown',
            success: false,
            error: result.reason?.message || 'Unknown error'
          });
          totalFailed++;
        }
      });
    }

    console.log(`Batch email results: ${totalSuccessful} sent, ${totalFailed} failed`);

    return {
      success: totalSuccessful > 0,
      total: recipients.length,
      successful: totalSuccessful,
      failed: totalFailed,
      results: allResults
    };
  }

  /**
   * Split array into chunks of specified size
   * @param {Array} array - Array to chunk
   * @param {number} size - Chunk size
   * @returns {Array<Array>} Array of chunks
   */
  chunk(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Format event date for display
   * @param {Date|string} date - Date to format
   * @param {string} [timezone] - Optional IANA timezone string
   * @returns {string} Formatted date string
   */
  formatEventDate(date, timezone) {
    const eventDate = new Date(date);
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
    return eventDate.toLocaleDateString('en-US', options);
  }

  /**
   * Calculate end time from start time and duration
   * @param {string} startTime - Start time in HH:MM format
   * @param {number} durationMinutes - Duration in minutes
   * @returns {string} End time in HH:MM format
   */
  calculateEndTime(startTime, durationMinutes) {
    if (!startTime || !durationMinutes) return '';

    try {
      const [hours, minutes] = startTime.split(':').map(Number);
      const startDate = new Date();
      startDate.setHours(hours, minutes, 0, 0);

      const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
      const endHours = String(endDate.getHours()).padStart(2, '0');
      const endMinutes = String(endDate.getMinutes()).padStart(2, '0');

      return `${endHours}:${endMinutes}`;
    } catch (error) {
      console.error('Error calculating end time:', error);
      return '';
    }
  }

  // ============================================
  // No Consensus Email Template
  // ============================================

  /**
   * Generate email template for no consensus notification
   * Sent to admins when an availability poll closes without a viable time slot
   * @param {Object} params - Template parameters
   * @param {string} params.groupName - Name of the group
   * @param {string} params.promptId - ID of the availability prompt
   * @param {string} params.dashboardUrl - URL to the prompt dashboard
   * @returns {{html: string, text: string}} Email content
   */
  generateNoConsensusEmailTemplate({ groupName, promptId, dashboardUrl }) {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #F59E0B; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #F59E0B; color: white; text-decoration: none; border-radius: 5px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>No Consensus Reached</h1>
    </div>
    <div class="content">
      <p>The availability poll for <strong>${groupName}</strong> has closed, but no time slot met the minimum participant threshold.</p>

      <p>You may want to:</p>
      <ul>
        <li>Review the available time slots and manually create an event</li>
        <li>Send a new availability poll with adjusted settings</li>
        <li>Reach out to group members who haven't responded</li>
      </ul>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${dashboardUrl}" class="button">Review Suggestions</a>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
No Consensus Reached

The availability poll for "${groupName}" has closed, but no time slot met the minimum participant threshold.

You may want to:
- Review the available time slots and manually create an event
- Send a new availability poll with adjusted settings
- Reach out to group members who haven't responded

Review suggestions: ${dashboardUrl}
    `.trim();

    return { html, text };
  }

  // ============================================
  // Group Invite Email Template
  // ============================================

  /**
   * Generate email template for group invite notification
   * Sent when a group owner/admin invites someone to join their group
   * @param {Object} params - Template parameters
   * @param {string} params.inviterName - Name of the person who sent the invite
   * @param {string} params.groupName - Name of the group
   * @param {number} params.memberCount - Current active member count
   * @param {string} params.inviteUrl - URL to accept the invite (contains token)
   * @returns {{html: string, text: string}} Email content
   */
  generateGroupInviteEmailTemplate({ inviterName, groupName, memberCount, inviteUrl }) {
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #28a745; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #28a745; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; }
    .footer { text-align: center; color: #6B7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #E5E7EB; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>You're Invited!</h1>
    </div>
    <div class="content">
      <p>Hey! <strong>${inviterName}</strong> invited you to join <strong>${groupName}</strong> on Next Game Night.</p>

      <p>The group has ${memberCount} member${memberCount !== 1 ? 's' : ''}.</p>

      <div style="text-align: center; margin: 30px 0;">
        <a href="${inviteUrl}" class="button">View Invite</a>
      </div>

      <p>If you don't have an account yet, you'll be able to create one when you click the link above.</p>

      <div class="footer">
        <p>This is an automated notification from Next Game Night.</p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
You're Invited!

Hey! ${inviterName} invited you to join ${groupName} on Next Game Night.

The group has ${memberCount} member${memberCount !== 1 ? 's' : ''}.

View invite: ${inviteUrl}

If you don't have an account yet, you'll be able to create one when you click the link above.

---
This is an automated notification from Next Game Night.
    `.trim();

    return { html, text };
  }

  /**
   * Send group invite notification email
   * @param {string} recipientEmail - Email address of the invitee
   * @param {Object} templateParams - Parameters for the email template
   * @param {string} templateParams.inviterName - Name of the inviter
   * @param {string} templateParams.groupName - Name of the group
   * @param {number} templateParams.memberCount - Active member count
   * @param {string} templateParams.inviteUrl - URL to accept the invite
   * @returns {Promise<{success: boolean, id?: string, error?: string}>}
   */
  async sendGroupInviteNotification(recipientEmail, templateParams) {
    const { html, text } = this.generateGroupInviteEmailTemplate(templateParams);

    return this.send({
      to: recipientEmail,
      subject: `You're invited to join ${templateParams.groupName} on Next Game Night`,
      html,
      text,
      groupName: templateParams.groupName,
    });
  }

  // ============================================
  // Legacy methods (to be updated in Phase 7)
  // These maintain API compatibility with existing code
  // ============================================

  /**
   * Generate email template for game session notification
   * @deprecated Use React Email templates instead (Phase 2, Plan 2)
   */
  generateGameSessionEmailTemplate(eventData) {
    const { gameName, groupName, startDate, durationMinutes, location, comments, eventUrl, recipientName, rsvpUrls, ballotUrl, timezone } = eventData;

    // Format date + times in the recipient's timezone, 12h with TZ abbreviation.
    // Time formatting is centralized here (MAIL-04) — callers pass raw startDate
    // + timezone instead of pre-formatted strings.
    const start = new Date(startDate);
    const formattedDate = this.formatEventDate(startDate, timezone);
    const formattedStartTime = this.formatEventTime12h(start, timezone);
    const formattedEndTime = durationMinutes
      ? this.formatEventTime12h(new Date(start.getTime() + durationMinutes * 60000), timezone)
      : '';

    // RSVP buttons HTML (table-based layout for email compatibility)
    const rsvpButtonsHtml = rsvpUrls ? `
      <div style="text-align: center; margin: 20px 0 10px;">
        <p style="font-size: 16px; font-weight: bold; color: #374151; margin-bottom: 12px;">Are you going?</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
          <tr>
            <td style="padding: 0 6px;">
              <a href="${rsvpUrls.yesUrl}" style="display: inline-block; padding: 12px 24px; background-color: #22c55e; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">Yes</a>
            </td>
            <td style="padding: 0 6px;">
              <a href="${rsvpUrls.maybeUrl}" style="display: inline-block; padding: 12px 24px; background-color: #eab308; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">Maybe</a>
            </td>
            <td style="padding: 0 6px;">
              <a href="${rsvpUrls.noUrl}" style="display: inline-block; padding: 12px 24px; background-color: #ef4444; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">No</a>
            </td>
          </tr>
        </table>
      </div>
    ` : '';

    // RSVP plain text links
    const rsvpPlainText = rsvpUrls ? `
RSVP:
- Yes: ${rsvpUrls.yesUrl}
- Maybe: ${rsvpUrls.maybeUrl}
- No: ${rsvpUrls.noUrl}
` : '';

    // Ballot vote button HTML (only when ballot exists)
    const ballotButtonHtml = ballotUrl ? `
      <div style="text-align: center; margin: 10px 0 20px;">
        <p style="font-size: 14px; color: #6B7280; margin-bottom: 8px;">A game ballot is open for this session:</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
          <tr>
            <td style="padding: 0 6px;">
              <a href="${ballotUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">Vote for a Game</a>
            </td>
          </tr>
        </table>
      </div>
    ` : '';

    // Ballot plain text link
    const ballotPlainText = ballotUrl ? `\nVote for a game: ${ballotUrl}\n` : '';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
    .event-details { background-color: white; padding: 20px; margin: 20px 0; border-radius: 5px; border-left: 4px solid #4F46E5; }
    .event-detail-row { margin: 10px 0; }
    .event-detail-label { font-weight: bold; color: #6B7280; }
    .event-detail-value { color: #111827; margin-left: 10px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; color: #6B7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #E5E7EB; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>New Game Session Scheduled!</h1>
    </div>
    <div class="content">
      <p>Hi ${recipientName || 'there'},</p>

      <p>A new game session has been scheduled for your group <strong>${groupName}</strong>.</p>

      ${rsvpButtonsHtml}

      ${ballotButtonHtml}

      <div class="event-details">
        <div class="event-detail-row">
          <span class="event-detail-label">Game:</span>
          <span class="event-detail-value">${gameName}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">Date:</span>
          <span class="event-detail-value">${formattedDate}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">Time:</span>
          <span class="event-detail-value">${formattedEndTime ? `${formattedStartTime} - ${formattedEndTime}` : formattedStartTime}</span>
        </div>
        ${durationMinutes ? `
        <div class="event-detail-row">
          <span class="event-detail-label">Duration:</span>
          <span class="event-detail-value">${durationMinutes} minutes</span>
        </div>
        ` : ''}
        ${location ? `
        <div class="event-detail-row">
          <span class="event-detail-label">Location:</span>
          <span class="event-detail-value">${location}</span>
        </div>
        ` : ''}
        ${comments ? `
        <div class="event-detail-row">
          <span class="event-detail-label">Notes:</span>
          <span class="event-detail-value">${comments}</span>
        </div>
        ` : ''}
      </div>

      <div style="text-align: center;">
        <a href="${eventUrl}" class="button">View Event Details</a>
      </div>

      <p>We hope to see you there!</p>

      <div class="footer">
        <p>This is an automated notification from PeriodicTableTop.</p>
        <p>You can manage your notification preferences in your <a href="${this.frontendUrl}/userProfile">profile settings</a>.</p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
New Game Session Scheduled!

Hi ${recipientName || 'there'},

A new game session has been scheduled for your group "${groupName}".
${rsvpPlainText}
${ballotPlainText}
Event Details:
- Game: ${gameName}
- Date: ${formattedDate}
- Time: ${formattedEndTime ? `${formattedStartTime} - ${formattedEndTime}` : formattedStartTime}
${durationMinutes ? `- Duration: ${durationMinutes} minutes\n` : ''}
${location ? `- Location: ${location}\n` : ''}
${comments ? `- Notes: ${comments}\n` : ''}

View event details: ${eventUrl}

We hope to see you there!

---
This is an automated notification from PeriodicTableTop.
You can manage your notification preferences in your profile: ${this.frontendUrl}/userProfile
    `.trim();

    return { html, text };
  }

  /**
   * Send game session notification email
   * @deprecated Will be updated to use React Email templates in Phase 7
   */
  async sendGameSessionNotification(recipientEmail, recipientName, eventData) {
    const { html, text } = this.generateGameSessionEmailTemplate({
      ...eventData,
      recipientName
    });

    return this.send({
      to: recipientEmail,
      subject: `New Game Session: ${eventData.gameName} - ${eventData.groupName}`,
      html,
      text,
      groupName: eventData.groupName
    });
  }

  /**
   * Send email notification to multiple recipients
   * @deprecated Will be updated to use React Email templates in Phase 7
   */
  async sendGameSessionNotificationToMultiple(recipients, eventData) {
    const recipientList = recipients.map(r => ({
      email: r.email,
      name: r.name || r.username
    }));

    const { html, text } = this.generateGameSessionEmailTemplate(eventData);

    return this.sendBatch(recipientList, {
      subject: `New Game Session: ${eventData.gameName} - ${eventData.groupName}`,
      html,
      text,
      groupName: eventData.groupName
    });
  }

  // ============================================
  // Date Change Email Template
  // ============================================

  /**
   * Generate email template for event date change notification
   * Sent to members who RSVPed (yes/maybe) when the event date changes
   * @param {Object} params - Template parameters
   * @param {string} params.gameName - Name of the game
   * @param {string} params.groupName - Name of the group
   * @param {Date|string} params.newDate - New event start (Date or ISO string, UTC ok)
   * @param {number} params.durationMinutes - Event duration in minutes (drives end time)
   * @param {string} params.eventUrl - URL to the event detail page
   * @param {string} params.recipientName - Recipient display name
   * @param {Object} [params.rsvpUrls] - Optional RSVP button URLs { yesUrl, maybeUrl, noUrl }
   * @returns {{html: string, text: string}} Email content
   */
  generateDateChangeEmailTemplate({ gameName, groupName, newDate, durationMinutes, eventUrl, recipientName, rsvpUrls, timezone }) {
    // Time formatting centralized here (MAIL-04) — callers pass raw newDate
    // + timezone instead of pre-formatted strings.
    const start = new Date(newDate);
    const formattedDate = this.formatEventDate(newDate, timezone);
    const formattedStartTime = this.formatEventTime12h(start, timezone);
    const formattedEndTime = durationMinutes
      ? this.formatEventTime12h(new Date(start.getTime() + durationMinutes * 60000), timezone)
      : '';

    // RSVP buttons HTML (reusable, same as game session template)
    const rsvpButtonsHtml = rsvpUrls ? `
      <div style="text-align: center; margin: 20px 0 10px;">
        <p style="font-size: 16px; font-weight: bold; color: #374151; margin-bottom: 12px;">Are you going?</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
          <tr>
            <td style="padding: 0 6px;">
              <a href="${rsvpUrls.yesUrl}" style="display: inline-block; padding: 12px 24px; background-color: #22c55e; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">Yes</a>
            </td>
            <td style="padding: 0 6px;">
              <a href="${rsvpUrls.maybeUrl}" style="display: inline-block; padding: 12px 24px; background-color: #eab308; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">Maybe</a>
            </td>
            <td style="padding: 0 6px;">
              <a href="${rsvpUrls.noUrl}" style="display: inline-block; padding: 12px 24px; background-color: #ef4444; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">No</a>
            </td>
          </tr>
        </table>
      </div>
    ` : '';

    const rsvpPlainText = rsvpUrls ? `
RSVP (re-confirm your attendance):
- Yes: ${rsvpUrls.yesUrl}
- Maybe: ${rsvpUrls.maybeUrl}
- No: ${rsvpUrls.noUrl}
` : '';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #F59E0B; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
    .event-details { background-color: white; padding: 20px; margin: 20px 0; border-radius: 5px; border-left: 4px solid #F59E0B; }
    .event-detail-row { margin: 10px 0; }
    .event-detail-label { font-weight: bold; color: #6B7280; }
    .event-detail-value { color: #111827; margin-left: 10px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #F59E0B; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; color: #6B7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #E5E7EB; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Date Changed</h1>
    </div>
    <div class="content">
      <p>Hi ${recipientName || 'there'},</p>

      <p>The date for <strong>${gameName}</strong> in <strong>${groupName}</strong> has been updated.</p>

      ${rsvpButtonsHtml}

      <div class="event-details">
        <div class="event-detail-row">
          <span class="event-detail-label">Game:</span>
          <span class="event-detail-value">${gameName}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">New Date:</span>
          <span class="event-detail-value" style="color: #D97706; font-weight: bold;">${formattedDate}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">Time:</span>
          <span class="event-detail-value">${formattedEndTime ? `${formattedStartTime} - ${formattedEndTime}` : formattedStartTime}</span>
        </div>
        ${durationMinutes ? `
        <div class="event-detail-row">
          <span class="event-detail-label">Duration:</span>
          <span class="event-detail-value">${durationMinutes} minutes</span>
        </div>
        ` : ''}
      </div>

      <div style="text-align: center;">
        <a href="${eventUrl}" class="button">View Event Details</a>
      </div>

      <div class="footer">
        <p>This is an automated notification from PeriodicTableTop.</p>
        <p>You can manage your notification preferences in your <a href="${this.frontendUrl}/userProfile">profile settings</a>.</p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
Date Changed

Hi ${recipientName || 'there'},

The date for "${gameName}" in "${groupName}" has been updated.
${rsvpPlainText}
New Event Details:
- Game: ${gameName}
- New Date: ${formattedDate}
- Time: ${formattedEndTime ? `${formattedStartTime} - ${formattedEndTime}` : formattedStartTime}
${durationMinutes ? `- Duration: ${durationMinutes} minutes\n` : ''}

View event details: ${eventUrl}

---
This is an automated notification from PeriodicTableTop.
You can manage your notification preferences in your profile: ${this.frontendUrl}/userProfile
    `.trim();

    return { html, text };
  }

  // ============================================
  // Event Cancellation Email Template
  // ============================================

  /**
   * Generate email template for event cancellation notification
   * Sent to members who RSVPed (yes/maybe) when an event is deleted
   * @param {Object} params - Template parameters
   * @param {string} params.gameName - Name of the game
   * @param {string} params.groupName - Name of the group
   * @param {string} params.eventDate - Original event date
   * @param {string} params.recipientName - Recipient display name
   * @param {string} params.groupUrl - URL to the group page
   * @returns {{html: string, text: string}} Email content
   */
  generateCancellationEmailTemplate({ gameName, groupName, eventDate, recipientName, groupUrl, timezone }) {
    const formattedDate = this.formatEventDate(eventDate, timezone);

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #EF4444; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
    .event-details { background-color: white; padding: 20px; margin: 20px 0; border-radius: 5px; border-left: 4px solid #EF4444; }
    .event-detail-row { margin: 10px 0; }
    .event-detail-label { font-weight: bold; color: #6B7280; }
    .event-detail-value { color: #111827; margin-left: 10px; }
    .button { display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
    .footer { text-align: center; color: #6B7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #E5E7EB; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Event Cancelled</h1>
    </div>
    <div class="content">
      <p>Hi ${recipientName || 'there'},</p>

      <p><strong>${gameName}</strong> scheduled for <strong>${formattedDate}</strong> has been cancelled.</p>

      <div class="event-details">
        <div class="event-detail-row">
          <span class="event-detail-label">Game:</span>
          <span class="event-detail-value" style="text-decoration: line-through;">${gameName}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">Date:</span>
          <span class="event-detail-value" style="text-decoration: line-through;">${formattedDate}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">Group:</span>
          <span class="event-detail-value">${groupName}</span>
        </div>
      </div>

      <div style="text-align: center;">
        <a href="${groupUrl}" class="button">Go to Group</a>
      </div>

      <div class="footer">
        <p>This is an automated notification from PeriodicTableTop.</p>
        <p>You can manage your notification preferences in your <a href="${this.frontendUrl}/userProfile">profile settings</a>.</p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
Event Cancelled

Hi ${recipientName || 'there'},

"${gameName}" scheduled for ${formattedDate} has been cancelled.

Event Details:
- Game: ${gameName}
- Date: ${formattedDate}
- Group: ${groupName}

Go to group: ${groupUrl}

---
This is an automated notification from PeriodicTableTop.
You can manage your notification preferences in your profile: ${this.frontendUrl}/userProfile
    `.trim();

    return { html, text };
  }

  // ============================================
  // Game-Join (QR) Confirmation Email — MAIL-03
  // ============================================

  /**
   * Format a time-of-day string in the recipient's timezone, 12h format.
   * Example: "6:00 PM MDT"
   * @param {Date|string} date
   * @param {string} [timezone] - IANA timezone
   * @returns {string}
   */
  formatEventTime12h(date, timezone) {
    const d = new Date(date);
    const opts = {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    };
    if (timezone) {
      opts.timeZone = timezone;
      opts.timeZoneName = 'short';
    }
    return d.toLocaleTimeString('en-US', opts);
  }

  /**
   * Generate a receipt-style confirmation email for QR game-join.
   * Single template for all recipients (returning + brand-new users).
   * @param {Object} params
   * @param {string} params.gameName
   * @param {string} params.groupName
   * @param {Date|string} params.eventDate - Start (UTC)
   * @param {number} [params.durationMinutes]
   * @param {string} [params.location]
   * @param {string} [params.hostName]
   * @param {string} [params.recipientName]
   * @param {string} params.eventUrl - Auth-required deep link to /gameDetail
   * @param {string} params.googleCalendarUrl
   * @param {string} [params.timezone] - IANA timezone string for display
   * @returns {{html: string, text: string, subject: string}}
   */
  generateGameJoinConfirmationTemplate({
    gameName,
    groupName,
    eventDate,
    durationMinutes,
    location,
    hostName,
    recipientName,
    eventUrl,
    googleCalendarUrl,
    timezone,
  }) {
    const formattedDate = this.formatEventDate(eventDate, timezone);
    const formattedTime = this.formatEventTime12h(eventDate, timezone);
    const subject = `You're in: ${gameName} with ${groupName}`;
    const greetingName = recipientName || 'there';
    const host = hostName || groupName || 'your group';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background-color: #4F46E5; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
    .content { background-color: #f9fafb; padding: 30px; border-radius: 0 0 5px 5px; }
    .event-details { background-color: white; padding: 20px; margin: 20px 0; border-radius: 5px; border-left: 4px solid #4F46E5; }
    .event-detail-row { margin: 10px 0; }
    .event-detail-label { font-weight: bold; color: #6B7280; }
    .event-detail-value { color: #111827; margin-left: 10px; }
    .footer { text-align: center; color: #6B7280; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #E5E7EB; }
    .footer a { color: #4F46E5; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>You're in!</h1>
    </div>
    <div class="content">
      <p>Hi ${greetingName}, you've joined <strong>${gameName}</strong> with <strong>${groupName}</strong>. Here are the details:</p>

      <div class="event-details">
        <div class="event-detail-row">
          <span class="event-detail-label">Game:</span>
          <span class="event-detail-value">${gameName}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">Date:</span>
          <span class="event-detail-value">${formattedDate}</span>
        </div>
        <div class="event-detail-row">
          <span class="event-detail-label">Time:</span>
          <span class="event-detail-value">${formattedTime}</span>
        </div>
        ${durationMinutes ? `
        <div class="event-detail-row">
          <span class="event-detail-label">Duration:</span>
          <span class="event-detail-value">${durationMinutes} minutes</span>
        </div>
        ` : ''}
        <div class="event-detail-row">
          <span class="event-detail-label">Host:</span>
          <span class="event-detail-value">${host}</span>
        </div>
        ${location ? `
        <div class="event-detail-row">
          <span class="event-detail-label">Location:</span>
          <span class="event-detail-value">${location}</span>
        </div>
        ` : ''}
      </div>

      <div style="text-align: center; margin: 24px 0 8px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
          <tr>
            <td style="padding: 0 6px;">
              <a href="${eventUrl}" style="display: inline-block; padding: 12px 24px; background-color: #4F46E5; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px;">View Event</a>
            </td>
            <td style="padding: 0 6px;">
              <a href="${googleCalendarUrl}" style="display: inline-block; padding: 12px 24px; background-color: white; color: #4F46E5; text-decoration: none; border: 2px solid #4F46E5; border-radius: 5px; font-weight: bold; font-size: 14px;">Add to Google Calendar</a>
            </td>
          </tr>
        </table>
      </div>

      <p style="font-size: 13px; color: #6B7280; text-align: center; margin: 8px 0 0;">Or open the attached .ics file to add this to any calendar app.</p>

      <div class="footer">
        <p><strong>What is Nextgamenight?</strong> A simple way for game groups to plan and play together. <a href="${this.frontendUrl}/about">Learn more</a>.</p>
        <p>This is an automated notification from NextGameNight.</p>
        <p>You can manage your notification preferences in your <a href="${this.frontendUrl}/userProfile">profile settings</a>.</p>
      </div>
    </div>
  </div>
</body>
</html>
    `.trim();

    const text = `
You're in!

Hi ${greetingName}, you've joined ${gameName} with ${groupName}. Here are the details:

- Game: ${gameName}
- Date: ${formattedDate}
- Time: ${formattedTime}
${durationMinutes ? `- Duration: ${durationMinutes} minutes\n` : ''}- Host: ${host}
${location ? `- Location: ${location}\n` : ''}
View event: ${eventUrl}
Add to Google Calendar: ${googleCalendarUrl}

Or open the attached .ics file to add this to any calendar app.

---
What is Nextgamenight? A simple way for game groups to plan and play together. Learn more: ${this.frontendUrl}/about

This is an automated notification from NextGameNight.
You can manage your notification preferences in your profile: ${this.frontendUrl}/userProfile
    `.trim();

    return { html, text, subject };
  }

  /**
   * Send a QR game-join confirmation email.
   * Caller is responsible for guarding on already_joined and the master
   * email_notifications_enabled toggle.
   * @param {string} recipientEmail
   * @param {Object} params - Same shape as generateGameJoinConfirmationTemplate plus icsAttachmentBase64
   * @param {string} [params.icsAttachmentBase64] - Base64-encoded ICS string
   * @returns {Promise<{success: boolean, id?: string, error?: string}>}
   */
  async sendGameJoinConfirmation(recipientEmail, params) {
    const { html, text, subject } = this.generateGameJoinConfirmationTemplate(params);

    const attachments = params.icsAttachmentBase64
      ? [{
          filename: 'event.ics',
          content: params.icsAttachmentBase64, // base64 string per Resend attachment API
          contentType: 'text/calendar',
        }]
      : [];

    return this.send({
      to: recipientEmail,
      subject,
      html,
      text,
      groupName: params.groupName, // produces "${groupName} via NextGameNight" — existing convention
      emailType: 'game_join_confirmation',
      attachments,
    });
  }
}

module.exports = new EmailService();
