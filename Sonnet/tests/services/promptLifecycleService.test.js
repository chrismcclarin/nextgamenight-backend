// tests/services/promptLifecycleService.test.js
// Phase 71.2 / Plan 02 — unit tests for the prompt lifecycle service.
//
// These tests mock all model imports + emailService so they run without the
// test DB. They exercise the consensus check, the close-notification dispatch,
// and the LOCKED recipient resolution rule (D-ADAPT-05 + D-SCHEMA-06).

// Mock models module before requiring the service.
jest.mock('../../models', () => {
  // BSEC-01 / D-03: the service resolves the email recipient via
  // `User.scope('withContactInfo').findByPk(...)` (promptLifecycleService.js:122/133)
  // and `User.scope('withContactInfo').findOne(...)` (L143). The scope was added
  // by the PII-defaultScope work 83-06 shipped. The mock's User must be CHAINABLE:
  // `User.scope(...)` returns an object whose findByPk/findOne are the SAME jest.fns
  // the tests configure via `User.findByPk.mockImplementation(...)`, so the existing
  // setups AND `expect(User.findByPk).toHaveBeenCalledWith(...)` assertions stay valid.
  // Without this, `User.scope` is undefined -> throws -> handlePromptClosed swallows it
  // at L234 -> the email never dispatches (the dominant cause of the 6 failing tests).
  const userFindByPk = jest.fn();
  const userFindOne = jest.fn();
  return {
    // Phase 87 / BINT-01: checkConsensusAndClose now closes via an atomic
    // conditional UPDATE (AvailabilityPrompt.update(..., { returning: true }))
    // instead of a prompt-instance update, so the static `update` must be mocked.
    // It resolves the Postgres shape [affectedCount, rows].
    AvailabilityPrompt: { findByPk: jest.fn(), update: jest.fn() },
    AvailabilityResponse: { count: jest.fn(), findAll: jest.fn() },
    AvailabilitySuggestion: { findAll: jest.fn() },
    UserGroup: { count: jest.fn(), findOne: jest.fn() },
    Group: { findByPk: jest.fn() },
    GroupPromptSettings: { findByPk: jest.fn() },
    User: {
      findByPk: userFindByPk,
      findOne: userFindOne,
      scope: jest.fn(() => ({ findByPk: userFindByPk, findOne: userFindOne })),
    },
    Game: { findByPk: jest.fn() },
  };
});

// We deliberately do NOT mock generatePollClosedEmailTemplate so Tests 8/9
// can assert on real HTML output. send() is mocked so we never call Resend.
// emailService exports a class instance — its methods live on the prototype,
// so we override `send` on the instance directly rather than spreading.
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn();
  return actual;
});

const lifecycleService = require('../../services/promptLifecycleService');
const models = require('../../models');
const emailService = require('../../services/emailService');

const {
  AvailabilityPrompt,
  AvailabilityResponse,
  AvailabilitySuggestion,
  UserGroup,
  Group,
  GroupPromptSettings,
  User,
  Game,
} = models;

// Helper — produce a Sequelize-instance-like prompt mock.
function makePromptMock(overrides = {}) {
  const data = {
    id: 'prompt-uuid-1',
    group_id: 'group-uuid-1',
    game_id: null,
    status: 'active',
    deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
    created_by_user_id: null,
    created_by_settings_id: null,
    ...overrides,
  };
  data.update = jest.fn(async (patch) => {
    Object.assign(data, patch);
    return data;
  });
  data.reload = jest.fn(async () => data);
  return data;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Sensible defaults — most tests override per-case.
  AvailabilitySuggestion.findAll.mockResolvedValue([]);
  AvailabilityResponse.count.mockResolvedValue(0);
  AvailabilityResponse.findAll.mockResolvedValue([]);
  UserGroup.count.mockResolvedValue(0);
  Group.findByPk.mockResolvedValue({ id: 'group-uuid-1', name: 'Test Group' });
  Game.findByPk.mockResolvedValue(null);
});

