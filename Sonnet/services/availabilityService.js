// services/availabilityService.js
// Service for calculating user availability by merging manual patterns and Google Calendar data

const { UserAvailability, User } = require('../models');
const googleCalendarService = require('./googleCalendarService');

// Process-local cache for Google Calendar busy results. Same user reloading
// the same week within ~30s skips the network round trip; concurrent fetches
// for the same key share one in-flight promise instead of duplicating calls.
const __gcalBusyCache = new Map(); // cacheKey -> { value, expiresAt } | { promise, expiresAt }
const __GCAL_CACHE_TTL_MS = 60 * 1000;

function __gcalCacheKey(userId, startDate, endDate, timezone) {
  const s = (startDate instanceof Date) ? startDate.toISOString() : String(startDate);
  const e = (endDate instanceof Date) ? endDate.toISOString() : String(endDate);
  return `${userId}|${timezone || 'UTC'}|${s}|${e}`;
}

async function getGcalBusyCached(user, startDate, endDate, timezone) {
  const key = __gcalCacheKey(user.user_id, startDate, endDate, timezone);
  const now = Date.now();
  const hit = __gcalBusyCache.get(key);
  if (hit && hit.expiresAt > now) {
    if (hit.promise) return hit.promise;
    return hit.value;
  }
  const promise = googleCalendarService.getBusyTimesForDateRange(user, startDate, endDate, timezone)
    .then(value => {
      __gcalBusyCache.set(key, { value, expiresAt: Date.now() + __GCAL_CACHE_TTL_MS });
      return value;
    })
    .catch(err => {
      __gcalBusyCache.delete(key);
      throw err;
    });
  __gcalBusyCache.set(key, { promise, expiresAt: now + __GCAL_CACHE_TTL_MS });
  return promise;
}

// ---------------------------------------------------------------------------
// Phase 87.4 Plan 08 (SPEC Req 2, D-03, PR-2) — boundary-only sub->UUID flip.
//
// Every availability WIRE emission must carry the member's Users.id UUID, not
// their Auth0 sub. But the ENTIRE internal pipeline (availableMembers builder,
// the noDataUserIds exclusion filter, the members00/members30 intersection,
// overlapAvailable/finalAvailable keying, the pollResponseMap overlay, and the
// gcalBusyByUser/gcalBusyMap/gcal-cache-key matching maps) stays sub-keyed —
// translating any internal site mid-pipeline silently corrupts that matching
// (double-counts a user under both a sub and a UUID key, desyncs gcal lookups,
// breaks the noDataUserIds filter). So we build ONE roster map per request and
// translate EXACTLY ONCE, in a single pass over each PUBLIC function's finished
// return payload, right before it leaves the module. Phase 87.5 deletes this
// translation layer once the availability tables are rekeyed to UUID
// (.planning/deferred/phase-87.5.md).
// ---------------------------------------------------------------------------

/**
 * Build the per-request roster map from an already-loaded `group.Users` list:
 * Auth0 sub (user_id column) -> Users.id UUID. No extra query — the roster is
 * already loaded with both `id` and `user_id`, so this avoids the N+1 that a
 * per-element User lookup inside the 7x14 slot loop would incur.
 *
 * @param {Array<{user_id: string, id: string}>} members
 * @returns {Map<string, string>} sub -> UUID
 */
function buildSubToUuid(members) {
  const map = new Map();
  for (const m of (members || [])) {
    if (m && m.user_id != null && m.id != null) {
      map.set(m.user_id, m.id);
    }
  }
  return map;
}

/**
 * Boundary translation for a collection of objects each carrying a `user_id`
 * (sub). Returns a NEW array with each `user_id` VALUE flipped sub->UUID via the
 * roster map. Field NAME stays `user_id` (no `user_uuid` sibling — locked
 * representation decision, INVENTORY §8 row 16).
 *
 * Map-miss rule (T5, coordinated with Plan 10's z.uuid() tighten): an entry
 * whose sub is not in the roster map (edge — e.g. an ex-member off the loaded
 * roster, or a stale poll responder) is DROPPED entirely. Never emit a raw sub,
 * never emit null — Plan 10 tightens the FE availability schemas to z.uuid(),
 * which rejects BOTH. Identity fields on the wire are therefore always a valid
 * Users.id UUID when present, or absent.
 *
 * @param {Array<{user_id: string}>} collection
 * @param {Map<string, string>} subToUuid
 * @returns {Array<Object>}
 */
function translateUserIdCollection(collection, subToUuid) {
  const out = [];
  for (const entry of (collection || [])) {
    if (!entry || entry.user_id == null) continue;
    const uuid = subToUuid.get(entry.user_id);
    if (uuid === undefined) continue; // unresolvable identity -> drop (never sub, never null)
    out.push({ ...entry, user_id: uuid });
  }
  return out;
}

/**
 * Validate an IANA timezone string.
 * @param {string} tz
 * @returns {boolean}
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
 * Convert a local date + hour in a given timezone to UTC date + hour.
 * Handles DST correctly by using Intl offset measurement.
 *
 * @param {string} localDateStr - 'YYYY-MM-DD' in local timezone
 * @param {number} localHour - 0-23 in local timezone
 * @param {string} timezone - IANA timezone string
 * @returns {{ utcDate: string, utcHour: number }}
 */
