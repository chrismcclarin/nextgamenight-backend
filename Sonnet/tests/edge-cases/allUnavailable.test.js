// tests/edge-cases/allUnavailable.test.js
// Edge case tests for deadline processing when all members mark themselves unavailable
// Tests that processExpiredPrompt closes the prompt (status: 'closed') rather than
// attempting to convert or crashing when there are no viable suggestions.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

const { processExpiredPrompt } = require('../../schedulers/deadlineScheduler');
const {
  User,
  Group,
  UserGroup,
  AvailabilityPrompt,
  AvailabilityResponse,
  sequelize
} = require('../../models');

describe('All-unavailable deadline processing', () => {
  let testGroup, testPrompt, testUsers;

  beforeEach(async () => {
    // Schema is built once by tests/globalSetup.js; the global beforeEach in
    // tests/setup.js TRUNCATEs all tables before each test, so this seed must run
    // in beforeEach (not beforeAll) to survive the per-test wipe.

    // Mock emailService.send to avoid real email calls
    jest.spyOn(require('../../services/emailService'), 'send').mockResolvedValue({ success: true });

    testGroup = await Group.create({
      name: 'All Unavailable Test Group',
      group_id: 'all-unavailable-group-001'
    });

    // Create 3 users
    testUsers = await Promise.all([
      User.create({
        user_id: 'auth0|unavailable-user-1',
        username: 'Unavailable User 1',
        email: 'unavailable1@test.com'
      }),
      User.create({
        user_id: 'auth0|unavailable-user-2',
        username: 'Unavailable User 2',
        email: 'unavailable2@test.com'
      }),
      User.create({
        user_id: 'auth0|unavailable-admin-1',
        username: 'Unavailable Admin',
        email: 'unavailable-admin@test.com'
      })
    ]);

    // Create UserGroup memberships.
    // Phase 87.1 seed cutover: DUAL-WRITE user_uuid (Users.id) alongside the old
    // Auth0-string user_id so the re-keyed UserGroup queries resolve post-Plan-09.
    await UserGroup.create({
      user_id: testUsers[0].user_id,
      user_uuid: testUsers[0].id,
      group_id: testGroup.id,
      role: 'member'
    });
    await UserGroup.create({
      user_id: testUsers[1].user_id,
      user_uuid: testUsers[1].id,
      group_id: testGroup.id,
      role: 'member'
    });
    await UserGroup.create({
      user_id: testUsers[2].user_id,
      user_uuid: testUsers[2].id,
      group_id: testGroup.id,
      role: 'admin'
    });

    // Create an active prompt (past deadline)
    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(Date.now() - 72 * 60 * 60 * 1000),
      deadline: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago — expired
      status: 'active',
      week_identifier: '2026-W12-all-unavailable',
      auto_schedule_enabled: true
    });

    // Create 3 availability responses all marking users as unavailable
    await AvailabilityResponse.create({
      prompt_id: testPrompt.id,
      user_id: testUsers[0].user_id,
      time_slots: [],
      user_timezone: 'America/New_York',
      submitted_at: new Date(),
      is_unavailable: true
    });
    await AvailabilityResponse.create({
      prompt_id: testPrompt.id,
      user_id: testUsers[1].user_id,
      time_slots: [],
      user_timezone: 'America/New_York',
      submitted_at: new Date(),
      is_unavailable: true
    });
    await AvailabilityResponse.create({
      prompt_id: testPrompt.id,
      user_id: testUsers[2].user_id,
      time_slots: [],
      user_timezone: 'America/New_York',
      submitted_at: new Date(),
      is_unavailable: true
    });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    // Note: sequelize.close() is handled globally by tests/setup.js
  });

  it('should close the prompt when all members are unavailable (no suggestions exist)', async () => {
    // Process the expired prompt
    await processExpiredPrompt(testPrompt);

    // Fetch the prompt again to check updated status
    const updatedPrompt = await AvailabilityPrompt.findByPk(testPrompt.id);

    // When no viable suggestions exist, prompt should be 'closed' not 'converted'
    expect(updatedPrompt.status).toBe('closed');
  });
});
