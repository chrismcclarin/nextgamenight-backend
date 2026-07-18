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

describe('GET /api/groups/:group_id/prompt-settings — members UUID wire field + A1 loop (87.4 PR-2)', () => {
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

  // Plan 11 (PR-2): members[].user_id now emits the member's Users.id UUID (the
  // name-stable alias flip). display_name falls back to `username || null` — never the
  // raw Auth0 sub. No members[] field carries a sub-shaped value.
  //
  // HISTORICAL: 87.1/PR-1 (T-87.1-13) required members[].user_id to be the Auth0 SUB so
  // the FE could round-trip it into selected_member_ids for a sub-keyed fanout. PR-2
  // flips both together — members[].user_id is now the UUID and the fanout filters
  // selected_member_ids through the UUID shape check.
  it('serializes each member with the Users.id UUID user_id (not the Auth0 sub, not undefined)', async () => {
    const res = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);

    const m1Entry = res.body.members.find((m) => m.user_id === m1.id);
    expect(m1Entry).toBeDefined();
    // Users.id UUID, NOT the Auth0 sub (the PR-2 flip; inverted from the PR-1 assertion).
    expect(m1Entry.user_id).toBe(m1.id);
    expect(m1Entry.user_id).not.toBe(m1.user_id);
    // The internal id is exposed and equals user_id post-flip (both the UUID now).
    expect(m1Entry.id).toBe(m1.id);

    // No members[] field emits a sub-shaped value anywhere (user_id, id, username, or
    // the display_name fallback). display_name is username || null — never the raw sub.
    for (const m of res.body.members) {
      expect(typeof m.user_id).toBe('string');
      expect(m.user_id).not.toMatch(/^auth0\|/);
      for (const [, v] of Object.entries(m)) {
        if (typeof v === 'string') expect(v).not.toMatch(/^(auth0|google-oauth2|apple)\|/);
      }
    }
  });

  it('A1 loop guard: selected_member_ids sourced from the members payload (UUID) reaches the fanout', async () => {
    // 1) FE reads members from the settings endpoint and stores their user_id (now the
    //    Users.id UUID post-flip) into selected_member_ids.
    const settingsRes = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);
    expect(settingsRes.status).toBe(200);
    const m1PayloadId = settingsRes.body.members.find((m) => m.user_id === m1.id).user_id;
    expect(m1PayloadId).toBe(m1.id); // UUID, the value the FE persists
    const selectedMemberIds = [m1PayloadId];

    // 2) A prompt fires; the fanout filters UserGroup members through the User include's
    //    UUID `id` (isUuid shape filter).
    const prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      status: 'active',
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      week_identifier: '2026-W30',
    });

    emailService.send.mockClear();
    const result = await promptInvitationService.notifyMembersOfPrompt(prompt, { selectedMemberIds });

    // 3) The selected member is reached — the FE → settings → fanout loop holds on UUIDs.
    expect(result.sent).toBe(1);
    const toAddresses = emailService.send.mock.calls.map((c) => c[0].to);
    expect(toAddresses).toEqual([m1.email]);
    // The unselected members are NOT reached.
    expect(toAddresses).not.toContain(m2.email);
    expect(toAddresses).not.toContain(owner.email);
  });

  // Plan 11 (PR-2): the GET response emits selected_member_ids as the raw stored
  // Users.id UUIDs directly — Plan 04's temporary PR-1 translate-on-read shim (which
  // serialized them back to Auth0 subs) is REMOVED. Both emission points (the top-level
  // schedules[] projection AND the raw template_config) now carry the UUID unchanged.
  //
  // HISTORICAL: PR-1 proved the backfill converted the stored keyspace to UUIDs and the
  // shim round-tripped them back out as subs so the wire stayed sub-consistent with the
  // still-sub members[].user_id. PR-2 flips both to UUID together, so the shim is gone.
  it('PR-2: selected_member_ids is emitted as raw stored UUIDs on GET (no sub translation)', async () => {
    // Store a schedule keyed by m1's Auth0 SUB (the pre-backfill shape).
    await GroupPromptSettings.create({
      group_id: group.id,
      schedule_timezone: 'UTC',
      template_config: {
        schedules: [{
          id: `sched-${group.id}`,
          is_active: true,
          game_id: null,
          selected_member_ids: [m1.user_id], // Auth0 sub (pre-backfill residue)
        }],
      },
    });

    // Run the real backfill migration — converts m1.user_id (sub) -> m1.id (UUID)
    // in the stored nested JSONB.
    await backfillMigration.up(sequelize.getQueryInterface());

    // The STORED keyspace is now the UUID (proves the backfill ran).
    const stored = await GroupPromptSettings.findOne({ where: { group_id: group.id } });
    expect(stored.template_config.schedules[0].selected_member_ids).toEqual([m1.id]);

    // GET emits the raw stored UUID at BOTH emission points — no translation to a sub.
    const res = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);
    expect(res.status).toBe(200);

    const schedFromProjection = res.body.schedules.find(s => s.id === `sched-${group.id}`);
    expect(schedFromProjection.selected_member_ids).toEqual([m1.id]); // UUID, not sub
    expect(schedFromProjection.selected_member_ids).not.toContain(m1.user_id);

    const schedFromTemplateConfig = res.body.template_config.schedules.find(s => s.id === `sched-${group.id}`);
    expect(schedFromTemplateConfig.selected_member_ids).toEqual([m1.id]); // UUID, not sub
  });

  // Plan 11 (PR-2): with the shim gone, a stored UUID (roster member or not) is emitted
  // verbatim — the sweep guarantees no sub crosses the wire because the stored value is
  // already a UUID. Every entry is validated UUID-shaped via isUuid.
  it('PR-2: a stored selected_member_ids UUID is emitted verbatim on GET', async () => {
    const nonMember = await makeUser({ username: 'not-in-group' });

    await GroupPromptSettings.create({
      group_id: group.id,
      schedule_timezone: 'UTC',
      template_config: {
        schedules: [{
          id: `sched-uuid-${group.id}`,
          is_active: true,
          game_id: null,
          selected_member_ids: [m1.id, nonMember.id], // stored UUIDs
        }],
      },
    });

    const res = await request(makeApp()).get(`/api/groups/${group.id}/prompt-settings`);
    expect(res.status).toBe(200);

    const sched = res.body.schedules.find(s => s.id === `sched-uuid-${group.id}`);
    expect(sched.selected_member_ids).toEqual([m1.id, nonMember.id]);
    for (const v of sched.selected_member_ids) {
      expect(isUuid(v)).toBe(true);
      expect(v).not.toMatch(/^auth0\|/);
    }
  });
});
