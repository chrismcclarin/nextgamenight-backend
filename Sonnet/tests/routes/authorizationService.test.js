// tests/routes/authorizationService.test.js
//
// Unit tests for the new Phase 71.1 authorization helpers:
//   - isEventParticipant
//   - canReadEventScopedSurface
//   - stripMemberPII
//
// Mocks the Sequelize models so tests run without a real database. Existing
// helpers (isActiveMember, etc.) are exercised indirectly through
// canReadEventScopedSurface — its behavior depends on UserGroup.findOne too,
// so we mock that as well.

jest.mock('../../models', () => ({
  UserGroup: { findOne: jest.fn() },
  EventParticipation: { findOne: jest.fn() },
  Event: { findByPk: jest.fn() },
  User: { findOne: jest.fn() },
}));

const { UserGroup, EventParticipation, Event, User } = require('../../models');
const {
  isEventParticipant,
  canReadEventScopedSurface,
  stripMemberPII,
} = require('../../services/authorizationService');

beforeEach(() => {
  UserGroup.findOne.mockReset();
  EventParticipation.findOne.mockReset();
  Event.findByPk.mockReset();
  User.findOne.mockReset();
});

describe('isEventParticipant', () => {
  it('returns false on null/empty inputs', async () => {
    expect(await isEventParticipant(null, 'event-1')).toBe(false);
    expect(await isEventParticipant('auth0|abc', null)).toBe(false);
    expect(await isEventParticipant('', '')).toBe(false);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  it('returns false when User row is missing (defensive)', async () => {
    User.findOne.mockResolvedValue(null);

    expect(await isEventParticipant('auth0|missing', 'event-1')).toBe(false);
    expect(User.findOne).toHaveBeenCalledWith({
      where: { user_id: 'auth0|missing' },
    });
    expect(EventParticipation.findOne).not.toHaveBeenCalled();
  });

  it('returns false when User exists but no EventParticipation row', async () => {
    User.findOne.mockResolvedValue({ id: 'user-uuid-1', user_id: 'auth0|abc' });
    EventParticipation.findOne.mockResolvedValue(null);

    expect(await isEventParticipant('auth0|abc', 'event-1')).toBe(false);
    expect(EventParticipation.findOne).toHaveBeenCalledWith({
      where: { event_id: 'event-1', user_id: 'user-uuid-1' },
    });
  });

  it('returns true when User exists and has EventParticipation row', async () => {
    User.findOne.mockResolvedValue({ id: 'user-uuid-1', user_id: 'auth0|abc' });
    EventParticipation.findOne.mockResolvedValue({
      id: 'ep-1',
      event_id: 'event-1',
      user_id: 'user-uuid-1',
    });

    expect(await isEventParticipant('auth0|abc', 'event-1')).toBe(true);
  });

  it('bridges Auth0 string → User.id UUID before querying EventParticipation', async () => {
    // The asymmetry is load-bearing: EventParticipation.user_id is UUID.
    User.findOne.mockResolvedValue({ id: 'uuid-not-auth0', user_id: 'auth0|abc' });
    EventParticipation.findOne.mockResolvedValue({ id: 'ep-1' });

    await isEventParticipant('auth0|abc', 'event-1');

    // First call: User table, by Auth0 string
    expect(User.findOne).toHaveBeenCalledWith({
      where: { user_id: 'auth0|abc' },
    });
    // Then EventParticipation, by User.id UUID — NEVER by Auth0 string
    expect(EventParticipation.findOne).toHaveBeenCalledWith({
      where: { event_id: 'event-1', user_id: 'uuid-not-auth0' },
    });
  });
});

describe('canReadEventScopedSurface', () => {
  it('returns allowed=false scope=none on null/empty inputs', async () => {
    expect(await canReadEventScopedSurface(null, 'event-1')).toEqual({
      allowed: false,
      scope: 'none',
      event: null,
    });
    expect(await canReadEventScopedSurface('auth0|abc', null)).toEqual({
      allowed: false,
      scope: 'none',
      event: null,
    });
    expect(Event.findByPk).not.toHaveBeenCalled();
  });

  it('returns allowed=false scope=none when event not found', async () => {
    Event.findByPk.mockResolvedValue(null);

    expect(await canReadEventScopedSurface('auth0|abc', 'event-missing')).toEqual({
      allowed: false,
      scope: 'none',
      event: null,
    });
    expect(UserGroup.findOne).not.toHaveBeenCalled();
  });

  it('returns allowed=true scope=group-member when caller is active group member', async () => {
    const event = { id: 'event-1', group_id: 'group-1' };
    Event.findByPk.mockResolvedValue(event);
    // isActiveMember resolves to true (UserGroup row exists with status=active)
    UserGroup.findOne.mockResolvedValue({ role: 'member', user_id: 'auth0|abc', group_id: 'group-1' });

    const result = await canReadEventScopedSurface('auth0|abc', 'event-1');
    expect(result).toEqual({ allowed: true, scope: 'group-member', event });
    // Should not have fallen through to the event-participant check.
    expect(User.findOne).not.toHaveBeenCalled();
    expect(EventParticipation.findOne).not.toHaveBeenCalled();
  });

  it('returns allowed=true scope=game-only when only EventParticipation matches', async () => {
    const event = { id: 'event-1', group_id: 'group-1' };
    Event.findByPk.mockResolvedValue(event);
    UserGroup.findOne.mockResolvedValue(null); // not a group member
    User.findOne.mockResolvedValue({ id: 'user-uuid-1', user_id: 'auth0|abc' });
    EventParticipation.findOne.mockResolvedValue({ id: 'ep-1' });

    const result = await canReadEventScopedSurface('auth0|abc', 'event-1');
    expect(result).toEqual({ allowed: true, scope: 'game-only', event });
  });

  it('returns allowed=false scope=none when neither group nor participation matches', async () => {
    const event = { id: 'event-1', group_id: 'group-1' };
    Event.findByPk.mockResolvedValue(event);
    UserGroup.findOne.mockResolvedValue(null); // not a group member
    User.findOne.mockResolvedValue({ id: 'user-uuid-1', user_id: 'auth0|abc' });
    EventParticipation.findOne.mockResolvedValue(null); // no participation row

    const result = await canReadEventScopedSurface('auth0|abc', 'event-1');
    expect(result).toEqual({ allowed: false, scope: 'none', event });
  });

  it('returns allowed=false scope=none when User row is missing for game-only path', async () => {
    const event = { id: 'event-1', group_id: 'group-1' };
    Event.findByPk.mockResolvedValue(event);
    UserGroup.findOne.mockResolvedValue(null);
    User.findOne.mockResolvedValue(null); // defensive: no User row

    const result = await canReadEventScopedSurface('auth0|abc', 'event-1');
    expect(result).toEqual({ allowed: false, scope: 'none', event });
  });
});

describe('stripMemberPII', () => {
  it('omits all PII fields', () => {
    const input = {
      id: 'uuid-1',
      user_id: 'auth0|abc',
      username: 'alice',
      email: 'alice@example.com',
      phone: '+15555550100',
      calendar_connected: true,
      google_calendar_token: 'secret-token',
      google_calendar_refresh_token: 'secret-refresh',
      google_calendar_email: 'alice@gmail.com',
      notification_preferences: { reminder: true },
      profile_picture_url: 'https://example.com/avatar.png',
    };

    const result = stripMemberPII(input);

    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('phone');
    expect(result).not.toHaveProperty('calendar_connected');
    expect(result).not.toHaveProperty('google_calendar_token');
    expect(result).not.toHaveProperty('google_calendar_refresh_token');
    expect(result).not.toHaveProperty('google_calendar_email');
    expect(result).not.toHaveProperty('notification_preferences');
  });

  it('preserves identity and display fields', () => {
    const input = {
      id: 'uuid-1',
      user_id: 'auth0|abc',
      username: 'alice',
      display_name: 'Alice A.',
      profile_picture_url: 'https://example.com/avatar.png',
      avatar_url: 'https://example.com/avatar2.png',
      email: 'alice@example.com', // strip
    };

    const result = stripMemberPII(input);

    expect(result.id).toBe('uuid-1');
    expect(result.user_id).toBe('auth0|abc');
    expect(result.username).toBe('alice');
    expect(result.display_name).toBe('Alice A.');
    expect(result.profile_picture_url).toBe('https://example.com/avatar.png');
    expect(result.avatar_url).toBe('https://example.com/avatar2.png');
  });

  it('preserves UserGroup association (with role/joined_at)', () => {
    const input = {
      id: 'uuid-1',
      user_id: 'auth0|abc',
      username: 'alice',
      email: 'alice@example.com',
      UserGroup: { role: 'owner', joined_at: '2026-01-01T00:00:00Z' },
    };

    const result = stripMemberPII(input);
    expect(result.UserGroup).toEqual({ role: 'owner', joined_at: '2026-01-01T00:00:00Z' });
  });

  it('preserves UserGroup field even when its value is explicitly null (game-only signal)', () => {
    // CRITICAL — Phase 71.1 cross-plan contract for Plan 02:
    // The synthetic caller-row injected into the filtered roster has
    // UserGroup: null as the signal that the caller is a game-only
    // participant. stripMemberPII must NOT drop null-valued fields.
    const input = {
      id: 'uuid-caller',
      user_id: 'auth0|caller',
      username: 'caller',
      email: 'caller@example.com',
      UserGroup: null,
    };

    const result = stripMemberPII(input);
    expect(result).toHaveProperty('UserGroup');
    expect(result.UserGroup).toBeNull();
  });

  it('handles Sequelize-instance shape via .toJSON()', () => {
    const fakeInstance = {
      toJSON: () => ({
        id: 'uuid-1',
        user_id: 'auth0|abc',
        username: 'alice',
        email: 'alice@example.com',
      }),
    };

    const result = stripMemberPII(fakeInstance);
    expect(result).toEqual({
      id: 'uuid-1',
      user_id: 'auth0|abc',
      username: 'alice',
    });
    expect(result).not.toHaveProperty('email');
  });

  it('returns a new object (does not mutate input)', () => {
    const input = {
      id: 'uuid-1',
      username: 'alice',
      email: 'alice@example.com',
    };

    const result = stripMemberPII(input);
    expect(result).not.toBe(input);
    // Input still has email
    expect(input.email).toBe('alice@example.com');
    // Result does not
    expect(result).not.toHaveProperty('email');
  });

  it('handles null/undefined input gracefully', () => {
    expect(stripMemberPII(null)).toBeNull();
    expect(stripMemberPII(undefined)).toBeUndefined();
  });
});
