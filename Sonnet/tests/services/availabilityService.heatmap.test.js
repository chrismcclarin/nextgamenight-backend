// tests/services/availabilityService.heatmap.test.js
// Unit tests for getGroupHeatmap -- 30-min to 1-hour bucketing, poll merging, and heatmap normalization

// Mock models before requiring the service
jest.mock('../../models', () => {
  const mockGroup = {
    findByPk: jest.fn(),
  };
  const mockUserGroup = {};
  const mockUserAvailability = {
    findAll: jest.fn().mockResolvedValue([]),
  };
  const mockUser = {};
  const mockAvailabilityPrompt = {
    findAll: jest.fn().mockResolvedValue([]),
  };
  const mockAvailabilityResponse = {
    findAll: jest.fn().mockResolvedValue([]),
  };
  return {
    Group: mockGroup,
    UserGroup: mockUserGroup,
    UserAvailability: mockUserAvailability,
    User: mockUser,
    AvailabilityPrompt: mockAvailabilityPrompt,
    AvailabilityResponse: mockAvailabilityResponse,
  };
});

jest.mock('../../services/googleCalendarService', () => ({
  getBusyTimesForDateRange: jest.fn().mockResolvedValue([]),
}));

const availabilityService = require('../../services/availabilityService');
const { Group, UserAvailability, AvailabilityPrompt, AvailabilityResponse } = require('../../models');
const googleCalendarService = require('../../services/googleCalendarService');

