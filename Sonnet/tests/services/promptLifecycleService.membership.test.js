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

const request = require('supertest');
const express = require('express');

const lifecycleService = require('../../services/promptLifecycleService');
const emailService = require('../../services/emailService');
const groupRoutes = require('../../routes/groups');
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

async function leaveGroup(user, group) {
  currentActor = user;
  const res = await request(app).post(`/api/groups/${group.id}/leave`);
  currentActor = null;
  expect(res.status).toBe(200);
  expect(await UserGroup.count({ where: { group_id: group.id, user_uuid: user.id } })).toBe(0);
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
});
