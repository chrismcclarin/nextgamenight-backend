// routes/webhooks.js
// Webhook handlers for external service callbacks (Resend delivery events, Twilio inbound SMS)
const express = require('express');
const crypto = require('crypto');
const twilio = require('twilio');
const { Op } = require('sequelize');
const router = express.Router();
const { EmailMetrics, User, Event, EventRsvp, SentNotification, Game } = require('../models');
const { parseReply } = require('../services/smsReplyParser');
const { smsInboundLimiter } = require('../middleware/rateLimiter');

/**
 * Verify Resend webhook signature (Svix)
 * Resend uses svix-id, svix-timestamp, svix-signature headers
 * @param {string} secret - Resend webhook signing secret (whsec_...)
 * @param {string} payload - Raw request body as string
 * @param {Object} headers - Request headers
 * @returns {boolean} True if signature is valid
 */
function verifyResendSignature(secret, payload, headers) {
  const svixId = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    return false;
  }

  try {
    // Reject timestamps older than 5 minutes to prevent replay attacks
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(svixTimestamp)) > 300) {
      return false;
    }

    // Strip the whsec_ prefix and decode the secret
    const secretBytes = Buffer.from(secret.replace('whsec_', ''), 'base64');

    // Build the signed content: "{svix-id}.{svix-timestamp}.{body}"
    const signedContent = `${svixId}.${svixTimestamp}.${payload}`;

    const expectedSignature = crypto
      .createHmac('sha256', secretBytes)
      .update(signedContent)
      .digest('base64');

    // svix-signature may contain multiple signatures separated by spaces (e.g. "v1,sig1 v1,sig2")
    const signatures = svixSignature.split(' ');
    return signatures.some(sig => {
      const sigValue = sig.split(',')[1];
      return sigValue && crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(sigValue)
      );
    });
  } catch (error) {
    console.error('Error verifying Resend webhook signature:', error.message);
    return false;
  }
}

/**
 * Handle Resend webhook events
 * Events: email.sent, email.delivered, email.bounced, email.complained,
 *         email.delivery_delayed, email.opened, email.clicked
 *
 * POST /api/webhooks/resend
 */
