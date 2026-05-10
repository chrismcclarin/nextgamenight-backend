// services/googleCalendarService.js
// Google Calendar integration service
// NOTE: This requires Google OAuth 2.0 setup and user authorization
// See GOOGLE_CALENDAR_SETUP.md for setup instructions

const { google } = require('googleapis');

// Helper function to get Google OAuth redirect URI (same logic as routes/googleAuth.js)
function getGoogleRedirectUri() {
  let redirectUri = process.env.GOOGLE_REDIRECT_URI;
  
  if (!redirectUri) {
    // Try to construct from Railway environment (Railway provides RAILWAY_PUBLIC_DOMAIN)
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/auth/google/callback`;
    } else if (process.env.NODE_ENV === 'production') {
      throw new Error('GOOGLE_REDIRECT_URI environment variable is required in production. Set it to your production backend URL (e.g., https://your-backend.railway.app/api/auth/google/callback)');
    } else {
      // Development: use localhost default
      redirectUri = 'http://localhost:4000/api/auth/google/callback';
    }
  }
  
  return redirectUri;
}

// Helper function to format date and time in a specific timezone
function formatDateAndTimeInTimezone(date, timezone = 'UTC') {
  try {
    // Format date (YYYY-MM-DD) in the specified timezone
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const dateStr = dateFormatter.format(date);
    
    // Format time (HH:MM) in the specified timezone
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const timeParts = timeFormatter.formatToParts(date);
    const hour = timeParts.find(p => p.type === 'hour').value;
    const minute = timeParts.find(p => p.type === 'minute').value;
    const timeStr = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
    
    return { date: dateStr, time: timeStr };
  } catch (error) {
    // Fallback to UTC if timezone is invalid
    console.error(`Invalid timezone ${timezone}, falling back to UTC:`, error.message);
    const dateStr = date.toISOString().split('T')[0];
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return { date: dateStr, time: `${hours}:${minutes}` };
  }
}

class GoogleCalendarService {
  /**
   * Check if event is in the future (only future events should be added to calendars)
   */
  isFutureEvent(startDate) {
    return new Date(startDate) > new Date();
  }

  /**
   * Refresh an expired access token using refresh token
   * @param {string} refreshToken - User's Google OAuth refresh token
   * @returns {Promise<string>} New access token
   */
  async refreshAccessToken(refreshToken) {
    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getGoogleRedirectUri()
      );

      oauth2Client.setCredentials({
        refresh_token: refreshToken,
      });

      const { credentials } = await oauth2Client.refreshAccessToken();
      return credentials.access_token;
    } catch (error) {
      console.error('Error refreshing access token:', error.message);
      throw new Error(`Failed to refresh access token: ${error.message}`);
    }
  }

  /**
   * Create a calendar event for a user
   * @param {Object} eventData - Event data including start_date, duration_minutes, game_name, comments
   * @param {Array} participantEmails - Array of participant email addresses
   * @param {string} accessToken - User's Google OAuth access token
   * @param {string} refreshToken - User's Google OAuth refresh token (optional, for auto-refresh)
   * @returns {Promise<Object>} Created calendar event
   */
  async createCalendarEventForUser(eventData, participantEmails, accessToken, refreshToken = null) {
    try {
      if (!accessToken) {
        throw new Error('Google Calendar access token is required');
      }

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getGoogleRedirectUri()
      );

      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // eventData.start_date should be in UTC (ISO string from database)
      // eventData.timezone should be the user's timezone (e.g., 'America/Los_Angeles')
      // We need to convert from UTC to the user's local time for Google Calendar
      const startDateUTC = new Date(eventData.start_date);
      const endDateUTC = new Date(startDateUTC.getTime() + (eventData.duration_minutes || 60) * 60 * 1000);
      
      // Use the timezone from eventData if provided, otherwise fall back to UTC
      // The timezone should be the user's local timezone, not the server's
      const eventTimezone = eventData.timezone || 'UTC';
      
      // Convert UTC dates to local time strings in the user's timezone
      // Google Calendar API expects dateTime as "YYYY-MM-DDTHH:mm:ss" (no timezone indicator)
      // and timeZone as the IANA timezone name
      const formatDateTimeForTimezone = (dateUTC, timezone) => {
        // Create a date formatter for the specified timezone
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false
        });
        
        // FormatToParts gives us structured parts
        const parts = formatter.formatToParts(dateUTC);
        const year = parts.find(p => p.type === 'year').value;
        const month = parts.find(p => p.type === 'month').value;
        const day = parts.find(p => p.type === 'day').value;
        const hour = parts.find(p => p.type === 'hour').value.padStart(2, '0');
        const minute = parts.find(p => p.type === 'minute').value.padStart(2, '0');
        const second = parts.find(p => p.type === 'second').value.padStart(2, '0');
        
        // Return in ISO format without timezone: "YYYY-MM-DDTHH:mm:ss"
        return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
      };

      const calendarEvent = {
        summary: eventData.game_name ? `Board Game: ${eventData.game_name}` : 'Board Game Session',
        description: eventData.comments || `Game session with ${participantEmails.length} players`,
        start: {
          dateTime: formatDateTimeForTimezone(startDateUTC, eventTimezone),
          timeZone: eventTimezone,
        },
        end: {
          dateTime: formatDateTimeForTimezone(endDateUTC, eventTimezone),
          timeZone: eventTimezone,
        },
        attendees: participantEmails.map(email => ({ email })),
        sendUpdates: 'all', // Send invitations to all attendees
        reminders: {
          useDefault: true,
        },
      };

      const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: calendarEvent,
      });

      return response.data;
    } catch (error) {
      // If token expired and we have a refresh token, try to refresh and retry
      if (error.code === 401 && refreshToken) {
        try {
          console.log('Access token expired, attempting to refresh...');
          const newAccessToken = await this.refreshAccessToken(refreshToken);
          
          // Retry with new token
          const oauth2Client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            getGoogleRedirectUri()
          );
          oauth2Client.setCredentials({
            access_token: newAccessToken,
            refresh_token: refreshToken,
          });
          
          const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
          const response = await calendar.events.insert({
            calendarId: 'primary',
            resource: calendarEvent,
          });
          
          // Return new access token so caller can update it
          return { 
            ...response.data, 
            _new_access_token: newAccessToken 
          };
        } catch (refreshError) {
          console.error('Error refreshing token and retrying:', refreshError.message);
          throw new Error(`Failed to create calendar event after token refresh: ${refreshError.message}`);
        }
      }
      
      console.error('Error creating Google Calendar event:', error.message);
      throw new Error(`Failed to create calendar event: ${error.message}`);
    }
  }

  /**
   * Create calendar events for all group members who have Google Calendar connected
   * This is called after creating a future event
   * 
   * IMPORTANT: 
   * - Only users with Google Calendar connected (OAuth tokens) will have events added to their calendar
   * - However, ALL group members' emails (including non-Gmail) will receive invitation emails
   * - Non-Gmail users can manually add the event from the invitation email
   * 
   * @param {Object} eventData - Event data
   * @param {Array} groupMembers - Array of group member objects with email and google_calendar_token
   * @returns {Promise<Array>} Array of created calendar events (may be empty if no tokens)
   */
  async createCalendarEventsForGroup(eventData, groupMembers) {
    const results = [];
    
    // Helper function to validate email addresses
    const isValidEmail = (email) => {
      if (!email || typeof email !== 'string') return false;
      // Check for basic email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      // Exclude Auth0 placeholder emails
      if (email.includes('@auth0.local') || email.includes('@auth0')) return false;
      // Exclude Auth0 user_ids (they contain | character)
      if (email.includes('|')) return false;
      return emailRegex.test(email);
    };
    
    // Get ALL participant emails (Gmail and non-Gmail users)
    // Google Calendar API can send invitations to any email address
    // Filter out invalid emails (Auth0 user_ids, placeholder emails, etc.)
    const participantEmails = groupMembers
      .filter(m => m.email && isValidEmail(m.email))
      .map(m => m.email);

    if (participantEmails.length === 0) {
      console.log('No group members have email addresses');
      return results;
    }
    
    // Filter members who have Google Calendar enabled and valid tokens
    // We only need ONE user with Google Calendar connected to create the event
    // and send invitations to everyone
    const membersWithCalendar = groupMembers.filter(member => 
      member.google_calendar_enabled && 
      member.google_calendar_token && 
      member.email
    );

    if (membersWithCalendar.length === 0) {
      console.log('No group members have Google Calendar connected - invitations cannot be sent');
      return results;
    }

    // Create calendar event from the first user with Google Calendar connected
    // This will send invitation emails to ALL participants (including non-Gmail users)
    // Only the event creator's calendar will have the event automatically added
    try {
      const firstMemberWithCalendar = membersWithCalendar[0];
      const calendarEvent = await this.createCalendarEventForUser(
        eventData,
        participantEmails, // Send invitations to ALL emails (Gmail and non-Gmail)
        firstMemberWithCalendar.google_calendar_token,
        firstMemberWithCalendar.google_calendar_refresh_token
      );
      
      // If token was refreshed, update it in the database
      if (calendarEvent._new_access_token) {
        const { User } = require('../models');
        await User.update(
          { google_calendar_token: calendarEvent._new_access_token },
          { where: { id: firstMemberWithCalendar.id } }
        );
        delete calendarEvent._new_access_token; // Remove from response
      }
      
      results.push({
        member_id: firstMemberWithCalendar.id,
        calendar_event: calendarEvent,
        invitations_sent_to: participantEmails, // Track who received invitations
        // Phase 75 / GCAL-01 (Plan 75-01): expose enough info for the route
        // handler to persist google_calendar_event_id on every connected
        // attendee's EventParticipation row. Google's invitation propagation
        // shares the SAME event id across host + invitee calendars, so the
        // cleanup worker (Plan 75-03) can call events.delete against each
        // user's primary calendar using THEIR token + this same id.
        connected_member_ids: membersWithCalendar.map(m => m.id),
        gcal_event_id: calendarEvent.id,
      });
      console.log(`Calendar event created and invitations sent to ${participantEmails.length} participants`);
    } catch (error) {
      console.error(`Failed to create calendar event:`, error);
    }

    return results;
  }

  /**
   * Get busy times from Google Calendar for a date range
   * Uses the freebusy API for efficiency
   * @param {Object} user - User object with google_calendar_token and google_calendar_refresh_token
   * @param {Date|string} startDate - Start date for query
   * @param {Date|string} endDate - End date for query
   * @param {string} timezone - Timezone for the query (default: UTC)
   * @returns {Promise<Array>} Array of busy time slots in 30-minute blocks
   * Format: [{ date: "YYYY-MM-DD", startTime: "HH:MM", endTime: "HH:MM" }, ...]
   */
  async getBusyTimesForDateRange(user, startDate, endDate, timezone = 'UTC') {
    try {
      if (!user.google_calendar_token) {
        return [];
      }

      let accessToken = user.google_calendar_token;
      const refreshToken = user.google_calendar_refresh_token;

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getGoogleRedirectUri()
      );

      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      // Convert dates to ISO strings
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      // Use freebusy API for efficiency
      const freebusyResponse = await calendar.freebusy.query({
        requestBody: {
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          timeZone: timezone,
          items: [{ id: 'primary' }],
        },
      });

      // Extract busy periods
      const busyPeriods = freebusyResponse.data.calendars?.primary?.busy || [];

      // Convert busy periods to 30-minute time slots keyed in UTC.
      //
      // IMPORTANT: keys MUST be in UTC to align with availabilityService.generateTimeSlots,
      // which produces the slot grid via toISOString() (UTC). The previous implementation
      // emitted local-timezone keys, so for any non-UTC user the busyKeys lookup in
      // availabilityService.calculateUserAvailability never matched -- every slot fell
      // through to the "free" branch and the heatmap rendered fully available regardless
      // of the user's actual calendar.
      const busySlots = [];
      const SLOT_MS = 30 * 60 * 1000;
      const MAX_SLOTS_PER_PERIOD = 10000; // Safety limit

      for (const period of busyPeriods) {
        const periodStartUTC = new Date(period.start);
        const periodEndUTC = new Date(period.end);

        // Round start down and end up to the nearest 30-min UTC boundary so the
        // resulting slots align with the slot grid in generateTimeSlots.
        const slotStartMs = Math.floor(periodStartUTC.getTime() / SLOT_MS) * SLOT_MS;
        const slotEndMs = Math.ceil(periodEndUTC.getTime() / SLOT_MS) * SLOT_MS;

        let slotCount = 0;
        for (let ms = slotStartMs; ms < slotEndMs; ms += SLOT_MS) {
          if (slotCount++ > MAX_SLOTS_PER_PERIOD) {
            console.error('Safety limit reached in getBusyTimesForDateRange. Stopping to prevent runaway loop.');
            break;
          }

          const start = new Date(ms);
          const end = new Date(ms + SLOT_MS);

          const date = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(start.getUTCDate()).padStart(2, '0')}`;
          const startTime = `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`;
          const endTime = `${String(end.getUTCHours()).padStart(2, '0')}:${String(end.getUTCMinutes()).padStart(2, '0')}`;

          busySlots.push({ date, startTime, endTime });
        }
      }

      return busySlots;
    } catch (error) {
      // If token expired and we have a refresh token, try to refresh and retry
      if (error.code === 401 && user.google_calendar_refresh_token) {
        try {
          console.log('Access token expired, attempting to refresh...');
          const newAccessToken = await this.refreshAccessToken(user.google_calendar_refresh_token);
          
          // Update user object with new token
          user.google_calendar_token = newAccessToken;
          
          // Retry the request
          return await this.getBusyTimesForDateRange(user, startDate, endDate, timezone);
        } catch (refreshError) {
          console.error('Error refreshing token and retrying:', refreshError.message);
          throw new Error(`Failed to get busy times after token refresh: ${refreshError.message}`);
        }
      }
      
      console.error('Error getting busy times from Google Calendar:', error.message);
      throw new Error(`Failed to get busy times: ${error.message}`);
    }
  }

  /**
   * Create a tentative calendar hold for a user
   * Tentative events show as "tentative" on the calendar and don't send notifications
   * @param {Object} eventData - Event data (groupName, gameName, startDateTime, endDateTime, timezone)
   * @param {string} accessToken - User's Google OAuth access token
   * @param {string} refreshToken - User's Google OAuth refresh token (optional, for auto-refresh)
   * @returns {Promise<Object>} Created calendar event with id
   */
  async createTentativeHold(eventData, accessToken, refreshToken = null) {
    try {
      if (!accessToken) {
        throw new Error('Google Calendar access token is required');
      }

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getGoogleRedirectUri()
      );

      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const calendarEvent = {
        summary: `${eventData.groupName} - ${eventData.gameName || 'Game Night'} (tentative)`,
        description: 'Tentative hold - pending group confirmation. Will be updated or removed when final decision is made.',
        start: {
          dateTime: eventData.startDateTime,
          timeZone: eventData.timezone || 'UTC',
        },
        end: {
          dateTime: eventData.endDateTime,
          timeZone: eventData.timezone || 'UTC',
        },
        status: 'tentative',         // Key: shows as tentative on calendar
        transparency: 'opaque',      // Still blocks time (shows as busy)
        colorId: '8',                // Graphite color to distinguish from confirmed
        reminders: {
          useDefault: false,
          overrides: []              // No reminders for tentative holds
        }
      };

      const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: calendarEvent,
        sendUpdates: 'none'          // Don't notify for tentative holds
      });

      return response.data;
    } catch (error) {
      // If token expired and we have a refresh token, try to refresh and retry
      if (error.code === 401 && refreshToken) {
        try {
          console.log('Tentative hold: Access token expired, attempting to refresh...');
          const newAccessToken = await this.refreshAccessToken(refreshToken);

          // Retry with new token (recursive call without refresh to avoid infinite loop)
          const retryResult = await this.createTentativeHold(eventData, newAccessToken, null);

          // Include new token so caller can update it
          return {
            ...retryResult,
            _new_access_token: newAccessToken
          };
        } catch (refreshError) {
          console.error('Error refreshing token for tentative hold:', refreshError.message);
          throw new Error(`Failed to create tentative hold after token refresh: ${refreshError.message}`);
        }
      }

      console.error('Error creating tentative calendar hold:', error.message);
      throw new Error(`Failed to create tentative hold: ${error.message}`);
    }
  }

  /**
   * Delete a single tentative calendar hold
   * @param {string} calendarEventId - Google Calendar event ID to delete
   * @param {string} accessToken - User's Google OAuth access token
   * @param {string} refreshToken - User's Google OAuth refresh token (optional, for auto-refresh)
   * @returns {Promise<boolean>} True if deleted successfully
   */
  async deleteTentativeHold(calendarEventId, accessToken, refreshToken = null) {
    try {
      if (!accessToken) {
        throw new Error('Google Calendar access token is required');
      }

      if (!calendarEventId) {
        console.warn('No calendar event ID provided for deletion');
        return false;
      }

      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getGoogleRedirectUri()
      );

      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      await calendar.events.delete({
        calendarId: 'primary',
        eventId: calendarEventId,
        sendUpdates: 'none'          // Silent deletion
      });

      return true;
    } catch (error) {
      // If token expired and we have a refresh token, try to refresh and retry
      if (error.code === 401 && refreshToken) {
        try {
          console.log('Delete tentative hold: Access token expired, attempting to refresh...');
          const newAccessToken = await this.refreshAccessToken(refreshToken);

          // Retry with new token (without refresh to avoid infinite loop)
          return await this.deleteTentativeHold(calendarEventId, newAccessToken, null);
        } catch (refreshError) {
          console.error('Error refreshing token for tentative hold deletion:', refreshError.message);
          // Don't throw - deletion failures shouldn't break the flow
        }
      }

      // Event may already be deleted by user - log but don't throw
      if (error.code === 404 || error.code === 410) {
        console.log(`Tentative hold ${calendarEventId} already deleted or not found`);
        return true;
      }

      console.error(`Error deleting tentative hold ${calendarEventId}:`, error.message);
      return false;
    }
  }

  /**
   * Phase 75 / GCAL-01: Delete a single Google Calendar event for the
   * outbound-cleanup worker (event cancel/delete + RSVP yes->no).
   *
   * Differs from deleteTentativeHold above: instead of swallowing errors and
   * returning a boolean, this method CLASSIFIES errors via `error.code` so
   * the BullMQ worker can decide whether to retry, alert, or skip:
   *   - 200/204                 -> { deleted: true }
   *   - 404 / 410               -> { deleted: true, alreadyGone: true }   (idempotent retry safety)
   *   - 401 + refresh token     -> refresh, retry once, return { ..., _new_access_token }
   *   - 401 (no refresh / fail) -> throw with err.code === 'GCAL_DISCONNECTED'   (worker: skip, breadcrumb)
   *   - 403                     -> throw with err.code === 'GCAL_PERMANENT'     (worker: re-throw, exhaust attempts -> Sentry alert)
   *   - 429                     -> throw with err.code === 'GCAL_RATE_LIMITED'  (worker: re-throw, BullMQ retries)
   *   - 5xx                     -> throw original error                          (worker: re-throw, BullMQ retries)
   *   - other 4xx               -> throw with err.code === 'GCAL_PERMANENT'
   *
   * @param {string} calendarEventId - GCal event id stored on EventParticipation.google_calendar_event_id
   * @param {string} accessToken     - Attendee's Google OAuth access token
   * @param {string|null} refreshToken - Attendee's Google OAuth refresh token (enables one-shot retry)
   * @returns {Promise<{ deleted: boolean, alreadyGone?: boolean, _new_access_token?: string }>}
   */
  async deleteCalendarEventForUser(calendarEventId, accessToken, refreshToken = null) {
    if (!accessToken) {
      const err = new Error('Google Calendar access token is required');
      err.code = 'GCAL_DISCONNECTED';
      throw err;
    }
    if (!calendarEventId) {
      // Defensive: caller should have filtered nulls. Not an error -- no-op.
      return { skipped: true, reason: 'no_event_id' };
    }

    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        getGoogleRedirectUri()
      );
      oauth2Client.setCredentials({
        access_token: accessToken,
        refresh_token: refreshToken,
      });

      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      await calendar.events.delete({
        calendarId: 'primary',
        eventId: calendarEventId,
        sendUpdates: 'none',         // Silent removal — no email blast to attendees
      });

      return { deleted: true };
    } catch (error) {
      const httpCode = error.code || error.response?.status;

      // Already-gone: success (idempotent retry safety per CONTEXT D-CLAUDE-DISCRETION)
      if (httpCode === 404 || httpCode === 410) {
        return { deleted: true, alreadyGone: true };
      }

      // 401 + refresh token: try refresh and retry once (without refresh to avoid recursion)
      if (httpCode === 401 && refreshToken) {
        try {
          const newAccessToken = await this.refreshAccessToken(refreshToken);
          const retryResult = await this.deleteCalendarEventForUser(
            calendarEventId,
            newAccessToken,
            null
          );
          return { ...retryResult, _new_access_token: newAccessToken };
        } catch (refreshErr) {
          // Refresh failed (revoked grant / no longer authorized): treat as disconnect.
          const err = new Error(`Token refresh failed: ${refreshErr.message}`);
          err.code = 'GCAL_DISCONNECTED';
          throw err;
        }
      }

      // 401 without refresh token: user disconnected GCal between event-add and cleanup.
      if (httpCode === 401) {
        const err = new Error('User has disconnected Google Calendar');
        err.code = 'GCAL_DISCONNECTED';
        throw err;
      }

      // 403: forbidden — permanent, no retry.
      if (httpCode === 403) {
        const err = new Error(`Forbidden: ${error.message}`);
        err.code = 'GCAL_PERMANENT';
        throw err;
      }

      // 429: rate limited — transient (BullMQ will retry per the queue's exponential backoff).
      if (httpCode === 429) {
        const err = new Error(`Rate limited: ${error.message}`);
        err.code = 'GCAL_RATE_LIMITED';
        throw err;
      }

      // 5xx: transient — re-throw the ORIGINAL error so BullMQ retries.
      if (httpCode >= 500 && httpCode < 600) {
        throw error;
      }

      // Other 4xx (including 400): permanent.
      if (httpCode >= 400 && httpCode < 500) {
        const err = new Error(`Permanent error: ${error.message}`);
        err.code = 'GCAL_PERMANENT';
        throw err;
      }

      // Unknown / no httpCode: treat as permanent so we don't retry blindly.
      const err = new Error(`Unknown error: ${error.message}`);
      err.code = 'GCAL_PERMANENT';
      throw err;
    }
  }

  /**
   * Delete multiple tentative calendar holds
   * Catches errors per-event so one failure doesn't stop others
   * @param {Array<string>} calendarEventIds - Array of Google Calendar event IDs to delete
   * @param {string} accessToken - User's Google OAuth access token
   * @param {string} refreshToken - User's Google OAuth refresh token (optional, for auto-refresh)
   * @returns {Promise<Object>} { deleted: number, failed: number }
   */
  async deleteTentativeHolds(calendarEventIds, accessToken, refreshToken = null) {
    const result = { deleted: 0, failed: 0 };

    if (!Array.isArray(calendarEventIds) || calendarEventIds.length === 0) {
      return result;
    }

    for (const eventId of calendarEventIds) {
      try {
        const success = await this.deleteTentativeHold(eventId, accessToken, refreshToken);
        if (success) {
          result.deleted++;
        } else {
          result.failed++;
        }
      } catch (error) {
        console.error(`Error deleting tentative hold ${eventId}:`, error.message);
        result.failed++;
      }
    }

    return result;
  }
}

module.exports = new GoogleCalendarService();
