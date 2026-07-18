// routes/availability.js
// Routes for managing user availability and group planning
const express = require('express');
const { UserAvailability, User } = require('../models');
const availabilityService = require('../services/availabilityService');
const { sendSafeError } = require('../utils/errorHandler');
const { validateUUID, validateAuth0UserId } = require('../middleware/validators');
// Phase 87.4 Plan 02 (SPEC Req 5, D-04): the self-param gate dual-accepts the
// caller's OWN sub OR OWN resolved Users.id UUID via the ONE shared helper.
const { matchesSelf } = require('../middleware/objectAuth');
const router = express.Router();
const { body, validationResult } = require('express-validator');

// ---------------------------------------------------------------------------
// Phase 87.4 Plan 08 (SPEC Req 2, D-03, PR-2): flip self-CRUD + patterns wire
// emissions from the caller's Auth0 sub to their Users.id UUID. The
// UserAvailability table stays sub-keyed internally (Phase 87.5 rekeys it); ONLY
// the emitted user_id field translates. Field NAME stays `user_id`, VALUE flips.
//
// Map-miss rule (T5, aligns with Plan 10 z.uuid()): if the caller has no Users
// row (should never happen for an authenticated caller), OMIT the user_id field
// rather than leak the sub or emit null.
// ---------------------------------------------------------------------------

// Resolve the authenticated caller's own Users.id UUID from their sub.
async function resolveCallerUuid(callerSub) {
  const caller = await User.findOne({ where: { user_id: callerSub }, attributes: ['id'] });
  return caller ? caller.id : null;
}

// Serialize a UserAvailability row with its user_id flipped to the caller's UUID
// (or the field omitted on an unresolvable caller).
function withEmittedUuid(row, callerUuid) {
  const out = typeof row.toJSON === 'function' ? row.toJSON() : { ...row };
  if (callerUuid) out.user_id = callerUuid;
  else delete out.user_id;
  return out;
}

// Convenience for the single-row create responses: resolve then serialize.
async function emitWithCallerUuid(row, callerSub) {
  return withEmittedUuid(row, await resolveCallerUuid(callerSub));
}

// Validation middleware
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      error: 'Validation failed',
      errors: errors.array().map(err => ({
        field: err.path || err.param,
        message: err.msg,
        value: err.value
      }))
    });
  }
  next();
};

// Get user's availability for a date range
router.get('/user/:user_id', 
  validateAuth0UserId('user_id'),
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Users can only view their own availability (dual-accept: own sub OR own UUID)
      if (!(await matchesSelf(req, req.params.user_id))) {
        return res.status(403).json({ error: 'Forbidden: Cannot access other users\' availability' });
      }

      const user = await User.findOne({ where: { user_id: userId } });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Parse query parameters
      const startDate = req.query.start_date ? new Date(req.query.start_date) : new Date();
      const endDate = req.query.end_date ? new Date(req.query.end_date) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Default: 30 days
      const timezone = req.query.timezone || 'UTC';

      // Validate dates
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)' });
      }

      if (startDate >= endDate) {
        return res.status(400).json({ error: 'Start date must be before end date' });
      }

      const availability = await availabilityService.calculateUserAvailability(
        user,
        startDate,
        endDate,
        timezone
      );

      res.json(availability);
    } catch (error) {
      sendSafeError(res, 500, error, 'Error fetching user availability');
    }
  }
);

