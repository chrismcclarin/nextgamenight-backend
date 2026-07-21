// tests/routes/availability.membershipGate.test.js
// Phase 87.1 / Plan 08 (BINT-02): behavioral proof that the /overlaps and
// /heatmap membership gates in routes/availability.js still admit a member and
// still 403 a non-member AFTER the UserGroup re-key.
//
// The gate resolves the authenticated caller's Users.id, then keys UserGroup on
// user_uuid (Plan 03 re-key). A regression here (wrong keyspace / caller not
// resolved) would either 403 every real member (fail-closed lockout) or admit
// non-members — both invisible without a test that seeds a member (dual-write
// user_uuid via addToGroup) and hits the converted endpoints. googleCalendar is
// stubbed so members without a connected calendar do no network work.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

jest.mock('../../services/googleCalendarService', () => ({
  getBusyTimesForDateRange: jest.fn().mockResolvedValue([]),
  getBusyTimes: jest.fn().mockResolvedValue([]),
}));

const request = require('supertest');
const express = require('express');
const { stubAuth } = require('../helpers/authStub');
const availabilityRoutes = require('../../routes/availability');
const availabilityService = require('../../services/availabilityService');
const googleCalendarService = require('../../services/googleCalendarService');
const { AvailabilityPrompt, AvailabilityResponse } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

function makeApp(actor) {
  const app = express();
  app.use(express.json());
  app.use(stubAuth(actor ? { user_id: actor.user_id } : undefined));
  app.use('/api/availability', availabilityRoutes);
  return app;
}

