// utils/smsUtils.js
// GSM-7 sanitization utility for SMS messages.
// Strips non-GSM-7 characters from user-supplied strings to prevent
// silent message inflation (emoji, smart quotes -> UCS-2 = 70 char segments).

/**
 * Sanitize a string for GSM-7 SMS encoding.
 * - Returns empty string for null/undefined
 * - Replaces smart quotes with straight ASCII equivalents
 * - Replaces em dash / en dash with hyphen
 * - Strips emoji and other non-GSM-7 characters
 * - Trims whitespace
 *
 * @param {string|null|undefined} str - Input string (typically user-supplied event/group name)
 * @returns {string} Sanitized string safe for GSM-7 encoding
 */
function sanitizeForSms(str) {
  if (str == null) return '';
  if (typeof str !== 'string') return '';

  let result = str;

  // Replace smart double quotes with straight quotes
  result = result.replace(/[\u201C\u201D]/g, '"');

  // Replace smart single quotes / apostrophes with straight apostrophe
  result = result.replace(/[\u2018\u2019]/g, "'");

  // Replace em dash and en dash with hyphen
  result = result.replace(/[\u2013\u2014]/g, '-');

  // Strip emoji and other non-GSM-7 characters.
  // GSM-7 basic character set includes: ASCII printable (0x20-0x7E),
  // plus some Latin-1 Supplement chars used in European languages.
  // We keep: basic ASCII printable, newlines, and common Latin-1 accented chars.
  // eslint-disable-next-line no-control-regex
  result = result.replace(/[^\x20-\x7E\n\r\xA0-\xFF]/g, '');

  // Clean up any double spaces left by stripped characters
  result = result.replace(/\s{2,}/g, ' ');

  return result.trim();
}

// The fewest characters of a name an SMS keeps before the NEXT name starts giving way
// (owner, 2026-09-30: "Twilight Imperium: Fourth Edition" down to "Twilight Imp" "would be fine").
const NAME_FLOOR = 12;
const ELLIPSIS = '...';

/**
 * Clip a name to at most `maxLength` characters INCLUDING the trailing "...".
 * A name that already fits is returned untouched.
 */
function clipName(name, maxLength) {
  if (name.length <= maxLength) return name;
  if (maxLength <= 0) return '';
  if (maxLength <= ELLIPSIS.length) return name.slice(0, maxLength);
  return name.slice(0, maxLength - ELLIPSIS.length).trimEnd() + ELLIPSIS;
}

/**
 * Make a message fit a character budget by shortening its NAMES — never its tail.
 *
 * DECISION 2026-09-30 (owner rule; code-adversarial-review 88.6 round 3, M1/M6/M8): an over-long
 * SMS gives up name characters, chosen OVER cutting the assembled message from the end (what
 * shipped — it removed "Reply STOP to opt out" first, then the reply options, then the link) and
 * OVER capping names in the app or the database (owner: names are not limited for texting's
 * sake). Names give way IN THE ORDER PASSED: the first shrinks to NAME_FLOOR characters before
 * the second is touched, so callers pass the game name first and the group name second. Only if
 * every name is at the floor and the message is still too long do names shrink further, same
 * order. Reordering the names or cutting the tail again is a decision, not a cleanup.
 *
 * @param {(...names: string[]) => string} build - Renders the message from the (possibly clipped) names
 * @param {string[]} names - Names in the order they give way
 * @param {number} budget - Maximum length of the rendered message
 * @returns {string} The rendered message; longer than `budget` only if it cannot fit with every name empty
 */
function fitNamesToBudget(build, names, budget) {
  const fitted = names.map((n) => n || '');
  const excess = () => build(...fitted).length - budget;

  for (const floor of [NAME_FLOOR + ELLIPSIS.length, 0]) {
    for (let i = 0; i < fitted.length; i += 1) {
      const over = excess();
      if (over <= 0) return build(...fitted);
      fitted[i] = clipName(fitted[i], Math.max(floor, fitted[i].length - over));
    }
  }
  return build(...fitted);
}

module.exports = { sanitizeForSms, fitNamesToBudget, NAME_FLOOR };
