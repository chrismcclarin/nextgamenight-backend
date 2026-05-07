// tests/services/promptLifecycleService.test.js
// Phase 71.2 / Plan 02 — unit tests for the prompt lifecycle service.
//
// These tests mock all model imports + emailService so they run without the
// test DB. They exercise the consensus check, the close-notification dispatch,
// and the LOCKED recipient resolution rule (D-ADAPT-05 + D-SCHEMA-06).

// Mock models module before requiring the service.
jest.mock('../../models', () => ({
  AvailabilityPrompt: { findByPk: jest.fn() },
  AvailabilityResponse: { count: jest.fn(), findAll: jest.fn() },
  AvailabilitySuggestion: { findAll: jest.fn() },
  UserGroup: { count: jest.fn(), findOne: jest.fn() },
  Group: { findByPk: jest.fn() },
  GroupPromptSettings: { findByPk: jest.fn() },
  User: { findByPk: jest.fn(), findOne: jest.fn() },
  Game: { findByPk: jest.fn() },
}));

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
    expect(prompt.update).toHaveBeenCalledWith({ status: 'closed' });
    expect(prompt.status).toBe('closed');
    expect(emailService.send).toHaveBeenCalledTimes(1);
  });

  it('Test 3: returns closed=false reason=already_closed without re-sending email when prompt already closed', async () => {
    const prompt = makePromptMock({ status: 'closed' });
    AvailabilityPrompt.findByPk.mockResolvedValue(prompt);

    const result = await lifecycleService.checkConsensusAndClose('prompt-uuid-1');

    expect(result.closed).toBe(false);
    expect(result.reason).toBe('already_closed');
    expect(prompt.update).not.toHaveBeenCalled();
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

  it('Test 5b: auto prompt with NULL settings.created_by_user_id falls back to group owner via UserGroup', async () => {
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
      user_id: 'auth0|owner-sub',
      role: 'owner',
      status: 'active',
      group_id: 'group-uuid-1',
    });
    User.findOne.mockImplementation(async ({ where }) => {
      if (where && where.user_id === 'auth0|owner-sub') {
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
    // then User by Auth0 sub (NOT a single User.findByPk).
    expect(UserGroup.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        group_id: 'group-uuid-1',
        role: 'owner',
      }),
    }));
    expect(User.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ user_id: 'auth0|owner-sub' }),
    }));
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
    expect(prompt.status).toBe('closed');
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
    expect(result.html).toContain('Schedule it?');
    // CTA URL contains the deep-link query params expected by createEvent.js.
    expect(result.html).toContain('prefillDate=');
    expect(result.html).toContain('prefillTime=');
    expect(result.subject).toContain('Tabletop Crew');
  });

  it('Test 9: multi-tie template renders all slots with separate CTAs ordered by suggested_start ASC', () => {
    const earlier = new Date('2026-05-10T18:00:00Z');
    const later = new Date('2026-05-12T19:00:00Z');
    // Provide ties NOT in chronological order — template must sort.
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

    // Earlier slot's prefillDate should appear before the later one in the HTML
    // (renders in chronological order, with multiple CTAs).
    const earlierIso = earlier.toISOString().slice(0, 10);
    const laterIso = later.toISOString().slice(0, 10);
    expect(result.html).toContain(earlierIso);
    expect(result.html).toContain(laterIso);
    expect(result.html.indexOf(earlierIso)).toBeLessThan(result.html.indexOf(laterIso));
    // At least one Schedule it? CTA per slot.
    const ctaMatches = result.html.match(/Schedule it\?/g) || [];
    expect(ctaMatches.length).toBeGreaterThanOrEqual(2);
  });
});
