// routes/availabilityPrefill.js
// Magic-token-authenticated pre-fill endpoints for the check-in availability flow.
// NOTE: This route uses magic token auth, NOT Auth0.
//
// Phase 81 Plan 02 (CHKIN-05): adds POST /gcal — returns slot IDs for slots
// where the magic-token user is FREE (no overlapping GCal busy event) in the
// requested week.
// Phase 81 Plan 03 (CHKIN-06): adds POST /saved — returns slot IDs for slots
// where the magic-token user has stored availability (recurring patterns +
// specific overrides, override-beats-recurring) intersecting the requested
// week. Filters out source:'default' so users with zero saved patterns do
// NOT get the entire grid painted (research Pitfall 3).

const express = require('express');
const router = express.Router();

const { User } = require('../models');
const { validateToken } = require('../services/magicTokenService');
const googleCalendarService = require('../services/googleCalendarService');
const availabilityService = require('../services/availabilityService');
const { magicTokenLimiter } = require('../middleware/rateLimiter');

/**
 * Inline IANA timezone validator. The availabilityService module has a
 * top-level `isValidTimezone` helper but doesn't expose it on the singleton
 * (the only thing the module exports). Re-implementing the same Intl-backed
 * check here keeps the dependency surface tight and matches research V5.
 */
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /api/availability-prefill/gcal
 *
 * Magic-token authenticated (NOT Auth0). Returns slot IDs for slots where the
 * user is FREE (no GCal busy events touching the slot) in the requested week.
 *
 * Conservative-overlap mapping (CONTEXT D-CHKIN-05): if a GCal busy event
 * touches ANY part of a 30-min slot, that slot is treated as busy and is NOT
 * included in the response. Backed by `googleCalendarService.getBusyTimesForDateRange`
 * which already uses floor-start / ceil-end slot anchoring.
 *
 * Token is NOT consumed (consume: false) — the user still needs the token to
 * submit the actual response.
 *
 * Request body: {
 *   magic_token: string,            // Required - magic token from email link
 *   start_date: "YYYY-MM-DD",       // Required - first day of the 7-day check-in window (the prompt's window_start)
 *   num_days: number (1-14),        // Required - typically 7
 *   timezone: string                // Required - IANA timezone (e.g. 'America/Los_Angeles')
 * }
 *
 * Response:
 *   Success: { slot_ids: ["2026-05-19T02:00:00.000Z", ...], count: N }
 *   Validation error: { error: string }
 *   Token error: { error: string, action: 'request_new' }
 */
router.post('/gcal', magicTokenLimiter, async (req, res) => {
  try {
    const { magic_token, start_date, num_days, timezone } = req.body;

    // ---- Input validation ----
    if (!magic_token || typeof magic_token !== 'string') {
      return res.status(400).json({ error: 'magic_token is required' });
    }
    if (!start_date || typeof start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      return res.status(400).json({ error: 'start_date must be YYYY-MM-DD' });
    }
    const numDaysInt = parseInt(num_days, 10);
    if (!Number.isFinite(numDaysInt) || numDaysInt < 1 || numDaysInt > 14) {
      return res.status(400).json({ error: 'num_days must be an integer 1-14' });
    }
    if (!timezone || !isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'timezone must be a valid IANA timezone' });
    }

    // ---- Magic-token validation (consume: false — DO NOT invalidate the token) ----
    const tokenResult = await validateToken(magic_token, null, { consume: false });
    if (!tokenResult.valid) {
      return res.status(400).json({
        error: 'This link is no longer valid.',
        action: 'request_new'
      });
    }
    const userId = tokenResult.decoded.sub;

    // ---- Load user, verify GCal still connected ----
    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!user.google_calendar_enabled || !user.google_calendar_token) {
      return res.status(400).json({ error: 'Google Calendar is not connected' });
    }

    // ---- Compute date range ----
    // start_date is the window anchor the client received from /magic-auth/validate; we trust
    // it verbatim to avoid client/server divergence at the timezone boundary
    // (research Pitfall 4).
    const startDate = new Date(`${start_date}T00:00:00.000Z`);
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + numDaysInt);

    // ---- Fetch GCal busy + build free-slot set ----
    const busySlots = await googleCalendarService.getBusyTimesForDateRange(
      user, startDate, endDate, timezone
    );
    const busyKeys = new Set(busySlots.map(s => `${s.date}_${s.startTime}`));

    const allSlots = availabilityService.generateTimeSlots(startDate, endDate, timezone);
    const freeSlotIds = allSlots
      .filter(s => !busyKeys.has(`${s.date}_${s.startTime}`))
      .map(s => new Date(`${s.date}T${s.startTime}:00.000Z`).toISOString());

    return res.json({ slot_ids: freeSlotIds, count: freeSlotIds.length });
  } catch (err) {
    console.error('[availability-prefill/gcal] error:', err);
    return res.status(500).json({ error: 'Failed to compute GCal pre-fill' });
  }
});

