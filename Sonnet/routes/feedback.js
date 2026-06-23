// routes/feedback.js
const express = require('express');
const router = express.Router();
// @octokit/rest is ESM-only; use dynamic import
let Octokit;
async function getOctokit() {
  if (!Octokit) {
    const mod = await import('@octokit/rest');
    Octokit = mod.Octokit;
  }
  return Octokit;
}
const { validateFeedback } = require('../middleware/validators');
const { verifyAuth0Token } = require('../middleware/auth0');
const { requirePlatformAdmin } = require('../middleware/adminAuth');
const { Feedback } = require('../models');
const emailService = require('../services/emailService');

// Submit feedback as a GitHub Issue (with DB fallback)
router.post('/github', verifyAuth0Token, async (req, res) => {
  try {
    const { category, text, pageUrl, userName, userEmail, label, userAgent } = req.body;

    // Inline validation
    if (!category || typeof category !== 'string' || !category.trim()) {
      return res.status(400).json({ error: 'Category is required' });
    }
    if (!text || typeof text !== 'string' || text.trim().length < 10) {
      return res.status(400).json({ error: 'Feedback must be at least 10 characters' });
    }
    if (!pageUrl || typeof pageUrl !== 'string' || !pageUrl.trim()) {
      return res.status(400).json({ error: 'Page URL is required' });
    }

    const title = `[Feedback] ${category}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`;
    const body = [
      '## Feedback',
      '',
      text,
      '',
      '---',
      `**Page:** ${pageUrl}`,
      `**User:** ${userName || 'Unknown'}`,
      `**Email:** ${userEmail || 'Not provided'}`,
      `**Category:** ${category}`,
      `**Submitted:** ${new Date().toISOString()}`,
      '',
      '<details>',
      '<summary>Browser Info</summary>',
      '',
      userAgent || 'Not captured',
      '',
      '</details>',
    ].join('\n');
    const labels = [label || 'feedback:general'];

    try {
      const OctokitClass = await getOctokit();
      const octokit = new OctokitClass({ auth: process.env.GITHUB_TOKEN });
      await octokit.issues.create({
        owner: process.env.GITHUB_REPO_OWNER,
        repo: process.env.GITHUB_REPO_NAME,
        title,
        body,
        labels,
      });
    } catch (err) {
      console.error('GitHub Issue creation failed, falling back to DB:', err.message);
      await Feedback.create({
        type: 'feedback',
        subject: title,
        description: text,
        user_email: userEmail || null,
        user_id: req.auth?.sub || null,
        page_context: pageUrl,
      });
    }

    res.json({ message: 'Thanks! Your feedback has been submitted.' });
  } catch (error) {
    console.error('Error submitting feedback to GitHub:', error);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// Submit bug report or suggestion
router.post('/', validateFeedback, async (req, res) => {
  try {
    const { type, subject, description, user_email, user_id, screenshot_base64, screenshot_filename } = req.body;

    // Save to database
    const entry = await Feedback.create({
      type,
      subject,
      description,
      user_email: user_email || null,
      user_id: user_id || null,
    });

    console.log(`Feedback saved: ${type} - ${subject.substring(0, 50)}${subject.length > 50 ? '...' : ''}`);

    // Email notification to admin
    const adminEmail = process.env.FEEDBACK_EMAIL;
    if (adminEmail && emailService.isConfigured()) {
      // HTML-escape user-supplied content before HTML interpolation, and
      // CRLF-strip the subject to block mail-header injection (BSEC-04).
      const safeType = emailService.escapeHtml(type);
      const safeSubject = emailService.escapeHtml(subject);
      const safeDescription = emailService.escapeHtml(description);
      const safeFrom = emailService.escapeHtml(user_email || 'Anonymous');
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #064e3b; color: white; padding: 16px 20px; border-radius: 6px 6px 0 0;">
            <h2 style="margin: 0;">New Feedback — Next Game Night</h2>
          </div>
          <div style="background-color: #f9fafb; padding: 24px; border-radius: 0 0 6px 6px; border: 1px solid #e5e7eb;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr><td style="padding: 8px 0; color: #6b7280; width: 120px;"><strong>Type</strong></td><td style="padding: 8px 0;">${safeType}</td></tr>
              <tr><td style="padding: 8px 0; color: #6b7280;"><strong>Subject</strong></td><td style="padding: 8px 0;">${safeSubject}</td></tr>
              <tr><td style="padding: 8px 0; color: #6b7280;"><strong>From</strong></td><td style="padding: 8px 0;">${safeFrom}</td></tr>
              <tr><td style="padding: 8px 0; color: #6b7280;"><strong>Time</strong></td><td style="padding: 8px 0;">${new Date(entry.created_at).toLocaleString()}</td></tr>
            </table>
            <div style="margin-top: 16px; padding: 16px; background: white; border-radius: 4px; border-left: 4px solid #d97706;">
              <strong style="color: #6b7280;">Description</strong>
              <p style="margin: 8px 0 0; color: #111827;">${safeDescription}</p>
            </div>
          </div>
        </div>
      `.trim();

      const text = `New Feedback — Next Game Night\n\nType: ${type}\nSubject: ${subject}\nFrom: ${user_email || 'Anonymous'}\nTime: ${new Date(entry.created_at).toLocaleString()}\n\n${description}`;

      // Build attachments array if screenshot provided
      const attachments = [];
      if (screenshot_base64 && screenshot_filename) {
        const mimeType = screenshot_filename.match(/\.(png)$/i) ? 'image/png'
          : screenshot_filename.match(/\.(gif)$/i) ? 'image/gif'
          : 'image/jpeg';
        attachments.push({
          content: screenshot_base64,
          filename: screenshot_filename,
          type: mimeType,
          disposition: 'attachment',
        });
      }

      await emailService.send({
        to: adminEmail,
        subject: emailService.stripCrlf(`[Feedback] ${type}: ${subject}`),
        html,
        text,
        ...(user_email && { replyTo: user_email }),
        ...(attachments.length > 0 && { attachments }),
      });
    }

    res.json({
      message: 'Thank you for your feedback! We appreciate your input.',
      feedback_id: entry.id,
    });
  } catch (error) {
    console.error('Error submitting feedback:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/feedback — retrieve all submissions (PLATFORM-ADMIN ONLY).
//
// BSEC-02 / BE-099: this returns EVERY feedback row including every submitter's
// `user_email`. The router runs under the mount-level `optionalAuth`
// (server.js), so `req.user` is populated-if-present. We REPLACE the previous
// inline `verifyAuth0Token` with `requirePlatformAdmin` (83-03) — NOT stack
// them. requirePlatformAdmin yields 403 for a null OR non-admin req.user
// (whereas the old verifyAuth0Token 401'd a no-token request; 403 is the
// correct "you are not allowed" signal here, and a null req.user is handled).
router.get('/', requirePlatformAdmin, async (req, res) => {
  try {
    const entries = await Feedback.findAll({
      order: [['created_at', 'DESC']],
    });
    res.json(entries);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
