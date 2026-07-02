// tests/routes/groupPromptSettings.hooks.test.js
// Verifies the on-write BullMQ hooks fire from each mutation route.
// Mocks the scheduler module + models so this test does not require Redis,
// Postgres, or the integration-test fixture chain.

// --- mock the scheduler module so we can assert it was called ---
const mockUpsertSingle = jest.fn();
const mockRemove = jest.fn();
jest.mock('../../schedulers/promptScheduler', () => ({
  upsertSinglePromptScheduler: mockUpsertSingle,
  removePromptScheduler: mockRemove
}));

// --- mock authorization (always allow) ---
jest.mock('../../services/authorizationService', () => ({
  isOwnerOrAdmin: jest.fn().mockResolvedValue(true),
  isActiveMember: jest.fn().mockResolvedValue(true)
}));

// --- mock models. Each test sets findOne/findByPk return values per case. ---
const mockGroupFindByPk = jest.fn();
const mockSettingsFindOne = jest.fn();
const mockSettingsCreate = jest.fn();
const mockSettingsUpdate = jest.fn();
const mockGameFindByPk = jest.fn();
const mockGameFindAll = jest.fn();
const mockUserGroupFindAll = jest.fn();
const mockUserFindOne = jest.fn();
// BINT-01: the route now serializes the JSONB read-modify-write inside a
// sequelize.transaction() with a FOR UPDATE row lock. Expose a mock sequelize
// with a transaction() factory so the mocked-models harness keeps working.
const mockSequelizeTransaction = jest.fn();

jest.mock('../../models', () => ({
  Group: { findByPk: (...a) => mockGroupFindByPk(...a) },
  User: { findOne: (...a) => mockUserFindOne(...a) },
  UserGroup: { findAll: (...a) => mockUserGroupFindAll(...a) },
  GroupPromptSettings: {
    findOne: (...a) => mockSettingsFindOne(...a),
    create: (...a) => mockSettingsCreate(...a)
  },
  Game: {
    findByPk: (...a) => mockGameFindByPk(...a),
    findAll: (...a) => mockGameFindAll(...a)
  },
  Event: {}, // referenced inside the GET route, never invoked here
  sequelize: { transaction: (...a) => mockSequelizeTransaction(...a) }
}));

const express = require('express');
const request = require('supertest');
const groupPromptSettingsRouter = require('../../routes/groupPromptSettings');

function makeApp() {
  const app = express();
  app.use(express.json());
  // The route file is mounted under /api/groups in the real server; replicate.
  app.use('/api/groups', (req, _res, next) => {
    req.user = { user_id: 'auth0|test-user' };
    next();
  }, groupPromptSettingsRouter);
  return app;
}

