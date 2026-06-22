// services/smsService.js
// SMS service for sending notifications using Twilio
const twilio = require('twilio');
const { sanitizeForSms } = require('../utils/smsUtils');

class SmsService {
  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = process.env.TWILIO_PHONE_NUMBER;

    // Initialize Twilio client if credentials are configured
    if (accountSid && authToken) {
      this.client = twilio(accountSid, authToken);
      console.log(`Twilio SMS service initialized. From: ${this.fromNumber}`);
    } else {
      this.client = null;
      console.warn('Twilio SMS service not configured (credentials not set).');
    }
  }

  /**
   * Check if SMS service is configured
   * @returns {boolean} True if Twilio client and from number are set
   */
  isConfigured() {
    return !!(this.client && this.fromNumber);
  }

  /**
   * Send an SMS notification via Twilio
   * @param {Object} options - SMS options
   * @param {string} options.to - Recipient phone number (E.164 format)
   * @param {string} options.type - Notification type key
   * @param {Object} options.data - Template data fields
   * @returns {Promise<{success: boolean, sid?: string, error?: string}>}
   */
  async send({ to, type, data }) {
    if (!this.isConfigured()) {
      console.warn('SMS service not configured. Skipping SMS.');
      return { success: false, error: 'SMS service not configured' };
    }

    try {
      const body = this.buildMessage(type, data);

      const message = await this.client.messages.create({
        body,
        to,
        from: this.fromNumber
      });

      console.log(`SMS sent successfully. SID: ${message.sid}`);
      return { success: true, sid: message.sid };
    } catch (error) {
      console.error(`SMS send failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Build an SMS message body from a notification type and data
   * @param {string} type - Notification type key
   * @param {Object} data - Template data fields
   * @returns {string} SMS message body (max 306 chars = 2 GSM-7 segments)
   */
  buildMessage(type, data) {
    const d = data || {};

    // CTIA-required opt-in confirmation. Sent exactly once on first SMS opt-in.
    // Contains all carrier-required disclosures (brand, frequency, rates, HELP, STOP).
    // Static template -- no variables -- to keep length predictable (single segment).
    const welcomeTemplate = {
      sms_welcome: () =>
        `NextGameNight: You're subscribed to game night alerts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to unsubscribe.`
    };

    // Phase 49 legacy templates. User-supplied fields (game/group/inviter/
    // requester names) are routed through sanitizeForSms — same as the
    // Phase 50 event templates below — to strip GSM-7-unsafe / injection
    // characters (BSEC-04 / B8). Dates and URLs are server-derived.
    const legacyTemplates = {
      event_confirmation: () =>
        `NextGameNight: ${sanitizeForSms(d.gameName)} is set for ${d.date}! ${d.actionUrl || ''}`.trim(),

      availability_prompt: () =>
        `NextGameNight: ${sanitizeForSms(d.groupName)} wants to schedule a game. Share your availability: ${d.actionUrl || ''}`.trim(),

      no_consensus: () =>
        `NextGameNight: No consensus for ${sanitizeForSms(d.groupName)}. Review options: ${d.actionUrl || ''}`.trim(),

      group_invite: () =>
        `NextGameNight: ${sanitizeForSms(d.inviterName)} invited you to ${sanitizeForSms(d.groupName)}! ${d.actionUrl || ''}`.trim(),

      rsvp_magic_link: () =>
        `NextGameNight: RSVP for ${sanitizeForSms(d.gameName)} on ${d.date}: ${d.actionUrl || ''}`.trim(),

      friend_request: () =>
        `NextGameNight: ${sanitizeForSms(d.requesterName)} sent you a friend request! ${d.actionUrl || ''}`.trim()
    };

    // Phase 50 event notification templates (casual tone, GSM-7 sanitized)
    const eventTemplates = {
      event_created: () => {
        const name = sanitizeForSms(d.eventName);
        const group = sanitizeForSms(d.groupName);
        const url = d.ballotUrl || d.eventUrl;
        const linkText = d.ballotUrl ? 'RSVP & vote' : 'Details';
        let msg = `Hey! ${name} with ${group} is set for ${d.dateTime}. ${linkText}: ${url}`;
        if (d.rsvpPrompt) msg += ' Reply 1=Yes, 2=No, 3=Maybe';
        return msg;
      },

      event_updated: () => {
        const name = sanitizeForSms(d.eventName);
        const group = sanitizeForSms(d.groupName);
        return `Heads up - ${name} with ${group} moved to ${d.dateTime}. Details: ${d.eventUrl}`;
      },

      event_cancelled: () => {
        const name = sanitizeForSms(d.eventName);
        const group = sanitizeForSms(d.groupName);
        return `Bummer - ${name} with ${group} on ${d.dateTime} has been cancelled.`;
      },

      reminder: () => {
        const name = sanitizeForSms(d.eventName);
        const group = sanitizeForSms(d.groupName);
        let msg = `Reminder: ${name} with ${group} is ${d.timeUntil}! Details: ${d.eventUrl}`;
        if (d.rsvpPrompt) msg += ' Reply 1=Yes, 2=No, 3=Maybe';
        return msg;
      }
    };

    let message;

    if (welcomeTemplate[type]) {
      // Welcome message has its own opt-out language baked in -- skip suffix below.
      message = welcomeTemplate[type]();
    } else if (eventTemplates[type]) {
      message = eventTemplates[type]();
    } else if (legacyTemplates[type]) {
      message = legacyTemplates[type]();
    } else {
      message = `NextGameNight notification: ${d.actionUrl || 'Check the app for details'}`;
    }

    // CTIA / carrier compliance: append opt-out reminder to every recurring message.
    // Welcome message already includes STOP/HELP language, so it's exempt.
    if (type !== 'sms_welcome') {
      message += ' Reply STOP to opt out';
    }

    // Truncate to 306 chars (2 GSM-7 segments)
    if (message.length > 306) {
      return message.substring(0, 303) + '...';
    }

    return message;
  }
}

module.exports = new SmsService();
