// tests/services/promptLifecycleService.membership.test.js
// Quick task 261025-rl3, review finding BE-1: the close-notification recipient
// must still hold an ACTIVE membership in the poll's group.
//
// handlePromptClosed resolves the recipient from a stored creator id: the manual
// poll's created_by_user_id, or the settings row's created_by_user_id for an
// automatic poll. Leaving a group hard-deletes the UserGroup row
// (routes/groups.js POST /:group_id/leave, userGroup.destroy force: true) and
// nothing clears either creator column, so without a membership check a former
// member keeps receiving the group's poll results. A leaver must fall through to
// the group-owner fallback instead.
// Removal by an owner/admin (DELETE /:group_id/users/:target_user_id) hard-deletes
// the row the same way and must fall through identically (review R8, M4).
//
// REAL-DB suite (the tests/services/promptLifecycleService.idempotency.test.js
// pattern): real models, the member leaves through the REAL leave route, ONLY
// emailService.send is mocked (to read the recipient) and
// heatmapService.aggregateResponses is stubbed so the seeded suggestion survives.
// The sibling promptLifecycleService.test.js mocks every model, so it cannot
// prove a membership lookup against Postgres.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  return actual;
});

jest.mock('../../services/heatmapService', () => ({
  aggregateResponses: jest.fn().mockResolvedValue(undefined),
}));

// Avoid Redis/BullMQ when requiring the prompt-settings route (M5-M8 create
// schedules through the REAL POST schedules route).
jest.mock('../../schedulers/promptScheduler', () => ({
  upsertSinglePromptScheduler: jest.fn(),
  removePromptScheduler: jest.fn(),
}));

const request = require('supertest');
const express = require('express');

const lifecycleService = require('../../services/promptLifecycleService');
const emailService = require('../../services/emailService');
const groupRoutes = require('../../routes/groups');
const groupPromptSettingsRoutes = require('../../routes/groupPromptSettings');
const {
  AvailabilityPrompt,
  AvailabilityResponse,
  GroupPromptSettings,
  UserGroup,
} = require('../../models');
const { makeUser, makeGroup, addToGroup, makeAvailabilitySuggestion } = require('../factories');

// The leave route reads req.user.user_id (Auth0 sub); inject it per request.
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor.user_id, email: currentActor.email };
  next();
});
app.use('/api/groups', groupRoutes);

// Separate app for the prompt-settings router so its /:group_id/... paths never
// interleave with the groups router above.
const settingsApp = express();
settingsApp.use(express.json());
settingsApp.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor.user_id, email: currentActor.email };
  next();
});
settingsApp.use('/api/groups', groupPromptSettingsRoutes);

// Review 261025-rl3 R1: a schedule created through the REAL POST schedules route,
// as `actor`. Returns the created schedule's id.
async function createSchedule(actor, group, day) {
  currentActor = actor;
  const res = await request(settingsApp)
    .post(`/api/groups/${group.id}/prompt-settings/schedules`)
    .send({ schedule_day_of_week: day, schedule_time: '19:00', schedule_timezone: 'UTC' });
  currentActor = null;
  expect(res.status).toBe(201);
  return res.body.schedule.id;
}

async function leaveGroup(user, group) {
  currentActor = user;
  const res = await request(app).post(`/api/groups/${group.id}/leave`);
  currentActor = null;
  expect(res.status).toBe(200);
  expect(await UserGroup.count({ where: { group_id: group.id, user_uuid: user.id } })).toBe(0);
}

// Review 261025-rl3 R8: the admin-removal path. The owner removes a member
// through the REAL DELETE /api/groups/:group_id/users/:target_user_id route
// (routes/groups.js), which hard-deletes the UserGroup row the same way leave
// does. The route resolves the target by Users.id UUID only (87.3 PR-C).
async function removeMember(actor, target, group) {
  currentActor = actor;
  const res = await request(app).delete(`/api/groups/${group.id}/users/${target.id}`);
  currentActor = null;
  expect(res.status).toBe(200);
  expect(await UserGroup.count({ where: { group_id: group.id, user_uuid: target.id } })).toBe(0);
}

// A group with an owner and a second member; the poll gets one submitted
// response and one suggestion so handlePromptClosed reaches the send.
async function seedGroup(tag) {
  const owner = await makeUser({ email: `owner-${tag}@example.com`, email_notifications_enabled: true });
  const member = await makeUser({ email: `member-${tag}@example.com`, email_notifications_enabled: true });
  const group = await makeGroup();
  await addToGroup(owner, group, 'owner');
  await addToGroup(member, group, 'member');
  return { owner, member, group };
}

async function makeClosedPrompt(group, respondent, creatorFields) {
  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 60 * 60 * 1000),
    status: 'closed',
    week_identifier: '2026-W43-legacy',
    ...creatorFields,
  });
  await AvailabilityResponse.create({
    prompt_id: prompt.id,
    user_uuid: respondent.id,
    time_slots: [],
    user_timezone: 'UTC',
    submitted_at: new Date(),
  });
  await makeAvailabilitySuggestion(prompt, respondent);
  return prompt;
}

async function makeSettings(group, creator) {
  return GroupPromptSettings.create({
    group_id: group.id,
    schedule_timezone: 'UTC',
    template_config: { schedules: [] },
    created_by_user_id: creator.id,
  });
}