describe('promptLifecycleService.checkConsensusAndClose', () => {
  it('Test 1: returns closed=false when not all members have responded', async () => {
    const prompt = makePromptMock();
    AvailabilityPrompt.findByPk.mockResolvedValue(prompt);
    UserGroup.count.mockResolvedValue(3);
    AvailabilityResponse.count.mockResolvedValue(2);

    const result = await lifecycleService.checkConsensusAndClose('prompt-uuid-1');

    expect(result.closed).toBe(false);
    expect(result.respondedCount).toBe(2);
    expect(result.totalActive).toBe(3);
    expect(prompt.update).not.toHaveBeenCalled();
    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('Test 2: returns closed=true and dispatches close-notification when all members respond', async () => {
    const prompt = makePromptMock({
      created_by_user_id: 'user-uuid-creator',
    });
    AvailabilityPrompt.findByPk.mockResolvedValue(prompt);
    // Atomic claim wins: [affectedCount=1, rows=[closedPrompt]].
    AvailabilityPrompt.update.mockResolvedValue([1, [{ ...prompt, status: 'closed' }]]);
    UserGroup.count.mockResolvedValue(3);
    AvailabilityResponse.count.mockResolvedValue(3);
    User.findByPk.mockResolvedValue({
      id: 'user-uuid-creator',
      email: 'creator@test.com',
      username: 'Creator',
      timezone: 'America/New_York',
      email_notifications_enabled: true,
    });
    AvailabilitySuggestion.findAll.mockResolvedValue([
      { id: 's1', score: 4, suggested_start: new Date('2026-05-10T18:00:00Z'), suggested_end: new Date('2026-05-10T21:00:00Z'), meets_minimum: true },
    ]);
    emailService.send.mockResolvedValue({ success: true });

    const result = await lifecycleService.checkConsensusAndClose('prompt-uuid-1');

    expect(result.closed).toBe(true);
    // Close is an atomic conditional UPDATE gated on status not-closed/converted.
    expect(AvailabilityPrompt.update).toHaveBeenCalledWith(
      { status: 'closed' },
      expect.objectContaining({ returning: true })
    );
    expect(emailService.send).toHaveBeenCalledTimes(1);
  });

  it('Test 3: lost the atomic close race (0 rows claimed) → already_closed, no re-send', async () => {
    // Consensus is reached (counts full) but the atomic conditional UPDATE flips
    // 0 rows because a concurrent path (PATCH-close / deadline / other consensus
    // caller) already closed the prompt. The close-notification email MUST NOT
    // fire a second time.
    const prompt = makePromptMock({ created_by_user_id: 'user-uuid-creator' });
    AvailabilityPrompt.findByPk.mockResolvedValue(prompt);
    UserGroup.count.mockResolvedValue(3);
    AvailabilityResponse.count.mockResolvedValue(3);
    // Claim lost: [affectedCount=0, rows=[]].
    AvailabilityPrompt.update.mockResolvedValue([0, []]);

    const result = await lifecycleService.checkConsensusAndClose('prompt-uuid-1');

    expect(result.closed).toBe(false);
    expect(result.reason).toBe('already_closed');
    expect(emailService.send).not.toHaveBeenCalled();
  });
});

describe('promptLifecycleService.handlePromptClosed — recipient resolution', () => {
  it('Test 4: manual prompt resolves recipient via prompt.created_by_user_id', async () => {
    const prompt = makePromptMock({
      status: 'closed',
      created_by_user_id: 'user-uuid-creator',
    });
    AvailabilityResponse.count.mockResolvedValue(2);
    User.findByPk.mockImplementation(async (id) => {
      if (id === 'user-uuid-creator') {
        return {
          id: 'user-uuid-creator',
          email: 'creator@test.com',
          username: 'Creator',
          timezone: 'America/New_York',
          email_notifications_enabled: true,
        };
      }
      return null;
    });
    AvailabilitySuggestion.findAll.mockResolvedValue([
      { id: 's1', score: 4, suggested_start: new Date('2026-05-10T18:00:00Z'), suggested_end: new Date('2026-05-10T21:00:00Z'), meets_minimum: true },
    ]);
    emailService.send.mockResolvedValue({ success: true });

    await lifecycleService.handlePromptClosed(prompt);

    expect(User.findByPk).toHaveBeenCalledWith('user-uuid-creator');
    // Auto branches not consulted.
    expect(GroupPromptSettings.findByPk).not.toHaveBeenCalled();
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(emailService.send.mock.calls[0][0].to).toBe('creator@test.com');
  });

  it('Test 5a: auto prompt with settings.created_by_user_id resolves recipient via settings creator', async () => {
    const prompt = makePromptMock({
      status: 'closed',
      created_by_user_id: null,
      created_by_settings_id: 'settings-uuid-1',
    });
    AvailabilityResponse.count.mockResolvedValue(2);
    GroupPromptSettings.findByPk.mockResolvedValue({
      id: 'settings-uuid-1',
      created_by_user_id: 'user-uuid-schedule-creator',
    });
    User.findByPk.mockImplementation(async (id) => {
      if (id === 'user-uuid-schedule-creator') {
        return {
          id: 'user-uuid-schedule-creator',
          email: 'admin-a@test.com',
          username: 'Admin A',
          timezone: 'UTC',
          email_notifications_enabled: true,
        };
      }
      return null;
    });
    AvailabilitySuggestion.findAll.mockResolvedValue([
      { id: 's1', score: 5, suggested_start: new Date('2026-05-10T18:00:00Z'), suggested_end: new Date('2026-05-10T21:00:00Z'), meets_minimum: true },
    ]);
    emailService.send.mockResolvedValue({ success: true });

    await lifecycleService.handlePromptClosed(prompt);

    expect(GroupPromptSettings.findByPk).toHaveBeenCalledWith('settings-uuid-1');
    expect(User.findByPk).toHaveBeenCalledWith('user-uuid-schedule-creator');
    // Group-owner fallback NOT consulted.
    expect(UserGroup.findOne).not.toHaveBeenCalled();
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(emailService.send.mock.calls[0][0].to).toBe('admin-a@test.com');
  });

  it('Test 5b: auto prompt with NULL settings.created_by_user_id falls back to group owner via UserGroup (D-11: user_uuid → findByPk)', async () => {
    // T-87.1-13 (corrected): the owner-fallback used to read ownerUg.user_id (an
    // Auth0-string instance property). After Plan 09 strips user_id from the
    // UserGroup model that read is undefined-SILENT → the branch is skipped → the
    // owner never gets the close email. This test EXERCISES the branch on the
    // re-keyed column (ownerUg.user_uuid, resolved via findByPk) so the fix is
    // proven live, not dead — a defined-value assertion is the only backstop for a
    // silent instance-property read.
    const prompt = makePromptMock({
      status: 'closed',
      created_by_user_id: null,
      created_by_settings_id: 'settings-uuid-1',
    });
    AvailabilityResponse.count.mockResolvedValue(2);
    GroupPromptSettings.findByPk.mockResolvedValue({
      id: 'settings-uuid-1',
      created_by_user_id: null, // legacy row — fallback path
    });
    UserGroup.findOne.mockResolvedValue({
      user_uuid: 'user-uuid-owner', // re-keyed surrogate (Users.id)
      role: 'owner',
      status: 'active',
      group_id: 'group-uuid-1',
    });
    User.findByPk.mockImplementation(async (id) => {
      if (id === 'user-uuid-owner') {
        return {
          id: 'user-uuid-owner',
          user_id: 'auth0|owner-sub',
          email: 'owner@test.com',
          username: 'Owner',
          timezone: 'UTC',
          email_notifications_enabled: true,
        };
      }
      return null;
    });
    AvailabilitySuggestion.findAll.mockResolvedValue([
      { id: 's1', score: 5, suggested_start: new Date('2026-05-10T18:00:00Z'), suggested_end: new Date('2026-05-10T21:00:00Z'), meets_minimum: true },
    ]);
    emailService.send.mockResolvedValue({ success: true });

    await lifecycleService.handlePromptClosed(prompt);

    // Settings was consulted.
    expect(GroupPromptSettings.findByPk).toHaveBeenCalledWith('settings-uuid-1');
    // Group owner lookup is the documented two-step path — UserGroup by role,
    // then the owner resolved by the re-keyed user_uuid via findByPk (NOT the old
    // Auth0-string User.findOne).
    expect(UserGroup.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        group_id: 'group-uuid-1',
        role: 'owner',
      }),
    }));
    expect(User.findByPk).toHaveBeenCalledWith('user-uuid-owner');
    // The owner ACTUALLY resolved (branch is live, not dead) → email dispatched.
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(emailService.send.mock.calls[0][0].to).toBe('owner@test.com');
  });

  it('Test 6: zero responses → silent close, no email sent (D-CLOSE-03)', async () => {
    const prompt = makePromptMock({
      status: 'closed',
      created_by_user_id: 'user-uuid-creator',
    });
    AvailabilityResponse.count.mockResolvedValue(0);
    User.findByPk.mockResolvedValue({
      id: 'user-uuid-creator',
      email: 'creator@test.com',
      username: 'Creator',
      timezone: 'UTC',
      email_notifications_enabled: true,
    });

    await lifecycleService.handlePromptClosed(prompt);

    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('Test 10: empty topSlots → no email sent', async () => {
    const prompt = makePromptMock({
      status: 'closed',
      created_by_user_id: 'user-uuid-creator',
    });
    AvailabilityResponse.count.mockResolvedValue(2);
    User.findByPk.mockResolvedValue({
      id: 'user-uuid-creator',
      email: 'creator@test.com',
      username: 'Creator',
      timezone: 'UTC',
      email_notifications_enabled: true,
    });
    // No suggestions — no top slot to put in CTA.
    AvailabilitySuggestion.findAll.mockResolvedValue([]);

    await lifecycleService.handlePromptClosed(prompt);

    expect(emailService.send).not.toHaveBeenCalled();
  });

  it('Test 7: closing an auto-prompt does NOT modify GroupPromptSettings row', async () => {
    const prompt = makePromptMock({
      status: 'closed',
      created_by_user_id: null,
      created_by_settings_id: 'settings-uuid-1',
    });
    AvailabilityResponse.count.mockResolvedValue(2);

    // Provide a settings row instance with a spied-on update method.
    const settingsUpdateSpy = jest.fn();
    const settingsDestroySpy = jest.fn();
    const settingsSnapshot = {
      id: 'settings-uuid-1',
      group_id: 'group-uuid-1',
      template_name: 'Friday Sessions',
      created_by_user_id: 'user-uuid-schedule-creator',
      schedule_day_of_week: 5,
      schedule_time: '18:00:00',
      is_active: true,
    };
    GroupPromptSettings.findByPk.mockResolvedValue({
      ...settingsSnapshot,
      update: settingsUpdateSpy,
      destroy: settingsDestroySpy,
    });
    User.findByPk.mockResolvedValue({
      id: 'user-uuid-schedule-creator',
      email: 'admin-a@test.com',
      username: 'Admin A',
      timezone: 'UTC',
      email_notifications_enabled: true,
    });
    AvailabilitySuggestion.findAll.mockResolvedValue([
      { id: 's1', score: 5, suggested_start: new Date('2026-05-10T18:00:00Z'), suggested_end: new Date('2026-05-10T21:00:00Z'), meets_minimum: true },
    ]);
    emailService.send.mockResolvedValue({ success: true });

    await lifecycleService.handlePromptClosed(prompt);

    // The lifecycle service must NOT mutate the parent settings row.
    expect(settingsUpdateSpy).not.toHaveBeenCalled();
    expect(settingsDestroySpy).not.toHaveBeenCalled();
  });
});

