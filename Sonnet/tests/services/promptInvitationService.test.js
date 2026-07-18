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
// PR-2: the fanout contracts to a UUID-shape-filtered `id [Op.in]` clause using this
// same isUuid predicate — a sub-shaped selectedMemberIds entry fails isUuid and is
// dropped before the query (never compared against the UUID id column).
const { isUuid } = require('../../utils/resolveTargetUser');

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

  // Phase 87.4 Plan 04 (D-11 case 1) / PR-2: UUID-keyed selectedMemberIds (the
  // post-backfill, post-contract shape) reaches EXACTLY those members via the fanout's
  // UUID-shape-filtered `id [Op.in]` clause.
  it('D-11 case 1: a UUID-keyed selectedMemberIds subset (Users.id) reaches EXACTLY those members', async () => {
    const { m1, m2, m3, prompt } = await seedPromptWithMembers();
    // These entries are UUID-shaped, so the contract's isUuid filter keeps them.
    expect(isUuid(m1.id) && isUuid(m2.id)).toBe(true);

    // selectedMemberIds stores Users.id UUIDs (m1, m2 — NOT m3).
    const result = await promptInvitationService.notifyMembersOfPrompt(prompt, {
      selectedMemberIds: [m1.id, m2.id],
    });

    expect(result.sent).toBe(2);
    expect(sentToAddresses()).toEqual([m1.email, m2.email].sort());
    expect(sentToAddresses()).not.toContain(m3.email);
  });

  // PR-2 contract (Plan 11): the fanout is now a UUID-shape-filtered `id [Op.in]`
  // clause — the dual-read window is CLOSED. A legacy sub-keyed selectedMemberIds row is
  // filtered out by isUuid BEFORE the query runs, so those members are silently EXCLUDED,
  // and the query never sees a sub-shaped value (no Postgres 22P02, no thrown/caught error).
  //
  // HISTORICAL: 87.1/PR-1 proved a sub-keyed subset STILL reached those members during the
  // D-07 dual-read window (the `[Op.or]` `user_id IN (...)` arm). PR-2 contracted the fanout
  // to the UUID shape filter after the Plan 04 backfill converted real rows to UUID, so a
  // raw sub row is now stale and is dropped rather than crashing the query.
  //
  // This ALSO proves the whole-group guard reads the ORIGINAL unfiltered array: the seeded
  // array is entirely sub-shaped (non-empty original), so the fanout stays on the
  // selected-members branch and reaches NOBODY — it does NOT fall back to the whole group.
  it('PR-2: a legacy all-sub selectedMemberIds row is silently EXCLUDED (reaches nobody, NOT the whole group)', async () => {
    const { m1, m2, m3, prompt } = await seedPromptWithMembers();

    // selectedMemberIds stores (now-stale) Auth0 user_id STRINGS (m1, m2).
    const result = await promptInvitationService.notifyMembersOfPrompt(prompt, {
      selectedMemberIds: [m1.user_id, m2.user_id],
    });

    // Nobody is reached — the sub-shaped entries are filtered out before the query, and
    // the whole-group guard (original non-empty array) keeps the fanout in the
    // selected-members branch, reaching nobody rather than the whole group.
    expect(result.sent).toBe(0);
    expect(sentToAddresses()).toEqual([]);
    expect(sentToAddresses()).not.toContain(m3.email);
  });

  // PR-2 contract: a MIXED array (one UUID + one stale sub) reaches ONLY the UUID-shaped
  // member — the sub entry is dropped by the shape filter, proving per-entry filtering and
  // that the query completes without a 22P02.
  it('PR-2: a mixed UUID+sub selectedMemberIds row reaches ONLY the UUID member', async () => {
    const { m1, m2, m3, prompt } = await seedPromptWithMembers();

    const result = await promptInvitationService.notifyMembersOfPrompt(prompt, {
      selectedMemberIds: [m1.id, m2.user_id], // m1 UUID (kept), m2 sub (dropped)
    });

    expect(result.sent).toBe(1);
    expect(sentToAddresses()).toEqual([m1.email]);
    expect(sentToAddresses()).not.toContain(m2.email);
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
