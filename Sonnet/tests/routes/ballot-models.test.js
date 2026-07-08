// tests/routes/ballot-models.test.js
// TDD RED: Tests for EventBallotOption, EventBallotVote models and updated Event model
// These tests verify model structure and module exports without requiring a running database.

describe('Ballot Models', () => {
  describe('EventBallotOption model', () => {
    it('should exist and be requireable', () => {
      const EventBallotOption = require('../../models/EventBallotOption');
      expect(EventBallotOption).toBeDefined();
    });

    it('should have required fields: id, event_id, game_id, game_name, display_order', () => {
      const EventBallotOption = require('../../models/EventBallotOption');
      const attrs = EventBallotOption.rawAttributes;
      expect(attrs.id).toBeDefined();
      expect(attrs.id.primaryKey).toBe(true);
      expect(attrs.event_id).toBeDefined();
      expect(attrs.event_id.allowNull).toBe(false);
      expect(attrs.game_id).toBeDefined();
      expect(attrs.game_id.allowNull).toBe(true); // nullable for free-text entries
      expect(attrs.game_name).toBeDefined();
      expect(attrs.game_name.allowNull).toBe(false);
      expect(attrs.display_order).toBeDefined();
    });

    it('should have ON DELETE CASCADE on event_id', () => {
      const EventBallotOption = require('../../models/EventBallotOption');
      const attrs = EventBallotOption.rawAttributes;
      expect(attrs.event_id.onDelete).toBe('CASCADE');
    });
  });

  describe('EventBallotVote model', () => {
    it('should exist and be requireable', () => {
      const EventBallotVote = require('../../models/EventBallotVote');
      expect(EventBallotVote).toBeDefined();
    });

    it('should have required fields: id, option_id, user_uuid (UUID)', () => {
      const EventBallotVote = require('../../models/EventBallotVote');
      const attrs = EventBallotVote.rawAttributes;
      expect(attrs.id).toBeDefined();
      expect(attrs.id.primaryKey).toBe(true);
      expect(attrs.option_id).toBeDefined();
      expect(attrs.option_id.allowNull).toBe(false);
      expect(attrs.user_uuid).toBeDefined();
      expect(attrs.user_uuid.allowNull).toBe(false);
    });

    it('should have ON DELETE CASCADE on option_id', () => {
      const EventBallotVote = require('../../models/EventBallotVote');
      const attrs = EventBallotVote.rawAttributes;
      expect(attrs.option_id.onDelete).toBe('CASCADE');
    });

    it('should use UUID type for user_uuid (Users.id FK; Auth0-string user_id removed in phase 87.1)', () => {
      const EventBallotVote = require('../../models/EventBallotVote');
      const attrs = EventBallotVote.rawAttributes;
      // Phase 87.1 (BINT-02 Part B): votes are keyed by the internal UUID surrogate key.
      expect(attrs.user_uuid.type.key).toBe('UUID');
      expect(attrs.user_id).toBeUndefined();
    });
  });

  describe('Event model updates', () => {
    it('should have rsvp_deadline field (nullable DATE)', () => {
      const Event = require('../../models/Event');
      const attrs = Event.rawAttributes;
      expect(attrs.rsvp_deadline).toBeDefined();
      expect(attrs.rsvp_deadline.allowNull).toBe(true);
    });

    it('should have ballot_status field (nullable ENUM open/closed)', () => {
      const Event = require('../../models/Event');
      const attrs = Event.rawAttributes;
      expect(attrs.ballot_status).toBeDefined();
      expect(attrs.ballot_status.allowNull).toBe(true);
    });
  });

  describe('models/index.js exports', () => {
    it('should export EventBallotOption', () => {
      const models = require('../../models/index');
      expect(models.EventBallotOption).toBeDefined();
    });

    it('should export EventBallotVote', () => {
      const models = require('../../models/index');
      expect(models.EventBallotVote).toBeDefined();
    });

    it('should define Event -> EventBallotOption association', () => {
      const models = require('../../models/index');
      // Check that Event has association to EventBallotOption
      const eventAssocs = models.Event.associations;
      expect(eventAssocs.EventBallotOptions).toBeDefined();
    });

    it('should define EventBallotOption -> EventBallotVote association', () => {
      const models = require('../../models/index');
      const optionAssocs = models.EventBallotOption.associations;
      expect(optionAssocs.EventBallotVotes).toBeDefined();
    });
  });
});

describe('Migration file', () => {
  it('should exist and export up and down functions', () => {
    const migration = require('../../migrations/20260310000001-create-game-voting-tables');
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
  });
});
