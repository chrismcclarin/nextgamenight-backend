// tests/unit/backgroundJobs.test.js
// quick-261119-w61: guards owner ruling N1 = A, the one off switch for every scheduled job,
// sweep and BullMQ worker (config/backgroundJobs.js, read by server.js at boot).
//
// WHY THIS FILE EXISTS. The switch has two ways to go wrong, and both are silent:
//   - it could turn PRODUCTION's jobs off (no reminders, no sweeps, no alarm for silent jobs)
//     if anything other than the exact value '1' counted, or if a start decision drifted from
//     the condition production has always used;
//   - it could leave STAGING's jobs on during its first deploy, when a wrong variable would
//     point them at the live database and the live queue.
// A red run here means one of those two is now possible. It is never a reason to relax a
// case: fix the code, or bring the change to the owner as a decision.
//
// What is pinned:
//   T1  switch unset or a near-miss: every start decision equals the OLD inline condition,
//       which this file writes out itself as its oracle (it does not ask the helper);
//   T2  switch exactly '1': nothing starts, production mode included;
//   T3  only the exact string '1' is the switch;
//   T4  called with no argument, the functions read process.env;
//   T5  the helper loads nothing, and its message names the variable;
//   S1  server.js, read as TEXT and never loaded (loading it needs Postgres): the condition
//       lives only in the helper, and every log line production prints today is still there,
//       letter for letter;
//   R1  docs/staging-environment.md quotes the off message word for word and carries the
//       "Never on production" entry.
//
// DB-free lane: no database, no Redis, no network.

const fs = require('fs');
const path = require('path');

const HELPER_PATH = path.join(__dirname, '..', '..', 'config', 'backgroundJobs.js');
const SERVER_PATH = path.join(__dirname, '..', '..', 'server.js');

const {
  BACKGROUND_JOBS_OFF_MESSAGE,
  backgroundJobsDisabled,
  schedulersEnabled,
  workersEnabled,
} = require('../../config/backgroundJobs');

const UNSET = Symbol('unset');

const NODE_ENVS = ['production', 'development', 'test', UNSET, 'Production'];
const ENABLE_VALUES = ['true', UNSET, 'false', 'TRUE'];
// Everything that is NOT the switch. Each of these must behave exactly like "unset".
const NEAR_MISSES = ['', '0', 'true', 'TRUE', 'yes', 'on', ' 1', '1 ', '01', '1.0'];

function buildEnv({ nodeEnv, scheduler, workers, disable }) {
  const env = {};
  if (nodeEnv !== UNSET) env.NODE_ENV = nodeEnv;
  if (scheduler !== UNSET) env.ENABLE_SCHEDULER = scheduler;
  if (workers !== UNSET) env.ENABLE_WORKERS = workers;
  if (disable !== UNSET) env.DISABLE_BACKGROUND_JOBS = disable;
  return env;
}

function show(value) {
  return value === UNSET ? '<unset>' : JSON.stringify(value);
}

function describeCase(c) {
  return `NODE_ENV=${show(c.nodeEnv)} ENABLE_SCHEDULER=${show(c.scheduler)} ENABLE_WORKERS=${show(c.workers)} DISABLE_BACKGROUND_JOBS=${show(c.disable)}`;
}

// THE ORACLE. These two lines are the conditions server.js carried inline at every start
// site before this change. They are written out here on purpose and must never be replaced
// by a call into the helper: the point is that the helper agrees with THEM.
function oldSchedulerCondition(env) {
  return env.NODE_ENV === 'production' || env.ENABLE_SCHEDULER === 'true';
}
function oldWorkerCondition(env) {
  return env.NODE_ENV === 'production' || env.ENABLE_WORKERS === 'true';
}

