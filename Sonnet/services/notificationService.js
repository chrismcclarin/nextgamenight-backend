// services/notificationService.js
// Unified notification dispatch layer -- routes to email/sms based on user preferences.
// This is the single dispatch interface for all downstream notification phases (50-54).
const emailService = require('./emailService');
const smsService = require('./smsService');
const { SentNotification } = require('../models');

class NotificationService {
  constructor() {
    this.emailService = emailService;
    this.smsService = smsService;
    console.log('Notification service initialized.');
  }

  /**
   * Determine whether a notification should fire on a given channel for a user.
   * This is the single source of truth for channel routing decisions.
   *
   * Resolution logic:
   * 1. Channel-specific gates (checked first)
   * 2. Explicit user preference (notification_preferences JSONB)
   * 3. Defaults: email=true, sms=false (SMS dark until Phase 54 explicitly enables)
   *
   * @param {Object} user - User model instance or plain object
   * @param {string} type - Notification type key (e.g., 'event_confirmation', 'reminder')
   * @param {string} channel - 'email' or 'sms'
   * @returns {boolean} Whether the notification should be sent on this channel
   */
  getPreference(user, type, channel) {
    // 1. Channel-specific gates (checked FIRST)
    if (channel === 'sms') {
      if (!user.sms_enabled) return false;
      if (!user.phone) return false;
      if (!user.phone_verified) return false;
    }

    if (channel === 'email') {
      if (user.email_notifications_enabled === false) return false;
    }

    // 2. Check explicit preference in notification_preferences JSONB
    const prefs = user.notification_preferences;
    if (prefs && prefs[type] && typeof prefs[type][channel] === 'boolean') {
      return prefs[type][channel];
    }

    // 3. Defaults -- email on, sms off (strict opt-in)
    if (channel === 'email') return true;
    if (channel === 'sms') return false;

    // Unknown channel -- deny by default
    return false;
  }

  /**
   * Send a notification to a user on all applicable channels.
   * Dispatches to email and/or SMS based on user preferences.
   * Errors on individual channels are caught and logged, never thrown.
   *
   * @param {Object} user - User model instance with preference fields
   * @param {string} type - Notification type key
   * @param {Object} payload - Channel-specific data
   * @param {Object} [payload.emailParams] - Parameters for emailService.send()
   * @param {Object} [payload.data] - Template data for smsService.send()
   * @returns {Promise<{email: Object|null, sms: Object|null}>} Results from each channel
   */
  async send(user, type, payload) {
    const results = { email: null, sms: null };

    // Email channel -- guard against null emailParams (SMS-only recipients)
    if (payload.emailParams && payload.emailParams.to && this.getPreference(user, type, 'email')) {
      try {
        results.email = await this.emailService.send(payload.emailParams);
      } catch (error) {
        console.error(`[NotificationService] Email send failed for type=${type}:`, error.message);
        results.email = { success: false, error: error.message };
      }
    }

    // SMS channel
    if (this.getPreference(user, type, 'sms')) {
      try {
        results.sms = await this.smsService.send({
          to: user.phone,
          type,
          data: payload.data
        });
      } catch (error) {
        console.error(`[NotificationService] SMS send failed for type=${type}:`, error.message);
        results.sms = { success: false, error: error.message };
      }
    }

    // Log outbound SMS to SentNotification for inbound reply-to-event resolution.
    // Only logs when SMS succeeded AND caller provided an eventId in the payload.
    // Logging failure is non-fatal -- the notification was already sent.
    if (results.sms && results.sms.success && payload.eventId) {
      try {
        await SentNotification.create({
          user_id: user.user_id,
          event_id: payload.eventId,
          phone: user.phone,
          channel: 'sms',
          notification_type: type,
          twilio_sid: results.sms.sid || null,
        });
      } catch (error) {
        console.error('[NotificationService] SentNotification logging failed:', error.message);
      }
    }

    return results;
  }
  /**
   * Send a notification to multiple users in parallel.
   * Uses send() per user so each gets proper preference routing and error isolation.
   *
   * @param {Array<Object>} users - Array of user model instances
   * @param {string} type - Notification type key
   * @param {Function} payloadBuilder - (user) => payload object for send()
   * @returns {Promise<Array<{userId: string, email: Object|null, sms: Object|null}>>}
   */
  async sendToMany(users, type, payloadBuilder) {
    if (!users || users.length === 0) return [];

    console.log(`[NotificationService] sendToMany: type=${type}, recipients=${users.length}`);
    const results = [];
    const promises = users.map(async (user) => {
      try {
        const payload = payloadBuilder(user);
        const result = await this.send(user, type, payload);
        console.log(`[NotificationService] ${type} for ${user.user_id}: email=${result.email?.success ?? 'skipped'}, sms=${result.sms?.success ?? 'skipped'}`);
        results.push({ userId: user.user_id, ...result });
        return result;
      } catch (error) {
        console.error(`[NotificationService] sendToMany failed for user=${user.user_id}, type=${type}:`, error.message);
        results.push({ userId: user.user_id, email: null, sms: null, error: error.message });
      }
    });
    await Promise.allSettled(promises);
    return results;
  }
}

// Singleton export (matches emailService/smsService pattern)
const notificationService = new NotificationService();
module.exports = notificationService;

// Named export for direct testing of getPreference without going through send()
module.exports.getPreference = NotificationService.prototype.getPreference;
