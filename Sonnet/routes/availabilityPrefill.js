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
 * DECISION Phase 88-34 WI-B3 (walk MAJOR M6, fork C — owner-ruled 2026-08-20):
 * compute the prefill window from LOCAL-DAY boundaries in the request's
 * timezone, over the two alternatives that were on the table.
 *
 * THE BUG (live-verified 2026-08-10). Both endpoints used to anchor the window
 * at `new Date(`${start_date}T00:00:00.000Z`)` plus N *UTC* days — calendar-UTC
 * midnights laid over a grid the user reads in LOCAL days. availabilityService
 * .generateTimeSlots filters half-open on those instants, so in PDT (UTC-7) the
 * last local day's 17:00 is already 00:00Z on the day AFTER the end bound and
 * every slot from 17:00 local onward on that day was silently dropped — the
 * whole evening, which is precisely when people play board games. The same
 * offset pulled in a phantom sliver of the *previous* local day at the start
 * (the orphan previous-Saturday rollover ids seen on the live endpoint).
 *
 * REJECTED: widening the window by ±1 day, the precedent
 * availabilityService.getGroupHeatmap:624-627 sets. That is safe THERE because
 * the heatmap is a read-only aggregation. It is NOT safe here: prefill output
 * round-trips into a WRITE. AvailabilityForm setValue's every returned slot id
 * and submits them verbatim (AvailabilityForm.js performGcalPrefill /
 * performSavedPrefill), so a widened window would persist out-of-week slots as
 * PHANTOM AVAILABILITY the user never selected and cannot see on the grid.
 *
 * REJECTED: manual offset arithmetic (`hours * 3600000`). Fixed-offset math is
 * wrong across DST transitions and wrong for the sub-hour zones (Asia/Kolkata
 * +05:30, Asia/Kathmandu +05:45, Pacific/Chatham +12:45). Both endpoints
 * already receive a VALIDATED IANA timezone, so the offset is measured with
 * Intl at the instant in question instead — the same Intl-backed idiom as
 * magicAuth.dateInTimezone and availabilityService.localToUtc.
 *
 * If you are tempted to widen this window: the guard test
 * ("no returned instant falls outside the requested local window") will stop
 * you, and it is there on purpose.
 */

/**
 * Measure a timezone's UTC offset AT a specific instant (DST-correct, and
 * correct for sub-hour offsets because it compares whole timestamps, not hours).
 *
 * @param {Date} instant
 * @param {string} timeZone - validated IANA timezone
 * @returns {number} offset in ms (local wall clock - UTC)
 */
function tzOffsetMsAt(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  // Some engines render midnight as hour '24' under hour12:false.
  const hour = parts.hour === '24' ? '00' : parts.hour;

  const wallClockAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(hour), Number(parts.minute), Number(parts.second)
  );
  return wallClockAsUtc - instant.getTime();
}

/**
 * The UTC instant at which a given LOCAL calendar day begins in a timezone.
 *
 * Two-pass: guess using the offset measured at the naive instant, then
 * re-measure at the corrected instant. The second pass is what makes DST
 * transition days correct — the offset on the far side of the guess can differ
 * from the offset at the naive instant.
 *
 * @param {string} yyyyMmDd - local calendar date
 * @param {string} timeZone - validated IANA timezone
 * @returns {Date} UTC instant of 00:00 local on that date
 */
function startOfLocalDayUtc(yyyyMmDd, timeZone) {
  const naiveMs = Date.parse(`${yyyyMmDd}T00:00:00.000Z`);
  const firstPass = naiveMs - tzOffsetMsAt(new Date(naiveMs), timeZone);
  const secondPass = naiveMs - tzOffsetMsAt(new Date(firstPass), timeZone);
  return new Date(secondPass);
}

/**
 * Add whole CALENDAR days to a YYYY-MM-DD string. Deliberately timezone-free:
 * "the day after the window's last local day" is a calendar question, and doing
 * it on instants is how a DST day (23 or 25 hours long) shifts the answer.
 *
 * @param {string} yyyyMmDd
 * @param {number} days
 * @returns {string} YYYY-MM-DD
 */
function addCalendarDays(yyyyMmDd, days) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The shared window helper both endpoints use. Half-open [start, end):
 *   start = 00:00 local on `start_date`
 *   end   = 00:00 local on the day AFTER the window's last local day
 * so the window is exactly the numDays local days the user sees on the grid —
 * no clipped evening, no rolled-over sliver of a neighbouring day.
 *
 * @param {string} start_date - YYYY-MM-DD, the window's first LOCAL day
 * @param {number} numDays
 * @param {string} timezone - validated IANA timezone
 * @returns {{ startDate: Date, endDate: Date }}
 */
function localDayWindow(start_date, numDays, timezone) {
  return {
    startDate: startOfLocalDayUtc(start_date, timezone),
    endDate: startOfLocalDayUtc(addCalendarDays(start_date, numDays), timezone),
  };
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
    // (research Pitfall 4). It is a LOCAL calendar date, so the bounds are
    // local-day boundaries in the request's validated timezone — see the M6 /
    // fork-C decision block at the top of this file.
    const { startDate, endDate } = localDayWindow(start_date, numDaysInt, timezone);

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
    // Same shared local-day helper as /gcal — the two endpoints computed
    // byte-identical bounds before M6 and must stay identical after it.
    const { startDate, endDate } = localDayWindow(start_date, numDaysInt, timezone);

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