function localToUtc(localDateStr, localHour, timezone) {
  // Start with a naive guess: treat local time as UTC
  const naiveUtc = new Date(`${localDateStr}T${String(localHour).padStart(2, '0')}:00:00Z`);

  // Get what local hour this UTC time maps to in the target timezone
  const localResult = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(naiveUtc),
    10
  );

  // The difference tells us the offset; adjust to get correct UTC time
  const offsetHours = localResult - localHour;
  const correctedUtc = new Date(naiveUtc.getTime() - offsetHours * 3600000);

  // Verify and re-adjust for DST edge cases
  const verifyHour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(correctedUtc),
    10
  );

  let finalUtc = correctedUtc;
  if (verifyHour !== localHour) {
    const delta = (localHour - verifyHour) * 3600000;
    finalUtc = new Date(correctedUtc.getTime() + delta);
  }

  const y = finalUtc.getUTCFullYear();
  const m = String(finalUtc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(finalUtc.getUTCDate()).padStart(2, '0');

  return {
    utcDate: `${y}-${m}-${d}`,
    utcHour: finalUtc.getUTCHours(),
  };
}

class AvailabilityService {
  /**
   * Generate all 30-minute time slots for a date range
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} timezone - Timezone string
   * @returns {Array} Array of time slot objects
   */
  generateTimeSlots(startDate, endDate, timezone = 'UTC') {
    const slots = [];
    const start = new Date(startDate);
    const end = new Date(endDate);

    // Safety check: prevent infinite loops
    const maxDays = 365; // Maximum 365 days as a safety limit
    const maxIterations = maxDays * 48; // 48 slots per day (30-minute intervals)
    let iterationCount = 0;
    
    // Start from beginning of start date (UTC). Using setUTCHours keeps slot
    // keys consistent regardless of the server's local timezone — production
    // (UTC server) and dev (e.g. PDT) produce the same output. Previously
    // setHours(0,0,0,0) used LOCAL time while dateStr/timeStr were derived
    // inconsistently (dateStr from toISOString()=UTC, timeStr from
    // toTimeString()=local), producing hybrid keys that broke matching on
    // non-UTC servers. See HEAT-02 expansion 3 in 63-02 SUMMARY.
    const current = new Date(start);
    current.setUTCHours(0, 0, 0, 0);

    // Generate slots for each day until end date
    while (current <= end) {
      // Safety check to prevent infinite loops
      if (iterationCount++ > maxIterations) {
        console.error('Safety limit reached in generateTimeSlots. Stopping to prevent infinite loop.');
        throw new Error('Date range too large or invalid. Maximum processing limit reached.');
      }

      // Generate 30-minute slots for this day (00:00 to 23:30 UTC)
      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          const slotTime = new Date(current);
          slotTime.setUTCHours(hour, minute, 0, 0);

          // Only include slots within the date range
          if (slotTime >= start && slotTime < end) {
            const isoStr = slotTime.toISOString();
            const dateStr = isoStr.split('T')[0];
            const timeStr = isoStr.slice(11, 16); // HH:MM in UTC

            slots.push({
              date: dateStr,
              startTime: timeStr,
              endTime: this.add30Minutes(timeStr),
              timestamp: slotTime.getTime(),
            });
          }
        }
      }

      // Move to next day (UTC)
      const previousDate = current.getUTCDate();
      current.setUTCDate(current.getUTCDate() + 1);
      current.setUTCHours(0, 0, 0, 0);

