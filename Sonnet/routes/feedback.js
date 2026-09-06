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
const { Feedback, User } = require('../models');
const emailService = require('../services/emailService');
// Phase 88.8 plan 09 Task 4: the ONE broad `@auth0` synthetic-address guard this
// app owns, imported rather than re-implemented. Narrowing it (e.g. to
// `@auth0.local` alone) is a decision, not a cleanup — DECISION Phase 88.2
// NIX-AUTH0, services/groupOwnershipOfferService.js:97-115.
const { isSyntheticAddress } = require('../services/provisioningService');

// [87.8-05 Task 4, round-3 security] pageUrl credential scrub — BE half,
// defence-in-depth (the FE scrubs at the source in
// periodictabletop/src/lib/scrubFeedbackPageUrl.ts, but a stale client can
// still send window.location.href verbatim). The five routes below embed a
// LIVE credential in the PATH segment (signed magic JWT, HMAC RSVP token,
// invite tokens, restore nonce), and the RSVP query string carries an Auth0
// sub — so the token segment is replaced with the literal placeholder and
// any query string / fragment is stripped BEFORE the value reaches a GitHub
// Issue body or the DB page_context column.
//
// DEFAULT-DENY RULE: any route whose path embeds a credential gets a
// placeholder before entering an issue body. The list is the five token
// routes TODAY — the next token route added to the app belongs here AND in
// the FE scrub list.
const TOKEN_ROUTE_PREFIXES = [
  '/availability-form/',
  '/rsvp/',
  '/invite/group/',
  '/invite/game/',
  '/restore/group/',
];

function scrubPageUrl(pageUrl) {
  if (typeof pageUrl !== 'string' || pageUrl === '') return pageUrl;
  // Strip query string and fragment unconditionally — the RSVP query carries
  // an Auth0 sub (?e=&u=&s=), and no legitimate reporting need survives it.
  const noQuery = pageUrl.split('?')[0].split('#')[0];
  // A stale client sends an absolute URL; split off the origin so the prefix
  // match runs against the path alone.
  const originMatch = noQuery.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i);
  const origin = originMatch ? originMatch[0] : '';
  const path = originMatch ? noQuery.slice(origin.length) || '/' : noQuery;
  for (const prefix of TOKEN_ROUTE_PREFIXES) {
    if (path.startsWith(prefix)) {
      // Replace the ENTIRE dynamic remainder — never truncate the token
      // partially (a prefix of a signed token is still sensitive material).
      return `${origin}${prefix}[token]`;
    }
  }
  return `${origin}${path}`;
}