describe('groupPromptSettings on-write BullMQ hooks', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpsertSingle.mockResolvedValue({ schedulerId: 'prompt-schedule-x', cronPattern: '0 0 18 * * 3' });
    mockRemove.mockResolvedValue(true);

    mockGroupFindByPk.mockResolvedValue({ id: 'group-1', name: 'Test Group' });
    mockUserFindOne.mockResolvedValue({ id: 'user-uuid-1', user_id: 'auth0|test-user' });

    // Default transaction mock: a no-op tx that tracks commit/rollback state.
    mockSequelizeTransaction.mockImplementation(async () => {
      const tx = { LOCK: { UPDATE: 'UPDATE' }, finished: undefined };
      tx.commit = jest.fn(async () => { tx.finished = 'commit'; });
      tx.rollback = jest.fn(async () => { tx.finished = 'rollback'; });
      return tx;
    });

    app = makeApp();
  });

  describe('POST /:group_id/prompt-settings/schedules', () => {
    test('fires upsertSinglePromptScheduler after creating schedule', async () => {
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        schedule_timezone: 'America/Los_Angeles',
        template_config: { schedules: [] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      const res = await request(app)
        .post('/api/groups/group-1/prompt-settings/schedules')
        .send({
          schedule_day_of_week: 3,
          schedule_time: '11:54',
          schedule_timezone: 'America/Los_Angeles',
          game_id: null,
          template_name: 'Wed test'
        });

      expect(res.status).toBe(201);
      expect(mockUpsertSingle).toHaveBeenCalledTimes(1);
      const [calledSettings, calledSchedule] = mockUpsertSingle.mock.calls[0];
      expect(calledSettings).toBe(settingsRow);
      expect(calledSchedule).toMatchObject({
        schedule_day_of_week: 3,
        schedule_time: '11:54',
        is_active: true
      });
      expect(calledSchedule.id).toBeDefined();
    });

    test('does NOT fire upsert when group settings is_active=false', async () => {
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: false, // group has paused prompts entirely
        schedule_timezone: 'America/Los_Angeles',
        template_config: { schedules: [] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      await request(app)
        .post('/api/groups/group-1/prompt-settings/schedules')
        .send({
          schedule_day_of_week: 3,
          schedule_time: '11:54',
          schedule_timezone: 'America/Los_Angeles'
        });

      expect(mockUpsertSingle).not.toHaveBeenCalled();
    });

    test('hook failure does not break the HTTP response', async () => {
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        schedule_timezone: 'America/Los_Angeles',
        template_config: { schedules: [] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);
      mockUpsertSingle.mockRejectedValue(new Error('redis down'));

      const res = await request(app)
        .post('/api/groups/group-1/prompt-settings/schedules')
        .send({
          schedule_day_of_week: 3,
          schedule_time: '11:54',
          schedule_timezone: 'America/Los_Angeles'
        });

      expect(res.status).toBe(201); // route still succeeded
      expect(mockUpsertSingle).toHaveBeenCalled();
    });
  });

  describe('PATCH /:group_id/prompt-settings/schedules/:schedule_id', () => {
    test('upserts when schedule remains active after update', async () => {
      const existingSchedule = {
        id: 'sched-1',
        is_active: true,
        schedule_day_of_week: 3,
        schedule_time: '11:54',
        schedule_timezone: 'America/Los_Angeles',
        game_id: null,
        selected_member_ids: []
      };
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        schedule_timezone: 'America/Los_Angeles',
        template_config: { schedules: [existingSchedule] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      const res = await request(app)
        .patch('/api/groups/group-1/prompt-settings/schedules/sched-1')
        .send({ schedule_time: '12:00' });

      expect(res.status).toBe(200);
      expect(mockUpsertSingle).toHaveBeenCalledTimes(1);
      const [, calledSchedule] = mockUpsertSingle.mock.calls[0];
      expect(calledSchedule.schedule_time).toBe('12:00');
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('removes when update sets is_active=false', async () => {
      const existingSchedule = {
        id: 'sched-1',
        is_active: true,
        schedule_day_of_week: 3,
        schedule_time: '11:54'
      };
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        template_config: { schedules: [existingSchedule] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      await request(app)
        .patch('/api/groups/group-1/prompt-settings/schedules/sched-1')
        .send({ is_active: false });

      expect(mockRemove).toHaveBeenCalledWith('settings-1', 'sched-1');
      expect(mockUpsertSingle).not.toHaveBeenCalled();
    });

    // BSEC-01 / D-05C: mass-assignment guard on the JSONB schedule merge.
    // A non-allow-listed body key must NOT land in template_config.schedules,
    // and must NOT be visible to the downstream scheduler.
    test('does not persist a non-allow-listed key into the JSONB blob', async () => {
      const existingSchedule = {
        id: 'sched-1',
        is_active: true,
        schedule_day_of_week: 3,
        schedule_time: '11:54',
        schedule_timezone: 'America/Los_Angeles',
        game_id: null,
        selected_member_ids: []
      };
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        schedule_timezone: 'America/Los_Angeles',
        template_config: { schedules: [existingSchedule] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      const res = await request(app)
        .patch('/api/groups/group-1/prompt-settings/schedules/sched-1')
        .send({ schedule_time: '12:00', injected_evil_key: 'pwned' });

      expect(res.status).toBe(200);

      // The persisted schedule (what settings.update was called with) must NOT
      // contain the injected key.
      const persistedArg = mockSettingsUpdate.mock.calls[0][0];
      const persistedSchedule = persistedArg.template_config.schedules[0];
      expect(persistedSchedule.injected_evil_key).toBeUndefined();
      expect(persistedSchedule.schedule_time).toBe('12:00');

      // The schedule handed to the scheduler must also be clean.
      const [, calledSchedule] = mockUpsertSingle.mock.calls[0];
      expect(calledSchedule.injected_evil_key).toBeUndefined();
    });

    // BSEC-01 / D-05C: the allow-list must be the UNION of every downstream
    // consumer's fields. Every field the :354-357 branch reads (is_active,
    // deleted_at) AND every field upsertSinglePromptScheduler reads
    // (schedule_day_of_week, schedule_time, schedule_timezone, game_id,
    // default_deadline_hours, default_token_expiry_hours, min_participants,
    // selected_member_ids) MUST survive when legitimately supplied — otherwise
    // jobs silently mis-schedule or the wrong branch fires.
    test('preserves every downstream-consumer field when legitimately supplied', async () => {
      const existingSchedule = {
        id: 'sched-1',
        is_active: true,
        schedule_day_of_week: 1,
        schedule_time: '09:00',
        schedule_timezone: 'UTC',
        game_id: null,
        template_name: 'Old',
        default_deadline_hours: 72,
        default_token_expiry_hours: 168,
        min_participants: null,
        selected_member_ids: [],
        deleted_at: null
      };
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        schedule_timezone: 'UTC',
        template_config: { schedules: [existingSchedule] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      // Supply a new value for every consumer-read field in one PATCH.
      const updates = {
        schedule_day_of_week: 5,
        schedule_time: '18:30',
        schedule_timezone: 'America/New_York',
        game_id: '11111111-1111-1111-1111-111111111111',
        template_name: 'New Template',
        default_deadline_hours: 48,
        default_token_expiry_hours: 96,
        min_participants: 3,
        selected_member_ids: ['m1', 'm2'],
        is_active: true   // branch field — keeps it on the re-register path
      };

      const res = await request(app)
        .patch('/api/groups/group-1/prompt-settings/schedules/sched-1')
        .send(updates);

      expect(res.status).toBe(200);
      // Active branch must have fired (re-register), not the unregister branch.
      expect(mockUpsertSingle).toHaveBeenCalledTimes(1);
      expect(mockRemove).not.toHaveBeenCalled();

      const [, calledSchedule] = mockUpsertSingle.mock.calls[0];
      // Every consumer-read field survived the allow-list pick.
      expect(calledSchedule.schedule_day_of_week).toBe(5);
      expect(calledSchedule.schedule_time).toBe('18:30');
      expect(calledSchedule.schedule_timezone).toBe('America/New_York');
      expect(calledSchedule.game_id).toBe('11111111-1111-1111-1111-111111111111');
      expect(calledSchedule.template_name).toBe('New Template');
      expect(calledSchedule.default_deadline_hours).toBe(48);
      expect(calledSchedule.default_token_expiry_hours).toBe(96);
      expect(calledSchedule.min_participants).toBe(3);
      expect(calledSchedule.selected_member_ids).toEqual(['m1', 'm2']);
      expect(calledSchedule.is_active).toBe(true);
    });

    // BSEC-01 / D-05C: the deleted_at branch field is allow-listed — supplying
    // it must route to the unregister branch (proves the branch sees it).
    test('honors deleted_at (branch field) routing to unregister', async () => {
      const existingSchedule = {
        id: 'sched-1',
        is_active: true,
        schedule_day_of_week: 3,
        schedule_time: '11:54'
      };
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        template_config: { schedules: [existingSchedule] },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      await request(app)
        .patch('/api/groups/group-1/prompt-settings/schedules/sched-1')
        .send({ deleted_at: new Date().toISOString() });

      // deleted_at survived the allow-list -> :354-357 branch chose unregister.
      expect(mockRemove).toHaveBeenCalledWith('settings-1', 'sched-1');
      expect(mockUpsertSingle).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:group_id/prompt-settings/schedules/:schedule_id', () => {
    test('always removes from BullMQ on delete', async () => {
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        template_config: {
          schedules: [{ id: 'sched-1', is_active: true, schedule_day_of_week: 3, schedule_time: '11:54' }]
        },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      await request(app)
        .delete('/api/groups/group-1/prompt-settings/schedules/sched-1');

      expect(mockRemove).toHaveBeenCalledWith('settings-1', 'sched-1');
      expect(mockUpsertSingle).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:group_id/prompt-settings/schedules/:schedule_id/toggle', () => {
    test('upserts when toggling from paused -> active', async () => {
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        template_config: {
          schedules: [{ id: 'sched-1', is_active: false, schedule_day_of_week: 3, schedule_time: '11:54' }]
        },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      await request(app)
        .patch('/api/groups/group-1/prompt-settings/schedules/sched-1/toggle');

      expect(mockUpsertSingle).toHaveBeenCalledTimes(1);
      const [, calledSchedule] = mockUpsertSingle.mock.calls[0];
      expect(calledSchedule.is_active).toBe(true);
      expect(mockRemove).not.toHaveBeenCalled();
    });

    test('removes when toggling from active -> paused', async () => {
      const settingsRow = {
        id: 'settings-1',
        group_id: 'group-1',
        is_active: true,
        template_config: {
          schedules: [{ id: 'sched-1', is_active: true, schedule_day_of_week: 3, schedule_time: '11:54' }]
        },
        update: mockSettingsUpdate
      };
      mockSettingsFindOne.mockResolvedValue(settingsRow);
      mockSettingsUpdate.mockResolvedValue(settingsRow);

      await request(app)
        .patch('/api/groups/group-1/prompt-settings/schedules/sched-1/toggle');

      expect(mockRemove).toHaveBeenCalledWith('settings-1', 'sched-1');
      expect(mockUpsertSingle).not.toHaveBeenCalled();
    });
  });

  // BINT-01 (T-87-09): two admins adding schedules at the same time must BOTH
  // persist — the classic JSONB read-modify-write lost-update. The route guards
  // this with SELECT ... FOR UPDATE inside a transaction. This test emulates the
  // row lock with an async mutex acquired by findOne({ lock }) and released on
  // commit/rollback, plus a stateful store the route reads and writes back. With
  // the lock the second writer reads the first writer's committed state (both
  // persist); without it the two writers would clobber each other.
  //
  // NOTE: real serialization verification happens on PR CI Postgres — this is the
  // mocked-harness proxy that proves the route acquires+holds+releases the lock
  // across the whole read-modify-write and writes the whole recomputed array.
  describe('concurrent schedule adds (BINT-01 no-lost-update)', () => {
    test('two concurrent schedule adds both persist (no clobber)', async () => {
      // Server-side persisted state (emulates the settings row JSONB column),
      // seeded with one existing schedule.
      const store = {
        template_config: {
          schedules: [{ id: 'seed', schedule_day_of_week: 0, schedule_time: '10:00', is_active: true }]
        }
      };

      // Async mutex emulating a Postgres FOR UPDATE row lock: only one
      // transaction may hold the settings row at a time.
      let locked = false;
      const waiters = [];
      const acquire = () => new Promise((resolve) => {
        const attempt = () => {
          if (!locked) { locked = true; resolve(); }
          else { waiters.push(attempt); }
        };
        attempt();
      });
      const release = () => {
        locked = false;
        const next = waiters.shift();
        if (next) next();
      };

      // transaction() releases the mutex on commit/rollback.
      mockSequelizeTransaction.mockImplementation(async () => {
        const tx = { LOCK: { UPDATE: 'UPDATE' }, finished: undefined, _released: false };
        const doRelease = () => { if (!tx._released) { tx._released = true; release(); } };
        tx.commit = jest.fn(async () => { tx.finished = 'commit'; doRelease(); });
        tx.rollback = jest.fn(async () => { tx.finished = 'rollback'; doRelease(); });
        return tx;
      });

      // findOne WITH a lock option acquires the mutex (SELECT ... FOR UPDATE)
      // before returning a row snapshot; update() writes the whole recomputed
      // template_config back to the shared store.
      mockSettingsFindOne.mockImplementation(async (opts) => {
        if (opts && opts.lock) {
          await acquire();
        }
        const row = {
          id: 'settings-1',
          group_id: 'group-1',
          is_active: true,
          schedule_timezone: 'UTC',
          // snapshot of currently-persisted state
          template_config: {
            ...store.template_config,
            schedules: [...store.template_config.schedules]
          },
          update: async (values) => {
            store.template_config = values.template_config;
            return row;
          }
        };
        return row;
      });

      const addReq = (time) => request(app)
        .post('/api/groups/group-1/prompt-settings/schedules')
        .send({
          schedule_day_of_week: 3,
          schedule_time: time,
          schedule_timezone: 'UTC',
          template_name: `template-${time}`
        });

      const [r1, r2] = await Promise.all([addReq('11:00'), addReq('12:00')]);

      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);

      // Re-fetch: the final persisted array must contain the seed + BOTH adds.
      const finalSchedules = store.template_config.schedules;
      expect(finalSchedules).toHaveLength(3);
      const times = finalSchedules.map((s) => s.schedule_time);
      expect(times).toContain('11:00');
      expect(times).toContain('12:00');
      expect(times).toContain('10:00'); // seed survived
    });
  });
});
