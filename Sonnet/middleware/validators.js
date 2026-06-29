// middleware/validators.js
// Input validation middleware using express-validator
const { body, param, query, validationResult, matchedData } = require('express-validator');
const { sendError } = require('../utils/errors');

// Middleware to check validation results
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Emit { field, message } ONLY — do NOT reflect err.value back to the client.
    // The live FE reads only err.message/err.field (never err.value), so dropping the
    // submitted input value is FE-safe and avoids echoing user input on the wire.
    const fieldErrors = errors.array().map(err => ({
      field: err.path || err.param,
      message: err.msg
    }));
    // Pass the OBJECT { errors } so the central serializer (utils/errors.js)
    // mirrors the field errors to BOTH details.errors[] AND a top-level
    // errors[] legacy alias (the live FE api.ts:148 reads top-level errors[]).
    return sendError(res, 'validation', { errors: fieldErrors });
  }
  next();
};

// BSEC-01 / D-05B: strip-unknown variant of `validate`.
//
// `validateStrict` runs the standard validation-result check AND, when it
// passes, REPLACES `req.body` with only the body fields that a validator chain
// actually declared (matchedData strip-unknown). This closes the
// mass-assignment surface at the validator layer for the handlers that opt in.
//
// CRITICAL — opt-in ONLY where the validator set is provably COMPLETE.
// matchedData on an INCOMPLETE validator chain silently DROPS every legitimate
// field the chain forgot to declare (RESEARCH §Anti-Patterns / Pitfall 4). So
// this is exported as a separate opt-in middleware rather than swapped into the
// shared `validate`, and it is NOT used on the games sinks (which have no
// validators at all and rely solely on the Sequelize `fields:` allow-list).
const validateStrict = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Emit { field, message } ONLY — do NOT reflect err.value (see `validate` above).
    const fieldErrors = errors.array().map(err => ({
      field: err.path || err.param,
      message: err.msg
    }));
    return sendError(res, 'validation', { errors: fieldErrors });
  }
  // Strip any body key not declared by a validator on this route.
  // CRITICAL (BSEC-01 mass-assignment guard, Pitfall 5): this PASS-branch
  // matchedData strip is preserved VERBATIM — only the reject branch changed.
  req.body = matchedData(req, { onlyValidData: true, locations: ['body'] });
  next();
};

// Group validators
const validateGroupCreate = [
  body('name')
    .trim()
    .isLength({ min: 1, max: 40 })
    .withMessage('Group name must be between 1 and 40 characters')
    .notEmpty()
    .withMessage('Group name is required'),
  validate
];

const validateGroupUpdate = [
  body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 40 })
    .withMessage('Group name must be between 1 and 40 characters'),
  body('profile_picture_url')
    .custom((value) => {
      // If value is falsy (null, undefined, empty string), allow it
      if (value === null || value === undefined || value === '' || (typeof value === 'string' && value.trim() === '')) {
        return true;
      }
      // If value is provided, validate it's either a URL or an emoji/short string
      if (typeof value !== 'string') {
        throw new Error('Profile picture URL must be a string');
      }
      
      // Check if it's a valid URL
      const urlRegex = /^https?:\/\/.+/;
      // If it's a URL, validate it
      if (urlRegex.test(value)) {
        if (value.length > 500) {
          throw new Error('Profile picture URL must be less than 500 characters');
        }
        return true;
      }
      
      // If it's not a URL, allow it if it's a short string (for emojis)
      // Emojis are typically 1-10 characters (including emoji sequences)
      if (value.length <= 10) {
        return true;
      }
      
      // If it's neither a URL nor a short string, reject it
      throw new Error('Profile picture URL must be a valid URL or an emoji');
    }),
  body('background_color')
    .custom((value) => {
      // If value is falsy (null, undefined, empty string), allow it
      if (value === null || value === undefined || value === '' || (typeof value === 'string' && value.trim() === '')) {
        return true;
      }
      // If value is provided, validate it's a hex color
      if (typeof value !== 'string') {
        throw new Error('Background color must be a string');
      }
      if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
        throw new Error('Background color must be a valid hex color (e.g., #ffffff)');
      }
      return true;
    }),
  body('background_image_url')
    .custom((value) => {
      // If value is falsy (null, undefined, empty string), allow it
      if (value === null || value === undefined || value === '' || (typeof value === 'string' && value.trim() === '')) {
        return true;
      }
      // If value is provided, validate it's a URL
      if (typeof value !== 'string') {
        throw new Error('Background image URL must be a string');
      }
      const urlRegex = /^https?:\/\/.+/;
      if (!urlRegex.test(value)) {
        throw new Error('Background image URL must be a valid URL');
      }
      if (value.length > 500) {
        throw new Error('Background image URL must be less than 500 characters');
      }
      return true;
    }),
  validate
];

