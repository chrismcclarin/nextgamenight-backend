// services/smsService.js
// SMS service for sending notifications using Twilio
const twilio = require('twilio');
const { sanitizeForSms, fitNamesToBudget } = require('../utils/smsUtils');

const SMS_MAX_LENGTH = 306; // 2 GSM-7 segments
const OPT_OUT_SUFFIX = ' Reply STOP to opt out';
const RSVP_PROMPT = ' Reply 1=Yes, 2=No, 3=Maybe';

class SmsService {
  constructor() {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    this.fromNumber = process.env.TWILIO_PHONE_NUMBER;

    // Initialize Twilio client if credentials are configured
    if (accountSid && authToken) {
      this.client = twilio(accountSid, authToken);
      // Log PRESENCE, not the value (CodeQL js/clear-text-logging): the sending number
      // is the app's own, not user PII, but it is configuration read from the
      // environment and there is no diagnostic reason for it to sit in the log stream.
      // Presence is what actually matters here — isConfigured() below requires BOTH the
      // client and fromNumber, so "client built, number missing" is a real startup state
      // that the old "initialized" line reported as healthy.
      console.log(
        `Twilio SMS service initialized. From number configured: ${this.fromNumber ? 'yes' : 'no'}`
      );
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

    // Every template except the welcome gets the opt-out line appended below, so a template
    // body may use what is left of the two segments. `fit` shortens NAMES to that budget — the
    // link, the reply options and the opt-out line are never what gives way (utils/smsUtils.js).
    const bodyBudget = SMS_MAX_LENGTH - OPT_OUT_SUFFIX.length;
    const fit = (build, ...names) => fitNamesToBudget(build, names, bodyBudget);
    const rsvpPrompt = d.rsvpPrompt ? RSVP_PROMPT : '';

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
      event_confirmation: () => fit(
        (game) => `NextGameNight: ${game} is set for ${d.date}! ${d.actionUrl || ''}`.trim(),
        sanitizeForSms(d.gameName)
      ),

      availability_prompt: () => fit(
        (group) => `NextGameNight: ${group} wants to schedule a game. Share your availability: ${d.actionUrl || ''}`.trim(),
        sanitizeForSms(d.groupName)
      ),

      no_consensus: () => fit(
        (group) => `NextGameNight: No consensus for ${group}. Review options: ${d.actionUrl || ''}`.trim(),
        sanitizeForSms(d.groupName)
      ),

      // The group name gives way before the person's name.
      group_invite: () => fit(
        (group, inviter) => `NextGameNight: ${inviter} invited you to ${group}! ${d.actionUrl || ''}`.trim(),
        sanitizeForSms(d.groupName),
        sanitizeForSms(d.inviterName)
      ),

      rsvp_magic_link: () => fit(
        (game) => `NextGameNight: RSVP for ${game} on ${d.date}: ${d.actionUrl || ''}`.trim(),
        sanitizeForSms(d.gameName)
      ),

      friend_request: () => fit(
        (requester) => `NextGameNight: ${requester} sent you a friend request! ${d.actionUrl || ''}`.trim(),
        sanitizeForSms(d.requesterName)
      )
    };

    // Phase 50 event notification templates (casual tone, GSM-7 sanitized).
    // Names are passed game first, group second: the game name gives way first.
    const eventName = sanitizeForSms(d.eventName);
    const groupName = sanitizeForSms(d.groupName);
    const eventTemplates = {
      event_created: () => {
        const url = d.ballotUrl || d.eventUrl;
        const linkText = d.ballotUrl ? 'RSVP & vote' : 'Details';
        return fit(
          (name, group) => `Hey! ${name} with ${group} is set for ${d.dateTime}. ${linkText}: ${url}${rsvpPrompt}`,
          eventName,
          groupName
        );
      },

      event_updated: () => fit(
        (name, group) => `Heads up - ${name} with ${group} moved to ${d.dateTime}. Details: ${d.eventUrl}`,
        eventName,
        groupName
      ),

      event_cancelled: () => fit(
        (name, group) => `Bummer - ${name} with ${group} on ${d.dateTime} has been cancelled.`,
        eventName,
        groupName
      ),

      // DECISION 2026-09-30 (owner): an over-long reminder FIRST drops the "Reminder:" label and
      // the "!" (11 characters), and only then starts shortening names — chosen OVER shortening
      // a name while decoration is still being sent. A reminder that fits is sent unchanged.
      reminder: () => {
        const full = `Reminder: ${eventName} with ${groupName} is ${d.timeUntil}! Details: ${d.eventUrl}${rsvpPrompt}`;
        if (full.length <= bodyBudget) return full;
        return fit(
          (name, group) => `${name} with ${group} is ${d.timeUntil} Details: ${d.eventUrl}${rsvpPrompt}`,
          eventName,
          groupName
        );
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
      message += OPT_OUT_SUFFIX;
    }

    // LAST RESORT only: the hard cap at 2 GSM-7 segments. Templates fit themselves by
    // shortening names (above), so this is reached only when the fixed text alone — a link or a
    // date far longer than any this app builds — cannot fit even with every name emptied.
    if (message.length > SMS_MAX_LENGTH) {
      return message.substring(0, SMS_MAX_LENGTH - 3) + '...';
    }

    return message;
  }
}

module.exports = new SmsService();
