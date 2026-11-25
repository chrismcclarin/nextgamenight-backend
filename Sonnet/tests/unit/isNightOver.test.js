// tests/unit/isNightOver.test.js
// Phase 89.6-28 (X42 backend twin, plan review R1 D3): isNightOver is the exact negation of the
// frontend's isNightNotOver (periodictabletop src/lib/upcomingEvents.ts), so the invite preview and
// join-by-token accept a scan exactly while the frontend shows Share Game QR. nowMs is passed
// explicitly in every case; no clock is read.
const { isNightOver, DEFAULT_RUN_WINDOW_MINUTES } = require('../../utils/isNightOver');

const MIN = 60 * 1000;
const START = Date.UTC(2026, 10, 25, 19, 0, 0);
const night = (overrides = {}) => ({ start_date: new Date(START).toISOString(), duration_minutes: 180, status: 'scheduled', ...overrides });

describe('isNightOver (Phase 89.6-28, X42 backend twin)', () => {
  test('the default run window is eight hours, the frontend D47 default', () => {
    expect(DEFAULT_RUN_WINDOW_MINUTES).toBe(480);
  });

  test('one hour before the start the night is not over (never copy isStillRunning, which would 410 every upcoming night)', () => {
    expect(isNightOver(night(), START - 60 * MIN)).toBe(false);
  });

  test('a cancelled night one hour before its start is not over (status counts only after the start)', () => {
    expect(isNightOver(night({ status: 'cancelled' }), START - 60 * MIN)).toBe(false);
  });

  test('at the start instant the night is not over', () => {
    expect(isNightOver(night(), START)).toBe(false);
  });

  test('duration 180: running at +1h and at +179min, over at +180min', () => {
    expect(isNightOver(night(), START + 60 * MIN)).toBe(false);
    expect(isNightOver(night(), START + 179 * MIN)).toBe(false);
    expect(isNightOver(night(), START + 180 * MIN)).toBe(true);
  });

  test('no stored length: running at +7h59m, over at +8h', () => {
    expect(isNightOver(night({ duration_minutes: null }), START + (8 * 60 - 1) * MIN)).toBe(false);
    expect(isNightOver(night({ duration_minutes: null }), START + 8 * 60 * MIN)).toBe(true);
  });

  test.each([0, -5, '90'])('a stored length of %p takes the default: running at +1min, over at +8h', (duration) => {
    expect(isNightOver(night({ duration_minutes: duration }), START + MIN)).toBe(false);
    expect(isNightOver(night({ duration_minutes: duration }), START + 8 * 60 * MIN)).toBe(true);
  });

  test('a cancelled night that has started is over', () => {
    expect(isNightOver(night({ status: 'cancelled' }), START + MIN)).toBe(true);
  });

  test('a completed night that has started is over', () => {
    expect(isNightOver(night({ status: 'completed' }), START + MIN)).toBe(true);
  });

  test('a missing status reads as scheduled: running at +1min', () => {
    expect(isNightOver(night({ status: null }), START + MIN)).toBe(false);
  });

  test('an unparseable start is not over (the frontend reads it as not started)', () => {
    expect(isNightOver(night({ start_date: 'garbage' }), START + 9 * 60 * MIN)).toBe(false);
  });
});