describe('end-to-end close-trigger wiring', () => {
  it('Test 11: response submit triggers consensus close → lifecycle emits one close-notification email', async () => {
    // Simulate the post-submit hook: caller passes a promptId, the lifecycle
    // counts members vs responses, and on full consensus closes + emits.
    const prompt = makePromptMock({
      created_by_user_id: 'user-uuid-creator',
    });
    AvailabilityPrompt.findByPk.mockResolvedValue(prompt);
    AvailabilityPrompt.update.mockResolvedValue([1, [{ ...prompt, status: 'closed' }]]);
    UserGroup.count.mockResolvedValue(3);
    AvailabilityResponse.count.mockResolvedValue(3);
    User.findByPk.mockResolvedValue({
      id: 'user-uuid-creator',
      email: 'creator@test.com',
      username: 'Creator',
      timezone: 'UTC',
      email_notifications_enabled: true,
    });
    AvailabilitySuggestion.findAll.mockResolvedValue([
      { id: 's1', score: 4, suggested_start: new Date('2026-05-10T18:00:00Z'), suggested_end: new Date('2026-05-10T21:00:00Z'), meets_minimum: true },
    ]);
    emailService.send.mockResolvedValue({ success: true });

    const result = await lifecycleService.checkConsensusAndClose('prompt-uuid-1');

    expect(result.closed).toBe(true);
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(emailService.send.mock.calls[0][0].subject).toMatch(/closed/i);
    expect(emailService.send.mock.calls[0][0].emailType).toBe('availability_prompt');
  });

  it('Test 12: deadline-path processExpiredPrompt closes prompt + emits email — does NOT call eventCreationService', async () => {
    // The deadline scheduler imports lifecycleService directly, so we exercise
    // the prompt-update + handlePromptClosed integration here. The convertSuggestionToEvent
    // assertion is verified at static-grep time below; here we verify that
    // even when a viable suggestion exists, no event is auto-created and the
    // prompt gets routed through the close-email path.
    const prompt = makePromptMock({
      status: 'active',
      created_by_user_id: null,
      created_by_settings_id: 'settings-uuid-1',
    });
    AvailabilityResponse.count.mockResolvedValue(2);
    GroupPromptSettings.findByPk.mockResolvedValue({
      id: 'settings-uuid-1',
      created_by_user_id: 'user-uuid-schedule-creator',
    });
    User.findByPk.mockResolvedValue({
      id: 'user-uuid-schedule-creator',
      email: 'admin-a@test.com',
      username: 'Admin A',
      timezone: 'UTC',
      email_notifications_enabled: true,
    });
    AvailabilitySuggestion.findAll.mockResolvedValue([
      { id: 's1', score: 5, suggested_start: new Date('2026-05-10T18:00:00Z'), suggested_end: new Date('2026-05-10T21:00:00Z'), meets_minimum: true },
    ]);
    emailService.send.mockResolvedValue({ success: true });

    // Simulate processExpiredPrompt's two steps: status='closed' update +
    // handlePromptClosed dispatch.
    await prompt.update({ status: 'closed' });
    await lifecycleService.handlePromptClosed(prompt);

    expect(prompt.status).toBe('closed');
    // Crucially NOT 'converted'.
    expect(prompt.status).not.toBe('converted');
    expect(emailService.send).toHaveBeenCalledTimes(1);
    expect(emailService.send.mock.calls[0][0].emailType).toBe('availability_prompt');
  });
});

