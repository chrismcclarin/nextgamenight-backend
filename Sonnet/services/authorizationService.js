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
 *
 * D-11 (Phase 87.1, BINT-02): UserGroup is now keyed on `user_uuid` (the Users.id
 * UUID surrogate), NOT the Auth0 string. The caller's Auth0 id MUST be resolved to
 * the Users row ONCE before querying — comparing a UUID column against an Auth0
 * string is always-false, which would silently 403 every legitimate owner/admin/
 * member. This is the CENTRAL funnel behind isOwner/isActiveMember/
 * isMemberOrHigher/isOwnerOrAdmin, so this single resolution covers all of them.
 *
 * Fail-closed: returns null when the caller has no Users row (same defensive
 * pattern as isEventParticipant below).
 *
 * @param {string} auth0UserId - Auth0 user ID string (e.g. "google-oauth2|123")
 * @param {string} groupId - Group UUID
 * @returns {Promise<string|null>} Role string ('owner', 'admin', 'member') or null
 */
const getUserRoleInGroup = async (auth0UserId, groupId) => {
  const user = await User.findOne({ where: { user_id: auth0UserId } });
  if (!user) return null; // fail-closed: no Users row → no role
  const userGroup = await UserGroup.findOne({
    where: {
      user_uuid: user.id,
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
 * ALLOW-LIST (BSEC-01 / D-03) — ONLY these fields are returned; everything
 * else (incl. email, phone, calendar_connected, google_calendar_*,
 * notification_preferences, and any future field such as is_platform_admin)
 * is stripped by default:
 *   id, user_id, username, display_name, profile_picture_url, avatar_url,
 *   UserGroup association (role, joined_at) — INCLUDING when UserGroup is
 *   explicitly null (the Phase 71.1 game-only signal for the frontend; the
 *   allow-list preserves the key even when its value is null).
 *
 * Flipped from an omit-list to an allow-list so new User columns default to
 * STRIPPED (fail-closed). Adding a field a future caller legitimately needs
 * is a deliberate edit to STRIP_MEMBER_PII_ALLOWLIST below.
 *
 * @param {object|Model} memberRow - Plain object or Sequelize instance
 * @returns {object}
 */
// BSEC-01 (D-03): allow-list, NOT omit-list. New User fields (e.g.
// is_platform_admin) default to STRIPPED — only these explicitly-permitted
// display/identity fields ever reach a game-only caller. UserGroup is
// allow-listed and preserved even when explicitly null (the Phase 71.1
// game-only signal). Adding a field a future caller needs is a deliberate
// edit here, fail-closed by design.
const STRIP_MEMBER_PII_ALLOWLIST = [
  'id',
  'user_id',
  'username',
  'display_name',
  'profile_picture_url',
  'avatar_url',
  'UserGroup',
];

const stripMemberPII = (memberRow) => {
  if (!memberRow) return memberRow;
  const json = memberRow.toJSON ? memberRow.toJSON() : memberRow;
  const safe = {};
  for (const key of STRIP_MEMBER_PII_ALLOWLIST) {
    // Preserve allow-listed keys that are present, INCLUDING explicit null
    // (UserGroup: null is the game-only signal — must not be dropped).
    if (Object.prototype.hasOwnProperty.call(json, key)) {
      safe[key] = json[key];
    }
  }
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