/**
 * POST /api/availability-prefill/saved
 *
 * Magic-token authenticated (NOT Auth0). Returns slot IDs for slots where the
 * magic-token user has stored availability (recurring patterns + specific
 * overrides) intersecting the requested week. Override-beats-recurring
 * precedence is handled inside `availabilityService.calculateUserAvailability`.
 *
 * Pitfall 3 guard: the service returns `{ isAvailable: true, source: 'default' }`
 * for EVERY slot when a user has zero saved patterns/overrides ("we have no
 * info, assume open"). Painting that on the grid would falsely suggest the
 * user had declared themselves available all week, so we filter `source !==
 * 'default'`. Users with no saved data get `{ slot_ids: [], count: 0 }`.
 *
 * GCal is intentionally forced OFF on a cloned user object so this endpoint
 * returns ONLY saved-pattern data — the GCal source is plan 02's domain.
 * The DB record is never mutated; only the spread clone passed to the service.
 *
 * Token is NOT consumed (consume: false) — the user still needs the token to
 * submit the actual response.
 *
 * Request body: {
 *   magic_token: string,            // Required - magic token from email link
 *   start_date: "YYYY-MM-DD",       // Required - first day of the 7-day check-in window (the prompt's window_start)
 *   num_days: number (1-14),        // Required - typically 7
 *   timezone: string                // Required - IANA timezone (e.g. 'America/Los_Angeles')
 * }
 *
 * Response:
 *   Success: { slot_ids: ["2026-05-19T02:00:00.000Z", ...], count: N }
 *   Validation error: { error: string }
 *   Token error: { error: string, action: 'request_new' }
 */
router.post('/saved', magicTokenLimiter, async (req, res) => {
  try {
    const { magic_token, start_date, num_days, timezone } = req.body;

    // ---- Input validation (same shape as /gcal) ----
    if (!magic_token || typeof magic_token !== 'string') {
      return res.status(400).json({ error: 'magic_token is required' });
    }
    if (!start_date || typeof start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
      return res.status(400).json({ error: 'start_date must be YYYY-MM-DD' });
    }
    const numDaysInt = parseInt(num_days, 10);
    if (!Number.isFinite(numDaysInt) || numDaysInt < 1 || numDaysInt > 14) {
      return res.status(400).json({ error: 'num_days must be an integer 1-14' });
    }
    if (!timezone || !isValidTimezone(timezone)) {
      return res.status(400).json({ error: 'timezone must be a valid IANA timezone' });
    }

    // ---- Magic-token validation (consume: false — DO NOT invalidate the token) ----
    const tokenResult = await validateToken(magic_token, null, { consume: false });
    if (!tokenResult.valid) {
      return res.status(400).json({
        error: 'This link is no longer valid.',
        action: 'request_new'
      });
    }
    // IDOR mitigation: derive user_id from the verified token claim, NEVER
    // from the request body.
    const userId = tokenResult.decoded.sub;

    // ---- Load user; force gcal disabled for the saved-only computation ----
    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // Spread clone so we don't mutate the Sequelize instance. Setting
    // google_calendar_enabled:false makes calculateUserAvailability skip its
    // GCal branch entirely — we get pure recurring + override output.
    const userForCalc = { ...user.toJSON(), google_calendar_enabled: false };

    // ---- Compute date range ----
    // start_date is the window anchor the client received from /magic-auth/validate; we
    // trust it verbatim to avoid client/server divergence (research Pitfall 4).
    const startDate = new Date(`${start_date}T00:00:00.000Z`);
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + numDaysInt);

    // ---- Run calculation; filter saved-only available slots ----
    // Phase 87.5 (BINT-02, D-04) rekey audit: the saved-availability read is
    // delegated to availabilityService.calculateUserAvailability, which keys its
    // UserAvailability query on user_uuid (Users.id) via the passed user's `.id`
    // (flipped in Plan 02). userForCalc carries `id` from user.toJSON(), so this
    // endpoint is UUID-native through delegation — no direct sub-keyed query lives
    // here to flip.
    const slots = await availabilityService.calculateUserAvailability(
      userForCalc, startDate, endDate, timezone
    );
    const savedSlotIds = slots
      // Pitfall 3 guard: `source: 'default'` means "user has zero data, we
      // synthetically marked the slot available" — never paint those.
      .filter(s => s.isAvailable && s.source !== 'default')
      .map(s => new Date(`${s.date}T${s.startTime}:00.000Z`).toISOString());

    return res.json({ slot_ids: savedSlotIds, count: savedSlotIds.length });
  } catch (err) {
    console.error('[availability-prefill/saved] error:', err);
    return res.status(500).json({ error: 'Failed to compute saved-availability pre-fill' });
  }
});

module.exports = router;