function everyCase(disableValues) {
  const cases = [];
  for (const nodeEnv of NODE_ENVS) {
    for (const scheduler of ENABLE_VALUES) {
      for (const workers of ENABLE_VALUES) {
        for (const disable of disableValues) {
          cases.push({ nodeEnv, scheduler, workers, disable });
        }
      }
    }
  }
  return cases;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('T1: switch unset or a near-miss, every start decision is the old condition', () => {
  const cases = everyCase([UNSET, ...NEAR_MISSES]);

  it('covers the whole table (anti-vacuity)', () => {
    // 5 NODE_ENV x 4 ENABLE_SCHEDULER x 4 ENABLE_WORKERS x (unset + 10 near-misses)
    expect(cases).toHaveLength(5 * 4 * 4 * 11);
    // The oracle really has both answers in the table; a table of all-false proves nothing.
    expect(cases.some((c) => oldSchedulerCondition(buildEnv(c)))).toBe(true);
    expect(cases.some((c) => !oldSchedulerCondition(buildEnv(c)))).toBe(true);
    expect(cases.some((c) => oldWorkerCondition(buildEnv(c)))).toBe(true);
    expect(cases.some((c) => !oldWorkerCondition(buildEnv(c)))).toBe(true);
  });

  it('schedulersEnabled(env) equals NODE_ENV === production OR ENABLE_SCHEDULER === true', () => {
    const wrong = cases
      .filter((c) => schedulersEnabled(buildEnv(c)) !== oldSchedulerCondition(buildEnv(c)))
      .map(describeCase);
    expect(wrong).toEqual([]);
  });

  it('workersEnabled(env) equals NODE_ENV === production OR ENABLE_WORKERS === true', () => {
    const wrong = cases
      .filter((c) => workersEnabled(buildEnv(c)) !== oldWorkerCondition(buildEnv(c)))
      .map(describeCase);
    expect(wrong).toEqual([]);
  });

  it('returns real booleans, never a truthy string', () => {
    const notBoolean = cases
      .filter((c) => {
        const env = buildEnv(c);
        return typeof schedulersEnabled(env) !== 'boolean' || typeof workersEnabled(env) !== 'boolean';
      })
      .map(describeCase);
    expect(notBoolean).toEqual([]);
  });

  it('production with nothing else set starts both (the live site today)', () => {
    const env = { NODE_ENV: 'production' };
    expect(backgroundJobsDisabled(env)).toBe(false);
    expect(schedulersEnabled(env)).toBe(true);
    expect(workersEnabled(env)).toBe(true);
  });

  it('a mistyped NODE_ENV does not count as production (unchanged from before)', () => {
    expect(schedulersEnabled({ NODE_ENV: 'Production' })).toBe(false);
    expect(workersEnabled({ NODE_ENV: 'Production' })).toBe(false);
  });
});

describe("T2: DISABLE_BACKGROUND_JOBS exactly '1' stops everything, production included", () => {
  const cases = everyCase(['1']);

  it('covers the whole table (anti-vacuity)', () => {
    expect(cases).toHaveLength(5 * 4 * 4);
    // Without the switch, some of these cases DO start jobs. Otherwise "all false" is empty.
    const withoutSwitch = cases.map((c) => buildEnv({ ...c, disable: UNSET }));
    expect(withoutSwitch.some((env) => oldSchedulerCondition(env))).toBe(true);
    expect(withoutSwitch.some((env) => oldWorkerCondition(env))).toBe(true);
  });

  it('schedulersEnabled is false in every case', () => {
    const started = cases.filter((c) => schedulersEnabled(buildEnv(c)) !== false).map(describeCase);
    expect(started).toEqual([]);
  });

  it('workersEnabled is false in every case', () => {
    const started = cases.filter((c) => workersEnabled(buildEnv(c)) !== false).map(describeCase);
    expect(started).toEqual([]);
  });

  it('production mode with both ENABLE_ variables true still starts nothing', () => {
    const env = {
      NODE_ENV: 'production',
      ENABLE_SCHEDULER: 'true',
      ENABLE_WORKERS: 'true',
      DISABLE_BACKGROUND_JOBS: '1',
    };
    expect(backgroundJobsDisabled(env)).toBe(true);
    expect(schedulersEnabled(env)).toBe(false);
    expect(workersEnabled(env)).toBe(false);
  });
});

describe("T3: only the exact string '1' is the switch", () => {
  it("'1' turns it on", () => {
    expect(backgroundJobsDisabled({ DISABLE_BACKGROUND_JOBS: '1' })).toBe(true);
  });

  it.each(NEAR_MISSES.map((value) => [JSON.stringify(value), value]))(
    '%s does not turn it on',
    (_label, value) => {
      expect(backgroundJobsDisabled({ DISABLE_BACKGROUND_JOBS: value })).toBe(false);
    }
  );

  it('an unset variable does not turn it on', () => {
    expect(backgroundJobsDisabled({})).toBe(false);
  });

  it('the number 1 does not turn it on (environment values are always strings)', () => {
    expect(backgroundJobsDisabled({ DISABLE_BACKGROUND_JOBS: 1 })).toBe(false);
  });
});

describe('T4: with no argument the functions read process.env', () => {
  const NAMES = ['NODE_ENV', 'ENABLE_SCHEDULER', 'ENABLE_WORKERS', 'DISABLE_BACKGROUND_JOBS'];
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
    for (const name of NAMES) delete process.env[name];
  });

  afterEach(() => {
    // Restore exactly: remove what the test added, put back what it removed or changed.
    for (const name of Object.keys(process.env)) {
      if (!(name in saved)) delete process.env[name];
    }
    for (const [name, value] of Object.entries(saved)) {
      process.env[name] = value;
    }
  });

  it('nothing set: nothing starts, and the switch is off', () => {
    expect(backgroundJobsDisabled()).toBe(false);
    expect(schedulersEnabled()).toBe(false);
    expect(workersEnabled()).toBe(false);
  });

  it('NODE_ENV=production in process.env starts both', () => {
    process.env.NODE_ENV = 'production';
    expect(schedulersEnabled()).toBe(true);
    expect(workersEnabled()).toBe(true);
  });

  it('ENABLE_SCHEDULER=true in process.env starts schedulers only', () => {
    process.env.ENABLE_SCHEDULER = 'true';
    expect(schedulersEnabled()).toBe(true);
    expect(workersEnabled()).toBe(false);
  });

  it('ENABLE_WORKERS=true in process.env starts workers only', () => {
    process.env.ENABLE_WORKERS = 'true';
    expect(schedulersEnabled()).toBe(false);
    expect(workersEnabled()).toBe(true);
  });

  it('DISABLE_BACKGROUND_JOBS=1 in process.env stops both under production', () => {
    process.env.NODE_ENV = 'production';
    process.env.DISABLE_BACKGROUND_JOBS = '1';
    expect(backgroundJobsDisabled()).toBe(true);
    expect(schedulersEnabled()).toBe(false);
    expect(workersEnabled()).toBe(false);
  });
});

