// tests/unit/findScheduleById.test.js
// Review 261025-rl3 R1 scoped check: the ONE firing-schedule matcher shared by
// decoratePromptForWire (schedule_name) and handlePromptClosed (recipient).

const { findScheduleById } = require('../../utils/findScheduleById');

const A = { id: '0b6c3f0e-5d1a-4c8e-9f3a-2e7d4b1a6c90', template_name: 'Tuesday' };
const B = { id: 'ABCDEF12-3456-4789-8ABC-DEF012345678', template_name: 'Friday' };
const schedules = [null, { id: 42 }, A, B];

describe('findScheduleById', () => {
  it('returns the schedule whose id matches', () => {
    expect(findScheduleById(schedules, A.id)).toBe(A);
  });

  it('matches case-insensitively: an uppercase poll id finds a lowercase stored id', () => {
    expect(findScheduleById(schedules, A.id.toUpperCase())).toBe(A);
  });

  it('matches case-insensitively: a lowercase poll id finds an uppercase stored id', () => {
    expect(findScheduleById(schedules, B.id.toLowerCase())).toBe(B);
  });

  it('returns null when no schedule matches', () => {
    expect(findScheduleById(schedules, '9f1e2d3c-4b5a-4697-8a8b-7c6d5e4f3a21')).toBeNull();
  });

  it('returns null for empty or invalid inputs without throwing', () => {
    expect(findScheduleById([], A.id)).toBeNull();
    expect(findScheduleById(undefined, A.id)).toBeNull();
    expect(findScheduleById(null, A.id)).toBeNull();
    expect(findScheduleById({ 0: A }, A.id)).toBeNull();
    expect(findScheduleById(schedules, null)).toBeNull();
    expect(findScheduleById(schedules, undefined)).toBeNull();
    expect(findScheduleById(schedules, '')).toBeNull();
    expect(findScheduleById(schedules, 42)).toBeNull();
  });
});
