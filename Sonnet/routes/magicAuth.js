// routes/magicAuth.js
// Magic link authentication endpoints for availability forms

const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { validateToken } = require('../services/magicTokenService');
const { magicTokenLimiter } = require('../middleware/rateLimiter');
const { trackValidation, extractTokenId } = require('../services/tokenAnalyticsService');
const { sendError } = require('../utils/errors');
const { User, UserAvailability, AvailabilityPrompt, GroupPromptSettings } = require('../models');

// Phase 81 Plan 03 Task 4 — compute the upcoming-Monday UTC date string
// (YYYY-MM-DD). Retained ONLY as the window-anchor fallback for prompts that
// can't be loaded (deleted prompt, lookup error) — the primary anchor is the
// prompt's send day (see getPromptWindowStart).
function getUpcomingMondayUTC(now = new Date()) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const daysUntilMonday = ((8 - day) % 7) || 7; // 1-7 days, never 0
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// Render a timestamp as a YYYY-MM-DD calendar date in the given IANA
// timezone (en-CA locale formats as YYYY-MM-DD). Falls back to the UTC date
// when the timezone is missing/invalid.
function dateInTimezone(date, tz) {
  if (tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(date);
    } catch {
      // invalid tz — fall through to UTC
    }
  }
  return date.toISOString().slice(0, 10);
}

// The check-in covers a rolling 7-day window anchored to the calendar day
// the prompt email was sent (a Thursday send paints Thu..Wed), NOT a
// Monday-anchored week. "Calendar day" is judged in the group's schedule
// timezone (GroupPromptSettings.schedule_timezone) so a Thursday-11pm send
// doesn't become a Friday anchor for the whole group; falls back to UTC.
// Returns YYYY-MM-DD, or null when the prompt can't be loaded.
async function getPromptWindowStart(promptId) {
  if (!promptId) return null;
  try {
    const prompt = await AvailabilityPrompt.findByPk(promptId, {
      attributes: ['prompt_date', 'group_id'],
    });
    if (!prompt || !prompt.prompt_date) return null;
    let scheduleTz = null;
    try {
      const settings = await GroupPromptSettings.findOne({
        where: { group_id: prompt.group_id },
        attributes: ['schedule_timezone'],
      });
      scheduleTz = settings?.schedule_timezone || null;
    } catch {
      // settings lookup is best-effort; UTC fallback below
    }
    return dateInTimezone(new Date(prompt.prompt_date), scheduleTz);
  } catch (err) {
    console.error('[magic-auth] failed to load prompt for window anchor:', err.message);
    return null;
  }
}

