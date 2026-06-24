// tests/edge-cases/emptyGroup.test.js
// Edge case tests for empty groups and prompts with zero responses
// Tests that the aggregation service handles prompts with no responses without crashing

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

const { aggregateResponses } = require('../../services/heatmapService');
const { Group, AvailabilityPrompt, AvailabilityResponse, AvailabilitySuggestion, sequelize } = require('../../models');

describe('Empty group aggregation handling', () => {
  let testGroup, testPrompt;

  beforeEach(async () => {
    // Seed in beforeEach so the rows survive the global per-test TRUNCATE
    // (schema is built once by tests/globalSetup.js).

    // Create a group with no members
    testGroup = await Group.create({
      name: 'Empty Group Test',
      group_id: 'empty-group-test-001'
    });

    // Create an availability prompt for the empty group (0 responses)
    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W11-empty-group'
    });
  });

  // Note: sequelize.close() is handled globally by tests/setup.js

  it('should return suggestionCount: 0 for a prompt with no responses', async () => {
    // Verify no responses exist for this prompt
    const responseCount = await AvailabilityResponse.count({
      where: { prompt_id: testPrompt.id }
    });
    expect(responseCount).toBe(0);

    // Call aggregation — should not throw
    const result = await aggregateResponses(testPrompt.id);

    expect(result.success).toBe(true);
    expect(result.suggestionCount).toBe(0);
  });

  it('should leave no suggestions in DB after aggregating empty responses', async () => {
    await aggregateResponses(testPrompt.id);

    const suggestions = await AvailabilitySuggestion.findAll({
      where: { prompt_id: testPrompt.id }
    });

    expect(suggestions.length).toBe(0);
  });
});