function sentTo() {
  return emailService.send.mock.calls.map((call) => call[0].to);
}

describe('handlePromptClosed recipient must be an active member (261025-rl3 BE-1, real DB)', () => {
  beforeEach(() => {
    emailService.send.mockClear();
  });

  it('M1: automatic poll whose schedule creator LEFT the group mails the group owner, not the leaver', async () => {
    const { owner, member, group } = await seedGroup('m1');
    const settings = await makeSettings(group, member);
    await leaveGroup(member, group);
    const prompt = await makeClosedPrompt(group, owner, { created_by_settings_id: settings.id });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['owner-m1@example.com']);
  });

  it('M2: manual poll whose creator LEFT the group mails the group owner, not the leaver', async () => {
    const { owner, member, group } = await seedGroup('m2');
    await leaveGroup(member, group);
    const prompt = await makeClosedPrompt(group, owner, { created_by_user_id: member.id });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['owner-m2@example.com']);
  });

  it('M3: automatic poll whose schedule creator is still an active member mails the schedule creator', async () => {
    const { owner, member, group } = await seedGroup('m3');
    const settings = await makeSettings(group, member);
    const prompt = await makeClosedPrompt(group, owner, { created_by_settings_id: settings.id });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['member-m3@example.com']);
  });

  it('M4: automatic poll whose schedule creator was REMOVED by the owner mails the group owner, not the removed member', async () => {
    const { owner, member, group } = await seedGroup('m4');
    const settings = await makeSettings(group, member);
    await removeMember(owner, member, group);
    const prompt = await makeClosedPrompt(group, owner, { created_by_settings_id: settings.id });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['owner-m4@example.com']);
  });

  // Review 261025-rl3 R1 (owner ruling 2026-10-26: "the schedule setter should get
  // the emails for the schedule they set"). An automatic poll mails the creator of
  // the schedule that FIRED it, not whoever first set up scheduling for the group.

  it('M5: automatic poll fired by an admin-created schedule mails that admin, not the first setter (owner)', async () => {
    const { owner, member, group } = await seedGroup('m5');
    const admin = await makeUser({ email: 'admin-m5@example.com', email_notifications_enabled: true });
    await addToGroup(admin, group, 'admin');
    await createSchedule(owner, group, 1); // S1: creates the settings row, first setter = owner
    const s2 = await createSchedule(admin, group, 2); // S2: set by the admin
    const settings = await GroupPromptSettings.findOne({ where: { group_id: group.id } });
    expect(settings.created_by_user_id).toBe(owner.id);
    const prompt = await makeClosedPrompt(group, member, {
      created_by_settings_id: settings.id,
      schedule_id: s2,
    });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['admin-m5@example.com']);
  });

  it('M6: a legacy schedule with no stored creator falls back to the settings-row creator (confirm-only)', async () => {
    const { owner, member, group } = await seedGroup('m6');
    const legacyId = '0b6c3f0e-5d1a-4c8e-9f3a-2e7d4b1a6c90';
    const settings = await GroupPromptSettings.create({
      group_id: group.id,
      schedule_timezone: 'UTC',
      template_config: {
        schedules: [{ id: legacyId, schedule_day_of_week: 3, schedule_time: '19:00', schedule_timezone: 'UTC', is_active: true }],
      },
      created_by_user_id: member.id,
    });
    const prompt = await makeClosedPrompt(group, owner, {
      created_by_settings_id: settings.id,
      schedule_id: legacyId,
    });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['member-m6@example.com']);
  });

  it('M7: a schedule_id matching no schedule (deleted from the array) falls back to the settings-row creator (confirm-only)', async () => {
    const { owner, group } = await seedGroup('m7');
    const admin = await makeUser({ email: 'admin-m7@example.com', email_notifications_enabled: true });
    await addToGroup(admin, group, 'admin');
    await createSchedule(admin, group, 1); // settings row first setter = admin
    const settings = await GroupPromptSettings.findOne({ where: { group_id: group.id } });
    const prompt = await makeClosedPrompt(group, owner, {
      created_by_settings_id: settings.id,
      schedule_id: '9f1e2d3c-4b5a-4697-8a8b-7c6d5e4f3a21', // in no schedule
    });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['admin-m7@example.com']);
  });

  it('M8: the firing schedule\'s creator who LEFT the group falls back to the owner, not the settings-row creator', async () => {
    const { owner, member, group } = await seedGroup('m8');
    const admin = await makeUser({ email: 'admin-m8@example.com', email_notifications_enabled: true });
    await addToGroup(admin, group, 'admin');
    await createSchedule(admin, group, 1); // first setter = admin
    // The member is promoted to admin, sets S3, then leaves the group.
    await UserGroup.update({ role: 'admin' }, { where: { group_id: group.id, user_uuid: member.id } });
    const s3 = await createSchedule(member, group, 3);
    await leaveGroup(member, group);
    const settings = await GroupPromptSettings.findOne({ where: { group_id: group.id } });
    const prompt = await makeClosedPrompt(group, owner, {
      created_by_settings_id: settings.id,
      schedule_id: s3,
    });

    await lifecycleService.handlePromptClosed(prompt);

    expect(sentTo()).toEqual(['owner-m8@example.com']);
  });
});
