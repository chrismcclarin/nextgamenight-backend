// services/availabilityService.js
// Service for calculating user availability by merging manual patterns and Google Calendar data

const { UserAvailability, User } = require('../models');
const googleCalendarService = require('./googleCalendarService');

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
    
    // Start from beginning of start date
    const current = new Date(start);
    current.setHours(0, 0, 0, 0);
    
    // Generate slots for each day until end date
    while (current <= end) {
      // Safety check to prevent infinite loops
      if (iterationCount++ > maxIterations) {
        console.error('Safety limit reached in generateTimeSlots. Stopping to prevent infinite loop.');
        throw new Error('Date range too large or invalid. Maximum processing limit reached.');
      }
      
      // Generate 30-minute slots for this day (00:00 to 23:30)
      for (let hour = 0; hour < 24; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
          const slotTime = new Date(current);
          slotTime.setHours(hour, minute, 0, 0);
          
          // Only include slots within the date range
          if (slotTime >= start && slotTime < end) {
            const dateStr = slotTime.toISOString().split('T')[0];
            const timeStr = slotTime.toTimeString().slice(0, 5); // HH:MM
            
            slots.push({
              date: dateStr,
              startTime: timeStr,
              endTime: this.add30Minutes(timeStr),
              timestamp: slotTime.getTime(),
            });
          }
        }
      }
      
      // Move to next day
      const previousDate = current.getDate();
      current.setDate(current.getDate() + 1);
      current.setHours(0, 0, 0, 0);
      
      // Safety check: ensure date actually advanced
      if (current.getDate() === previousDate) {
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
  matchesRecurringPattern(slot, pattern, timezone) {
    // Patterns store times in the user's local timezone.
    // Slots are generated in UTC (on a UTC server). Convert to local for matching.
    const local = (timezone && timezone !== 'UTC') ? this.slotToLocal(slot, timezone) : null;
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
  matchesSpecificOverride(slot, override, timezone) {
    const local = (timezone && timezone !== 'UTC') ? this.slotToLocal(slot, timezone) : null;
    const matchDate = local ? local.date : slot.date;
    const matchTime = local ? local.startTime : slot.startTime;

    const slotDate = new Date(matchDate);
    const overrideDate = new Date(override.pattern_data.date);

    // Check if dates match (in the user's local timezone)
    if (slotDate.toISOString().split('T')[0] !== overrideDate.toISOString().split('T')[0]) {
      return false;
    }

    // Check if date is within override's date range
    if (!this.isDateInRange(slotDate, override.start_date, override.end_date)) {
      return false;
    }

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
  async calculateUserAvailability(user, startDate, endDate, timezone = 'UTC') {
    try {
      // Generate all time slots for the date range
      const allSlots = this.generateTimeSlots(startDate, endDate, timezone);
      
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
        allSlots.forEach(slot => {
          const key = `${slot.date}_${slot.startTime}`;
          if (this.matchesRecurringPattern(slot, pattern, timezone)) {
            const slotData = availabilityMap.get(key);
            if (slotData) {
              slotData.isAvailable = true;
              slotData.source = 'recurring_pattern';
            }
          }
        });
      }

      // Apply specific overrides (these take precedence over recurring patterns).
      // Pass the user's timezone so the matcher can compare in local time --
      // overrides are stored in local time but slots are generated in UTC.
      const specificOverrides = manualPatterns.filter(p => p.type === 'specific_override');
      for (const override of specificOverrides) {
        allSlots.forEach(slot => {
          const key = `${slot.date}_${slot.startTime}`;
          if (this.matchesSpecificOverride(slot, override, timezone)) {
            const slotData = availabilityMap.get(key);
            if (slotData) {
              slotData.isAvailable = override.is_available !== false; // Default to true if not explicitly false
              slotData.source = 'specific_override';
            }
          }
        });
      }

      // If Google Calendar is enabled, use it as full availability override (gcal > recurring in priority)
      // Free on calendar = available, busy on calendar = unavailable
      if (user.google_calendar_enabled && user.google_calendar_token) {
        try {
          const busySlots = await googleCalendarService.getBusyTimesForDateRange(
            user,
            startDate,
            endDate,
            timezone
          );

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
   * Calculate overlapping free time for all group members
   * @param {string} groupId - Group ID
   * @param {Date|string} startDate - Start date
   * @param {Date|string} endDate - End date
   * @param {string} timezone - Timezone string
   * @returns {Promise<Array>} Array of time slots with overlap information
   */
  async calculateGroupOverlaps(groupId, startDate, endDate, timezone = 'UTC') {
    try {
      const { Group, UserGroup } = require('../models');
      
      // Get all group members
      let group;
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

      if (!group) {
        throw new Error('Group not found');
      }

      const members = group.Users || [];
      if (members.length === 0) {
        return [];
      }

      // Calculate availability for each member using their stored timezone
      const memberAvailabilities = await Promise.all(
        members.map(member =>
          this.calculateUserAvailability(member, startDate, endDate, member.timezone || 'UTC')
            .then(availability => ({ member, availability }))
            .catch(error => {
              console.error(`Error calculating availability for member ${member.user_id}:`, error);
              return { member, availability: [] };
            })
        )
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
              email: member.email,
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

    // 3. Get raw 30-min overlaps from existing method
    const overlaps = await this.calculateGroupOverlaps(groupId, overlapStart, overlapEnd, timezone);

    // 4. Query group members to determine who has/lacks availability data
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

    // 6. Build gcal busy map for users with both poll responses AND gcal enabled
    const gcalBusyMap = new Map(); // user_id -> { username, busySlots: Set<"date_HH:MM"> }
    for (const member of members) {
      const hasGcal = member.google_calendar_enabled && member.google_calendar_token;
      if (hasGcal && pollResponseMap.has(member.user_id)) {
        try {
          const busyTimes = await googleCalendarService.getBusyTimesForDateRange(
            member, overlapStart, overlapEnd, timezone
          );
          const busySet = new Set();
          for (const busy of busyTimes) {
            // busy has { date, startTime, endTime } format from getBusyTimesForDateRange
            busySet.add(`${busy.date}_${busy.startTime}`);
          }
          gcalBusyMap.set(member.user_id, { username: member.username, busySlots: busySet });
        } catch (err) {
          console.warn(`Failed to fetch gcal for ${member.user_id}:`, err.message);
        }
      }
    }

    // Check each member for availability data sources (including poll responses)
    const membersWithoutData = [];
    for (const member of members) {
      const hasGcal = member.google_calendar_enabled && member.google_calendar_token;
      const hasPollResponse = pollResponseMap.has(member.user_id);
      let hasRecurring = false;
      if (!hasGcal && !hasPollResponse) {
        const records = await UserAvailability.findAll({
          where: { user_id: member.user_id },
        });
        hasRecurring = records.length > 0;
      }
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
    const validTz = isValidTimezone(timezone) && timezone !== 'UTC' ? timezone : null;
    if (timezone && timezone !== 'UTC' && !validTz) {
      console.warn(`getGroupHeatmap: invalid timezone "${timezone}", falling back to UTC`);
    }

    const gcalConflicts = [];
    const slots = [];
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const slotDate = new Date(startDate);
      slotDate.setUTCDate(slotDate.getUTCDate() + dayOffset);

      for (let localHour = 10; localHour <= 23; localHour++) {
        let dateStr, utcHour, isoDayOfWeek;

        if (validTz) {
          // Compute local date by adding dayOffset to the weekStart date string.
          // weekStart is always a Monday; local days are Mon-Sun regardless of timezone.
          const localBase = new Date(weekStart + 'T12:00:00Z'); // noon UTC avoids day-boundary issues
          localBase.setUTCDate(localBase.getUTCDate() + dayOffset);
          const localDateStr = localBase.toISOString().split('T')[0]; // YYYY-MM-DD
          const converted = localToUtc(localDateStr, localHour, validTz);
          dateStr = converted.utcDate;
          utcHour = converted.utcHour;
          // dayOfWeek based on the UTC date of the emitted slot
          const utcSlotDate = new Date(dateStr + 'T00:00:00Z');
          isoDayOfWeek = this.getISODayOfWeek(utcSlotDate);
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

    return {
      weekStart: weekStartStr,
      weekEnd: weekEndStr,
      totalMembers: membersWithData,
      totalGroupMembers: totalMembers,
      membersWithData,
      membersWithoutData,
      membersWithoutDataCount: membersWithoutData.length,
      gcalConflicts,
      slots,
    };
  }
}

module.exports = new AvailabilityService();