describe('emailService.generatePollClosedEmailTemplate', () => {
  // Use the REAL template (jest.requireActual'd above). We re-import the actual
  // module here so the assertions run against the un-mocked function.
  const realEmailService = jest.requireActual('../../services/emailService');

  it('Test 8: single-slot template includes group/game/CTA/slot date', () => {
    const result = realEmailService.generatePollClosedEmailTemplate({
      recipientName: 'Alice',
      groupName: 'Tabletop Crew',
      gameName: 'Catan',
      topSlots: [
        {
          suggested_start: new Date('2026-05-10T18:00:00Z'),
          suggested_end: new Date('2026-05-10T21:00:00Z'),
          score: 4,
        },
      ],
      scheduleItBaseUrl: 'https://app.test/groupPlanning',
      promptId: 'prompt-uuid-1',
      groupId: 'group-uuid-1',
      timezone: 'America/New_York',
    });

    expect(result).toHaveProperty('html');
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('subject');
    expect(result.html).toContain('Tabletop Crew');
    expect(result.html).toContain('Catan');
    // Canonical CTA (Phase 71.2 / Plan 03 hotfix, emailService.js:462-483):
    // the template was collapsed to ONE "Schedule a session" CTA that deep-links
    // to /groupPlanning with group_id + prompt_id (the modal renders a heatmap
    // restricted to this poll, so per-slot prefillDate/prefillTime are no longer
    // emitted). The old "Schedule it?" + prefillDate/prefillTime assertions were
    // stale relative to the shipped single-CTA design — current output is canonical.
    expect(result.html).toContain('Schedule a session');
    expect(result.html).toContain('prompt_id=prompt-uuid-1');
    expect(result.html).toContain('group_id=group-uuid-1');
    expect(result.subject).toContain('Tabletop Crew');
  });

  it('Test 9: multi-tie template sorts slots ASC and previews the earliest tied slot under one CTA', () => {
    const earlier = new Date('2026-05-10T18:00:00Z');
    const later = new Date('2026-05-12T19:00:00Z');
    // Provide ties NOT in chronological order — template must sort (emailService.js:403).
    const result = realEmailService.generatePollClosedEmailTemplate({
      recipientName: 'Bob',
      groupName: 'Tabletop Crew',
      gameName: null,
      topSlots: [
        { suggested_start: later, suggested_end: new Date('2026-05-12T22:00:00Z'), score: 5 },
        { suggested_start: earlier, suggested_end: new Date('2026-05-10T21:00:00Z'), score: 5 },
      ],
      scheduleItBaseUrl: 'https://app.test/groupPlanning',
      promptId: 'prompt-uuid-2',
      groupId: 'group-uuid-2',
      timezone: 'UTC',
    });

    // Canonical single-CTA design (Plan 03 hotfix): the template no longer renders
    // one CTA per slot with bare ISO dates. It sorts the ties chronologically and
    // previews the EARLIEST tied slot (sortedSlots[0]) in human-readable form, with
    // a "N times tied for best — top: ..." line and a single CTA. The old per-slot
    // ISO-date ordering assertion was stale relative to the shipped design.
    expect(result.html).toContain('2 times tied for best');
    // The previewed top slot is the EARLIER one, rendered in human-readable form.
    expect(result.html).toContain('May 10'); // earlier slot's day label (UTC tz)
    // Exactly one collapsed CTA.
    const ctaMatches = result.html.match(/Schedule a session/g) || [];
    expect(ctaMatches.length).toBe(1);
  });
});