function addDaysUTC(yyyyMmDd, days) {
  const d = new Date(`${yyyyMmDd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * POST /api/magic-auth/validate
 * Validates a magic token and returns user info for UI confirmation
 *
 * Body: { token: string, formLoadedAt?: string }
 * Response:
 *   Success: { valid: true, user: { name, timezone }, prompt_id, expiresAt, graceUsed,
 *             gcal_connected, has_saved_availability, window_start }
 *   Failure: { error: string, action: string }
 */
router.post('/validate', magicTokenLimiter, async (req, res) => {
  try {
    const { token, formLoadedAt } = req.body;

    if (!token) {
      // Status STAYS 400 (Pitfall 2 — token_invalid is anchored to 400, not 401).
      // `action` moves under details; call-site emit (never a bare async throw).
      return sendError(res, 'token_invalid', { action: 'request_new' }, 'Token is required');
    }

    const result = await validateToken(token, formLoadedAt, { consume: false });

    if (!result.valid) {
      // Track failed validation (fire-and-forget)
      trackValidation({
        tokenId: extractTokenId(token),
        success: false,
        reason: result.reason,
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });

      // All failures get same generic message (security, ASVS V2 / T-85-03 —
      // no per-reason prose). Status STAYS 400; `action` under details.
      return sendError(res, 'token_invalid', { action: 'request_new' });
    }

    // Track successful validation (fire-and-forget)
    trackValidation({
      tokenId: result.decoded.jti,
      success: true,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      graceUsed: result.graceUsed || false
    });

    // Phase 71.2 / Plan 03 hotfix — include the user's profile TZ so the
    // availability form renders slot labels in the user's saved timezone
    // (Denver, NY, etc.) instead of falling back to the browser's detected
    // timezone, which is wrong when the browser is on a different machine
    // than where the user normally games.
    //
    // Phase 81 / Plan 01 — also pull google_calendar_enabled + google_calendar_token
    // so we can return a gcal_connected boolean that gates pre-fill button
    // rendering in plans 02 + 03. The actual token is NEVER returned — only
    // the boolean. (Information-disclosure mitigation, research V4.)
    let profileTimezone = null;
    let gcalConnected = false;
    // Phase 87.5 (BINT-02, D-04): resolve the caller's Users.id here (from the
    // SAME profile lookup — no extra query) so the re-keyed UserAvailability count
    // below can key on user_uuid. Stays null if the lookup fails → the saved-avail
    // count fails gracefully (button just won't render).
    let meId = null;
    try {
      const dbUser = await User.findOne({
        where: { user_id: result.decoded.sub },
        attributes: ['id', 'timezone', 'google_calendar_enabled', 'google_calendar_token'],
      });
      profileTimezone = dbUser?.timezone || null;
      meId = dbUser?.id || null;
      // Canonical "connected" check — both the flag AND a usable token must be
      // present. Mirrors googleAuth.js /google/status semantics so the button
      // doesn't appear for users with a stale token after a disconnect.
      gcalConnected = !!(dbUser?.google_calendar_enabled && dbUser?.google_calendar_token);
    } catch (tzErr) {
      // Non-fatal — frontend falls back to browser TZ if profileTimezone is null.
      console.error('[magic-auth] failed to look up user profile:', tzErr.message);
    }

    // Rolling 7-day check-in window anchored to the prompt's send day —
    // this is the window the form paints, the prefill endpoints fill, and
    // the has_saved_availability gate counts against. Falls back to the
    // legacy upcoming-Monday anchor only when the prompt can't be loaded.
    const windowStart = (await getPromptWindowStart(result.decoded.prompt_id))
      || getUpcomingMondayUTC();

    // Phase 81 / Plan 01 — boolean for "Use my saved availability" pre-fill
    // button. Source-of-truth is row count, NOT a derived isAvailable check
    // (research Pitfall 3: source: 'default' is the no-data fallback and
    // would falsely flip this on for users with zero stored patterns).
    //
    // Plan 03 Task 4 tightening — also gate on date-range overlap with the
    // window the form will paint. A user with only stale rows (e.g. a
    // recurring pattern that ended last month, or a one-off override from
    // 2025) should NOT get an enabled button — it would return zero matches.
    // The single predicate covers both row types: recurring patterns set
    // end_date NULL for open-ended, and specific_overrides set start_date =
    // end_date = the override's date (see routes/availability.js).
    let hasSavedAvailability = false;
    // Phase 87.5 (D-04): UserAvailability is re-keyed onto user_uuid. Key the count
    // on the resolved Users.id (meId), NOT the raw sub — a literal
    // `where: { user_uuid: result.decoded.sub }` would silently return 0 for every
    // magic-link recipient (a sub never matches a UUID column), permanently
    // disabling the "you have saved availability" button. Skip gracefully if the
    // caller's UUID could not be resolved (meId null).
    if (meId) {
      try {
        const weekStart = windowStart;
        const weekEnd = addDaysUTC(weekStart, 6); // 7-day window, inclusive
        const savedCount = await UserAvailability.count({
          where: {
            user_uuid: meId,
            start_date: { [Op.lte]: weekEnd },
            [Op.or]: [
              { end_date: null },
              { end_date: { [Op.gte]: weekStart } },
            ],
          },
        });
        hasSavedAvailability = savedCount > 0;
      } catch (countErr) {
        // Non-fatal — defaults to false (button just won't render).
        console.error('[magic-auth] failed to count saved availability:', countErr.message);
      }
    }

    // Success response with info needed by frontend
    res.json({
      valid: true,
      user: {
        name: result.decoded.name,  // For "Submitting as [Name]" UI
        timezone: profileTimezone,
      },
      prompt_id: result.decoded.prompt_id,
      expiresAt: result.tokenRecord.expires_at,
      graceUsed: result.graceUsed || false,
      // Phase 81 — pre-fill button gates (read by AvailabilityForm in 81-02 / 81-03)
      gcal_connected: gcalConnected,
      has_saved_availability: hasSavedAvailability,
      // Rolling 7-day window anchor (YYYY-MM-DD): the calendar day the prompt
      // email was sent. The form paints [window_start, window_start+6].
      window_start: windowStart,
    });

  } catch (err) {
    // Track server error (fire-and-forget)
    trackValidation({
      tokenId: extractTokenId(token),
      success: false,
      reason: 'server_error',
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    console.error('Token validation error:', err);
    res.status(500).json({
      error: 'Validation failed',
      action: 'request_new'
    });
  }
});

/**
 * POST /api/magic-auth/request-new
 * Stub endpoint for requesting a new magic link (Phase 4 will implement)
 */
router.post('/request-new', async (req, res) => {
  // Placeholder - will be implemented in Phase 4 when prompt/email integration is complete
  res.status(501).json({
    error: 'This feature will be available soon.',
    message: 'Please ask the group organizer to resend the availability prompt.'
  });
});

module.exports = router;
