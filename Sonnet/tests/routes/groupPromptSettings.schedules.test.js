// tests/routes/groupPromptSettings.schedules.test.js
// Phase 87.4 Plan 11 (PR-2): REAL-DB proof that BOTH schedule write handlers (the POST
// create handler AND the PATCH update handler) normalize any incoming sub-shaped
// selected_member_ids entry to its Users.id UUID against the GROUP's own roster BEFORE
// persisting — the stale-tab self-heal that closes the window in which a FE tab loaded
// before the PR-2 deploy could re-write sub residue AFTER the re-sweep migration ran.
//
// This is what makes Plan 12's "no sub-shaped entries remain post-deploy" gate true BY
// CONSTRUCTION on both persistence paths, not just at the point-in-time re-sweep: the
// fanout's UUID shape filter would otherwise silently and permanently exclude any
// sub-shaped member re-introduced through either route. Both routes run through ONE
// shared normalizeSelectedMemberIds helper (they cannot drift), resolved before the FOR
// UPDATE lock is taken (no member lookup held under the lock).

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Avoid Redis/BullMQ when requiring the settings route.
jest.mock('../../schedulers/promptScheduler', () => ({
  upsertSinglePromptScheduler: jest.fn(),
  removePromptScheduler: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const groupPromptSettingsRouter = require('../../routes/groupPromptSettings');
const { GroupPromptSettings } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');
const { isUuid } = require('../../utils/resolveTargetUser');

let currentActor = null;
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/groups',
    (req, _res, next) => {
      if (currentActor) req.user = { user_id: currentActor };
      next();
    },
    groupPromptSettingsRouter
  );
  return app;
}

async function storedSchedules(group) {
  const settings = await GroupPromptSettings.findOne({ where: { group_id: group.id } });
  return settings?.template_config?.schedules || [];
}

describe('groupPromptSettings write-path normalization — sub → UUID self-heal (87.4 PR-2)', () => {
  let owner;
  let m1;
  let m2;
  let group;

  beforeEach(async () => {
    jest.clearAllMocks();
    owner = await makeUser({ username: 'sched-owner' });
    m1 = await makeUser({ username: 'sched-member-1' });
    m2 = await makeUser({ username: 'sched-member-2' });
    group = await makeGroup({ name: 'Prompt Settings Schedules Group' });
    await addToGroup(owner, group, 'owner');
    await addToGroup(m1, group, 'member');
    await addToGroup(m2, group, 'member');
    currentActor = owner.user_id;
  });

  afterEach(() => {
    currentActor = null;
  });

  it('POST create: a sub-shaped selected_member_ids entry (stale tab) persists as the Users.id UUID', async () => {
    const res = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 2,
        schedule_time: '19:00',
        schedule_timezone: 'UTC',
        selected_member_ids: [m1.user_id], // stale sub the FE still holds in memory
      });

    expect(res.status).toBe(201);
    // The echo is already normalized — no sub on the wire.
    expect(res.body.schedule.selected_member_ids).toEqual([m1.id]);

    // Persisted value is the UUID, NOT the sub (self-heal by construction).
    const schedules = await storedSchedules(group);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].selected_member_ids).toEqual([m1.id]);
    expect(schedules[0].selected_member_ids.every(isUuid)).toBe(true);
  });

  it('PATCH update: a sub-shaped selected_member_ids entry on an existing schedule persists as the UUID', async () => {
    // Seed an existing schedule (already UUID-keyed).
    const created = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 3,
        schedule_time: '20:00',
        schedule_timezone: 'UTC',
        selected_member_ids: [m1.id],
      });
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.id;

    // A stale tab PATCHes a sub-shaped entry for m2.
    const patched = await request(makeApp())
      .patch(`/api/groups/${group.id}/prompt-settings/schedules/${scheduleId}`)
      .send({ selected_member_ids: [m2.user_id] });

    expect(patched.status).toBe(200);
    expect(patched.body.schedule.selected_member_ids).toEqual([m2.id]);

    const schedules = await storedSchedules(group);
    const sched = schedules.find((s) => s.id === scheduleId);
    expect(sched.selected_member_ids).toEqual([m2.id]);
    expect(sched.selected_member_ids.every(isUuid)).toBe(true);
  });

  it('POST create: an unresolvable sub entry (no matching group member) is DROPPED (not persisted, not errored)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 4,
        schedule_time: '18:00',
        schedule_timezone: 'UTC',
        selected_member_ids: ['auth0|not-in-this-group', m1.id], // one orphan sub + one valid UUID
      });

    expect(res.status).toBe(201);
    // The orphan sub is dropped; the valid UUID is kept.
    expect(res.body.schedule.selected_member_ids).toEqual([m1.id]);

    const schedules = await storedSchedules(group);
    expect(schedules[0].selected_member_ids).toEqual([m1.id]);

    // The drop was logged — COUNTS ONLY (PR2-L2, owner decision 2026-07-18): never
    // the raw sub, and never the persisted UUID selection list.
    expect(warnSpy).toHaveBeenCalled();
    const logged = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/dropped=1/);
    expect(logged).not.toMatch(/auth0\|not-in-this-group/); // raw sub NEVER logged
    expect(logged).not.toContain(m1.id); // persisted UUID list NEVER logged (PR2-L2)
    warnSpy.mockRestore();
  });

  it('POST create: an already-UUID selected_member_ids is persisted unchanged (normalization no-op)', async () => {
    const res = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 5,
        schedule_time: '21:00',
        schedule_timezone: 'UTC',
        selected_member_ids: [m1.id, m2.id],
      });

    expect(res.status).toBe(201);
    expect(res.body.schedule.selected_member_ids).toEqual([m1.id, m2.id]);

    const schedules = await storedSchedules(group);
    expect(schedules[0].selected_member_ids).toEqual([m1.id, m2.id]);
  });

  // PR2-M2 (87.4-review): a present-but-non-array selected_member_ids (null/string/
  // object) must 400 on BOTH write handlers — never bypass normalization and persist
  // verbatim into the JSONB (echoed raw on GET; read as whole-group by the fanout).
  it('POST create: a present-but-non-array selected_member_ids is rejected with 400 (PR2-M2)', async () => {
    for (const bad of ['auth0|not-an-array', { 0: 'sneaky' }, null]) {
      const res = await request(makeApp())
        .post(`/api/groups/${group.id}/prompt-settings/schedules`)
        .send({
          schedule_day_of_week: 1,
          schedule_time: '17:00',
          schedule_timezone: 'UTC',
          selected_member_ids: bad,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must be an array/);
    }
    expect(await storedSchedules(group)).toHaveLength(0); // nothing persisted
  });

  it('PATCH update: a present-but-non-array selected_member_ids is rejected with 400, prior value preserved (PR2-M2)', async () => {
    const created = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 2,
        schedule_time: '18:00',
        schedule_timezone: 'UTC',
        selected_member_ids: [m1.id],
      });
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.id;

    const res = await request(makeApp())
      .patch(`/api/groups/${group.id}/prompt-settings/schedules/${scheduleId}`)
      .send({ selected_member_ids: 'auth0|stale-string' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an array/);

    const schedules = await storedSchedules(group);
    expect(schedules.find((s) => s.id === scheduleId).selected_member_ids).toEqual([m1.id]);
  });

  // PR2-M3 (87.4-review): a NON-EMPTY selection whose entries ALL drop must never
  // persist as [] — empty means "whole group" to the fanout, silently WIDENING an
  // explicit subset (the read-path fanout guards exactly this shape).
  it('POST create: a non-empty selection whose entries ALL drop is rejected with 400 (PR2-M3)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 3,
        schedule_time: '19:30',
        schedule_timezone: 'UTC',
        selected_member_ids: ['auth0|departed-member-1', 'auth0|departed-member-2'],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer in this group/);
    expect(await storedSchedules(group)).toHaveLength(0); // never persisted as []
    warnSpy.mockRestore();
  });

  it('PATCH update: an all-dropped selection is rejected with 400 and the prior selection is preserved (PR2-M3)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const created = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 4,
        schedule_time: '20:30',
        schedule_timezone: 'UTC',
        selected_member_ids: [m1.id],
      });
    expect(created.status).toBe(201);
    const scheduleId = created.body.schedule.id;

    const res = await request(makeApp())
      .patch(`/api/groups/${group.id}/prompt-settings/schedules/${scheduleId}`)
      .send({ selected_member_ids: ['auth0|every-selected-member-departed'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer in this group/);

    // The explicit subset was preserved — never widened to whole-group.
    const schedules = await storedSchedules(group);
    expect(schedules.find((s) => s.id === scheduleId).selected_member_ids).toEqual([m1.id]);
    warnSpy.mockRestore();
  });

  // PR2-L1 (87.4-review): default-deny is now uniform across BOTH keyspaces — a
  // UUID-shaped entry NOT in the group's active roster is dropped exactly like an
  // unresolvable sub (previously any well-formed UUID persisted unchecked).
  it('POST create: a UUID-shaped entry NOT in the group roster is dropped like an unresolvable sub (PR2-L1)', async () => {
    const outsider = await makeUser({ username: 'sched-outsider' }); // real user, NOT in the group
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(makeApp())
      .post(`/api/groups/${group.id}/prompt-settings/schedules`)
      .send({
        schedule_day_of_week: 5,
        schedule_time: '21:30',
        schedule_timezone: 'UTC',
        selected_member_ids: [outsider.id, m1.id], // one non-roster UUID + one member
      });

    expect(res.status).toBe(201);
    expect(res.body.schedule.selected_member_ids).toEqual([m1.id]);

    const schedules = await storedSchedules(group);
    expect(schedules[0].selected_member_ids).toEqual([m1.id]);

    // COUNTS ONLY in the log (PR2-L2): no raw sub, no UUID selection list.
    const logged = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/dropped=1/);
    expect(logged).not.toContain(outsider.id);
    expect(logged).not.toContain(m1.id);
    warnSpy.mockRestore();
  });
});
