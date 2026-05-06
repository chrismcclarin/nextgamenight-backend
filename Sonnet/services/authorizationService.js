// services/authorizationService.js
// Centralized permission helpers for group-based authorization.
// All route files import from here instead of defining their own helpers.

const { UserGroup, EventParticipation, Event, User } = require('../models');

/**
 * Role hierarchy for permission comparisons.
 * Higher numbers = more privileges.
 */
const ROLE_HIERARCHY = {
  owner: 4,
  admin: 3,
  member: 2,
  pending: 1,
};

/**
 * Get a user's role in a group.
 * Uses the "direct" pattern: queries UserGroup directly with the Auth0 user_id string.
 * No User table lookup is needed because UserGroup.user_id IS the Auth0 string.
 *
 * @param {string} auth0UserId - Auth0 user ID string (e.g. "google-oauth2|123")
 * @param {string} groupId - Group UUID
 * @returns {Promise<string|null>} Role string ('owner', 'admin', 'member') or null
 */
const getUserRoleInGroup = async (auth0UserId, groupId) => {
  const userGroup = await UserGroup.findOne({
    where: {
      user_id: auth0UserId,
      group_id: groupId,
      status: 'active',
    },
  });
  return userGroup ? userGroup.role : null;
};

/**
 * Check if user is owner or admin of a group.
 * @param {string} auth0UserId - Auth0 user ID string
 * @param {string} groupId - Group UUID
 * @returns {Promise<boolean>}
 */
const isOwnerOrAdmin = async (auth0UserId, groupId) => {
  const role = await getUserRoleInGroup(auth0UserId, groupId);
  return role === 'owner' || role === 'admin';
};

/**
 * Check if user is an active member of a group (any role, including pending).
 * Use for: viewing group content, reading data, voting, RSVP, availability.
 * Pending members pass this check -- they can read group content.
 * @param {string} auth0UserId - Auth0 user ID string
 * @param {string} groupId - Group UUID
 * @returns {Promise<boolean>}
 */
const isActiveMember = async (auth0UserId, groupId) => {
  const role = await getUserRoleInGroup(auth0UserId, groupId);
  return role !== null;
};

/**
 * Check if user is at least a full member of a group (member, admin, or owner).
 * Use for: creating events, adding games, writing reviews, managing ballot options
 * (excludes pending members).
 * @param {string} auth0UserId - Auth0 user ID string
 * @param {string} groupId - Group UUID
 * @returns {Promise<boolean>}
 */
const isMemberOrHigher = async (auth0UserId, groupId) => {
  const role = await getUserRoleInGroup(auth0UserId, groupId);
  if (!role) return false;
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY['member'];
};

/**
 * Check if user is the owner of a group.
 * @param {string} auth0UserId - Auth0 user ID string
 * @param {string} groupId - Group UUID
 * @returns {Promise<boolean>}
 */
const isOwner = async (auth0UserId, groupId) => {
  const role = await getUserRoleInGroup(auth0UserId, groupId);
  return role === 'owner';
};

/**
 * Check if user has an EventParticipation row for a specific event.
 *
 * Auth0 user IDs are strings (e.g. "google-oauth2|123") while
 * EventParticipation.user_id is a User.id UUID. We bridge through the User
 * table first (same pattern as routes/events.js /join-game-by-token), then
 * query EventParticipation by User.id.
 *
 * Returns false defensively if the User row is missing — a legitimate
 * game-only participant always has a User row created at QR-join time.
 *
 * @param {string} auth0UserId - Auth0 user ID string
 * @param {string} eventId - Event UUID
 * @returns {Promise<boolean>}
 */
const isEventParticipant = async (auth0UserId, eventId) => {
  if (!auth0UserId || !eventId) return false;
  const user = await User.findOne({ where: { user_id: auth0UserId } });
  if (!user) return false;
  const ep = await EventParticipation.findOne({
    where: { event_id: eventId, user_id: user.id },
  });
  return !!ep;
};

/**
 * Resolve a caller's read access to an event-scoped surface.
 *
 * Used by RSVP, brings, ballot, suggestions, members-list, and event detail
 * routes. Game-only participants pass on the specific event they joined;
 * group members pass on any event in their group; everyone else is denied.
 *
 * Resolves the Event in-helper so callers don't need to double-fetch.
 *
 * @param {string} auth0UserId - Auth0 user ID string
 * @param {string} eventId - Event UUID
 * @returns {Promise<{allowed: boolean, scope: 'group-member'|'game-only'|'none', event: Event|null}>}
 */
const canReadEventScopedSurface = async (auth0UserId, eventId) => {
  if (!auth0UserId || !eventId) {
    return { allowed: false, scope: 'none', event: null };
  }
  const event = await Event.findByPk(eventId);
  if (!event) return { allowed: false, scope: 'none', event: null };
  if (await isActiveMember(auth0UserId, event.group_id)) {
    return { allowed: true, scope: 'group-member', event };
  }
  if (await isEventParticipant(auth0UserId, event.id)) {
    return { allowed: true, scope: 'game-only', event };
  }
  return { allowed: false, scope: 'none', event };
};

/**
 * Strip PII fields from a member row before returning it to a game-only caller.
 *
 * Pure function. Accepts either a plain object or a Sequelize instance
 * (calls .toJSON() if present). Returns a NEW object — does not mutate input.
 *
 * Omitted fields (per CONTEXT "PII stripping for game-only callers"):
 *   email, phone, calendar_connected, google_calendar_token,
 *   google_calendar_refresh_token, google_calendar_email,
 *   notification_preferences
 *
 * Preserved fields (everything else, including):
 *   id, user_id, username, display_name, profile_picture_url, avatar_url,
 *   UserGroup association (role, joined_at) — INCLUDING when UserGroup is
 *   explicitly null (game-only signal for the frontend; null values are not
 *   stripped — only the PII fields above are).
 *
 * Uses an omit list rather than a whitelist because unknown future fields
 * default to "kept" — a whitelist would be too brittle when models grow.
 *
 * @param {object|Model} memberRow - Plain object or Sequelize instance
 * @returns {object}
 */
const stripMemberPII = (memberRow) => {
  if (!memberRow) return memberRow;
  const json = memberRow.toJSON ? memberRow.toJSON() : memberRow;
  const {
    email,
    phone,
    calendar_connected,
    google_calendar_token,
    google_calendar_refresh_token,
    google_calendar_email,
    notification_preferences,
    ...safe
  } = json;
  return safe;
};

module.exports = {
  getUserRoleInGroup,
  isOwnerOrAdmin,
  isActiveMember,
  isMemberOrHigher,
  isOwner,
  isEventParticipant,
  canReadEventScopedSurface,
  stripMemberPII,
  ROLE_HIERARCHY,
};
