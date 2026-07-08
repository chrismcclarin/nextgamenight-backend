// tests/services/suggestionService.test.js
// Phase 87.1 / Plan 08 (BINT-02, T-87.1-16): REAL-DB proof that game
// suggestions are NON-EMPTY after the EventRsvp/UserGroup re-key.
//
// getSuggestions reads whose collections to search from EventRsvp (event-scoped)
// and UserGroup (group-scoped). Both are re-keyed onto the user_uuid UUID FK
// (Users.id). Plan 08 switched those reads from the legacy Auth0-string user_id
// column to user_uuid; had it kept the old reads, every list would resolve to
// Auth0 strings that never match UserGame.user_id (a UUID) and ALL suggestions
// would silently empty. getSuggestions previously had ZERO coverage, so a silent
// zero-match would otherwise pass green. This suite runs against the real test
// DB (no mocks) so the user_uuid -> UserGame.user_id join is exercised for real.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const suggestionService = require('../../services/suggestionService');
const { Game, UserGame, Event } = require('../../models');
const { makeUser, makeGroup, addToGroup, makeEventRsvp } = require('../factories');

// Seed a Game that passes getSuggestions' gameWhere filter (bgg_id set,
// is_custom false, player range spans typical counts).
async function makeOwnedGame(user, nameSuffix) {
  const game = await Game.create({
    name: `SuggestGame-${nameSuffix}-${Date.now()}`,
    bgg_id: Math.floor(Math.random() * 1e9),
    is_custom: false,
    min_players: 1,
    max_players: 8,
    playing_time: 60,
    weight: 2.5,
  });
  // UserGame.user_id is a Users.id UUID (not the Auth0 string).
  await UserGame.create({ user_id: user.id, game_id: game.id });
  return game;
}

describe('suggestionService.getSuggestions — user_uuid reads post-rekey (87.1 T-87.1-16, real DB)', () => {
  it('group-scoped: an active member\'s owned game is suggested with the correct owner name', async () => {
    const group = await makeGroup();
    const member = await makeUser();
    await addToGroup(member, group, 'member');
    const game = await makeOwnedGame(member, 'group');

    const { suggestions, playerCount } = await suggestionService.getSuggestions({
      groupId: group.id,
      playerCount: 2,
    });

    expect(playerCount).toBe(2);
    const match = suggestions.find(s => s.id === game.id);
    expect(match).toBeDefined();
    // Owner name resolved by Users.id (uuidToUsername preserved), not 'Unknown'.
    expect(match.owners).toContain(member.username);
    expect(match.owners).not.toContain('Unknown');
  });

  it('event-scoped: an RSVP-yes member\'s owned game is suggested with the correct owner name', async () => {
    const group = await makeGroup();
    const member = await makeUser();
    await addToGroup(member, group, 'member');
    const game = await makeOwnedGame(member, 'event');

    const event = await Event.create({ group_id: group.id, start_date: new Date() });
    // makeEventRsvp DUAL-WRITES user_uuid (Users.id) — the column the service reads.
    await makeEventRsvp(event, member, { status: 'yes' });

    const { suggestions, playerCount } = await suggestionService.getSuggestions({
      groupId: group.id,
      eventId: event.id,
    });

    // playerCount derives from the RSVP count (1 yes).
    expect(playerCount).toBe(1);
    const match = suggestions.find(s => s.id === game.id);
    expect(match).toBeDefined();
    expect(match.owners).toContain(member.username);
    expect(match.owners).not.toContain('Unknown');
  });

  it('group-scoped: a group with no members yields no suggestions (safe empty, not a throw)', async () => {
    const group = await makeGroup();
    const { suggestions } = await suggestionService.getSuggestions({
      groupId: group.id,
      playerCount: 2,
    });
    expect(suggestions).toEqual([]);
  });
});
