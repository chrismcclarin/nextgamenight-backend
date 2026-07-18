// tests/routes/groupPromptSettings.members.test.js
// Phase 87.1 / Plan 07 (A1 loop closure, T-87.1-13 corrected): REAL-DB proof that
// the GET prompt-settings members payload emits the Auth0-sub user_id from the
// User include — and that FE-saved selected_member_ids sourced from that payload
// still reaches the invitation fanout (the FE → settings → fanout invariant the
// A1 fix depends on).
//
// Why this matters: the FE MemberSelector stores members[].user_id back into
// selected_member_ids, which promptInvitationService filters on the Auth0-string
// keyspace. If the serializer read ug.user_id off the UserGroup instance, Plan 09
// would strip that column → members[].user_id serializes undefined → the FE falls
// back to member.id (the User UUID) → selected_member_ids gets re-poisoned with
// UUIDs → the fanout matches NOBODY (silent under-notification, T-87.1-18). This
// suite pins the seam on the real DB with the real serializer + real fanout — a
// mock could not catch the silent-nobody regression.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Avoid Redis/BullMQ when requiring the settings route.
jest.mock('../../schedulers/promptScheduler', () => ({
  upsertSinglePromptScheduler: jest.fn(),
  removePromptScheduler: jest.fn(),
}));

// Fanout side — count sends without reaching Resend / minting a MagicToken.
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  actual.isConfigured = jest.fn().mockReturnValue(true);
  return actual;
});
jest.mock('../../services/magicTokenService', () => ({
  generateToken: jest.fn().mockResolvedValue('fake-magic-token'),
}));

const express = require('express');
const request = require('supertest');
const groupPromptSettingsRouter = require('../../routes/groupPromptSettings');
const promptInvitationService = require('../../services/promptInvitationService');
const emailService = require('../../services/emailService');
const { AvailabilityPrompt, GroupPromptSettings, sequelize } = require('../../models');
const backfillMigration = require('../../migrations/20260716000002-backfill-selected-member-ids-uuid');
const { makeUser, makeGroup, addToGroup } = require('../factories');

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