describe('availabilityService.getGroupHeatmap', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no active prompts
    AvailabilityPrompt.findAll.mockResolvedValue([]);
    AvailabilityResponse.findAll.mockResolvedValue([]);
  });

  // Helper to build mock overlap data (what calculateGroupOverlaps returns)
  function buildOverlapSlot(date, timeSlot, availableMembers, totalMembers = 5) {
    const [h, m] = timeSlot.split(':').map(Number);
    const endMinutes = h * 60 + m + 30;
    const endH = String(Math.floor(endMinutes / 60) % 24).padStart(2, '0');
    const endM = String(endMinutes % 60).padStart(2, '0');
    return {
      date,
      timeSlot,
      endTime: `${endH}:${endM}`,
      availableCount: availableMembers.length,
      totalMembers,
      availableMembers: availableMembers.map(u => ({
        user_id: u.user_id,
        username: u.username,
        email: u.email || `${u.username.toLowerCase()}@test.com`,
      })),
      unavailableCount: totalMembers - availableMembers.length,
    };
  }

  const userA = { user_id: 'auth0|aaa', username: 'Alice', email: 'alice@test.com' };
  const userB = { user_id: 'auth0|bbb', username: 'Bob', email: 'bob@test.com' };
  const userC = { user_id: 'auth0|ccc', username: 'Carol', email: 'carol@test.com' };

  // Helper: mock the INTERNAL overlap builder to return controlled data.
  // Phase 87.4 Plan 08 rename split: getGroupHeatmap now consumes the sub-keyed
  // `buildGroupOverlaps` (not the public, boundary-translating `calculateGroupOverlaps`),
  // so the injection seam moved here. Coverage is unchanged — the mock data these
  // tests inject is sub-keyed, exactly the shape the internal builder emits.
  function mockOverlaps(overlaps) {
    jest.spyOn(availabilityService, 'buildGroupOverlaps').mockResolvedValue(overlaps);
  }

  // Helper: mock Group.findByPk to return members
  function mockGroupMembers(members, hasAvailability = {}) {
    // hasAvailability: { 'auth0|xxx': true } means that user has availability data
    const groupUsers = members.map(m => ({
      ...m,
      id: m.id || m.user_id,
      google_calendar_enabled: m.google_calendar_enabled || false,
      google_calendar_token: m.google_calendar_token || null,
      google_calendar_refresh_token: null,
    }));

    Group.findByPk.mockResolvedValue({
      id: 'test-group-id',
      Users: groupUsers,
    });

    // Mock UserAvailability.findAll to return records for users marked as having data.
    // Supports both the legacy per-member shape ({ user_id: 'X' }) AND the
    // post-HEAT-03 batched shape ({ user_id: { [Op.in]: [...] } }).
    UserAvailability.findAll.mockImplementation(async ({ where }) => {
      const uid = where.user_id;
      if (uid && typeof uid === 'object') {
        // Batched: pull the array of ids out of any Sequelize Op.in symbol-keyed object
        const symbols = Object.getOwnPropertySymbols(uid);
        const ids = symbols.length ? uid[symbols[0]] : (uid.in || []);
        return ids
          .filter(id => hasAvailability[id])
          .map(id => ({ id: 'some-record', user_id: id, type: 'recurring_pattern' }));
      }
      // Legacy per-member shape
      if (hasAvailability[uid]) {
        return [{ id: 'some-record', user_id: uid, type: 'recurring_pattern' }];
      }
      return [];
    });
  }

  // ===================================
  // Test 1: AND logic -- available in both 30-min sub-slots
  // ===================================
  it('counts user as available when present in BOTH 30-min sub-slots for an hour', async () => {
    const overlaps = [
      // User A available in both 14:00 and 14:30
      buildOverlapSlot('2026-03-23', '14:00', [userA], 3),
      buildOverlapSlot('2026-03-23', '14:30', [userA], 3),
    ];
    mockOverlaps(overlaps);
    mockGroupMembers([userA, userB, userC], { 'auth0|aaa': true, 'auth0|bbb': true, 'auth0|ccc': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot14).toBeDefined();
    expect(slot14.availableCount).toBe(1);
    expect(slot14.availableMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: 'auth0|aaa', username: 'Alice' })
      ])
    );
  });

  // ===================================
  // Test 2: AND logic -- NOT available when only in one sub-slot
  // ===================================
  it('counts user as NOT available when present in only ONE 30-min sub-slot (AND logic)', async () => {
    const overlaps = [
      // User A available at 14:00 but NOT at 14:30
      buildOverlapSlot('2026-03-23', '14:00', [userA], 3),
      buildOverlapSlot('2026-03-23', '14:30', [], 3),
    ];
    mockOverlaps(overlaps);
    mockGroupMembers([userA, userB, userC], { 'auth0|aaa': true, 'auth0|bbb': true, 'auth0|ccc': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot14).toBeDefined();
    expect(slot14.availableCount).toBe(0);
    expect(slot14.availableMembers).toEqual([]);
  });

  // ===================================
  // Test 3: Hour range is 10-23 (14 hours); hour 9 excluded, hour 23 included
  // ===================================
  it('includes hours 10-23 and excludes hour 9 (14-hour output window)', async () => {
    const overlaps = [
      // 09:00 and 09:30 -- should be excluded (before 10am)
      buildOverlapSlot('2026-03-23', '09:00', [userA], 3),
      buildOverlapSlot('2026-03-23', '09:30', [userA], 3),
      // 14:00 and 14:30 -- should be included
      buildOverlapSlot('2026-03-23', '14:00', [userA], 3),
      buildOverlapSlot('2026-03-23', '14:30', [userA], 3),
      // 23:00 and 23:30 -- should be included (10am-midnight range)
      buildOverlapSlot('2026-03-23', '23:00', [userA], 3),
      buildOverlapSlot('2026-03-23', '23:30', [userA], 3),
    ];
    mockOverlaps(overlaps);
    mockGroupMembers([userA, userB, userC], { 'auth0|aaa': true, 'auth0|bbb': true, 'auth0|ccc': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    // No slot for hour 9
    const slot09 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 9);
    expect(slot09).toBeUndefined();

    // Hour 23 should now exist (10am-midnight range)
    const slot23 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 23);
    expect(slot23).toBeDefined();
    expect(slot23.availableCount).toBe(1);

    // Hour 14 should exist
    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot14).toBeDefined();
    expect(slot14.availableCount).toBe(1);

    // Hour 10 should exist (lower boundary)
    const slot10 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 10);
    expect(slot10).toBeDefined();
  });

  // ===================================
  // Test 4: membersWithoutData identifies members with no recurring schedule, gcal, or poll response
  // ===================================
  it('membersWithoutData lists members with no recurring schedule, gcal, or poll response', async () => {
    mockOverlaps([]);
    // 5 members: 3 have availability data, 2 do not
    mockGroupMembers(
      [
        { ...userA, google_calendar_enabled: false },
        { ...userB, google_calendar_enabled: true, google_calendar_token: 'token-b' },
        { ...userC, google_calendar_enabled: false },
        { user_id: 'auth0|ddd', username: 'Dave', email: 'dave@test.com', google_calendar_enabled: false },
        { user_id: 'auth0|eee', username: 'Eve', email: 'eve@test.com', google_calendar_enabled: false },
      ],
      {
        'auth0|aaa': true,   // has recurring schedule
        'auth0|bbb': false,  // has gcal (google_calendar_enabled=true)
        'auth0|ccc': true,   // has recurring schedule
        'auth0|ddd': false,  // no data
        'auth0|eee': false,  // no data
      }
    );

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    // totalMembers now reflects only data-contributing members
    expect(result.totalMembers).toBe(3);
    expect(result.totalGroupMembers).toBe(5);
    expect(result.membersWithoutData).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: 'auth0|ddd', username: 'Dave' }),
        expect.objectContaining({ user_id: 'auth0|eee', username: 'Eve' }),
      ])
    );
    expect(result.membersWithoutData).toHaveLength(2);
    expect(result.membersWithoutDataCount).toBe(2);
    expect(result.membersWithData).toBe(3);
  });

  // ===================================
  // Test 5: Returns exactly 98 slots (7 days x 14 hours: 10-23)
  // ===================================
  it('returns exactly 98 slots (7 days x 14 hours) for a full week', async () => {
    mockOverlaps([]);
    mockGroupMembers([userA], { 'auth0|aaa': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    expect(result.slots).toHaveLength(98);

    // Verify all hours are 10-23
    const hours = [...new Set(result.slots.map(s => s.hour))];
    expect(hours.sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

    // Verify all 7 days present
    const dates = [...new Set(result.slots.map(s => s.date))];
    expect(dates).toHaveLength(7);
  });

  // ===================================
  // Test 6: dayOfWeek values are 1-7 (Mon-Sun ISO format)
  // ===================================
  it('dayOfWeek values are 1-7 (Mon-Sun ISO format) matching the date', async () => {
    mockOverlaps([]);
    mockGroupMembers([userA], { 'auth0|aaa': true });

    // 2026-03-23 is a Monday
    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    // March 23, 2026 is Monday
    const mondaySlots = result.slots.filter(s => s.date === '2026-03-23');
    expect(mondaySlots.length).toBeGreaterThan(0);
    mondaySlots.forEach(s => expect(s.dayOfWeek).toBe(1)); // Monday = 1

    // March 29, 2026 is Sunday
    const sundaySlots = result.slots.filter(s => s.date === '2026-03-29');
    expect(sundaySlots.length).toBeGreaterThan(0);
    sundaySlots.forEach(s => expect(s.dayOfWeek).toBe(7)); // Sunday = 7
  });

  // ===================================
  // Test 7: weekStart must be a Monday -- errors if not
  // ===================================
  it('throws error when weekStart is not a Monday', async () => {
    mockOverlaps([]);
    mockGroupMembers([userA], { 'auth0|aaa': true });

    // 2026-03-25 is a Wednesday
    await expect(
      availabilityService.getGroupHeatmap('test-group-id', '2026-03-25', 'UTC')
    ).rejects.toThrow(/monday/i);
  });

  // ===================================
  // Test 8: Response shape -- weekStart, weekEnd, totalMembers, gcalConflicts fields
  // ===================================
  it('returns correct response shape with weekStart, weekEnd, totalMembers, gcalConflicts', async () => {
    mockOverlaps([]);
    mockGroupMembers([userA, userB], { 'auth0|aaa': true, 'auth0|bbb': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    expect(result.weekStart).toBe('2026-03-23');
    expect(result.weekEnd).toBe('2026-03-30');
    expect(result.totalMembers).toBe(2);
    expect(result.totalGroupMembers).toBe(2);
    expect(result.membersWithData).toBe(2);
    expect(result.membersWithoutData).toEqual([]);
    expect(result.membersWithoutDataCount).toBe(0);
    expect(Array.isArray(result.slots)).toBe(true);
    expect(Array.isArray(result.gcalConflicts)).toBe(true);
    expect(result.gcalConflicts).toEqual([]);
  });

  // ===================================
  // Test 9: Each slot has correct shape
  // ===================================
  it('each slot has date, dayOfWeek, hour, availableCount, totalMembers, availableMembers', async () => {
    const overlaps = [
      buildOverlapSlot('2026-03-23', '14:00', [userA], 2),
      buildOverlapSlot('2026-03-23', '14:30', [userA], 2),
    ];
    mockOverlaps(overlaps);
    mockGroupMembers([userA, userB], { 'auth0|aaa': true, 'auth0|bbb': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    const slot = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot).toMatchObject({
      date: '2026-03-23',
      dayOfWeek: 1,
      hour: 14,
      availableCount: 1,
      totalMembers: 2,
      availableMembers: [{ user_id: 'auth0|aaa', username: 'Alice' }],
    });
  });

  // ===================================
  // Test 10: Poll response overrides overlap data (poll says available)
  // ===================================
  it('poll response marks user as available even when overlap data says unavailable', async () => {
    // No overlap data for userA at 19:00-19:30 (gcal/recurring says busy)
    const overlaps = [];
    mockOverlaps(overlaps);
    mockGroupMembers([userA, userB], { 'auth0|aaa': true, 'auth0|bbb': true });

    // Mock an active prompt for this week
    AvailabilityPrompt.findAll.mockResolvedValue([{
      id: 'prompt-1',
      group_id: 'test-group-id',
      status: 'active',
      week_identifier: '2026-W13',
    }]);

    // User A responded with availability at 19:00-20:00 on Monday
    AvailabilityResponse.findAll.mockResolvedValue([{
      user_id: 'auth0|aaa',
      prompt_id: 'prompt-1',
      time_slots: [
        { start: '2026-03-23T19:00:00.000Z', end: '2026-03-23T19:30:00.000Z', preference: 'preferred' },
        { start: '2026-03-23T19:30:00.000Z', end: '2026-03-23T20:00:00.000Z', preference: 'preferred' },
      ],
      User: { user_id: 'auth0|aaa', username: 'Alice' },
    }]);

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    const slot19 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 19);
    expect(slot19).toBeDefined();
    expect(slot19.availableCount).toBe(1);
    expect(slot19.availableMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ user_id: 'auth0|aaa', username: 'Alice' })
      ])
    );
  });

  // ===================================
  // Test 11: Poll response removes user from available when poll says unavailable
  // ===================================
  it('poll response removes user from slot when poll has no data for that hour', async () => {
    // Overlap says userA is available at 14:00-14:30 (from recurring)
    const overlaps = [
      buildOverlapSlot('2026-03-23', '14:00', [userA], 2),
      buildOverlapSlot('2026-03-23', '14:30', [userA], 2),
    ];
    mockOverlaps(overlaps);
    mockGroupMembers([userA, userB], { 'auth0|aaa': true, 'auth0|bbb': true });

    // Mock active prompt
    AvailabilityPrompt.findAll.mockResolvedValue([{
      id: 'prompt-1',
      group_id: 'test-group-id',
      status: 'active',
      week_identifier: '2026-W13',
    }]);

    // User A responded but only for 19:00-20:00, not 14:00
    AvailabilityResponse.findAll.mockResolvedValue([{
      user_id: 'auth0|aaa',
      prompt_id: 'prompt-1',
      time_slots: [
        { start: '2026-03-23T19:00:00.000Z', end: '2026-03-23T19:30:00.000Z', preference: 'preferred' },
        { start: '2026-03-23T19:30:00.000Z', end: '2026-03-23T20:00:00.000Z', preference: 'preferred' },
      ],
      User: { user_id: 'auth0|aaa', username: 'Alice' },
    }]);

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    // At 14:00, userA should be removed because poll takes priority and poll says unavailable at that hour
    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot14).toBeDefined();
    expect(slot14.availableCount).toBe(0);
  });

  // ===================================
  // Test 12: gcalConflicts detected when poll says available but gcal says busy
  // ===================================
  it('detects gcal conflicts when poll says available but Google Calendar says busy', async () => {
    mockOverlaps([]);
    mockGroupMembers([
      { ...userA, google_calendar_enabled: true, google_calendar_token: 'token-a' },
      userB,
    ], { 'auth0|aaa': false, 'auth0|bbb': true });

    // Mock active prompt
    AvailabilityPrompt.findAll.mockResolvedValue([{
      id: 'prompt-1',
      group_id: 'test-group-id',
      status: 'active',
      week_identifier: '2026-W13',
    }]);

    // User A responded available at 19:00-20:00
    AvailabilityResponse.findAll.mockResolvedValue([{
      user_id: 'auth0|aaa',
      prompt_id: 'prompt-1',
      time_slots: [
        { start: '2026-03-23T19:00:00.000Z', end: '2026-03-23T19:30:00.000Z', preference: 'preferred' },
        { start: '2026-03-23T19:30:00.000Z', end: '2026-03-23T20:00:00.000Z', preference: 'preferred' },
      ],
      User: { user_id: 'auth0|aaa', username: 'Alice' },
    }]);

    // Gcal says busy at 19:00-19:30
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([
      { date: '2026-03-23', startTime: '19:00', endTime: '19:30' },
    ]);

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    // User A should still be available (poll takes priority)
    const slot19 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 19);
    expect(slot19.availableCount).toBe(1);

    // But a gcal conflict should be recorded
    expect(result.gcalConflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: 'auth0|aaa',
          username: 'Alice',
          date: '2026-03-23',
          hour: 19,
        })
      ])
    );
  });

  // ===================================
  // Test 13: Timezone shifting -- America/New_York shifts output hours to UTC
  // ===================================
  it('shifts output hours to UTC equivalents when timezone is provided', async () => {
    // Build overlap data covering UTC hours 14-03 (local 10-23 EDT, UTC-4)
    const overlapSlots = [];
    // Local 10am EDT = UTC 14:00. Provide overlap at UTC 14:00 and 14:30 with userA available.
    overlapSlots.push(buildOverlapSlot('2026-04-20', '14:00', [userA], 2));
    overlapSlots.push(buildOverlapSlot('2026-04-20', '14:30', [userA], 2));
    // Local 11pm EDT = UTC 03:00 next day. Provide overlap at UTC 03:00 and 03:30 on 2026-04-21.
    overlapSlots.push(buildOverlapSlot('2026-04-21', '03:00', [userA], 2));
    overlapSlots.push(buildOverlapSlot('2026-04-21', '03:30', [userA], 2));
    mockOverlaps(overlapSlots);
    mockGroupMembers([userA, userB], { 'auth0|aaa': true, 'auth0|bbb': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-04-20', 'America/New_York');

    // First local hour (10am EDT) should map to UTC 14
    const firstSlot = result.slots[0];
    expect(firstSlot.hour).toBe(14);
    expect(firstSlot.date).toBe('2026-04-20');
    expect(firstSlot.availableCount).toBe(1);

    // Last local hour (11pm EDT) should map to UTC 03 next day
    const lastLocalHourSlots = result.slots.filter(s => s.date === '2026-04-21' && s.hour === 3);
    expect(lastLocalHourSlots.length).toBeGreaterThan(0);
    expect(lastLocalHourSlots[0].availableCount).toBe(1);

    // Should still have 98 total slots (7 days x 14 hours)
    expect(result.slots).toHaveLength(98);
  });

  // ===================================
  // Test 14: Timezone fallback -- invalid timezone falls back to UTC 10-23
  // ===================================
  it('falls back to UTC hours 10-23 when timezone is invalid', async () => {
    mockOverlaps([]);
    mockGroupMembers([userA], { 'auth0|aaa': true });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'Invalid/Zone');
    warnSpy.mockRestore();

    // Should still produce 98 slots with UTC hours 10-23
    expect(result.slots).toHaveLength(98);
    const hours = [...new Set(result.slots.map(s => s.hour))];
    expect(hours.sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  });

  // ===================================
  // Test 15: Timezone fallback -- undefined timezone falls back to UTC 10-23
  // ===================================
  it('falls back to UTC hours 10-23 when timezone is undefined', async () => {
    mockOverlaps([]);
    mockGroupMembers([userA], { 'auth0|aaa': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23');

    expect(result.slots).toHaveLength(98);
    const hours = [...new Set(result.slots.map(s => s.hour))];
    expect(hours.sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  });

  // ===================================
  // Test 16: Data-less member exclusion from slot availableMembers
  // ===================================
  it('excludes data-less members from slot availableMembers and adjusts totalMembers', async () => {
    const userD = { user_id: 'auth0|ddd', username: 'Dave', email: 'dave@test.com' };
    // Overlap data has all 3 users available (data-less member inflated by calculateGroupOverlaps)
    const overlaps = [
      buildOverlapSlot('2026-03-23', '14:00', [userA, userB, userD], 3),
      buildOverlapSlot('2026-03-23', '14:30', [userA, userB, userD], 3),
    ];
    mockOverlaps(overlaps);
    // userA has recurring, userB has gcal, userD has nothing
    mockGroupMembers(
      [
        { ...userA, google_calendar_enabled: false },
        { ...userB, google_calendar_enabled: true, google_calendar_token: 'token-b' },
        { ...userD, google_calendar_enabled: false },
      ],
      { 'auth0|aaa': true, 'auth0|bbb': false, 'auth0|ddd': false }
    );

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    // totalMembers = 2 (only data-contributing), totalGroupMembers = 3
    expect(result.totalMembers).toBe(2);
    expect(result.totalGroupMembers).toBe(3);
    expect(result.membersWithoutDataCount).toBe(1);

    // Dave should NOT appear in any slot's availableMembers
    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot14).toBeDefined();
    expect(slot14.availableCount).toBe(2);
    expect(slot14.availableMembers.map(m => m.user_id)).not.toContain('auth0|ddd');
    expect(slot14.totalMembers).toBe(2);
  });

  // ===================================
  // Test 17: Empty heatmap (0 members with data)
  // ===================================
  it('returns 98 slots with 0 availability when all members have no data', async () => {
    mockOverlaps([]);
    // All members have no data sources
    mockGroupMembers(
      [
        { ...userA, google_calendar_enabled: false },
        { ...userB, google_calendar_enabled: false },
      ],
      { 'auth0|aaa': false, 'auth0|bbb': false }
    );

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-03-23', 'UTC');

    expect(result.totalMembers).toBe(0);
    expect(result.totalGroupMembers).toBe(2);
    expect(result.membersWithoutDataCount).toBe(2);
    expect(result.slots).toHaveLength(98);
    // Every slot should have 0 available
    result.slots.forEach(s => {
      expect(s.availableCount).toBe(0);
      expect(s.totalMembers).toBe(0);
    });
  });

  // ===================================
  // Test 18: Day boundary wrapping -- local late evening maps to next-day UTC
  // ===================================
  it('wraps to next-day UTC date when local evening hour crosses midnight UTC', async () => {
    // America/Los_Angeles is UTC-7 in April (PDT)
    // Local 23:00 PDT = UTC 06:00 next day
    const overlaps = [
      buildOverlapSlot('2026-04-21', '06:00', [userA], 2),
      buildOverlapSlot('2026-04-21', '06:30', [userA], 2),
    ];
    mockOverlaps(overlaps);
    mockGroupMembers([userA, userB], { 'auth0|aaa': true, 'auth0|bbb': true });

    const result = await availabilityService.getGroupHeatmap('test-group-id', '2026-04-20', 'America/Los_Angeles');

    // Find the slot emitted for local 23:00 PDT on Monday (2026-04-20 local)
    // This should have UTC date 2026-04-21 and UTC hour 6
    const wrappedSlot = result.slots.find(s => s.date === '2026-04-21' && s.hour === 6);
    expect(wrappedSlot).toBeDefined();
    expect(wrappedSlot.availableCount).toBe(1);
    expect(wrappedSlot.availableMembers[0].user_id).toBe('auth0|aaa');
  });

  // ===================================
  // Test 19: Overlap query window extends ±1 day to cover timezone shifts
  // Regression: Sun 17-23 PDT lands in next-Mon 00-06 UTC. The overlap query
  // must cover that range, otherwise late Sunday slots show 0 availability.
  // ===================================
  it('queries the overlap builder with window extended ±1 day for timezone coverage', async () => {
    // Phase 87.4 Plan 08: getGroupHeatmap calls the internal sub-keyed builder.
    const spy = jest.spyOn(availabilityService, 'buildGroupOverlaps').mockResolvedValue([]);
    mockGroupMembers([userA, userB], { 'auth0|aaa': true, 'auth0|bbb': true });

    await availabilityService.getGroupHeatmap('test-group-id', '2026-04-20', 'America/Los_Angeles');

    expect(spy).toHaveBeenCalled();
    const [, startArg, endArg] = spy.mock.calls[0];
    // weekStart is 2026-04-20 (Mon). overlap window should be [04-19, 04-28).
    expect(startArg.toISOString().startsWith('2026-04-19')).toBe(true);
    expect(endArg.toISOString().startsWith('2026-04-28')).toBe(true);
  });
});

// ============================================================================
// Phase 87.4 Plan 08 (SPEC Req 2, D-03, PR-2): boundary sub->UUID translation.
//
// The 19 tests above use mock members where `id` defaults to `user_id` (sub),
// so the boundary translation is an identity map and never exercises the actual
// sub->UUID flip. These tests give members a DISTINCT Users.id UUID (id !=
// user_id) and assert the RISKIEST part of the change is correct rather than
// merely grepped for:
//   - every emitted user_id is the Users.id UUID, never the Auth0 sub, never null
//   - a member available via BOTH the overlap path AND the poll path is counted
//     exactly ONCE in availableCount (dedup survives translation)
//   - the membersWithoutData exclusion still holds after translation
//   - gcal conflicts still attach for poll members after translation
//   - an off-roster identity (map-miss) is DROPPED, not emitted as sub or null
//   - the PUBLIC calculateGroupOverlaps wrapper (the GET /overlaps route path)
//     translates its finished payload
// These execute the REAL getGroupHeatmap boundary pass end-to-end.
// ============================================================================
describe('availabilityService boundary sub->UUID translation (Plan 08)', () => {
  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';
  const UUID_Z = '99999999-9999-4999-8999-999999999999';

  const SUB_RE = /\|/; // Auth0 subs are provider-prefixed (contain "|"); UUIDs never do.

  // Recursively assert no value anywhere in the payload is an Auth0 sub or a null user_id.
  function assertNoSubOrNullUserId(node) {
    if (Array.isArray(node)) {
      node.forEach(assertNoSubOrNullUserId);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'user_id') {
          expect(v).not.toBeNull();
          expect(typeof v === 'string' && SUB_RE.test(v)).toBe(false);
        }
        assertNoSubOrNullUserId(v);
      }
    }
  }

  // Build a sub-keyed overlap slot exactly as the internal buildGroupOverlaps emits.
  function subOverlapSlot(date, timeSlot, availableMembers, totalMembers) {
    return {
      date,
      timeSlot,
      endTime: timeSlot.endsWith(':00')
        ? timeSlot.replace(':00', ':30')
        : `${String(Number(timeSlot.slice(0, 2)) + 1).padStart(2, '0')}:00`,
      availableCount: availableMembers.length,
      totalMembers,
      availableMembers: availableMembers.map(m => ({ user_id: m.user_id, username: m.username })),
      unavailableCount: totalMembers - availableMembers.length,
    };
  }

  // Configure Group.findByPk + UserAvailability.findAll for a roster whose
  // members carry a DISTINCT Users.id UUID (id != sub).
  function mockRoster(members, hasAvailability = {}) {
    Group.findByPk.mockResolvedValue({ id: 'g-uuid', Users: members });
    UserAvailability.findAll.mockImplementation(async ({ where }) => {
      const uid = where.user_id;
      if (uid && typeof uid === 'object') {
        const symbols = Object.getOwnPropertySymbols(uid);
        const ids = symbols.length ? uid[symbols[0]] : (uid.in || []);
        return ids.filter(id => hasAvailability[id]).map(id => ({ id: 'rec', user_id: id, type: 'recurring_pattern' }));
      }
      if (hasAvailability[uid]) return [{ id: 'rec', user_id: uid, type: 'recurring_pattern' }];
      return [];
    });
  }

  function member(id, sub, username, extra = {}) {
    return {
      id, user_id: sub, username, email: `${username.toLowerCase()}@t.com`,
      google_calendar_enabled: false, google_calendar_token: null,
      google_calendar_refresh_token: null, timezone: 'UTC', ...extra,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // The first describe installs a persistent spy on buildGroupOverlaps — undo it
    // so each test controls the seam explicitly.
    jest.restoreAllMocks();
    AvailabilityPrompt.findAll.mockResolvedValue([]);
    AvailabilityResponse.findAll.mockResolvedValue([]);
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([]);
  });

  it('flips every emitted user_id to the Users.id UUID and counts a poll+overlap member exactly once', async () => {
    const memberA = member(UUID_A, 'auth0|aaa', 'Alice');
    const memberB = member(UUID_B, 'auth0|bbb', 'Bob');
    mockRoster([memberA, memberB], { 'auth0|aaa': true, 'auth0|bbb': true });

    // Overlap path: Alice available in BOTH 14:00 and 14:30 sub-slots.
    jest.spyOn(availabilityService, 'buildGroupOverlaps').mockResolvedValue([
      subOverlapSlot('2026-03-23', '14:00', [{ user_id: 'auth0|aaa', username: 'Alice' }], 2),
      subOverlapSlot('2026-03-23', '14:30', [{ user_id: 'auth0|aaa', username: 'Alice' }], 2),
    ]);

    // Poll path: Alice ALSO responded available across 14:00-15:00 (same hour).
    AvailabilityPrompt.findAll.mockResolvedValue([{ id: 'p1', group_id: 'g-uuid', status: 'active', week_identifier: '2026-W13' }]);
    AvailabilityResponse.findAll.mockResolvedValue([{
      user_id: 'auth0|aaa', prompt_id: 'p1',
      time_slots: [
        { start: '2026-03-23T14:00:00.000Z', end: '2026-03-23T14:30:00.000Z', preference: 'preferred' },
        { start: '2026-03-23T14:30:00.000Z', end: '2026-03-23T15:00:00.000Z', preference: 'preferred' },
      ],
      User: { user_id: 'auth0|aaa', username: 'Alice' },
    }]);

    const result = await availabilityService.getGroupHeatmap('g-uuid', '2026-03-23', 'UTC');

    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot14).toBeDefined();
    // Counted once despite being available via BOTH paths.
    expect(slot14.availableCount).toBe(1);
    expect(slot14.availableMembers).toEqual([{ user_id: UUID_A, username: 'Alice' }]);
    // No emitted user_id anywhere is a sub or null.
    assertNoSubOrNullUserId(result);
  });

  it('emits UUIDs in membersWithoutData and still excludes data-less members after translation', async () => {
    const memberA = member(UUID_A, 'auth0|aaa', 'Alice');       // has recurring
    const memberZ = member(UUID_Z, 'auth0|zzz', 'Zoe');         // no data at all
    mockRoster([memberA, memberZ], { 'auth0|aaa': true, 'auth0|zzz': false });

    // Overlap data inflates BOTH (calculateGroupOverlaps defaults data-less to available).
    jest.spyOn(availabilityService, 'buildGroupOverlaps').mockResolvedValue([
      subOverlapSlot('2026-03-23', '14:00', [{ user_id: 'auth0|aaa', username: 'Alice' }, { user_id: 'auth0|zzz', username: 'Zoe' }], 2),
      subOverlapSlot('2026-03-23', '14:30', [{ user_id: 'auth0|aaa', username: 'Alice' }, { user_id: 'auth0|zzz', username: 'Zoe' }], 2),
    ]);

    const result = await availabilityService.getGroupHeatmap('g-uuid', '2026-03-23', 'UTC');

    // Zoe emitted as a UUID in membersWithoutData.
    expect(result.membersWithoutData).toEqual([{ user_id: UUID_Z, username: 'Zoe' }]);
    expect(result.membersWithoutDataCount).toBe(1);
    expect(result.membersWithData).toBe(1);

    // Zoe excluded from slot availableMembers; Alice present as UUID.
    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    expect(slot14.availableCount).toBe(1);
    expect(slot14.availableMembers).toEqual([{ user_id: UUID_A, username: 'Alice' }]);
    assertNoSubOrNullUserId(result);
  });

  it('attaches gcal conflicts with UUIDs after translation', async () => {
    const memberA = member(UUID_A, 'auth0|aaa', 'Alice', { google_calendar_enabled: true, google_calendar_token: 'tok-a' });
    mockRoster([memberA], { 'auth0|aaa': false });

    jest.spyOn(availabilityService, 'buildGroupOverlaps').mockResolvedValue([]);
    AvailabilityPrompt.findAll.mockResolvedValue([{ id: 'p1', group_id: 'g-uuid', status: 'active', week_identifier: '2026-W13' }]);
    AvailabilityResponse.findAll.mockResolvedValue([{
      user_id: 'auth0|aaa', prompt_id: 'p1',
      time_slots: [
        { start: '2026-03-23T19:00:00.000Z', end: '2026-03-23T19:30:00.000Z', preference: 'preferred' },
        { start: '2026-03-23T19:30:00.000Z', end: '2026-03-23T20:00:00.000Z', preference: 'preferred' },
      ],
      User: { user_id: 'auth0|aaa', username: 'Alice' },
    }]);
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([{ date: '2026-03-23', startTime: '19:00', endTime: '19:30' }]);

    const result = await availabilityService.getGroupHeatmap('g-uuid', '2026-03-23', 'UTC');

    const slot19 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 19);
    expect(slot19.availableCount).toBe(1);
    expect(slot19.availableMembers).toEqual([{ user_id: UUID_A, username: 'Alice' }]);
    expect(result.gcalConflicts).toEqual([
      expect.objectContaining({ user_id: UUID_A, username: 'Alice', date: '2026-03-23', hour: 19 }),
    ]);
    assertNoSubOrNullUserId(result);
  });

  it('DROPS an off-roster (map-miss) identity instead of emitting a sub or null', async () => {
    const memberA = member(UUID_A, 'auth0|aaa', 'Alice');
    mockRoster([memberA], { 'auth0|aaa': true });

    jest.spyOn(availabilityService, 'buildGroupOverlaps').mockResolvedValue([]);
    AvailabilityPrompt.findAll.mockResolvedValue([{ id: 'p1', group_id: 'g-uuid', status: 'active', week_identifier: '2026-W13' }]);
    // Both Alice (on roster) and Ghost (responded, then left the group) responded available.
    AvailabilityResponse.findAll.mockResolvedValue([
      {
        user_id: 'auth0|aaa', prompt_id: 'p1',
        time_slots: [
          { start: '2026-03-23T14:00:00.000Z', end: '2026-03-23T14:30:00.000Z', preference: 'preferred' },
          { start: '2026-03-23T14:30:00.000Z', end: '2026-03-23T15:00:00.000Z', preference: 'preferred' },
        ],
        User: { user_id: 'auth0|aaa', username: 'Alice' },
      },
      {
        user_id: 'auth0|ghost', prompt_id: 'p1',
        time_slots: [
          { start: '2026-03-23T14:00:00.000Z', end: '2026-03-23T14:30:00.000Z', preference: 'preferred' },
          { start: '2026-03-23T14:30:00.000Z', end: '2026-03-23T15:00:00.000Z', preference: 'preferred' },
        ],
        User: { user_id: 'auth0|ghost', username: 'Ghost' },
      },
    ]);

    const result = await availabilityService.getGroupHeatmap('g-uuid', '2026-03-23', 'UTC');

    const slot14 = result.slots.find(s => s.date === '2026-03-23' && s.hour === 14);
    // Alice kept (UUID), Ghost dropped — count reflects the drop.
    expect(slot14.availableCount).toBe(1);
    expect(slot14.availableMembers).toEqual([{ user_id: UUID_A, username: 'Alice' }]);
    const emittedIds = result.slots.flatMap(s => s.availableMembers.map(m => m.user_id));
    expect(emittedIds).not.toContain('auth0|ghost');
    assertNoSubOrNullUserId(result);
  });

  it('public calculateGroupOverlaps wrapper translates its finished payload (GET /overlaps path)', async () => {
    const memberA = member(UUID_A, 'auth0|aaa', 'Alice');
    const memberB = member(UUID_B, 'auth0|bbb', 'Bob');
    Group.findByPk.mockResolvedValue({ id: 'g-uuid', Users: [memberA, memberB] });

    // The internal builder returns sub-keyed slots; the public wrapper must flip them.
    jest.spyOn(availabilityService, 'buildGroupOverlaps').mockResolvedValue([
      subOverlapSlot('2026-03-23', '14:00', [{ user_id: 'auth0|aaa', username: 'Alice' }], 2),
    ]);

    const start = new Date('2026-03-23T00:00:00Z');
    const end = new Date('2026-03-24T00:00:00Z');
    const overlaps = await availabilityService.calculateGroupOverlaps('g-uuid', start, end, 'UTC');

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].availableMembers).toEqual([{ user_id: UUID_A, username: 'Alice' }]);
    expect(overlaps[0].availableCount).toBe(1);
    assertNoSubOrNullUserId(overlaps);
  });
});

