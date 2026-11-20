// tests/unit/schedulerStart.test.js
// quick-261119-w61 R-1: a scheduler module must NOT run its job just because it was loaded.
//
// WHY THIS FILE EXISTS. server.js loads three of the four cron schedulers at the top of the
// file, long before it reads ENABLE_SCHEDULER or DISABLE_BACKGROUND_JOBS, and
// workers/deadlineWorker.js loads the deadline scheduler too. In node-cron 4, schedule()
// always starts the task: the old `scheduled: false` option is not read at all. Built that
// way, the deadline check, the reminder texts and the auto-promotion ran on every boot, in
// every environment, whatever the switches said, and the boot log still printed "disabled".
// The four modules therefore build their task with createTask(), which registers it and
// leaves it stopped until server.js calls .start() behind its gate.
//
// A red run here means a cron runs at load time again: the off switch (config/backgroundJobs.js)
// no longer stops it, and a local or staging server starts closing polls and sending reminder
// texts against whatever database it is pointed at. It is never a reason to relax a case.
//
// What is pinned, with the REAL node-cron and its own status API (getStatus, getNextRun):
//   C1  the status API tells a started task from a stopped one, and the trap is real
//       (anti-vacuity: "stopped" below means something);
//   C2  after require, each of the four tasks is stopped, and four tasks were registered;
//   C3  with the clock run across a moment at which all four are due, no job body runs;
//   C4  after start(), each task is running and its job body runs when due;
//   C5  after stop(), it is stopped again and its job body no longer runs.
//
// DB-free lane: no database, no Redis, no network, no child process. The scheduler modules
// load models and services at the top, so those are replaced with jest.mock below (models,
// promptLifecycleService, schedulerHealthService, smsService, notificationService). The
// mocked recordRun never calls the job's inner function, so no job does any work here.

const cron = require('node-cron');

const mockRecordRun = jest.fn(async () => undefined);

jest.mock('../../models', () => ({
  AvailabilityPrompt: {},
  UserGroup: {},
  Event: {},
  EventRsvp: {},
  User: {},
  Game: {},
  Group: {},
}));
jest.mock('../../services/promptLifecycleService', () => ({ handlePromptClosed: jest.fn() }));
jest.mock('../../services/schedulerHealthService', () => ({
  recordRun: (...args) => mockRecordRun(...args),
}));
jest.mock('../../services/smsService', () => ({
  send: jest.fn(),
  isConfigured: jest.fn(() => false),
}));
jest.mock('../../services/notificationService', () => ({ getPreference: jest.fn(() => false) }));

// The four cron schedulers. `runName` is the name each job passes to recordRun, which is how
// this file sees that a job body ran.
const SCHEDULERS = [
  {
    file: 'deadlineScheduler',
    exportName: 'deadlineJob',
    runName: 'deadline',
    load: () => require('../../schedulers/deadlineScheduler'),
  },
  {
    file: 'autoPromotionScheduler',
    exportName: 'autoPromotionJob',
    runName: 'auto_promotion',
    load: () => require('../../schedulers/autoPromotionScheduler'),
  },
  {
    file: 'reminderScheduler',
    exportName: 'reminderJob',
    runName: 'reminder',
    load: () => require('../../schedulers/reminderScheduler'),
  },
  {
    file: 'backupScheduler',
    exportName: 'backupJob',
    runName: 'backup',
    load: () => require('../../schedulers/backupScheduler'),
  },
];

// A Sunday, a little under ten minutes before 02:00 UTC. Within the next twenty minutes every
// one of the four schedules is due at least once: every 5 minutes (deadline, reminder), every
// 15 minutes (auto-promotion), and Sundays at 02:00 UTC (backup).
// The thirty seconds are deliberate: each clock step below must END between two due times.
// A step that ends exactly on a due time leaves that run half done (the fake clock stops
// before node-cron's inner zero-delay timer), and the counts below would be off by one.
const START = new Date('2026-01-04T01:50:30.000Z');
const TWENTY_MINUTES = 20 * 60 * 1000;

// Names the modules read at load time. Removed for this file so the default schedules apply
// (and so backupScheduler does not load Sentry), then put back exactly.
const ENV_NAMES = [
  'DEADLINE_CHECK_INTERVAL',
  'AUTO_PROMOTE_INTERVAL',
  'REMINDER_CHECK_INTERVAL',
  'SENTRY_DSN',
];