// Submit feedback as a GitHub Issue (with DB fallback)
router.post('/github', verifyAuth0Token, async (req, res) => {
  try {
    // [88.8-09 Task 4] `userEmail` is DELIBERATELY NOT DESTRUCTURED HERE ANY MORE.
    // This route runs behind verifyAuth0Token, so the server already knows who the
    // caller is; reading an address off the body let any signed-in caller file
    // feedback under someone else's address (T-88.8-84). A body that still carries
    // the key is simply IGNORED, which is what makes the frontend and backend merge
    // orders independent of each other (plan 13 Task 3 stops the client sending it).
    // `userName` is a DISPLAY NAME, not an address, and stays body-supplied — out of
    // scope for this correction and recorded here rather than silently left.
    const { category, text, pageUrl, userName, label, userAgent } = req.body;

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

    // [87.8-05 Task 4] ONE scrubbed value feeds BOTH sinks (issue body and the
    // DB fallback below) — never interpolate the raw pageUrl past this point.
    const safePageUrl = scrubPageUrl(pageUrl);

    /**
     * DECISION Phase 88.8 D-42: the feedback address on THIS route is SERVER-DERIVED
     * from the caller's `Users.email`, chosen OVER three alternatives.
     *
     * WHY IT MATTERS: D-42 moves `Feedback` rows by matching `user_email` against the
     * user's `Users.email`, and `services/accountDeletionService.js:292-298` scrubs on
     * that same column — while both writers set `user_id: null` under the 2026-07-24
     * owner decision below, so `user_email` is the ONLY link to a person. Review round
     * 4 verified the column was CLIENT-SUPPLIED and that both frontend writers send the
     * Auth0 SESSION address, which equals `Users.email` only for a row provisioned from
     * a verified claim and never repaired. This is what makes D-42's
     * `WHERE user_email = <previousEmail>` match rows this app wrote.
     *
     * REJECTED: (a) keeping the client value and having the frontend send `self.email`
     * instead — a downstream catch on a route where the server already knows the
     * answer, and it leaves the endpoint accepting an address any signed-in caller can
     * assert; (b) normalising or validating the client value — same problem, more code;
     * (c) DERIVING the address on the public `POST /` path the same way — it carries no
     * bearer, so there is nothing to derive from, and its comment at :139-144 already
     * records why the row is unattributed.
     *
     * (c) REJECTS THE DERIVATION ONLY, AND NOT THE SYNTHETIC GUARD BELOW. The two are
     * different changes, and conflating them is exactly how the guard gets dropped in a
     * later tidy-up.
     *
     * THE SCOPE IS NOT OPTIONAL: `models/User.js:133-143`'s defaultScope excludes
     * `email`, so a bare `User.findOne` returns a row whose `email` is `undefined` and
     * every caller would silently persist null — the same Phase 88-34 Rule 1 trap
     * `routes/users.js` records.
     *
     * ONE derived binding feeds BOTH sinks, mirroring `safePageUrl` above: the issue
     * body's Email line and `Feedback.create`'s `user_email`. A missing row and a
     * SYNTHETIC address both resolve to null — a `<sub>@auth0.local` sentinel is not a
     * contact handle and must never be published into a GitHub issue.
     *
     * THE TWO FEEDBACK SINKS NOW SHARE ONE RULE: this writer DERIVES the address and
     * drops it when synthetic; the public writer below ACCEPTS the address and drops it
     * when synthetic. The frontend half is `88.8-13-PLAN.md` Task 1's shared
     * `isSyntheticAddress` helper — named here because neither repo's CI can see the
     * other, so the rule has to be written down on both sides.
     */
    let safeUserEmail = null;
    const caller = req.user && req.user.user_id
      ? await User.scope('withContactInfo').findOne({ where: { user_id: req.user.user_id } })
      : null;
    if (caller && caller.email && !isSyntheticAddress(caller.email)) {
      safeUserEmail = caller.email;
    }

    const title = `[Feedback] ${category}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`;
    const body = [
      '## Feedback',
      '',
      text,
      '',
      '---',
      `**Page:** ${safePageUrl}`,
      `**User:** ${userName || 'Unknown'}`,
      `**Email:** ${safeUserEmail || 'Not provided'}`,
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
      // [87.6, owner decision 2026-07-24] Feedback rows carry no user attribution
      // (see POST / below) — user_email is the contact handle on this path too.
      await Feedback.create({
        type: 'feedback',
        subject: title,
        description: text,
        user_email: safeUserEmail,
        user_id: null,
        page_context: safePageUrl,
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
    const { type, subject, description, user_email, screenshot_base64, screenshot_filename } = req.body;

    /**
     * [88.8-09 Task 4] BELT AND BRACES — the SAME broad `@auth0` guard as the
     * authenticated writer above, applied to this path's CLIENT-SUPPLIED address.
     *
     * The derivation above fixes the authenticated writer, but it would leave the
     * synthetic-address rule living in ONE place while `Feedback.user_email` has TWO
     * writers. Plan 13 Task 3 stops the public CLIENT from sending a synthetic value —
     * and that is a client fix on an UNAUTHENTICATED endpoint, which anyone can post to
     * directly and which a future client edit can silently regress with nothing
     * downstream to catch it. So the rule lives server-side as well.
     *
     * THE ADDRESS ON THIS PATH STAYS CLIENT-SUPPLIED. The guard DROPS a sentinel; it
     * does not DERIVE a replacement. There is no bearer here, so there is no
     * server-side identity to derive from — see the owner-decision comment below.
     *
     * ONE derived binding feeds BOTH sinks (the `Feedback` row and the admin mail),
     * mirroring `safePageUrl`'s shape at :90-92.
     *
     * EVERYTHING DOWNSTREAM ALREADY HANDLES null CORRECTLY — confirmed by reading
     * rather than by adding branches: the two From lines are `... || 'Anonymous'`, so
     * the mail falls back on its own, and the `replyTo` spread is conditional, so a null
     * OMITS the key entirely rather than sending an empty one. The consequence, stated
     * plainly: a submitter whose address is synthetic loses the reply-to affordance,
     * which is correct — there is no inbox behind a `<sub>@auth0.local` sentinel to
     * reply to.
     */
    const safeSubmitterEmail = user_email && !isSyntheticAddress(user_email) ? user_email : null;

    // [87.6, owner decision 2026-07-24, review WR-01] Feedback is NOT attributed
    // to a user account: this route rides the public transport (no bearer), so
    // any user_id would be client-asserted and unverifiable. user_email is the
    // contact handle. The user_id column is retained for historical rows only
    // (account deletion anonymizes them); new rows always store null.
    const entry = await Feedback.create({
      type,
      subject,
      description,
      user_email: safeSubmitterEmail,
      user_id: null,
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
      const safeFrom = emailService.escapeHtml(safeSubmitterEmail || 'Anonymous');
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

      const text = `New Feedback — Next Game Night\n\nType: ${type}\nSubject: ${subject}\nFrom: ${safeSubmitterEmail || 'Anonymous'}\nTime: ${new Date(entry.created_at).toLocaleString()}\n\n${description}`;

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
        ...(safeSubmitterEmail && { replyTo: safeSubmitterEmail }),
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
// Exported for the unit test (tests/routes/feedback.test.js) — pure helper,
// no router behaviour attached.
module.exports.scrubPageUrl = scrubPageUrl;