// ============================================================================
// HEAT-02 reproduction: specific_override survival in heatmap
//
// The existing 19 tests above all MOCK calculateGroupOverlaps with
// `mockOverlaps()`, which means they never exercise the real
// matchesSpecificOverride / calculateUserAvailability path. A specific override
// could fall off any boundary in that path and the existing suite would not
// notice.
//
// These tests do NOT mock calculateGroupOverlaps. They mock UserAvailability
// .findAll to return a single specific_override row (shaped exactly as the
// real POST /availability/user/:id/override route writes it) and then assert
// that the heatmap output contains the user as available for the slot the
// override covers, in the user's local timezone.
// ============================================================================
describe('availabilityService.getGroupHeatmap -- specific_override survival (HEAT-02)', () => {
  // userT = "user under test" -- always Tuesday, never UTC, never gcal
  const userT = { user_id: 'auth0|override-user', username: 'OverrideUser', email: 'ot@test.com' };
  const denverTz = 'America/Denver';
  const weekMonday = '2026-04-20';      // Monday
  const overrideTuesday = '2026-04-21'; // Tuesday in that week

  // Helper: configure mocks so the REAL aggregation path runs end-to-end.
  // - Group has exactly userT, no gcal
  // - UserAvailability.findAll returns [override] for userT, [] for anyone else
  // - No active prompts
  function setupOverrideOnlyUser({ overrides = [], extraMembers = [], extraAvailabilityByUser = {} } = {}) {
    const allMembers = [
      {
        ...userT,
        id: userT.user_id,
        google_calendar_enabled: false,
        google_calendar_token: null,
        google_calendar_refresh_token: null,
        timezone: denverTz,
      },
      ...extraMembers,
    ];

    Group.findByPk.mockResolvedValue({
      id: 'test-group-id',
      Users: allMembers,
    });

    UserAvailability.findAll.mockImplementation(async ({ where }) => {
      const uid = where.user_id;
      // Batched shape from getGroupHeatmap noData check (post-HEAT-03)
      if (uid && typeof uid === 'object') {
        const symbols = Object.getOwnPropertySymbols(uid);
        const ids = symbols.length ? uid[symbols[0]] : (uid.in || []);
        const out = [];
        for (const id of ids) {
          if (id === userT.user_id && overrides.length) out.push(...overrides);
          if (extraAvailabilityByUser[id]) out.push(...extraAvailabilityByUser[id]);
        }
        return out;
      }
      // Per-user shape from calculateUserAvailability
      if (uid === userT.user_id) return overrides;
      if (extraAvailabilityByUser[uid]) return extraAvailabilityByUser[uid];
      return [];
    });

    AvailabilityPrompt.findAll.mockResolvedValue([]);
    AvailabilityResponse.findAll.mockResolvedValue([]);
  }

  // Build an override row shaped exactly like routes/availability.js POST /override writes
  function buildOverrideRow(date, startTime, endTime, isAvailable = true) {
    return {
      id: 'override-' + date + '-' + startTime,
      user_id: userT.user_id,
      type: 'specific_override',
      pattern_data: { date, startTime, endTime, isAvailable },
      start_date: date,           // Sequelize DATEONLY -> string in queries
      end_date: date,
      is_available: isAvailable,
      timezone: 'UTC',            // hardcoded by current route
    };
  }

  // Build a recurring pattern row (used to flip defaultAvailability to false)
  function buildRecurringRow(dayOfWeek, startTime, endTime, startDate = '2026-01-01') {
    return {
      id: 'recurring-' + dayOfWeek + '-' + startTime,
      user_id: userT.user_id,
      type: 'recurring_pattern',
      pattern_data: { dayOfWeek, startTime, endTime, timezone: denverTz },
      start_date: startDate,
      end_date: null,
      is_available: null,
      timezone: denverTz,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    // Critical: prior describe block uses jest.spyOn(...calculateGroupOverlaps).mockResolvedValue([])
    // which persists across describes (clearAllMocks resets calls but keeps the spy installed).
    // Restore so we exercise the REAL aggregation path for these tests.
    jest.restoreAllMocks();
    AvailabilityPrompt.findAll.mockResolvedValue([]);
    AvailabilityResponse.findAll.mockResolvedValue([]);
  });

  // -------------------------------------------------------------------------
  // Variant 1 (headline test): override-only user, mid-day override.
  // Expectation: the heatmap slot for the user's local 14:00 on Tuesday
  // shows the user as available.
  //
  // Why this might pass even with the bug: when a user has NO recurring
  // patterns, calculateUserAvailability defaults every slot to available.
  // So the override could be silently mis-targeting a different UTC slot
  // and this test would still pass. If it does pass, variant 2 below
  // (recurring + override on a non-recurring day) is the real probe.
  // -------------------------------------------------------------------------
  it('override-only user: 14:00-16:00 Tuesday override shows user available at local 14:00', async () => {
    setupOverrideOnlyUser({
      overrides: [buildOverrideRow(overrideTuesday, '14:00', '16:00', true)],
    });

    const result = await availabilityService.getGroupHeatmap('test-group-id', weekMonday, denverTz);

    // Find the Tuesday 14:00 local slot. With TZ shift, local 14:00 MDT = UTC 20:00.
    // The slot is keyed by its UTC date+hour but represents the user's local 14:00.
    const tuesdaySlots = result.slots.filter(s => {
      // After localToUtc shift: local Tue 14:00 MDT (UTC-6) -> UTC 2026-04-21 20:00
      return s.date === overrideTuesday && s.hour === 20;
    });

    expect(tuesdaySlots.length).toBe(1);
    const slot = tuesdaySlots[0];
    expect(slot.availableMembers.map(m => m.user_id)).toContain(userT.user_id);
    expect(slot.availableCount).toBeGreaterThanOrEqual(1);
    expect(slot.totalMembers).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Variant 2 (the real probe): user has a recurring pattern that does NOT
  // cover Tuesday 14:00, plus an override that DOES cover Tuesday 14:00.
  //
  // With recurring patterns present, defaultAvailability flips to FALSE.
  // Now the override MUST positively mark the right slots -- there is no
  // default-available fallback. If matchesSpecificOverride compares the
  // override's local startTime against UTC slot.startTime, it will mark
  // UTC 14:00 (= local 08:00 MDT) instead of local 14:00, and the local
  // 14:00 slot will show the user as UNAVAILABLE.
  //
  // Expected (correct) behavior: user IS available at local 14:00 Tue.
  // -------------------------------------------------------------------------
  it('recurring + override: override on a non-recurring day still appears in heatmap', async () => {
    setupOverrideOnlyUser({
      overrides: [
        // Recurring: Mondays only, 18:00-20:00 local. dayOfWeek 1 = Monday.
        buildRecurringRow(1, '18:00', '20:00'),
        // Override: Tuesday 14:00-16:00 local (a day the recurring pattern does NOT cover).
        buildOverrideRow(overrideTuesday, '14:00', '16:00', true),
      ],
    });

    const result = await availabilityService.getGroupHeatmap('test-group-id', weekMonday, denverTz);

    // Tue local 14:00 MDT = UTC 20:00 on 2026-04-21
    const slot = result.slots.find(s => s.date === overrideTuesday && s.hour === 20);
    expect(slot).toBeDefined();
    expect(slot.availableMembers.map(m => m.user_id)).toContain(userT.user_id);
    expect(slot.availableCount).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Variant 3: cross-TZ correctness probe. The override is at user's local
  // 14:00 MDT (UTC 20:00). The slot at UTC 14:00 (= local 08:00 MDT) should
  // NOT show the user as available -- they specifically did not flag that hour.
  //
  // If the matcher compares override.pattern_data.startTime ("14:00") against
  // slot.startTime ("14:00" UTC), the wrong slot lights up. This test catches
  // that misalignment.
  // -------------------------------------------------------------------------
  it('recurring + override: heatmap does NOT show user available at the WRONG (UTC-equivalent) hour', async () => {
    setupOverrideOnlyUser({
      overrides: [
        // Recurring: Mondays only, 18:00-20:00 local
        buildRecurringRow(1, '18:00', '20:00'),
        // Override: Tuesday 14:00-16:00 local
        buildOverrideRow(overrideTuesday, '14:00', '16:00', true),
      ],
    });

    const result = await availabilityService.getGroupHeatmap('test-group-id', weekMonday, denverTz);

    // The local 08:00 hour is OUTSIDE the heatmap's 10-23 window, so won't appear at all.
    // Probe the local 10:00 instead -- override does NOT cover it, recurring does NOT cover it.
    // local Tue 10:00 MDT = UTC 16:00 on 2026-04-21.
    const tenAmSlot = result.slots.find(s => s.date === overrideTuesday && s.hour === 16);
    expect(tenAmSlot).toBeDefined();
    expect(tenAmSlot.availableMembers.map(m => m.user_id)).not.toContain(userT.user_id);
  });

  // -------------------------------------------------------------------------
  // Variant 4: late-day boundary probe. Override at local 22:00-23:00
  // (after the 60.1 14-hour window's upper edge in some TZs). Confirms the
  // fix doesn't regress at the same edge 60.1 introduced.
  // -------------------------------------------------------------------------
  it('override at local 22:00-23:00 Tuesday appears in heatmap (late-day edge)', async () => {
    setupOverrideOnlyUser({
      overrides: [
        buildRecurringRow(1, '18:00', '20:00'), // forces defaultAvailability=false
        buildOverrideRow(overrideTuesday, '22:00', '23:00', true),
      ],
    });

    const result = await availabilityService.getGroupHeatmap('test-group-id', weekMonday, denverTz);

    // Tue local 22:00 MDT = UTC 04:00 on 2026-04-22 (next day UTC)
    const slot = result.slots.find(s => s.date === '2026-04-22' && s.hour === 4);
    expect(slot).toBeDefined();
    expect(slot.availableMembers.map(m => m.user_id)).toContain(userT.user_id);
  });

  // -------------------------------------------------------------------------
  // Variant 5 (manual-test regression discovered after Task 2 commit):
  // User has ONLY specific overrides (no recurring patterns). The previous
  // logic in calculateUserAvailability checked `manualPatterns.some(p => p.type
  // === 'recurring_pattern')` to decide defaultAvailability. With overrides-
  // only, no recurring pattern was found -> defaultAvailability = true ->
  // EVERY slot started as available -> positive overrides became no-ops ->
  // heatmap rendered fully green even though the user only flagged 14:00-16:00
  // and 22:00-23:00.
  //
  // Correct semantic: any availability data (recurring OR override) means
  // "user has spoken; only what they declared is true". Default-to-available
  // is reserved for users with ZERO availability data ("we have no info").
  //
  // CONTEXT D-07 widening: this lives in calculateUserAvailability, the
  // shared aggregation code already touched by HEAT-02, so it's in scope.
  // -------------------------------------------------------------------------
  it('override-only user: slots OUTSIDE override window are NOT available', async () => {
    setupOverrideOnlyUser({
      overrides: [
        // Only two specific overrides, NO recurring patterns
        buildOverrideRow(overrideTuesday, '14:00', '16:00', true),
        buildOverrideRow(overrideTuesday, '22:00', '23:00', true),
      ],
    });

    const result = await availabilityService.getGroupHeatmap('test-group-id', weekMonday, denverTz);

    // Slot INSIDE first override window: Tue local 14:00 MDT = UTC 20:00 on 2026-04-21
    const insideFirstWindow = result.slots.find(s => s.date === overrideTuesday && s.hour === 20);
    expect(insideFirstWindow).toBeDefined();
    expect(insideFirstWindow.availableMembers.map(m => m.user_id)).toContain(userT.user_id);

    // Slot INSIDE second override window: Tue local 22:00 MDT = UTC 04:00 on 2026-04-22
    const insideSecondWindow = result.slots.find(s => s.date === '2026-04-22' && s.hour === 4);
    expect(insideSecondWindow).toBeDefined();
    expect(insideSecondWindow.availableMembers.map(m => m.user_id)).toContain(userT.user_id);

    // Slot OUTSIDE any override: Tue local 10:00 MDT = UTC 16:00 on 2026-04-21.
    // BUG: this currently shows the user available because defaultAvailability=true
    // when only specific_override patterns exist.
    const outsideOverride = result.slots.find(s => s.date === overrideTuesday && s.hour === 16);
    expect(outsideOverride).toBeDefined();
    expect(outsideOverride.availableMembers.map(m => m.user_id)).not.toContain(userT.user_id);

    // Wednesday (no override at all): Wed local 14:00 MDT = UTC 20:00 on 2026-04-22
    const wednesdayMidday = result.slots.find(s => s.date === '2026-04-22' && s.hour === 20);
    expect(wednesdayMidday).toBeDefined();
    expect(wednesdayMidday.availableMembers.map(m => m.user_id)).not.toContain(userT.user_id);
  });
});

// ============================================================================
// HEAT-02 expansion 3: dev-TZ bug in generateTimeSlots
//
// In production the backend runs on a UTC server, so setHours == setUTCHours
// and the slot keys are pure UTC. In dev (e.g. macOS PDT), setHours uses LOCAL
// time but the dateStr is derived from toISOString() (UTC). The result is a
// hybrid key: dateStr in UTC, timeStr in local. Downstream lookups (matcher
// + heatmap aggregator) all assume pure-UTC keys, so overrides silently miss.
//
// These tests assert the slot-key INVARIANT: each emitted slot must round-trip
// to a single UTC moment. The invariant is process-TZ-agnostic, so the test
// catches the bug whether jest runs under UTC or PDT.
// ============================================================================
describe('availabilityService.generateTimeSlots -- UTC-consistent slot keys (dev-TZ regression)', () => {
  // KEY INVARIANT: a slot's (date, startTime) key must describe the same UTC
  // moment as its `timestamp` field. The bug: setHours uses LOCAL time but
  // dateStr is derived from toISOString() (UTC), producing hybrid keys that
  // disagree with the slot's actual UTC moment. Downstream code (matcher,
  // heatmap aggregator) treats keys as pure UTC and silently misses slots.
  //
  // This test FAILS on a non-UTC server (the bug's manifestation) and is
  // a no-op on a UTC server (the production behavior).
  it('slot (date, startTime) key describes the same UTC moment as slot.timestamp', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-05-02T00:00:00Z');

    const slots = availabilityService.generateTimeSlots(start, end, 'UTC');

    expect(slots.length).toBe(48);

    for (const slot of slots) {
      const keyAsUtc = new Date(`${slot.date}T${slot.startTime}:00Z`).getTime();
      expect(keyAsUtc).toBe(slot.timestamp);
    }
  });

  // Sanity check: under any process TZ, the slots covering UTC May 1 must
  // include the UTC hours [00:00 .. 23:30] exactly once. Hybrid keys produce
  // keys like (2026-05-01, 17:00) for UTC midnight on PDT, which causes the
  // expected UTC keys to be MISSING from the output set.
  it('every UTC half-hour on the requested day appears as a slot key exactly once', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-05-02T00:00:00Z');
    const slots = availabilityService.generateTimeSlots(start, end, 'UTC');

    const keys = new Set(slots.map(s => `${s.date}_${s.startTime}`));
    expect(keys.size).toBe(slots.length); // no duplicates

    for (let h = 0; h < 24; h++) {
      for (const m of [0, 30]) {
        const key = `2026-05-01_${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        expect(keys.has(key)).toBe(true);
      }
    }
  });

  // Round-trip + monotonicity: timestamps step by 30min. A passive sanity
  // check that the loop math itself is sound. (Not the bug-catcher — the
  // first test is. This is a guardrail against future regressions.)
  it('emits slots in monotonically increasing 30-min steps across the range', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-05-03T00:00:00Z'); // 2 days = 96 slots
    const slots = availabilityService.generateTimeSlots(start, end, 'UTC');

    expect(slots.length).toBe(96);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].timestamp - slots[i - 1].timestamp).toBe(30 * 60 * 1000);
    }
  });
});

// ============================================================================
// HEAT-02 expansion 4: save-side TZ inconsistency in specific overrides.
//
// Diagnostic on a PDT dev box revealed override rows persisted with DIVERGENT
// date fields:
//   pattern_data.date = "2026-05-02"  (raw string from frontend)
//   start_date        = "2026-05-01"  (Sequelize DATEONLY of new Date(date)
//                                      = UTC midnight, truncated to local day)
//   end_date          = "2026-05-01"
// Two distinct bugs collide here:
//   1. routes/availability.js POST /override does `new Date(date)` and passes
//      the Date to Sequelize DATEONLY -- which truncates to LOCAL day on a
//      non-UTC server, dropping the date by one in negative offsets.
//   2. The frontend default `new Date().toISOString().split('T')[0]` evaluates
//      "now" in UTC, so a user clicking the form at local Mon 22:00 PDT sees
//      Tue prefilled and submits Tue.
//
// The matcher then runs `isDateInRange(slotDate, start_date, end_date)` and
// fails because the slot for the override's intended day (May 2) is OUTSIDE
// the persisted [May 1, May 1] window. Net effect: override silently lost.
//
// These tests cover both (a) the legacy/divergent-shape robustness and
// (b) the post-fix coherent-shape happy path.
// ============================================================================
describe('availabilityService.matchesSpecificOverride -- save-side TZ divergence (HEAT-02 expansion 4)', () => {
  const denverTz = 'America/Denver'; // UTC-6 MDT in late April / early May 2026

  // Build a slot the way generateTimeSlots emits them (UTC-keyed).
  function buildUtcSlot(utcDate, utcHour) {
    const ts = new Date(`${utcDate}T${String(utcHour).padStart(2, '0')}:00:00Z`).getTime();
    return {
      date: utcDate,
      startTime: `${String(utcHour).padStart(2, '0')}:00`,
      endTime: `${String(utcHour).padStart(2, '0')}:30`,
      timestamp: ts,
    };
  }

  // ---------------------------------------------------------------------------
  // The bug-catcher: persisted override has pattern_data.date AHEAD of
  // start_date/end_date by one day (the exact divergence diagnostic captured).
  // The matcher MUST treat pattern_data.date as the source of truth and ignore
  // (or be tolerant of) the inconsistent start_date/end_date window.
  // ---------------------------------------------------------------------------
  it('matches when pattern_data.date is AHEAD of start_date/end_date (legacy bad-data shape)', () => {
    // User intent: override on local 2026-05-02 14:00-16:00 MDT
    // (Diagnostic showed exactly this divergence on disk.)
    const override = {
      type: 'specific_override',
      pattern_data: {
        date: '2026-05-02',
        startTime: '14:00',
        endTime: '16:00',
        isAvailable: true,
      },
      start_date: '2026-05-01',  // Sequelize DATEONLY truncated by 1 day
      end_date: '2026-05-01',
      is_available: true,
      timezone: 'UTC',
    };

    // Slot at local 2026-05-02 14:00 MDT (UTC-6) = UTC 2026-05-02 20:00
    const slot = buildUtcSlot('2026-05-02', 20);

    const matched = availabilityService.matchesSpecificOverride(slot, override, denverTz);
    expect(matched).toBe(true);
  });

  // Sanity-check the converse: with bad-data shape, the WRONG day's slots must
  // not light up. The override's intent is May 2, NOT May 1. The persisted
  // start_date/end_date both point at May 1 -- if the matcher trusted that
  // window, it would mark a May 1 slot as available. It must not.
  it('does NOT match a slot on start_date/end_date when pattern_data.date points at a different day', () => {
    const override = {
      type: 'specific_override',
      pattern_data: {
        date: '2026-05-02',
        startTime: '14:00',
        endTime: '16:00',
        isAvailable: true,
      },
      start_date: '2026-05-01',
      end_date: '2026-05-01',
      is_available: true,
      timezone: 'UTC',
    };

    // Slot at local 2026-05-01 14:00 MDT = UTC 2026-05-01 20:00
    const wrongDaySlot = buildUtcSlot('2026-05-01', 20);

    const matched = availabilityService.matchesSpecificOverride(wrongDaySlot, override, denverTz);
    expect(matched).toBe(false);
  });

  // Happy path with the post-fix coherent shape. Same intent, but
  // pattern_data.date and start_date/end_date all agree.
  it('matches when all date fields are coherent (post-fix shape)', () => {
    const override = {
      type: 'specific_override',
      pattern_data: {
        date: '2026-05-02',
        startTime: '14:00',
        endTime: '16:00',
        isAvailable: true,
      },
      start_date: '2026-05-02',
      end_date: '2026-05-02',
      is_available: true,
      timezone: 'UTC',
    };

    const slot = buildUtcSlot('2026-05-02', 20);
    const matched = availabilityService.matchesSpecificOverride(slot, override, denverTz);
    expect(matched).toBe(true);
  });

  // Out-of-window time check still works under coherent shape.
  it('does NOT match when slot time is outside override time window (coherent shape)', () => {
    const override = {
      type: 'specific_override',
      pattern_data: {
        date: '2026-05-02',
        startTime: '14:00',
        endTime: '16:00',
        isAvailable: true,
      },
      start_date: '2026-05-02',
      end_date: '2026-05-02',
      is_available: true,
      timezone: 'UTC',
    };

    // Local 2026-05-02 18:00 MDT = UTC 2026-05-03 00:00 (next day UTC)
    const outOfTimeSlot = buildUtcSlot('2026-05-03', 0);
    const matched = availabilityService.matchesSpecificOverride(outOfTimeSlot, override, denverTz);
    expect(matched).toBe(false);
  });
});