// Create recurring availability pattern
router.post('/user/:user_id/recurring',
  validateAuth0UserId('user_id'),
  [
    body('dayOfWeek')
      .isInt({ min: 0, max: 6 })
      .withMessage('Day of week must be between 0 (Sunday) and 6 (Saturday)'),
    body('startTime')
      .matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Start time must be in HH:MM format (24-hour)'),
    body('endTime')
      .matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('End time must be in HH:MM format (24-hour)'),
    body('start_date')
      .isISO8601()
      .withMessage('Start date must be a valid ISO 8601 date (YYYY-MM-DD)'),
    body('end_date')
      .optional({ checkFalsy: true })
      .custom((value) => {
        // Allow null, undefined, or empty string
        if (value === null || value === undefined || value === '') {
          return true;
        }
        // If provided, must be a valid ISO 8601 date
        const iso8601Regex = /^\d{4}-\d{2}-\d{2}$/;
        if (!iso8601Regex.test(value)) {
          throw new Error('End date must be a valid ISO 8601 date (YYYY-MM-DD)');
        }
        return true;
      })
      .withMessage('End date must be a valid ISO 8601 date (YYYY-MM-DD)'),
    body('timezone')
      .optional()
      .isString()
      .withMessage('Timezone must be a string'),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!(await matchesSelf(req, req.params.user_id))) {
        return res.status(403).json({ error: 'Forbidden: Cannot create availability for other users' });
      }

      const { dayOfWeek, startTime, endTime, start_date, end_date, timezone } = req.body;

      // Validate time range
      const [startHours, startMinutes] = startTime.split(':').map(Number);
      const [endHours, endMinutes] = endTime.split(':').map(Number);
      const startTotalMinutes = startHours * 60 + startMinutes;
      const endTotalMinutes = endHours * 60 + endMinutes;

      if (startTotalMinutes >= endTotalMinutes) {
        return res.status(400).json({ error: 'Start time must be before end time' });
      }

      // Validate date range
      const startDate = new Date(start_date);
      const endDateObj = end_date ? new Date(end_date) : null;
      
      if (endDateObj && startDate >= endDateObj) {
        return res.status(400).json({ error: 'Start date must be before end date' });
      }

      const pattern = await UserAvailability.create({
        user_id: userId,
        type: 'recurring_pattern',
        pattern_data: {
          dayOfWeek,
          startTime,
          endTime,
          timezone: timezone || 'UTC',
        },
        start_date: startDate,
        end_date: endDateObj,
        timezone: timezone || 'UTC',
      });

      res.status(201).json(await emitWithCallerUuid(pattern, userId));
    } catch (error) {
      sendSafeError(res, 500, error, 'Error creating recurring availability pattern');
    }
  }
);

// Create specific date/time override
router.post('/user/:user_id/override',
  validateAuth0UserId('user_id'),
  [
    body('date')
      .isISO8601()
      .withMessage('Date must be a valid ISO 8601 date (YYYY-MM-DD)'),
    body('startTime')
      .matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Start time must be in HH:MM format (24-hour)'),
    body('endTime')
      .matches(/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('End time must be in HH:MM format (24-hour)'),
    body('isAvailable')
      .optional()
      .isBoolean()
      .withMessage('isAvailable must be a boolean'),
    validate
  ],
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!(await matchesSelf(req, req.params.user_id))) {
        return res.status(403).json({ error: 'Forbidden: Cannot create availability for other users' });
      }

      const { date, startTime, endTime, isAvailable = true } = req.body;

      // Validate time range
      const [startHours, startMinutes] = startTime.split(':').map(Number);
      const [endHours, endMinutes] = endTime.split(':').map(Number);
      const startTotalMinutes = startHours * 60 + startMinutes;
      const endTotalMinutes = endHours * 60 + endMinutes;

      if (startTotalMinutes >= endTotalMinutes) {
        return res.status(400).json({ error: 'Start time must be before end time' });
      }

      // Validate strict YYYY-MM-DD shape. The previous implementation did
      // `new Date(date)` and passed the Date object to Sequelize DATEONLY,
      // which truncates to LOCAL day on a non-UTC server (e.g. PDT dev box):
      //   new Date("2026-05-02") -> UTC midnight -> local 2026-05-01 17:00 PDT
      //   -> DATEONLY -> "2026-05-01"
      // pattern_data.date kept the raw string ("2026-05-02"), producing a
      // 1-day divergence between pattern_data.date and start_date/end_date
      // and silently dropping the override from the heatmap matcher.
      // Pass the raw string directly to Sequelize -- DATEONLY accepts
      // "YYYY-MM-DD" as-is, with no Date round-trip and no TZ ambiguity.
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD.' });
      }

      const override = await UserAvailability.create({
        user_id: userId,
        type: 'specific_override',
        pattern_data: {
          date,
          startTime,
          endTime,
          isAvailable,
        },
        start_date: date,  // raw "YYYY-MM-DD" string; Sequelize DATEONLY stores as-is
        end_date: date,    // same day, same string
        is_available: isAvailable,
        timezone: 'UTC',
      });

      res.status(201).json(await emitWithCallerUuid(override, userId));
    } catch (error) {
      sendSafeError(res, 500, error, 'Error creating availability override');
    }
  }
);