describe('availability membership gates — post-rekey (87.1 BINT-02)', () => {
  let group, member, nonMember;

  beforeEach(async () => {
    group = await makeGroup();
    member = await makeUser();
    nonMember = await makeUser();
    // DUAL-WRITES user_uuid — the key the re-keyed gate now resolves against.
    await addToGroup(member, group, 'member');
  });

  describe('GET /api/availability/group/:group_id/overlaps', () => {
    it('admits an active member (200)', async () => {
      const res = await request(makeApp(member))
        .get(`/api/availability/group/${group.id}/overlaps`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('403s a non-member', async () => {
      const res = await request(makeApp(nonMember))
        .get(`/api/availability/group/${group.id}/overlaps`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/availability/group/:group_id/heatmap', () => {
    it('admits an active member (200)', async () => {
      const res = await request(makeApp(member))
        .get(`/api/availability/group/${group.id}/heatmap`);
      expect(res.status).toBe(200);
    });

    it('403s a non-member', async () => {
      const res = await request(makeApp(nonMember))
        .get(`/api/availability/group/${group.id}/heatmap`);
      expect(res.status).toBe(403);
    });
  });
});

// ============================================================================
// Phase 87.5 Plan 02 (BINT-02) — T-875-02-PARTIALFLIP behavioral proof.
//
// The availability tables are rekeyed to user_uuid (Users.id) and the
// getGroupHeatmap internal roster pipeline is flipped to key on that UUID end
// to end (gcal-busy lookup, poll-response overlay, no-data/recurring exclusion,
// gcalConflicts). A grep only proves the where-clauses and deleted symbols —
// it CANNOT prove the internal maps are all on the SAME keyspace. A partial /
// mixed-keyspace flip would silently misclassify members (poll overlay stops
// overriding, gcalConflicts goes empty) while every symbol grep still passes.
//
// This test seeds against the REAL DB: one poll responder (no gcal/recurring)
// and one gcal-enabled poll responder with a conflicting busy block, runs the
// heatmap, and asserts (a) the poll response still OVERRIDES the raw overlap
// result — the responder is available at the polled hour but removed at a
// non-polled hour the default-available overlap would otherwise include — and
// (b) gcalConflicts is non-empty for the gcal member. It also asserts every
// emitted user_id VALUE is the member's Users.id UUID (never the Auth0 sub),
// proving the flip is UUID-native, not just symbol-clean.
// ============================================================================
describe('getGroupHeatmap roster pipeline — UUID-native post-rekey (T-875-02-PARTIALFLIP)', () => {
  const WEEK_START = '2026-03-23';      // a Monday
  const ISO_WEEK = '2026-W13';          // the ISO week getGroupHeatmap derives for that Monday
  const POLL_DATE = '2026-03-23';
  // Poll slots covering hour 19 (both 30-min sub-slots) so the 1-hour heatmap
  // bucket for hour 19 is fully poll-covered.
  const pollSlots = [
    { start: `${POLL_DATE}T19:00:00.000Z`, end: `${POLL_DATE}T19:30:00.000Z`, preference: 'preferred' },
    { start: `${POLL_DATE}T19:30:00.000Z`, end: `${POLL_DATE}T20:00:00.000Z`, preference: 'preferred' },
  ];

  let group, pollMember, gcalMember, prompt;

  beforeEach(async () => {
    googleCalendarService.getBusyTimesForDateRange.mockReset();
    // Only the gcal-enabled member is queried; a conflicting busy block at 19:00.
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([
      { date: POLL_DATE, startTime: '19:00', endTime: '19:30' },
    ]);

    group = await makeGroup();
    // pollMember: NO gcal, NO recurring — data source is the poll response ONLY.
    pollMember = await makeUser({ google_calendar_enabled: false, google_calendar_token: null, timezone: 'UTC' });
    // gcalMember: gcal enabled with a busy block AND a poll response (gcalConflict
    // is only recorded for members who have BOTH a poll response and gcal busy).
    gcalMember = await makeUser({ google_calendar_enabled: true, google_calendar_token: 'tok-gcal', timezone: 'UTC' });
    await addToGroup(pollMember, group, 'member');
    await addToGroup(gcalMember, group, 'member');

    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: ISO_WEEK,
    });

    // Responses keyed on user_uuid (Users.id) — the rekeyed identity.
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_uuid: pollMember.id,
      time_slots: pollSlots,
      user_timezone: 'UTC',
      submitted_at: new Date(),
    });
    await AvailabilityResponse.create({
      prompt_id: prompt.id,
      user_uuid: gcalMember.id,
      time_slots: pollSlots,
      user_timezone: 'UTC',
      submitted_at: new Date(),
    });
  });

  it('poll overlay still overrides the overlap and gcalConflicts still fire, all UUID-keyed', async () => {
    const result = await availabilityService.getGroupHeatmap(group.id, WEEK_START, 'UTC');

    const slot19 = result.slots.find(s => s.date === POLL_DATE && s.hour === 19);
    expect(slot19).toBeDefined();

    // (a) Poll overlay OVERRIDES: pollMember has no gcal/recurring, so their ONLY
    // reason to be available at hour 19 is the poll response. They ARE present.
    const ids19 = slot19.availableMembers.map(m => m.user_id);
    expect(ids19).toContain(pollMember.id);

    // Poll overlay also SUBTRACTS: at hour 14 the raw overlap would default
    // pollMember to available (zero patterns => default-available), but the poll
    // has no 14:00 slot, so the overlay removes them. Proves the overlay is live,
    // not a no-op that leaves the raw overlap untouched.
    const slot14 = result.slots.find(s => s.date === POLL_DATE && s.hour === 14);
    expect(slot14).toBeDefined();
    expect(slot14.availableMembers.map(m => m.user_id)).not.toContain(pollMember.id);

    // (b) gcalConflicts fire for the gcal member (poll says available, gcal busy).
    expect(result.gcalConflicts.length).toBeGreaterThan(0);
    const conflict = result.gcalConflicts.find(c => c.user_id === gcalMember.id && c.hour === 19);
    expect(conflict).toBeDefined();

    // UUID-native proof: every emitted user_id VALUE is a Users.id UUID, never a
    // provider-prefixed Auth0 sub (subs contain "|"; UUIDs never do).
    const allEmittedUserIds = [
      ...result.slots.flatMap(s => s.availableMembers.map(m => m.user_id)),
      ...result.membersWithoutData.map(m => m.user_id),
      ...result.gcalConflicts.map(c => c.user_id),
    ];
    for (const uid of allEmittedUserIds) {
      expect(typeof uid).toBe('string');
      expect(uid).not.toContain('|');
    }
    // The polled hour carries the actual UUIDs (not the subs).
    expect(ids19).toContain(gcalMember.id);
    expect(ids19).not.toContain(pollMember.user_id);
  });
});