router.post('/resend', async (req, res) => {
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);

  const signingSecret = process.env.RESEND_WEBHOOK_SECRET;

  if (signingSecret) {
    if (!verifyResendSignature(signingSecret, rawBody, req.headers)) {
      console.warn('Resend webhook signature verification failed.');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    if (process.env.NODE_ENV === 'production') {
      console.warn('RESEND_WEBHOOK_SECRET not configured. Rejecting webhook in production.');
      return res.status(401).json({ error: 'Webhook verification not configured' });
    }
    console.warn('RESEND_WEBHOOK_SECRET not configured. Allowing webhook in development.');
  }

  const { type, data } = req.body;
  const emailId = data?.email_id || 'unknown';
  const toEmail = Array.isArray(data?.to) ? data.to[0] : data?.to;
  // Extract prompt_id from Resend tags array
  const promptIdTag = data?.tags?.find?.(t => t.name === 'prompt_id');
  const promptId = promptIdTag?.value || null;

  switch (type) {
    case 'email.sent':
      console.log(`[Resend] Email sent - ID: ${emailId}, To: ${maskEmail(toEmail)}`);
      break;

    case 'email.delivered':
      console.log(`[Resend] Email delivered - ID: ${emailId}, To: ${maskEmail(toEmail)}`);
      try {
        await EmailMetrics.create({
          sg_message_id: emailId,
          event_type: 'delivered',
          email_hash: toEmail ? crypto.createHash('sha256').update(toEmail).digest('hex') : null,
          prompt_id: promptId,
          occurred_at: new Date(data.created_at || Date.now()),
          sg_machine_open: false,
          source_type: 'resend_live'
        });
      } catch (e) { console.error('[Webhooks] Failed to persist delivered event:', e.message); }
      break;

    case 'email.bounced':
      console.error(`[Resend] Email bounced - ID: ${emailId}, To: ${maskEmail(toEmail)}`);
      try {
        await EmailMetrics.create({
          sg_message_id: emailId,
          event_type: 'bounce',
          email_hash: toEmail ? crypto.createHash('sha256').update(toEmail).digest('hex') : null,
          prompt_id: promptId,
          occurred_at: new Date(data.created_at || Date.now()),
          sg_machine_open: false,
          source_type: 'resend_live'
        });
      } catch (e) { console.error('[Webhooks] Failed to persist bounce event:', e.message); }
      break;

    case 'email.complained':
      console.warn(`[Resend] Spam complaint - ID: ${emailId}, To: ${maskEmail(toEmail)}`);
      try {
        await EmailMetrics.create({
          sg_message_id: emailId,
          event_type: 'spamreport',
          email_hash: toEmail ? crypto.createHash('sha256').update(toEmail).digest('hex') : null,
          prompt_id: promptId,
          occurred_at: new Date(data.created_at || Date.now()),
          sg_machine_open: false,
          source_type: 'resend_live'
        });
      } catch (e) { console.error('[Webhooks] Failed to persist spamreport event:', e.message); }
      break;

    case 'email.delivery_delayed':
      console.warn(`[Resend] Email delivery delayed - ID: ${emailId}, To: ${maskEmail(toEmail)}`);
      break;

    case 'email.opened':
      console.log(`[Resend] Email opened - ID: ${emailId}, To: ${maskEmail(toEmail)}`);
      try {
        await EmailMetrics.create({
          sg_message_id: emailId,
          event_type: 'open',
          email_hash: toEmail ? crypto.createHash('sha256').update(toEmail).digest('hex') : null,
          prompt_id: promptId,
          occurred_at: new Date(data.created_at || Date.now()),
          sg_machine_open: false,
          source_type: 'resend_live'
        });
      } catch (e) { console.error('[Webhooks] Failed to persist open event:', e.message); }
      break;

    case 'email.clicked':
      console.log(`[Resend] Link clicked - ID: ${emailId}, To: ${maskEmail(toEmail)}`);
      break;

    default:
      console.log(`[Resend] Event: ${type} - ID: ${emailId}`);
  }

  res.status(200).json({ received: true });
});

// Legacy SendGrid endpoint — returns 200 but does nothing
router.post('/sendgrid', (req, res) => {
  console.warn('[Webhooks] Received request to deprecated /sendgrid endpoint. Use /resend instead.');
  res.status(200).json({ received: true, deprecated: true });
});

/**
 * Mask email address for privacy in logs
 * example@domain.com -> e***e@d***.com
 */
function maskEmail(email) {
  if (!email) return 'unknown';

  try {
    const [local, domain] = email.split('@');
    if (!local || !domain) return 'invalid';

    const maskedLocal = local.length > 2
      ? `${local[0]}***${local[local.length - 1]}`
      : `${local[0]}***`;

    const domainParts = domain.split('.');
    const maskedDomain = domainParts[0].length > 2
      ? `${domainParts[0][0]}***`
      : `${domainParts[0][0]}*`;

    return `${maskedLocal}@${maskedDomain}.${domainParts.slice(1).join('.')}`;
  } catch (error) {
    return 'unknown';
  }
}

// ============================================================
// Twilio Inbound SMS Webhook
// ============================================================

/**
 * Twilio signature validation middleware.
 * In production, validates X-Twilio-Signature using TWILIO_AUTH_TOKEN.
 * In non-production, validation is skipped automatically.
 * twilio.webhook() handles URL reconstruction and protocol detection internally,
 * avoiding proxy pitfalls (RESEARCH.md Pitfall 2).
 */
const twilioWebhookValidation = twilio.webhook({ validate: process.env.NODE_ENV === 'production' });