// Event validators
const validateEventCreate = [
  body('group_id')
    .isUUID()
    .withMessage('Group ID must be a valid UUID'),
  body('game_id')
    .optional({ nullable: true })
    .isUUID()
    .withMessage('Game ID must be a valid UUID when provided'),
  body('game_name')
    .optional({ nullable: true })
    .trim()
    .isLength({ min: 1, max: 255 })
    .withMessage('Game name must be between 1 and 255 characters'),
  body('start_date')
    .isISO8601()
    .withMessage('Start date must be a valid ISO 8601 date'),
  body('duration_minutes')
    .optional({ nullable: true })
    .isInt({ min: 1, max: 1440 })
    .withMessage('Duration must be between 1 and 1440 minutes when provided'),
  body('comments')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Comments must be less than 2000 characters'),
  body('is_group_win')
    .optional()
    .isBoolean()
    .withMessage('is_group_win must be a boolean'),
  body('participants')
    .optional()
    .isArray()
    .withMessage('Participants must be an array'),
  body('participants.*.user_id')
    .optional()
    .isUUID()
    .withMessage('Participant user_id must be a valid UUID'),
  body('participants.*.score')
    .optional({ checkFalsy: true })
    .custom((value) => {
      // Allow null, undefined, or empty string
      if (value === null || value === undefined || value === '') {
        return true;
      }
      // If provided, must be a non-negative number
      const numValue = parseFloat(value);
      return !isNaN(numValue) && numValue >= 0;
    })
    .withMessage('Participant score must be a non-negative number or empty'),
  body('participants.*.faction')
    .optional()
    .isLength({ max: 255 })
    .withMessage('Faction must be less than 255 characters'),
  body('ballot_options')
    .optional()
    .isArray()
    .withMessage('Ballot options must be an array'),
  body('ballot_options.*.game_id')
    .optional({ nullable: true })
    .isUUID()
    .withMessage('Ballot option game_id must be a valid UUID when provided'),
  body('ballot_options.*.game_name')
    .notEmpty()
    .withMessage('Ballot option game_name is required')
    .trim()
    .isLength({ min: 1, max: 255 })
    .withMessage('Ballot option game_name must be between 1 and 255 characters'),
  validate
];

const validateEventUpdate = [
  body('group_id')
    .optional()
    .isUUID()
    .withMessage('Group ID must be a valid UUID'),
  body('game_id')
    .optional({ nullable: true })
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true;
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRegex.test(value);
    })
    .withMessage('Game ID must be a valid UUID'),
  body('start_date')
    .optional()
    .isISO8601()
    .withMessage('Start date must be a valid ISO 8601 date'),
  body('duration_minutes')
    .optional({ nullable: true })
    .custom((value) => {
      if (value === null || value === undefined || value === '') return true;
      const num = Number(value);
      if (!Number.isInteger(num) || num < 1 || num > 1440) {
        throw new Error('Duration must be between 1 and 1440 minutes (24 hours) when provided');
      }
      return true;
    }),
  body('comments')
    .optional()
    .isLength({ max: 2000 })
    .withMessage('Comments must be less than 2000 characters'),
  validate
];