// Delete availability pattern/override
router.delete('/:id',
  validateUUID('id'),
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const availability = await UserAvailability.findByPk(req.params.id);
      if (!availability) {
        return res.status(404).json({ error: 'Availability pattern not found' });
      }

      // Users can only delete their own availability. The row's user_id is still
      // the sub (UserAvailability stays sub-keyed until Phase 87.5), so matchesSelf
      // takes the sub arm here; a caller acting under a UUID self-param elsewhere
      // still matches because matchesSelf resolves their own UUID from their sub.
      if (!(await matchesSelf(req, availability.user_id))) {
        return res.status(403).json({ error: 'Forbidden: Cannot delete other users\' availability' });
      }

      await availability.destroy();
      res.json({ message: 'Availability pattern deleted successfully' });
    } catch (error) {
      sendSafeError(res, 500, error, 'Error deleting availability pattern');
    }
  }
);

// Get overlapping free time for all group members
router.get('/group/:group_id/overlaps',
  validateUUID('group_id'),
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Verify user is a member of the group
      const { Group, UserGroup, User } = require('../models');
      let userGroup;
      try {
        // Phase 87.1 (BINT-02): UserGroup is re-keyed onto the user_uuid UUID FK.
        // Resolve the authenticated caller's Users.id first, then gate on
        // user_uuid — keying the legacy Auth0-string user_id column is an
        // undefined-SILENT read once Plan 09 drops it. Fail-closed (userGroup
        // stays null -> 403) if the caller has no Users row.
        const caller = await User.findOne({ where: { user_id: userId }, attributes: ['id'] });
        userGroup = caller ? await UserGroup.findOne({
          where: {
            group_id: req.params.group_id,
            user_uuid: caller.id,
            status: 'active',
          },
        }) : null;
      } catch (dbError) {
        console.error('Database error checking group membership:', dbError);
        return sendSafeError(res, 500, dbError, 'Error checking group membership');
      }

      if (!userGroup) {
        return res.status(403).json({ error: 'Forbidden: You must be a member of this group' });
      }

      // Parse query parameters
      const startDate = req.query.start_date ? new Date(req.query.start_date) : new Date();
      const endDate = req.query.end_date ? new Date(req.query.end_date) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Default: 30 days
      const timezone = req.query.timezone || 'UTC';

      // Validate dates
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return res.status(400).json({ error: 'Invalid date format. Use ISO 8601 format (YYYY-MM-DD)' });
      }

      if (startDate >= endDate) {
        return res.status(400).json({ error: 'Start date must be before end date' });
      }

      // Limit date range to prevent performance issues and infinite loops
      const MAX_DATE_RANGE_DAYS = 90; // Maximum 90 days
      const dateRangeMs = endDate.getTime() - startDate.getTime();
      const dateRangeDays = dateRangeMs / (1000 * 60 * 60 * 24);
      
      if (dateRangeDays > MAX_DATE_RANGE_DAYS) {
        return res.status(400).json({ 
          error: `Date range too large. Maximum allowed range is ${MAX_DATE_RANGE_DAYS} days. Requested range: ${Math.ceil(dateRangeDays)} days` 
        });
      }

      // Prevent dates too far in the past or future
      const MAX_PAST_DAYS = 365;
      const MAX_FUTURE_DAYS = 365;
      const now = new Date();
      const daysFromNow = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      
      if (daysFromNow < -MAX_PAST_DAYS) {
        return res.status(400).json({ error: `Start date cannot be more than ${MAX_PAST_DAYS} days in the past` });
      }
      
      if (daysFromNow > MAX_FUTURE_DAYS) {
        return res.status(400).json({ error: `Start date cannot be more than ${MAX_FUTURE_DAYS} days in the future` });
      }

      const overlaps = await availabilityService.calculateGroupOverlaps(
        req.params.group_id,
        startDate,
        endDate,
        timezone
      );

      res.json(overlaps);
    } catch (error) {
      sendSafeError(res, 500, error, 'Error calculating group overlaps');
    }
  }
);