      // Safety check: ensure date actually advanced
      if (current.getUTCDate() === previousDate) {
        console.error('Date did not advance in generateTimeSlots. Stopping to prevent infinite loop.');
        throw new Error('Invalid date progression detected. Stopping to prevent infinite loop.');
      }
    }
    
    return slots;
  }

  /**
   * Add 30 minutes to a time string (HH:MM format)
   */
  add30Minutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const totalMinutes = hours * 60 + minutes + 30;
    const newHours = Math.floor(totalMinutes / 60) % 24;
    const newMinutes = totalMinutes % 60;
    return `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
  }

  /**
   * Check if a date falls within a date range (inclusive)
   */
  isDateInRange(date, startDate, endDate) {
    const checkDate = new Date(date);
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : null;
    
    if (end) {
      return checkDate >= start && checkDate <= end;
    }
    return checkDate >= start;
  }

  /**
   * Get day of week (0 = Sunday, 6 = Saturday)
   */
  getDayOfWeek(date) {
    return new Date(date).getDay();
  }

  /**
   * Convert a UTC slot's date/time to the user's local timezone.
   * Returns { date: 'YYYY-MM-DD', startTime: 'HH:MM', dayOfWeek: 0-6 }
   */
  slotToLocal(slot, timezone) {
    if (!timezone || timezone === 'UTC') return null;
    const utcDate = new Date(`${slot.date}T${slot.startTime}:00Z`);
    const localDate = utcDate.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD
    const localTime = utcDate.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
    const localDayOfWeek = new Date(localDate + 'T12:00:00').getDay(); // noon avoids edge cases
    return { date: localDate, startTime: localTime, dayOfWeek: localDayOfWeek };
  }

  /**
   * Check if a time slot matches a recurring pattern
   */
  matchesRecurringPattern(slot, pattern, timezone, precomputedLocal) {
    // Patterns store times in the user's local timezone.
    // Slots are generated in UTC (on a UTC server). Convert to local for matching.
    // `precomputedLocal` lets the caller skip slotToLocal -- ~3000 calls/render
    // each constructing 2 Intl.DateTimeFormat instances were the dominant cost.
    const local = precomputedLocal !== undefined
      ? precomputedLocal
      : ((timezone && timezone !== 'UTC') ? this.slotToLocal(slot, timezone) : null);
    const matchDate = local ? local.date : slot.date;
    const matchTime = local ? local.startTime : slot.startTime;
    const matchDay = local ? local.dayOfWeek : this.getDayOfWeek(new Date(slot.date));

    const slotDate = new Date(matchDate);

    // Check if date is within pattern's date range
    if (!this.isDateInRange(slotDate, pattern.start_date, pattern.end_date)) {
      return false;
    }

    // Check if day of week matches
    if (pattern.pattern_data.dayOfWeek !== matchDay) {
      return false;
    }

    // Check if time slot is within pattern's time range
    const slotStart = this.timeToMinutes(matchTime);
    const patternStart = this.timeToMinutes(pattern.pattern_data.startTime);
    const patternEnd = this.timeToMinutes(pattern.pattern_data.endTime);

    // Slot is available if it starts within the pattern's time range
    // and doesn't extend beyond it
    return slotStart >= patternStart && slotStart < patternEnd;
  }

  /**
   * Convert time string (HH:MM) to minutes since midnight
   */
  timeToMinutes(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    return hours * 60 + minutes;
  }

  /**
   * Check if a time slot matches a specific override.
   *
   * Overrides are stored in the user's local time:
   *   pattern_data: { date: 'YYYY-MM-DD', startTime: 'HH:MM' (local), ... }
   * Slots are generated in UTC (slot.date / slot.startTime are UTC). Convert
   * the slot to the user's local timezone before comparing -- otherwise the
   * matcher marks the wrong UTC slot (e.g. 14:00 UTC instead of 14:00 local).
   * Mirrors matchesRecurringPattern's slotToLocal flow.
   */
  matchesSpecificOverride(slot, override, timezone, precomputedLocal) {
    const local = precomputedLocal !== undefined
      ? precomputedLocal
      : ((timezone && timezone !== 'UTC') ? this.slotToLocal(slot, timezone) : null);
    const matchDate = local ? local.date : slot.date;
    const matchTime = local ? local.startTime : slot.startTime;

    // pattern_data.date is the canonical user-intended local date for this
    // override. Compare as raw strings to avoid any TZ round-trip (both are
    // already "YYYY-MM-DD" in the user's local timezone).
    if (matchDate !== override.pattern_data.date) {
      return false;
    }

    // NOTE: Intentionally do NOT cross-check start_date/end_date here.
    // For a single-day override they are redundant with pattern_data.date,
    // and historical bad-data rows (HEAT-02 expansion 4) persisted them with
    // a 1-day shift caused by `new Date("YYYY-MM-DD")` -> UTC midnight ->
    // Sequelize DATEONLY -> local-day truncation on non-UTC servers. Trusting
    // pattern_data.date alone makes the matcher robust to that legacy shape
    // AND the post-fix coherent shape.

    // Check if time slot is within override's time range (both in local minutes-since-midnight)
    const slotStart = this.timeToMinutes(matchTime);
    const overrideStart = this.timeToMinutes(override.pattern_data.startTime);
    const overrideEnd = this.timeToMinutes(override.pattern_data.endTime);

    return slotStart >= overrideStart && slotStart < overrideEnd;
  }

  /**
   * Calculate user's availability for a date range
   * Merges manual availability patterns with Google Calendar busy times
   * @param {Object} user - User object
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @param {string} timezone - Timezone string
   * @returns {Promise<Array>} Array of time slots with availability status
   */
  async calculateUserAvailability(user, startDate, endDate, timezone = 'UTC', preloadedGcalBusy) {
    try {
      // Generate all time slots for the date range
      const allSlots = this.generateTimeSlots(startDate, endDate, timezone);

      // Precompute the local-TZ view of every slot ONCE per user. The matchers
      // previously called slotToLocal per (slot, pattern) pair -- ~3000 calls
      // per render at 7 patterns x 432 slots, each constructing 2 fresh
      // Intl.DateTimeFormat instances. Doing it once cuts that to 432 calls.
      const slotsLocal = (timezone && timezone !== 'UTC')
        ? allSlots.map(slot => this.slotToLocal(slot, timezone))
        : null;

      // Fetch manual availability patterns from database
      let manualPatterns;
      try {
        manualPatterns = await UserAvailability.findAll({
          where: {
            user_id: user.user_id,
          },
          order: [['createdAt', 'ASC']],
        });
      } catch (dbError) {
        console.error(`Database error fetching availability patterns for user ${user.user_id}:`, dbError);
        // Return empty array if database query fails - don't crash the whole calculation
        manualPatterns = [];
      }

      // Determine initial availability state.
      // If the user has ANY availability data (recurring patterns OR specific
      // overrides), start with all slots UNAVAILABLE -- they've spoken, so
      // only what they declared is true. Default-to-available is reserved for
      // users with ZERO availability data ("we have no info, assume open").
      //
      // Previously this only checked for recurring_pattern, so an override-
      // only user (e.g. two 2-hour overrides on a Tuesday) would default the
      // entire week to AVAILABLE and the positive overrides would become
      // no-ops -- the heatmap rendered fully green. Aligns with CONTEXT D-01:
      // "data-less" = no schedule AND no override.
      const hasAnyPatterns = manualPatterns.length > 0;
      const defaultAvailability = !hasAnyPatterns; // true only when user has zero availability data
      
      // Initialize all slots
      const availabilityMap = new Map();
      allSlots.forEach(slot => {
        availabilityMap.set(`${slot.date}_${slot.startTime}`, {
          ...slot,
          isAvailable: defaultAvailability,
          source: defaultAvailability ? 'default' : 'unavailable_by_default', // 'default', 'recurring_pattern', 'specific_override', 'google_calendar', 'unavailable_by_default'
        });
      });

      // Apply recurring patterns - mark matching slots as available
      const recurringPatterns = manualPatterns.filter(p => p.type === 'recurring_pattern');
      for (const pattern of recurringPatterns) {
        for (let i = 0; i < allSlots.length; i++) {
          const slot = allSlots[i];
          const local = slotsLocal ? slotsLocal[i] : null;
          if (this.matchesRecurringPattern(slot, pattern, timezone, local)) {
            const slotData = availabilityMap.get(`${slot.date}_${slot.startTime}`);
            if (slotData) {
              slotData.isAvailable = true;
              slotData.source = 'recurring_pattern';
            }
          }
        }
      }

      // Apply specific overrides (these take precedence over recurring patterns).
      // Pass the user's timezone so the matcher can compare in local time --
      // overrides are stored in local time but slots are generated in UTC.
      const specificOverrides = manualPatterns.filter(p => p.type === 'specific_override');
      for (const override of specificOverrides) {
        for (let i = 0; i < allSlots.length; i++) {
          const slot = allSlots[i];
          const local = slotsLocal ? slotsLocal[i] : null;
          if (this.matchesSpecificOverride(slot, override, timezone, local)) {
            const slotData = availabilityMap.get(`${slot.date}_${slot.startTime}`);
            if (slotData) {
              slotData.isAvailable = override.is_available !== false; // Default to true if not explicitly false
              slotData.source = 'specific_override';
            }
          }
        }
      }

      // If Google Calendar is enabled, use it as full availability override (gcal > recurring in priority)
      // Free on calendar = available, busy on calendar = unavailable.
      // Caller may pass `preloadedGcalBusy` (already-fetched busy slots) so we
      // don't fan out N parallel gcal calls when the parent already paid for
      // them; falls back to the cached helper otherwise.
      if (user.google_calendar_enabled && user.google_calendar_token) {
        try {
          const busySlots = preloadedGcalBusy !== undefined
            ? preloadedGcalBusy
            : await getGcalBusyCached(user, startDate, endDate, timezone);

          // Build set of busy slot keys for quick lookup
          const busyKeys = new Set(busySlots.map(s => `${s.date}_${s.startTime}`));

          // GCal overrides recurring: free slots → available, busy slots → unavailable
          allSlots.forEach(slot => {
            const key = `${slot.date}_${slot.startTime}`;
            const slotData = availabilityMap.get(key);
            if (slotData && slotData.source !== 'specific_override') {
              if (busyKeys.has(key)) {
                slotData.isAvailable = false;
                slotData.source = 'google_calendar';
              } else {
                slotData.isAvailable = true;
                slotData.source = 'google_calendar';
              }
            }
          });
        } catch (error) {
          console.error(`Error fetching Google Calendar busy times for user ${user.user_id}:`, error.message);
          // Continue without calendar data if there's an error
        }
      }

      // Convert map to array and return
      return Array.from(availabilityMap.values());
    } catch (error) {
      console.error('Error calculating user availability:', error);
      throw error;
    }
  }

  /**
   * INTERNAL sub-keyed overlap builder (Phase 87.4 Plan 08 rename split).
   *
   * This is the original `calculateGroupOverlaps` computation, renamed. Its
   * `availableMembers[].user_id` VALUES stay the Auth0 sub — UNTRANSLATED —
   * because `getGroupHeatmap` consumes it directly to drive its own sub-keyed
   * matching (noDataUserIds filter, members00/members30 intersection,
   * pollResponseMap overlay, gcalConflicts attach). NEVER translate here.
   *
   * The PUBLIC `calculateGroupOverlaps` below delegates to this builder and
   * applies the boundary translation for the GET /group/:group_id/overlaps
   * route consumer. Phase 87.5 collapses this split back into one function once
   * the availability tables are rekeyed to UUID (.planning/deferred/phase-87.5.md).
   *
   * @param {string} groupId - Group ID
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @param {string} timezone - Timezone string
   * @returns {Promise<Array>} Array of time slots with overlap information (sub-keyed)
   */
  async buildGroupOverlaps(groupId, startDate, endDate, timezone = 'UTC', preloadedGroup = null, preloadedGcalBusyByUser = null) {
    try {
      const { Group, UserGroup } = require('../models');

      // Get all group members. Caller may pass a preloaded Group instance to
      // avoid a duplicate findByPk roundtrip (HEAT-03 perf).
      let group = preloadedGroup;
      if (!group) {
        try {
          group = await Group.findByPk(groupId, {
            include: [{
              model: User,
              through: UserGroup,
              attributes: ['id', 'user_id', 'username', 'email', 'google_calendar_enabled', 'google_calendar_token', 'google_calendar_refresh_token', 'timezone'],
            }],
          });
        } catch (dbError) {
          console.error('Database error fetching group:', dbError);
          throw new Error(`Database error: ${dbError.message}`);
        }
      }

      if (!group) {
        throw new Error('Group not found');
      }

      const members = group.Users || [];
      if (members.length === 0) {
        return [];
      }

      // Calculate availability for each member using their stored timezone.
      // If the caller pre-fetched gcal busy data (HEAT-03 perf hoist), pass
      // the per-member slice through so calculateUserAvailability skips its
      // own gcal fetch.
      const memberAvailabilities = await Promise.all(
        members.map(member => {
          const preloadedBusy = preloadedGcalBusyByUser
            ? preloadedGcalBusyByUser.get(member.user_id)
            : undefined;
          return this.calculateUserAvailability(member, startDate, endDate, member.timezone || 'UTC', preloadedBusy)
            .then(availability => ({ member, availability }))
            .catch(error => {
              console.error(`Error calculating availability for member ${member.user_id}:`, error);
              return { member, availability: [] };
            });
        })
      );

      // Generate all time slots
      const allSlots = this.generateTimeSlots(startDate, endDate, timezone);

      // Calculate overlaps
      const overlaps = allSlots.map(slot => {
        const key = `${slot.date}_${slot.startTime}`;
        const availableMembers = [];
        
        memberAvailabilities.forEach(({ member, availability }) => {
          const memberSlot = availability.find(s => 
            s.date === slot.date && s.startTime === slot.startTime
          );
          
          if (memberSlot && memberSlot.isAvailable) {
            availableMembers.push({
              user_id: member.user_id,
              username: member.username,
              // BSEC-01 (D-03): email removed from the availability heatmap
              // response — it leaked members' emails to every viewer. The
              // include still fetches email for internal calendar matching.
            });
          }
        });

        return {
          date: slot.date,
          timeSlot: slot.startTime,
          endTime: slot.endTime,
          availableCount: availableMembers.length,
          totalMembers: members.length,
          availableMembers: availableMembers,
          unavailableCount: members.length - availableMembers.length,
        };
      });

      return overlaps;
    } catch (error) {
      console.error('Error calculating group overlaps:', error);
      throw error;
    }
  }

  /**
   * PUBLIC overlap function (Phase 87.4 Plan 08). Delegates to the sub-keyed
   * `buildGroupOverlaps` builder, then applies the boundary translation ONCE so
   * every emitted `user_id` VALUE is a Users.id UUID. This lives inside the
   * function itself — NOT left to the calling route — because the function has
   * two callers with opposite needs (getGroupHeatmap consumes the untranslated
   * builder directly; the GET /group/:group_id/overlaps route consumes this
   * translated result). Keeping the translation here means routes/availability.js
   * needs no change and any future caller of the public name is safe by default.
   * Phase 87.5 removes this pass once the availability tables are rekeyed to UUID.
   *
   * @param {string} groupId - Group ID
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @param {string} timezone - Timezone string
   * @returns {Promise<Array>} Array of time slots with overlap info (UUID-keyed emissions)
   */
  async calculateGroupOverlaps(groupId, startDate, endDate, timezone = 'UTC', preloadedGroup = null, preloadedGcalBusyByUser = null) {
    const { Group, UserGroup } = require('../models');

    // Resolve the roster ONCE so we can both (a) hand the builder a preloaded
    // group (no duplicate findByPk in the success path) and (b) build the
    // per-request subToUuid map for the boundary translation.
    let group = preloadedGroup;
    if (!group) {
      try {
        group = await Group.findByPk(groupId, {
          include: [{
            model: User,
            through: UserGroup,
            attributes: ['id', 'user_id', 'username', 'email', 'google_calendar_enabled', 'google_calendar_token', 'google_calendar_refresh_token', 'timezone'],
          }],
        });
      } catch (dbError) {
        console.error('Database error fetching group:', dbError);
        throw new Error(`Database error: ${dbError.message}`);
      }
    }

    const overlaps = await this.buildGroupOverlaps(groupId, startDate, endDate, timezone, group, preloadedGcalBusyByUser);

    // Boundary translation: single pass over the finished builder output. The
    // builder's output stays sub-keyed for getGroupHeatmap; this pass only
    // affects the public route consumer.
    const members = (group && group.Users) || [];
    const subToUuid = buildSubToUuid(members);
    return overlaps.map(slot => {
      const availableMembers = translateUserIdCollection(slot.availableMembers, subToUuid);
      return {
        ...slot,
        availableMembers,
        availableCount: availableMembers.length,
        unavailableCount: slot.totalMembers - availableMembers.length,
      };
    });
  }

  /**
   * Get ISO day of week (1=Monday through 7=Sunday)
   * @param {Date} date
   * @returns {number} 1-7
   */
  getISODayOfWeek(date) {
    const day = date.getUTCDay(); // 0=Sunday, 6=Saturday
    return day === 0 ? 7 : day;   // Convert to 1=Monday, 7=Sunday
  }

  /**
   * Format a Date to YYYY-MM-DD string (UTC)
   * @param {Date} date
   * @returns {string}
   */
  formatDateISO(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /**
   * Generate normalized 1-hour heatmap data for a group's weekly availability.
   * Wraps calculateGroupOverlaps() and buckets 30-min slots into 1-hour slots
   * using AND logic (user must be available in both halves to count).
   *
   * @param {string} groupId - Group UUID
   * @param {string} weekStart - ISO date string for the Monday of the week
   * @param {string} timezone - Timezone string (default 'UTC')
   * @returns {Promise<Object>} Normalized heatmap data
   */
  async getGroupHeatmap(groupId, weekStart, timezone = 'UTC') {
    const __t0 = Date.now();
    // 1. Validate weekStart is a Monday
    const startDate = new Date(weekStart + 'T00:00:00Z');
    if (isNaN(startDate.getTime())) {
      throw new Error('Invalid weekStart date');
    }
    const dayOfWeek = startDate.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
    if (dayOfWeek !== 1) {
      throw new Error('weekStart must be a Monday');
    }

    // 2. Calculate weekEnd (Monday + 7 days = next Monday, for overlap coverage)
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 7);
    const weekStartStr = this.formatDateISO(startDate);
    const weekEndStr = this.formatDateISO(endDate);

    // Extend the underlying overlap query window by ±1 day so local Mon–Sun
    // hours 10–23 land inside the queried UTC range for any timezone offset.
    // (e.g. PDT Sun 17:00–23:00 = next Mon 00:00–06:00 UTC, outside [Mon, nextMon).)
    const overlapStart = new Date(startDate);
    overlapStart.setUTCDate(overlapStart.getUTCDate() - 1);
    const overlapEnd = new Date(endDate);
    overlapEnd.setUTCDate(overlapEnd.getUTCDate() + 1);

    // 3. Load the group ONCE and reuse for both the overlap calc and the
    //    members/no-data accounting below (HEAT-03 perf: removes a duplicate
    //    findByPk that was costing 5-50ms per render).
    const { Group, UserGroup, AvailabilityPrompt, AvailabilityResponse } = require('../models');
    const group = await Group.findByPk(groupId, {
      include: [{
        model: User,
        through: UserGroup,
        attributes: ['id', 'user_id', 'username', 'email', 'google_calendar_enabled', 'google_calendar_token', 'google_calendar_refresh_token', 'timezone'],
      }],
    });
    const members = group ? group.Users || [] : [];
    const totalMembers = members.length;

    // 3.5. Pre-fetch Google Calendar busy slots for every gcal-enabled member
    //      ONCE in parallel, before calculateGroupOverlaps runs. This:
    //      (a) lets calculateUserAvailability skip its own gcal fetch,
    //      (b) eliminates the redundant `gcalBusyMap` second-fetch loop below,
    //      (c) hits the 60s in-process cache for warm reloads of the same week.
    const gcalEnabledMembers = members.filter(m => m.google_calendar_enabled && m.google_calendar_token);
    const gcalBusyByUser = new Map(); // user_id -> Array<{date,startTime,endTime}>
    if (gcalEnabledMembers.length > 0) {
      const results = await Promise.all(gcalEnabledMembers.map(member =>
        getGcalBusyCached(member, overlapStart, overlapEnd, member.timezone || timezone)
          .then(busy => ({ member, busy }))
          .catch(err => {
            console.warn(`Failed to fetch gcal for ${member.user_id}:`, err.message);
            return { member, busy: [] };
          })
      ));
      for (const { member, busy } of results) {
        gcalBusyByUser.set(member.user_id, busy);
      }
    }

    // 4. Get raw 30-min overlaps -- pass the preloaded group AND the gcal busy
    //    map so calculateUserAvailability doesn't re-fetch per-member.
    //    Phase 87.4 Plan 08: call the INTERNAL sub-keyed builder directly. The
    //    heatmap's own matching below (noDataUserIds filter, members00/members30
    //    intersection, pollResponseMap overlay, gcalConflicts) keys on the sub,
    //    so this input MUST stay untranslated. The single UUID translation for
    //    THIS function happens once, at its return boundary (step 9 below).
    const overlaps = await this.buildGroupOverlaps(groupId, overlapStart, overlapEnd, timezone, group, gcalBusyByUser);

    // 5. Query active poll responses for this week
    // Derive ISO week string from weekStart to match prompt's week_identifier
    const weekDate = new Date(weekStart + 'T00:00:00Z');
    // ISO week calculation: find the Thursday of this week, then get its week number
    const thursday = new Date(weekDate);
    thursday.setUTCDate(thursday.getUTCDate() + (4 - (thursday.getUTCDay() || 7)));
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
    const isoWeek = `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;

    let pollResponseMap = new Map(); // user_id -> { username, slots: Set<"date_HH:MM"> }

    const prompts = await AvailabilityPrompt.findAll({
      where: {
        group_id: groupId,
        status: 'active',
        week_identifier: isoWeek,
      },
      order: [['createdAt', 'DESC']],
      limit: 1,
    });

    if (prompts.length > 0) {
      const prompt = prompts[0];
      const responses = await AvailabilityResponse.findAll({
        where: { prompt_id: prompt.id },
        include: [{ model: User, attributes: ['user_id', 'username'] }],
      });

      for (const response of responses) {
        const userId = response.user_id;
        const username = response.User?.username || 'Unknown';
        if (!pollResponseMap.has(userId)) {
          pollResponseMap.set(userId, { username, slots: new Set() });
        }
        // Convert response time_slots to date_HH:MM keys
        for (const slot of response.time_slots || []) {
          const slotStart = new Date(slot.start);
          const dateStr = this.formatDateISO(slotStart);
          const hh = String(slotStart.getUTCHours()).padStart(2, '0');
          const mm = String(slotStart.getUTCMinutes()).padStart(2, '0');
          pollResponseMap.get(userId).slots.add(`${dateStr}_${hh}:${mm}`);
        }
      }
    }

    // 6. Build gcal busy map for users with both poll responses AND gcal enabled.
    // Reuses the already-fetched gcalBusyByUser from step 3.5 -- no new network
    // calls. Only includes users with poll responses (the conflict-detection
    // path in the bucketing loop below only consults this map for those users).
    const gcalBusyMap = new Map(); // user_id -> { username, busySlots: Set<"date_HH:MM"> }
    for (const member of members) {
      if (!gcalBusyByUser.has(member.user_id)) continue;
      if (!pollResponseMap.has(member.user_id)) continue;
      const busySet = new Set();
      for (const busy of gcalBusyByUser.get(member.user_id)) {
        busySet.add(`${busy.date}_${busy.startTime}`);
      }
      gcalBusyMap.set(member.user_id, { username: member.username, busySlots: busySet });
    }

    // Check each member for availability data sources (including poll responses).
    // Batch the UserAvailability lookup into a single query (HEAT-03 perf:
    // was N+1, one findAll per member; now O(1) regardless of member count).
    const { Op } = require('sequelize');
    const candidatesNeedingDbCheck = members.filter(m => {
      const hasGcal = m.google_calendar_enabled && m.google_calendar_token;
      const hasPollResponse = pollResponseMap.has(m.user_id);
      return !hasGcal && !hasPollResponse;
    });

    const recurringByUser = new Set();
    if (candidatesNeedingDbCheck.length > 0) {
      const ids = candidatesNeedingDbCheck.map(m => m.user_id);
      const rows = await UserAvailability.findAll({
        where: { user_id: { [Op.in]: ids } },
        attributes: ['user_id'],
      });
      for (const r of rows) recurringByUser.add(r.user_id);
    }

    const membersWithoutData = [];
    for (const member of members) {
      const hasGcal = member.google_calendar_enabled && member.google_calendar_token;
      const hasPollResponse = pollResponseMap.has(member.user_id);
      const hasRecurring = recurringByUser.has(member.user_id);
      if (!hasGcal && !hasRecurring && !hasPollResponse) {
        membersWithoutData.push({ user_id: member.user_id, username: member.username });
      }
    }

    const membersWithData = totalMembers - membersWithoutData.length;

    // Build exclusion set for data-less members (Bug 3 fix)
    const noDataUserIds = new Set(membersWithoutData.map(m => m.user_id));

    // 7. Build a lookup map for overlaps: key = "date_HH:MM"
    const overlapMap = new Map();
    for (const slot of overlaps) {
      overlapMap.set(`${slot.date}_${slot.timeSlot}`, slot);
    }

    // 8. Generate hourly slots (7 days x 14 hours: 10am-midnight) with poll merging
    //    When a valid timezone is provided, convert local 10-23 to UTC hours per day.
    //    Otherwise fall back to UTC 10-23.
    //
    //    HEAT-03 perf: localToUtc is the dominant cost (each call constructs
    //    two Intl.DateTimeFormat instances). Original code called it 7*14=98
    //    times per render. We now probe each day at hour 10 AND hour 23: if
    //    the resulting UTC delta equals 13 (i.e. no DST flip inside the day),
    //    we derive hours 11-22 arithmetically. Drops 98 calls to 14 on normal
    //    days; DST days fall back to per-hour resolution to stay correct.
    const validTz = isValidTimezone(timezone) && timezone !== 'UTC' ? timezone : null;
    if (timezone && timezone !== 'UTC' && !validTz) {
      console.warn(`getGroupHeatmap: invalid timezone "${timezone}", falling back to UTC`);
    }

    const gcalConflicts = [];
    const slots = [];
    // Hoist the localBase Date once -- inner loop only mutates dayOffset.
    const localBase = validTz ? new Date(weekStart + 'T12:00:00Z') : null;

    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const slotDate = new Date(startDate);
      slotDate.setUTCDate(slotDate.getUTCDate() + dayOffset);

      // Per-day TZ resolution: probe hour 10 and hour 23 once.
      let dayResolutions = null; // map<localHour, {utcDate, utcHour, isoDayOfWeek}>
      if (validTz) {
        const dayBase = new Date(localBase.getTime());
        dayBase.setUTCDate(dayBase.getUTCDate() + dayOffset);
        const localDateStr = dayBase.toISOString().split('T')[0];

        const c10 = localToUtc(localDateStr, 10, validTz);
        const c23 = localToUtc(localDateStr, 23, validTz);
        const totalUtcMs10 = Date.UTC(
          parseInt(c10.utcDate.slice(0, 4), 10),
          parseInt(c10.utcDate.slice(5, 7), 10) - 1,
          parseInt(c10.utcDate.slice(8, 10), 10),
          c10.utcHour
        );
        const totalUtcMs23 = Date.UTC(
          parseInt(c23.utcDate.slice(0, 4), 10),
          parseInt(c23.utcDate.slice(5, 7), 10) - 1,
          parseInt(c23.utcDate.slice(8, 10), 10),
          c23.utcHour
        );
        const expectedDeltaMs = 13 * 3600000; // hour 23 - hour 10 = 13 hours
        const noDstFlip = (totalUtcMs23 - totalUtcMs10) === expectedDeltaMs;

        dayResolutions = new Map();
        if (noDstFlip) {
          // Normal day: derive hours 10-23 arithmetically from hour 10 anchor.
          for (let h = 10; h <= 23; h++) {
            const offsetMs = (h - 10) * 3600000;
            const utcMs = totalUtcMs10 + offsetMs;
            const d = new Date(utcMs);
            const utcDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
            dayResolutions.set(h, {
              utcDate,
              utcHour: d.getUTCHours(),
              isoDayOfWeek: this.getISODayOfWeek(new Date(utcDate + 'T00:00:00Z')),
            });
          }
        } else {
          // DST transition day: fall back to per-hour resolution.
          for (let h = 10; h <= 23; h++) {
            const c = localToUtc(localDateStr, h, validTz);
            dayResolutions.set(h, {
              utcDate: c.utcDate,
              utcHour: c.utcHour,
              isoDayOfWeek: this.getISODayOfWeek(new Date(c.utcDate + 'T00:00:00Z')),
            });
          }
        }
      }

      for (let localHour = 10; localHour <= 23; localHour++) {
        let dateStr, utcHour, isoDayOfWeek;

        if (validTz) {
          const r = dayResolutions.get(localHour);
          dateStr = r.utcDate;
          utcHour = r.utcHour;
          isoDayOfWeek = r.isoDayOfWeek;
        } else {
          // Fallback: use UTC hours directly
          dateStr = this.formatDateISO(slotDate);
          utcHour = localHour;
          isoDayOfWeek = this.getISODayOfWeek(slotDate);
        }

        const h00Key = `${dateStr}_${String(utcHour).padStart(2, '0')}:00`;
        const h30Key = `${dateStr}_${String(utcHour).padStart(2, '0')}:30`;

        const slot00 = overlapMap.get(h00Key);
        const slot30 = overlapMap.get(h30Key);

        // AND logic: user must be in BOTH sub-slots to count as available
        // Filter out data-less members BEFORE intersection (Bug 3)
        const members00 = (slot00 ? slot00.availableMembers : []).filter(m => !noDataUserIds.has(m.user_id));
        const members30 = (slot30 ? slot30.availableMembers : []).filter(m => !noDataUserIds.has(m.user_id));

        // Intersect by user_id for overlap-based availability
        const members30Set = new Set(members30.map(m => m.user_id));
        const overlapAvailable = new Map(); // user_id -> { user_id, username }
        for (const m of members00) {
          if (members30Set.has(m.user_id)) {
            overlapAvailable.set(m.user_id, { user_id: m.user_id, username: m.username });
          }
        }

        // Apply poll response priority: poll > gcal > recurring
        const finalAvailable = new Map(overlapAvailable);

        for (const [userId, pollData] of pollResponseMap.entries()) {
          // Skip poll users who have no data (shouldn't happen, but be safe)
          if (noDataUserIds.has(userId)) continue;

          const hasBothSubSlots = pollData.slots.has(h00Key) && pollData.slots.has(h30Key);
          if (hasBothSubSlots) {
            // Poll says available -- override overlap result
            finalAvailable.set(userId, { user_id: userId, username: pollData.username });

            // Check for gcal conflict
            const gcalData = gcalBusyMap.get(userId);
            if (gcalData) {
              const hasGcalBusy = gcalData.busySlots.has(h00Key) || gcalData.busySlots.has(h30Key);
              if (hasGcalBusy) {
                gcalConflicts.push({
                  user_id: userId,
                  username: gcalData.username,
                  date: dateStr,
                  hour: utcHour,
                });
              }
            }
          } else {
            // Poll says NOT available for this slot -- remove from available even if overlap had them
            finalAvailable.delete(userId);
          }
        }

        const availableMembers = Array.from(finalAvailable.values());

        slots.push({
          date: dateStr,
          dayOfWeek: isoDayOfWeek,
          hour: utcHour,
          availableCount: availableMembers.length,
          totalMembers: membersWithData,
          availableMembers,
        });
      }
    }

    const __renderMs = Date.now() - __t0;
    console.log(`heatmap render: ${__renderMs}ms group=${groupId} members=${totalMembers}`);

    // 9. Boundary translation (Phase 87.4 Plan 08): the ENTIRE pipeline above
    //    stayed sub-keyed. Build ONE roster map from the already-loaded
    //    group.Users and flip every emitted user_id VALUE sub->UUID in a single
    //    pass over this finished payload. Member-accounting counts
    //    (membersWithData, membersWithoutDataCount, totalMembers) are computed
    //    from the ORIGINAL arrays so an unresolvable-identity drop never skews
    //    the counts — only the emitted identity collections drop the entry.
    const subToUuid = buildSubToUuid(members);
    const translatedMembersWithoutData = translateUserIdCollection(membersWithoutData, subToUuid);
    const translatedGcalConflicts = translateUserIdCollection(gcalConflicts, subToUuid);
    const translatedSlots = slots.map(slot => {
      const availableMembers = translateUserIdCollection(slot.availableMembers, subToUuid);
      return { ...slot, availableMembers, availableCount: availableMembers.length };
    });

    return {
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      totalMembers: membersWithData,
      totalGroupMembers: totalMembers,
      membersWithData,
      membersWithoutData: translatedMembersWithoutData,
      membersWithoutDataCount: membersWithoutData.length,
      gcalConflicts: translatedGcalConflicts,
      slots: translatedSlots,
    };
  }
}

module.exports = new AvailabilityService();