// Review validators
const validateReviewCreate = [
  body('group_id')
    .isUUID()
    .withMessage('Group ID must be a valid UUID'),
  body('game_id')
    .isUUID()
    .withMessage('Game ID must be a valid UUID'),
  body('rating')
    .optional()
    .isFloat({ min: 0, max: 5 })
    .withMessage('Rating must be between 0 and 5'),
  body('review_text')
    .optional()
    .isLength({ max: 5000 })
    .withMessage('Review text must be less than 5000 characters'),
  body('is_recommended')
    .optional()
    .isBoolean()
    .withMessage('is_recommended must be a boolean'),
  validate
];

// User search validators
const validateUserSearch = [
  query('email')
    .optional()
    .isEmail()
    .withMessage('Email must be a valid email address'),
  param('email')
    .optional()
    .isEmail()
    .withMessage('Email must be a valid email address'),
  validate
];

// BGG username validators
const validateBGGUsername = [
  body('bgg_username')
    .trim()
    .isLength({ min: 1, max: 50 })
    .withMessage('BGG username must be between 1 and 50 characters')
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage('BGG username can only contain letters, numbers, hyphens, and underscores'),
  validate
];

// Feedback validators
const validateFeedback = [
  body('type')
    .isIn(['bug', 'suggestion', 'feature'])
    .withMessage('Type must be bug, suggestion, or feature'),
  body('subject')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Subject must be between 1 and 200 characters'),
  body('description')
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage('Description must be between 1 and 2000 characters'),
  body('user_email')
    .optional({ nullable: true })
    .isEmail()
    .withMessage('User email must be a valid email address'),
  body('screenshot_base64')
    .optional({ nullable: true })
    .isString()
    .withMessage('Screenshot must be a base64 string'),
  body('screenshot_filename')
    .optional({ nullable: true })
    .isString()
    .isLength({ max: 255 })
    .withMessage('Screenshot filename must be a string under 255 characters'),
  validate
];

// UUID parameter validators
const validateUUID = (paramName = 'id') => [
  param(paramName)
    .isUUID()
    .withMessage(`${paramName} must be a valid UUID`),
  validate
];

// Validate Auth0 user_id (not a UUID, can contain pipes, dashes, etc.)
// Format: provider|id (e.g., google-oauth2|107459289778553956693)
const validateAuth0UserId = (paramName = 'user_id') => [
  param(paramName)
    .isString()
    .trim()
    .isLength({ min: 1, max: 255 })
    .withMessage(`${paramName} must be a valid user ID string`)
    .matches(/^[a-zA-Z0-9_\-|:]+$/)
    .withMessage(`${paramName} must be a valid Auth0 user ID format`),
  validate
];

// RSVP validators
const validateRsvpCreate = [
  body('event_id')
    .isUUID()
    .withMessage('Event ID must be a valid UUID'),
  body('status')
    .isIn(['yes', 'no', 'maybe'])
    .withMessage('Status must be one of: yes, no, maybe'),
  body('note')
    .optional({ nullable: true })
    .trim()
    .isLength({ max: 500 })
    .withMessage('Note must be less than 500 characters'),
  validate
];

// Ballot validators
const validateBallotOptions = [
  body('options')
    .isArray({ min: 2, max: 10 })
    .withMessage('Ballot must have between 2 and 10 options'),
  body('options.*.game_name')
    .isString()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Each option must have a game name between 1 and 200 characters'),
  body('options.*.game_id')
    .optional({ nullable: true })
    .isUUID()
    .withMessage('Game ID must be a valid UUID when provided'),
  validate
];

const validateBallotVote = [
  body('option_id')
    .isUUID()
    .withMessage('Option ID must be a valid UUID'),
  validate
];

module.exports = {
  validate,
  validateStrict,
  validateGroupCreate,
  validateGroupUpdate,
  validateEventCreate,
  validateEventUpdate,
  validateReviewCreate,
  validateUserSearch,
  validateBGGUsername,
  validateFeedback,
  validateUUID,
  validateAuth0UserId,
  validateRsvpCreate,
  validateBallotOptions,
  validateBallotVote,
};