/**
 * Handle inbound SMS replies from Twilio.
 * Users RSVP to events by replying to SMS notifications they received.
 *
 * Flow:
 * 1. Look up user by phone number
 * 2. Parse reply text (RSVP yes/no/maybe, opt-out, or unknown)
 * 3. Resolve target event via most recent SentNotification
 * 4. Upsert EventRsvp record
 * 5. Return TwiML auto-reply with confirmation
 *
 * POST /api/webhooks/twilio/sms
 */
router.post('/twilio/sms', smsInboundLimiter, twilioWebhookValidation, async (req, res) => {
  try {
    const { From, Body } = req.body;

    // 1. Look up user by phone number
    const user = await User.findOne({ where: { phone: From } });
    if (!user) {
      // Unknown phone number -- silent ignore (no response)
      return res.type('text/xml').send('<Response/>');
    }

    // 2. Parse the reply text
    const parsed = parseReply(Body);

    // 3. Handle by parsed type
    const twiml = new twilio.twiml.MessagingResponse();

    // Opt-out: disable SMS and confirm
    if (parsed.type === 'opt_out') {
      user.sms_enabled = false;
      await user.save();
      twiml.message("You've been unsubscribed from SMS notifications. You can re-enable SMS in your profile.");
      return res.type('text/xml').send(twiml.toString());
    }

    // Unknown text: send help message
    if (parsed.type === 'unknown') {
      twiml.message('Reply 1=Yes, 2=No, 3=Maybe to RSVP. Reply STOP to opt out.');
      return res.type('text/xml').send(twiml.toString());
    }

    // RSVP: resolve event via most recent SentNotification
    const notification = await SentNotification.findOne({
      where: { phone: From, channel: 'sms' },
      include: [{
        model: Event,
        where: { status: { [Op.ne]: 'cancelled' } },
        include: [{ model: Game, attributes: ['name'] }],
        required: true,
      }],
      order: [['sent_at', 'DESC']],
    });

    if (!notification) {
      twiml.message('No upcoming events to RSVP for right now.');
      return res.type('text/xml').send(twiml.toString());
    }

    // Check for stale event (already passed)
    const eventDate = new Date(notification.Event.start_date);
    if (eventDate < new Date()) {
      const frontendUrl = process.env.FRONTEND_URL || 'https://nextgamenight.app';
      twiml.message(`That event has already passed. Check the app for upcoming events: ${frontendUrl}`);
      return res.type('text/xml').send(twiml.toString());
    }

    // 4. RSVP upsert (matching existing pattern from routes/rsvp.js).
    // Phase 87.1 (BINT-02, D-11): the user is already resolved (via phone) above,
    // so key EventRsvp on user_uuid (Users.id) — the old Auth0-string user_id column
    // was removed from the model in Plan 09.
    const existing = await EventRsvp.findOne({
      where: { event_id: notification.Event.id, user_uuid: user.id },
    });

    if (existing) {
      await existing.update({ status: parsed.status });
    } else {
      await EventRsvp.create({
        event_id: notification.Event.id,
        user_uuid: user.id,
        status: parsed.status,
      });
    }

    // 5. Build confirmation TwiML. No link — game name + date in the body is
    // enough verification, and the original SMS the user replied to already
    // carries the event-detail link if they want to navigate there.
    const statusLabel = parsed.status.charAt(0).toUpperCase() + parsed.status.slice(1);
    const eventName = notification.Event.Game ? notification.Event.Game.name : 'Game Night';
    const dateStr = eventDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    twiml.message(`RSVP recorded: ${statusLabel} for ${eventName} (${dateStr}).`);
    return res.type('text/xml').send(twiml.toString());

  } catch (error) {
    console.error('[Webhooks] Twilio inbound SMS error:', error);
    // Never expose errors to SMS sender -- return empty TwiML
    return res.type('text/xml').send('<Response/>');
  }
});

module.exports = router;
