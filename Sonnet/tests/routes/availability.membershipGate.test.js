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
