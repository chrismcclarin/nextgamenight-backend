// tests/services/promptInvitationService.test.js
// Phase 87.1 / Plan 07 (BINT-02, A1): REAL-DB proof that the selected-member
// fanout still reaches exactly the selected members AFTER the UserGroup re-key.
//
// A1 (VERIFIED): schedule.selected_member_ids stores Auth0 user_id STRINGS. The
// old code keyed UserGroup.user_id = selectedMemberIds. Once Plan 09 re-keys
// UserGroup onto user_uuid, that filter silently matches NOBODY (the column is
// gone), so selected-subset prompts would reach zero members with NO loud error.
// The fix scopes the subset through the User include's user_id (still the Auth0
// string) while UserGroup itself is keyed on the group. This suite runs against
// the sync'd Postgres test DB with REAL models — only emailService.send /
// isConfigured and magicTokenService.generateToken are mocked — so the include
// join (UserGroup → User on user_uuid) is exercised for real. A mock could not
// catch the silent-nobody regression.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// emailService is a class instance — override send/isConfigured on the instance,
// keep escapeHtml (used by the HTML builder) real.
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  actual.isConfigured = jest.fn().mockReturnValue(true);
  return actual;
});
// Avoid MAGIC_TOKEN_SECRET requirement + a MagicToken DB write.
jest.mock('../../services/magicTokenService', () => ({
  generateToken: jest.fn().mockResolvedValue('fake-magic-token'),
}));

const promptInvitationService = require('../../services/promptInvitationService');
const emailService = require('../../services/emailService');
const { AvailabilityPrompt } = require('../../models');
const { makeUser, makeGroup, addToGroup } = require('../factories');

async function seedPromptWithMembers() {
  const group = await makeGroup();
  // Three active members. addToGroup DUAL-WRITES user_uuid so the include join
  // (UserGroup → User on user_uuid) resolves each member's User row.
  const m1 = await makeUser({ email_notifications_enabled: true });
  const m2 = await makeUser({ email_notifications_enabled: true });
  const m3 = await makeUser({ email_notifications_enabled: true });
  await addToGroup(m1, group, 'member');
  await addToGroup(m2, group, 'member');
  await addToGroup(m3, group, 'member');

  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    status: 'active',
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
    week_identifier: '2026-W27',
  });
  return { group, m1, m2, m3, prompt };
}

function sentToAddresses() {
  return emailService.send.mock.calls.map((call) => call[0].to).sort();
}

describe('promptInvitationService.notifyMembersOfPrompt — selected-member fanout (87.1 A1, real DB)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emailService.send.mockResolvedValue({ success: true });
    emailService.isConfigured.mockReturnValue(true);
  });

  // Phase 87.4 Plan 04 (D-11 case 1): UUID-keyed selectedMemberIds (the post-backfill
  // shape) reaches EXACTLY those members via the fanout dual-read's `id IN (...)` arm.
  it('D-11 case 1: a UUID-keyed selectedMemberIds subset (Users.id) reaches EXACTLY those members', async () => {
    const { m1, m2, m3, prompt } = await seedPromptWithMembers();

    // selectedMemberIds stores Users.id UUIDs (m1, m2 — NOT m3).
    const result = await promptInvitationService.notifyMembersOfPrompt(prompt, {
      selectedMemberIds: [m1.id, m2.id],
    });

    expect(result.sent).toBe(2);
    expect(sentToAddresses()).toEqual([m1.email, m2.email].sort());
    expect(sentToAddresses()).not.toContain(m3.email);
  });

  // D-11 case 2: a legacy sub-keyed subset (Railway pre-deploy residue) STILL fans out
  // during the PR-1 dual-read window via the `user_id IN (...)` arm.
  it('D-11 case 2: a legacy sub-keyed selectedMemberIds subset (Auth0 strings) STILL reaches EXACTLY those members (dual-read)', async () => {
    const { m1, m2, m3, prompt } = await seedPromptWithMembers();

    // selectedMemberIds stores Auth0 user_id STRINGS (m1, m2 — NOT m3).
    const result = await promptInvitationService.notifyMembersOfPrompt(prompt, {
      selectedMemberIds: [m1.user_id, m2.user_id],
    });

    expect(result.sent).toBe(2);
    expect(sentToAddresses()).toEqual([m1.email, m2.email].sort());
    // The unselected member must NOT be emailed — the bug would send to nobody OR
    // (pre-bug) to the whole group; this pins the exact selected subset.
    expect(sentToAddresses()).not.toContain(m3.email);
  });

  // D-11 case 3: empty/null selectedMemberIds preserves the whole-active-group default.
  it('D-11 case 3: no selectedMemberIds → every active member is invited (manual poll)', async () => {
    const { m1, m2, m3, prompt } = await seedPromptWithMembers();

    const result = await promptInvitationService.notifyMembersOfPrompt(prompt);

    expect(result.sent).toBe(3);
    expect(sentToAddresses()).toEqual([m1.email, m2.email, m3.email].sort());
  });
});