describe('R-1: the four cron schedulers do not run until start() is called', () => {
  const jobs = {};
  let savedEnv;
  let tasksBeforeRequire;
  let logSpy;

  function ranNames() {
    return mockRecordRun.mock.calls.map((call) => call[0]);
  }

  beforeAll(() => {
    savedEnv = {};
    for (const name of ENV_NAMES) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    // The job bodies print a "Running ... check" line each time they run. Keep the output quiet.
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Fake clock BEFORE the modules load: if a module starts its task at load, the fake clock
    // is what drives it, and C3 sees the job body run.
    jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate'] });

    tasksBeforeRequire = cron.getTasks().size;
    for (const scheduler of SCHEDULERS) {
      jobs[scheduler.file] = scheduler.load()[scheduler.exportName];
    }
  });

  afterAll(() => {
    for (const job of Object.values(jobs)) {
      if (job && typeof job.destroy === 'function') job.destroy();
    }
    jest.useRealTimers();
    logSpy.mockRestore();
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  describe('C1: the status API is real and the node-cron 4 trap is real (anti-vacuity)', () => {
    it('is the real node-cron, with createTask', () => {
      expect(jest.isMockFunction(cron.schedule)).toBe(false);
      expect(typeof cron.createTask).toBe('function');
      expect(typeof cron.getTasks).toBe('function');
    });

    it('createTask leaves a task stopped; start() makes it idle; stop() stops it again', () => {
      const task = cron.createTask('0 0 1 1 *', () => {}, { timezone: 'UTC' });
      try {
        expect(task.getStatus()).toBe('stopped');
        expect(task.getNextRun()).toBeNull();
        task.start();
        expect(task.getStatus()).toBe('idle');
        expect(task.getNextRun()).toBeInstanceOf(Date);
        task.stop();
        expect(task.getStatus()).toBe('stopped');
      } finally {
        task.destroy();
      }
    });

    it('schedule() starts the task at once, even with scheduled: false (the trap)', () => {
      // If this goes red after a node-cron upgrade, the library changed. The schedulers keep
      // createTask until somebody decides otherwise (DECISION quick-261119-w61 R1).
      const task = cron.schedule('0 0 1 1 *', () => {}, { scheduled: false, timezone: 'UTC' });
      try {
        expect(task.getStatus()).toBe('idle');
        expect(task.getNextRun()).toBeInstanceOf(Date);
      } finally {
        task.destroy();
      }
    });
  });

  describe('C2: after require, nothing is running', () => {
    it('loaded all four job objects (anti-vacuity)', () => {
      expect(SCHEDULERS).toHaveLength(4);
      for (const scheduler of SCHEDULERS) {
        const job = jobs[scheduler.file];
        expect(job).toBeDefined();
        expect(typeof job.start).toBe('function');
        expect(typeof job.getStatus).toBe('function');
      }
    });

    it.each(SCHEDULERS.map((s) => [s.file, s]))(
      '%s: its task is stopped after require',
      (_file, scheduler) => {
        const job = jobs[scheduler.file];
        expect(job.getStatus()).toBe('stopped');
        expect(job.getNextRun()).toBeNull();
      }
    );

    it('the four modules registered exactly four tasks with node-cron, every one stopped', () => {
      const tasks = [...cron.getTasks().values()];
      expect(tasks.length - tasksBeforeRequire).toBe(4);
      expect(tasks.map((task) => task.getStatus())).toEqual(tasks.map(() => 'stopped'));
    });
  });

  describe('C3: before start(), no job body runs, even across a moment when all four are due', () => {
    it('twenty minutes across Sunday 02:00 UTC: recordRun is never called', async () => {
      await jest.advanceTimersByTimeAsync(TWENTY_MINUTES);
      expect(new Date().toISOString()).toBe('2026-01-04T02:10:30.000Z');
      expect(ranNames()).toEqual([]);
    });
  });

  describe('C4: after start(), each task runs', () => {
    it.each(SCHEDULERS.map((s) => [s.file, s]))(
      '%s: start() makes its task running, with a next run time',
      (_file, scheduler) => {
        const job = jobs[scheduler.file];
        job.start();
        expect(job.getStatus()).toBe('idle');
        expect(job.getNextRun()).toBeInstanceOf(Date);
      }
    );

    it('the next twenty minutes run the deadline, reminder and auto-promotion job bodies', async () => {
      mockRecordRun.mockClear();
      await jest.advanceTimersByTimeAsync(TWENTY_MINUTES);
      const names = ranNames();
      // 02:15, 02:20, 02:25, 02:30 for the five-minute jobs; 02:15 and 02:30 for auto-promotion.
      expect(names.filter((name) => name === 'deadline')).toHaveLength(4);
      expect(names.filter((name) => name === 'reminder')).toHaveLength(4);
      expect(names.filter((name) => name === 'auto_promotion')).toHaveLength(2);
      expect(names.filter((name) => name === 'backup')).toHaveLength(0);
    });

    it('a second start() on a running task changes nothing (no double firing)', async () => {
      for (const scheduler of SCHEDULERS) jobs[scheduler.file].start();
      mockRecordRun.mockClear();
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
      // One five-minute mark (02:35): one deadline run and one reminder run, not two of each.
      expect(ranNames().sort()).toEqual(['deadline', 'reminder']);
    });

    it('the backup job body runs when the following Sunday 02:00 UTC arrives (timezone honoured)', async () => {
      // Proven by running the clock, not by getNextRun(): for a weekday schedule node-cron
      // 4.2.1 reports a next run that is too far away (the first Sunday of the next month),
      // while the task itself still fires every Sunday. Only the firing is pinned here.
      // Stop the three frequent jobs so a week of clock is a handful of timers, not thousands.
      for (const file of ['deadlineScheduler', 'autoPromotionScheduler', 'reminderScheduler']) {
        jobs[file].stop();
      }
      mockRecordRun.mockClear();
      const untilJustAfter = new Date('2026-01-11T02:00:30.000Z').getTime() - Date.now();
      await jest.advanceTimersByTimeAsync(untilJustAfter);
      expect(ranNames()).toEqual(['backup']);
    });
  });

  describe('C5: after stop(), each task is stopped and its job body no longer runs', () => {
    it.each(SCHEDULERS.map((s) => [s.file, s]))('%s: stop() stops its task', (_file, scheduler) => {
      const job = jobs[scheduler.file];
      job.stop();
      expect(job.getStatus()).toBe('stopped');
      expect(job.getNextRun()).toBeNull();
    });

    it('eight more days of clock: recordRun is never called', async () => {
      mockRecordRun.mockClear();
      await jest.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
      expect(ranNames()).toEqual([]);
    });
  });
});