describe('T5: the helper is pure and its message names the variable', () => {
  const helperSource = fs.readFileSync(HELPER_PATH, 'utf8');

  it('loads nothing: the helper source has no require call', () => {
    expect(helperSource.length).toBeGreaterThan(0);
    expect(helperSource).not.toMatch(/\brequire\s*\(/);
  });

  it('exports exactly the three functions and the message', () => {
    expect(Object.keys(require('../../config/backgroundJobs')).sort()).toEqual(
      ['BACKGROUND_JOBS_OFF_MESSAGE', 'backgroundJobsDisabled', 'schedulersEnabled', 'workersEnabled']
    );
  });

  it('the off message is one line that names the variable and says OFF', () => {
    expect(typeof BACKGROUND_JOBS_OFF_MESSAGE).toBe('string');
    expect(BACKGROUND_JOBS_OFF_MESSAGE).toContain('DISABLE_BACKGROUND_JOBS');
    expect(BACKGROUND_JOBS_OFF_MESSAGE).toContain('OFF');
    expect(BACKGROUND_JOBS_OFF_MESSAGE).not.toMatch(/[\r\n]/);
  });

  it('carries the decision marker, so the strict compare is not tidied away', () => {
    expect(helperSource).toContain('DECISION quick-261119-w61');
  });
});

describe('S1: server.js start sites (read as text, never loaded)', () => {
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const listenAt = src.indexOf('app.listen(PORT');

  // Copied from server.js as it stood before this change (backend main at b71afd3).
  // Production prints exactly these seven lines at every boot.
  const STARTED_LINES = [
    "console.log('Deadline scheduler started (node-cron)');",
    "console.log('Backup scheduler started (weekly, Sundays 2am UTC)');",
    "console.log('Auto-promotion scheduler started (every 15 min)');",
    "console.log('Reminder scheduler started (every 5 min, SMS reminders)');",
    "console.log('Scheduler anomaly sweep started (every 30 min)');",
    "console.log('PendingAuth0Deletion reconciliation sweep started (every 30 min)');",
    "console.log('Group purge sweep started (daily 03:00 UTC)');",
  ];
  // The two lines a non-production run prints when the ENABLE_ variables are not set.
  const DISABLED_LINES = [
    "console.log('Deadline scheduler disabled (set ENABLE_SCHEDULER=true to enable)');",
    "console.log('BullMQ workers disabled (set ENABLE_WORKERS=true to enable)');",
  ];

  const SCHEDULER_SITE = 'if (schedulersOn) {';
  const WORKER_SITE = 'if (workersOn) {';

  it('has the listen callback (anti-vacuity: this is the file with the start sites)', () => {
    expect(listenAt).toBeGreaterThan(-1);
    expect(count(src, 'app.listen(PORT')).toBe(1);
  });

  it('reads no ENABLE_ variable itself, in code or in a comment', () => {
    expect(src).not.toMatch(/process\.env\.ENABLE_/);
    expect(src).not.toMatch(/process\.env\[\s*['"`]ENABLE_/);
    expect(src).not.toMatch(/process\.env\.DISABLE_BACKGROUND_JOBS/);
  });

  it('loads the helper exactly once', () => {
    expect(count(src, "require('./config/backgroundJobs')")).toBe(1);
  });

  it('computes jobsOff, schedulersOn and workersOn once each, inside the listen callback', () => {
    const lines = [
      'const jobsOff = backgroundJobsDisabled(process.env);',
      'const schedulersOn = schedulersEnabled(process.env);',
      'const workersOn = workersEnabled(process.env);',
    ];
    for (const line of lines) {
      expect(count(src, line)).toBe(1);
      expect(src.indexOf(line)).toBeGreaterThan(listenAt);
      expect(src.indexOf(line)).toBeLessThan(src.indexOf(SCHEDULER_SITE));
    }
  });

  it('has exactly 7 scheduler sites and 2 worker sites, all after app.listen', () => {
    expect(count(src, SCHEDULER_SITE)).toBe(7);
    expect(count(src, WORKER_SITE)).toBe(2);
    expect(src.indexOf(SCHEDULER_SITE)).toBeGreaterThan(listenAt);
    expect(src.indexOf(WORKER_SITE)).toBeGreaterThan(listenAt);
  });

  it('each scheduler start still sits directly behind a scheduler site', () => {
    // The seven things the scheduler sites start. Each must be reachable only through one.
    const starts = [
      'deadlineJob.start();',
      'backupJob.start();',
      'autoPromotionJob.start();',
      'reminderJob.start();',
      "require('./services/schedulerHealthService')",
      "require('./services/pendingAuth0DeletionSweep')",
      "require('./services/groupPurgeSweep')",
    ];
    for (const start of starts) {
      expect(count(src, start)).toBe(1);
      const before = src.slice(listenAt, src.indexOf(start));
      const lastScheduler = before.lastIndexOf(SCHEDULER_SITE);
      const lastWorker = before.lastIndexOf(WORKER_SITE);
      expect(lastScheduler).toBeGreaterThan(-1);
      // The nearest gate above it is a scheduler gate, and no other `if (` sits between.
      expect(lastScheduler).toBeGreaterThan(lastWorker);
      expect(before.slice(lastScheduler + SCHEDULER_SITE.length)).not.toMatch(/\bif \(/);
    }
  });

  it('each worker start still sits directly behind a worker site', () => {
    const starts = ["require('./workers')", "require('./routes/bullBoard')"];
    for (const start of starts) {
      expect(count(src, start)).toBe(1);
      const before = src.slice(listenAt, src.indexOf(start));
      const lastScheduler = before.lastIndexOf(SCHEDULER_SITE);
      const lastWorker = before.lastIndexOf(WORKER_SITE);
      expect(lastWorker).toBeGreaterThan(-1);
      expect(lastWorker).toBeGreaterThan(lastScheduler);
      expect(before.slice(lastWorker + WORKER_SITE.length)).not.toMatch(/\bif \(/);
    }
  });

  it('prints the off line once, behind jobsOff, before anything could start', () => {
    const offLog = 'console.log(BACKGROUND_JOBS_OFF_MESSAGE);';
    expect(count(src, offLog)).toBe(1);
    expect(src.indexOf(offLog)).toBeGreaterThan(listenAt);
    expect(src.indexOf(offLog)).toBeLessThan(src.indexOf(SCHEDULER_SITE));
    expect(src).toMatch(/if \(jobsOff\) \{\s*\n\s*console\.log\(BACKGROUND_JOBS_OFF_MESSAGE\);/);
  });

  it('sends one Sentry warning with the same message, before anything could start', () => {
    const capture = "captureMessage(BACKGROUND_JOBS_OFF_MESSAGE, 'warning')";
    expect(count(src, capture)).toBe(1);
    expect(src.indexOf(capture)).toBeGreaterThan(src.indexOf('console.log(BACKGROUND_JOBS_OFF_MESSAGE);'));
    expect(src.indexOf(capture)).toBeLessThan(src.indexOf(SCHEDULER_SITE));
    // Only where Sentry is set up; staging deletes its DSN, so Sentry is null there.
    expect(src).toMatch(/if \(Sentry\) \{[^}]*captureMessage\(BACKGROUND_JOBS_OFF_MESSAGE, 'warning'\)/);
  });

  it('keeps the seven "started" lines, each once, letter for letter', () => {
    for (const line of STARTED_LINES) {
      expect(count(src, line)).toBe(1);
      expect(src.indexOf(line)).toBeGreaterThan(listenAt);
    }
  });

  it('keeps the two "disabled" lines, each once, directly inside an else-if-not-jobsOff', () => {
    expect(count(src, '} else if (!jobsOff) {')).toBe(2);
    for (const line of DISABLED_LINES) {
      expect(count(src, line)).toBe(1);
      const at = src.indexOf(line);
      const before = src.slice(0, at);
      // Nothing but whitespace between the branch opener and the line.
      expect(before).toMatch(/\} else if \(!jobsOff\) \{\s*\n\s*$/);
    }
  });

  it('has no plain else left in the listen callback (the switch must not print an "enable" hint)', () => {
    const end = src.indexOf("console.error('Unable to start server:'");
    expect(end).toBeGreaterThan(listenAt);
    expect(src.slice(listenAt, end)).not.toMatch(/\} else \{/);
  });
});

describe('R1: the staging runbook and the code say the same thing', () => {
  // The owner reads the staging deploy log for ONE line and compares it with the runbook by
  // eye. If the message in the code and the line quoted in the runbook drift apart, he is
  // told to look for a line that never appears, and removes a healthy deployment (or, worse,
  // stops trusting the check). Change the message and the runbook together.
  const RUNBOOK_PATH = path.join(__dirname, '..', '..', 'docs', 'staging-environment.md');
  const runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');

  it('is the staging runbook (anti-vacuity)', () => {
    expect(runbook).toContain('# Staging: setting it up, seeding it, and proving the live site was not touched');
  });

  it('quotes the off message word for word', () => {
    expect(runbook).toContain(BACKGROUND_JOBS_OFF_MESSAGE);
  });

  it('quotes the off message on a line of its own, as the log prints it', () => {
    const ownLine = runbook
      .split('\n')
      .some((line) => line.replace(/^>\s?/, '') === BACKGROUND_JOBS_OFF_MESSAGE);
    expect(ownLine).toBe(true);
  });

  it('carries the Never entry for production', () => {
    expect(runbook).toContain('- Never add `DISABLE_BACKGROUND_JOBS` to production.');
  });

  it('tells the owner the exact value', () => {
    expect(runbook).toContain('Add `DISABLE_BACKGROUND_JOBS` with the value `1`');
  });
});