// Get heatmap data for group availability (normalized 1-hour slots, 10am-11pm)
router.get('/group/:group_id/heatmap',
  validateUUID('group_id'),
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Verify user is a member of the group
      const { Group, UserGroup, User } = require('../models');
      let userGroup;
      try {
        // Phase 87.1 (BINT-02): UserGroup is re-keyed onto the user_uuid UUID FK.
        // Resolve the authenticated caller's Users.id first, then gate on
        // user_uuid — keying the legacy Auth0-string user_id column is an
        // undefined-SILENT read once Plan 09 drops it. Fail-closed (userGroup
        // stays null -> 403) if the caller has no Users row.
        const caller = await User.findOne({ where: { user_id: userId }, attributes: ['id'] });
        userGroup = caller ? await UserGroup.findOne({
          where: {
            group_id: req.params.group_id,
            user_uuid: caller.id,
            status: 'active',
          },
        }) : null;
      } catch (dbError) {
        console.error('Database error checking group membership:', dbError);
        return sendSafeError(res, 500, dbError, 'Error checking group membership');
      }

      if (!userGroup) {
        return res.status(403).json({ error: 'Forbidden: You must be a member of this group' });
      }

      // Parse query params
      const timezone = req.query.timezone || 'UTC';

      // Default week_start to current Monday if not provided
      let weekStartDate;
      if (req.query.week_start) {
        weekStartDate = new Date(req.query.week_start + 'T00:00:00Z');
        if (isNaN(weekStartDate.getTime())) {
          return res.status(400).json({ error: 'Invalid week_start date format. Use ISO 8601 format (YYYY-MM-DD)' });
        }
      } else {
        // Default to Monday of current week
        const now = new Date();
        const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon
        const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Days to subtract to get to Monday
        weekStartDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
      }

      // Validate week_start is a Monday
      if (weekStartDate.getUTCDay() !== 1) {
        return res.status(400).json({ error: 'week_start must be a Monday' });
      }

      // Validate week_start is within allowed range (-3 weeks past, +12 weeks future
      // from current Monday). Phase 72-03 HUX-04 widened the range from the legacy
      // -2/+4 to match the CONTEXT-locked -3/+12 frontend navigation bounds — keep
      // these in sync with periodictabletop's heatmap nav (createEvent / MergedHeatmap
      // / HeatmapGrid all use -3/+12).
      const now = new Date();
      const currentDayOfWeek = now.getUTCDay();
      const diffToMonday = currentDayOfWeek === 0 ? -6 : 1 - currentDayOfWeek;
      const currentMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday));

      const diffMs = weekStartDate.getTime() - currentMonday.getTime();
      const diffWeeks = diffMs / (7 * 24 * 60 * 60 * 1000);

      if (diffWeeks < -3) {
        return res.status(400).json({ error: 'week_start cannot be more than 3 weeks in the past' });
      }
      if (diffWeeks > 12) {
        return res.status(400).json({ error: 'week_start cannot be more than 12 weeks in the future' });
      }

      const weekStartStr = weekStartDate.toISOString().split('T')[0];
      const result = await availabilityService.getGroupHeatmap(req.params.group_id, weekStartStr, timezone);

      res.json(result);
    } catch (error) {
      sendSafeError(res, 500, error, 'Error generating group heatmap');
    }
  }
);

// Get user's availability patterns (for editing/deleting)
router.get('/user/:user_id/patterns',
  validateAuth0UserId('user_id'),
  async (req, res) => {
    try {
      const userId = req.user?.user_id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!(await matchesSelf(req, req.params.user_id))) {
        return res.status(403).json({ error: 'Forbidden: Cannot access other users\' availability patterns' });
      }

      const patterns = await UserAvailability.findAll({
        where: { user_id: userId },
        order: [['createdAt', 'DESC']],
      });

      // Every row here is owned by the caller (query filters on their sub), so a
      // single caller-UUID resolution covers the whole list.
      const callerUuid = await resolveCallerUuid(userId);
      res.json(patterns.map(p => withEmittedUuid(p, callerUuid)));
    } catch (error) {
      sendSafeError(res, 500, error, 'Error fetching availability patterns');
    }
  }
);

module.exports = router;