describe('GET /api/groups/:group_id/prompt-settings — members Auth0-sub wire field + A1 loop (87.1)', () => {
  let owner;
  let m1;
  let m2;
  let group;

  beforeEach(async () => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
    emailService.isConfigured.mockReturnValue(true);

    owner = await makeUser({ username: 'settings-owner', email_notifications_enabled: true });
    m1 = await makeUser({ username: 'settings-member-1', email_notifications_enabled: true });
    m2 = await makeUser({ username: 'settings-member-2', email_notifications_enabled: true });
    group = await makeGroup({ name: 'Prompt Settings Members Group' });
    // addToGroup DUAL-WRITES user_uuid so both the isActiveMember gate AND the
    // UserGroup → User include join resolve.
    await addToGroup(owner, group, 'owner');
    await addToGroup(m1, group, 'member');
    await addToGroup(m2, group, 'member');

    currentActor = owner.user_id;
  });

  it('serializes each member with the Auth0-sub user_id (not the Users.id UUID, not undefined)', async () => {
    const res = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);

    const m1Entry = res.body.members.find((m) => m.user_id === m1.user_id);
    expect(m1Entry).toBeDefined();
    // Auth0 sub, NOT the internal User UUID.
    expect(m1Entry.user_id).toBe(m1.user_id);
    expect(m1Entry.user_id).not.toBe(m1.id);
    // The internal id is still exposed separately (unchanged wire shape).
    expect(m1Entry.id).toBe(m1.id);

    // Every member carries a defined Auth0-sub string (the silent-undefined
    // regression would make these undefined post-Plan-09).
    for (const m of res.body.members) {
      expect(typeof m.user_id).toBe('string');
      expect(m.user_id).toMatch(/^auth0\|/);
    }
  });

  it('A1 loop guard: selected_member_ids sourced from the members payload reaches the fanout', async () => {
    // 1) FE reads members from the settings endpoint and stores their user_id into
    //    selected_member_ids.
    const settingsRes = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);
    expect(settingsRes.status).toBe(200);
    const m1PayloadId = settingsRes.body.members.find((m) => m.user_id === m1.user_id).user_id;
    const selectedMemberIds = [m1PayloadId]; // exactly the value the FE would persist

    // 2) A prompt fires; the fanout filters UserGroup members through the User
    //    include on those Auth0 strings.
    const prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      status: 'active',
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      week_identifier: '2026-W30',
    });

    emailService.send.mockClear();
    const result = await promptInvitationService.notifyMembersOfPrompt(prompt, { selectedMemberIds });

    // 3) The selected member is reached — the FE → settings → fanout loop holds.
    expect(result.sent).toBe(1);
    const toAddresses = emailService.send.mock.calls.map((c) => c[0].to);
    expect(toAddresses).toEqual([m1.email]);
    // The unselected members are NOT reached.
    expect(toAddresses).not.toContain(m2.email);
    expect(toAddresses).not.toContain(owner.email);
  });

  // Phase 87.4 Plan 04 (D-06, owner decision 2026-07-17): the backfill converts the
  // STORED selected_member_ids keyspace to Users.id UUIDs, but the GET handler's
  // TEMPORARY PR-1 translate-on-read shim serializes them back to Auth0 subs on read
  // so the PR-1 wire shape stays sub-consistent with members[].user_id (above). The
  // reverse UUID->sub map is built ONLY from the active-member roster (no global
  // Users query / no UUID->sub oracle). Removed by Plan 11 in PR-2.
  it('PR-1 shim: selected_member_ids round-trips through the backfill and back out as SUBS on GET (roster member)', async () => {
    // Store a schedule keyed by m1's Auth0 SUB (the pre-backfill shape).
    await GroupPromptSettings.create({
      group_id: group.id,
      schedule_timezone: 'UTC',
      template_config: {
        schedules: [{
          id: `sched-${group.id}`,
          is_active: true,
          game_id: null,
          selected_member_ids: [m1.user_id], // Auth0 sub
        }],
      },
    });

    // Run the real backfill migration — converts m1.user_id (sub) -> m1.id (UUID)
    // in the stored nested JSONB.
    await backfillMigration.up(sequelize.getQueryInterface());

    // The STORED keyspace is now the UUID (proves the backfill ran).
    const stored = await GroupPromptSettings.findOne({ where: { group_id: group.id } });
    expect(stored.template_config.schedules[0].selected_member_ids).toEqual([m1.id]);

    // GET translates the backfilled UUID back to m1's Auth0 sub at BOTH emission
    // points — the top-level schedules[] projection AND the raw template_config.
    const res = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);
    expect(res.status).toBe(200);

    const schedFromProjection = res.body.schedules.find(s => s.id === `sched-${group.id}`);
    expect(schedFromProjection.selected_member_ids).toEqual([m1.user_id]); // sub, not UUID
    expect(schedFromProjection.selected_member_ids).not.toContain(m1.id);

    const schedFromTemplateConfig = res.body.template_config.schedules.find(s => s.id === `sched-${group.id}`);
    expect(schedFromTemplateConfig.selected_member_ids).toEqual([m1.user_id]); // sub, not UUID
  });

  // H-B (T-874-04-ORACLE): a stored UUID that is NOT in the active-member roster must
  // pass through UNTRANSLATED on GET — the roster-scoped reverse map has no oracle
  // behavior, so a non-member's Auth0 sub is never leaked.
  it('PR-1 shim: a non-member UUID in stored selected_member_ids is NOT translated to a sub on GET', async () => {
    // A user who is NOT a member of this group.
    const nonMember = await makeUser({ username: 'not-in-group' });

    await GroupPromptSettings.create({
      group_id: group.id,
      schedule_timezone: 'UTC',
      template_config: {
        schedules: [{
          id: `sched-nonmember-${group.id}`,
          is_active: true,
          game_id: null,
          selected_member_ids: [nonMember.id], // a UUID absent from the active roster
        }],
      },
    });

    const res = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);
    expect(res.status).toBe(200);

    const sched = res.body.schedules.find(s => s.id === `sched-nonmember-${group.id}`);
    // Untranslated: the stored UUID passes through unchanged — it is NOT resolved to
    // the non-member's Auth0 sub (no UUID->sub oracle).
    expect(sched.selected_member_ids).toEqual([nonMember.id]);
    expect(sched.selected_member_ids).not.toContain(nonMember.user_id);
  });
});
