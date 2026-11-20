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
//   T5  the helper loads nothing, and its message names the variable and shares no words
//       with a real "started" boot line (review R-3);
//   S1  server.js, read as TEXT and never loaded (loading it needs Postgres): the condition
//       lives only in the helper, and every log line production prints today is still there,
//       letter for letter;
//   S2  server.js as text again (review R-2): inside the listen callback every require and
//       every start call sits inside a gate and nothing else is called outside the gates;
//       outside the callback nothing loads or calls a starter;
//   S3  schedulers/ as text (review R-1, R-2): no module there can start its own task (no
//       schedule(), no .start()), and node-cron is loaded only by those modules and server.js;
//       and across the whole app (scoped check S-1): bullmq is loaded and a Worker is built
//       only under workers/ (queues/ loads bullmq for its queues), and nothing outside
//       workers/ loads a worker module except the one gated require in server.js;
//   M   the text scanner S2 and S3 rest on reads what it says it reads, and its one blind
//       spot is pinned as a known limit (scoped check S-2);
//   R1  docs/staging-environment.md quotes the off message word for word and carries the
//       "Never on production" entry.
//
// S1 names the starts it knows. S2 and S3 exist because that is not enough: a NEW start
// added outside a gate, or a module that starts its own cron when it is loaded (which is what
// node-cron 4's schedule() does, tests/unit/schedulerStart.test.js), passed S1 untouched.
//
// DB-free lane: no database, no Redis, no network.

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');
const HELPER_PATH = path.join(APP_ROOT, 'config', 'backgroundJobs.js');
const SERVER_PATH = path.join(APP_ROOT, 'server.js');
const SCHEDULERS_DIR = path.join(APP_ROOT, 'schedulers');

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

// ---- Reading source as text (S2, S3) ----------------------------------------------------

// Returns the text twice more, each the same length with the same line breaks, so that an
// index in one is the same place in the others:
//   noComments  comments blanked out, strings kept (a require path is a string);
//   code        comments AND the contents of strings, templates and regex literals blanked
//               out, which is what matching braces and finding calls need.
// What it reads: line comments, block comments, the two quote styles, templates (the code
// inside a template's interpolation is read as code, to any depth), and regex literals.
// `problems` lists what did not scan cleanly (a string or a regex literal that runs past its
// line, text that ends inside a string or a template, braces that do not balance). The
// anti-vacuity tests fail on a non-empty list for server.js and schedulers/, and the app-wide
// checks count such a file as a hit.
// What it can still NOT see, stated exactly (group M below pins this, so the sentence stays
// true): whether a slash starts a regex literal or is a division is decided by what stands
// before it. After a closing round or square bracket, a name that is not a keyword, a number,
// or a string, it is taken for a division. A regex literal written in such a place, as in
// "if (x) /re/.test(y)", is read as code, and if it holds two slashes in a row the rest of
// that line is taken for a comment and hidden with no problem reported. Nothing in the app
// is written that way today.
const REGEX_AFTER_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'delete', 'throw', 'new', 'yield', 'await', 'instanceof',
]);
function maskSource(text) {
  const noComments = text.split('');
  const code = text.split('');
  const problems = [];
  const blank = (chars, at) => {
    if (at < text.length && text[at] !== '\n') chars[at] = ' ';
  };
  const lineOf = (at) => text.slice(0, at).split('\n').length;
  // Does the slash at `at` start a regex literal? Decided by the code read so far.
  const startsRegex = (at) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    if (j < 0) return true;
    if (REGEX_AFTER_CHARS.includes(code[j])) return true;
    if (!/[\w$]/.test(code[j])) return false;
    let k = j;
    while (k >= 0 && /[\w$]/.test(code[k])) k--;
    return REGEX_AFTER_WORDS.has(code.slice(k + 1, j + 1).join(''));
  };
  const CLOSER = { single: "'", double: '"', template: '`' };
  // One entry per template interpolation being read: how many braces are open inside it.
  const interpolations = [];
  let inClass = false;
  let state = 'code';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    const top = interpolations.length - 1;
    if (state === 'code') {
      if (ch === '/' && (next === '/' || next === '*')) {
        state = next === '/' ? 'line' : 'block';
        for (const at of [i, i + 1]) {
          blank(noComments, at);
          blank(code, at);
        }
        i++;
      } else if (ch === '/' && startsRegex(i)) {
        state = 'regex';
        inClass = false;
      } else if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      else if (top >= 0 && ch === '{') interpolations[top]++;
      else if (top >= 0 && ch === '}') {
        if (interpolations[top] === 0) {
          // The brace that ends the interpolation: back to the template's own text.
          interpolations.pop();
          blank(code, i);
          state = 'template';
        } else interpolations[top]--;
      }
    } else if (state === 'line') {
      if (ch === '\n') state = 'code';
      else {
        blank(noComments, i);
        blank(code, i);
      }
    } else if (state === 'block') {
      blank(noComments, i);
      blank(code, i);
      if (ch === '*' && next === '/') {
        blank(noComments, i + 1);
        blank(code, i + 1);
        i++;
        state = 'code';
      }
    } else if (state === 'regex') {
      if (ch === '\n') {
        problems.push(`a regex literal that does not end on its line (line ${lineOf(i)})`);
        state = 'code';
      } else if (ch === '\\') {
        blank(code, i);
        blank(code, i + 1);
        i++;
      } else if (ch === '/' && !inClass) {
        state = 'code';
      } else {
        if (ch === '[') inClass = true;
        if (ch === ']') inClass = false;
        blank(code, i);
      }
    } else if (ch === '\\') {
      blank(code, i);
      blank(code, i + 1);
      i++;
    } else if (state === 'template' && ch === '$' && next === '{') {
      // An interpolation: what is inside is code, and is read as code.
      blank(code, i);
      blank(code, i + 1);
      i++;
      interpolations.push(0);
      state = 'code';
    } else if (ch === CLOSER[state]) {
      state = 'code';
    } else {
      if (ch === '\n' && state !== 'template') {
        problems.push(`a quoted string that does not end on its line (line ${lineOf(i)})`);
      }
      blank(code, i);
    }
  }
  if (state !== 'code' && state !== 'line') problems.push(`the text ends inside a ${state}`);
  if (interpolations.length > 0) problems.push('the text ends inside a template interpolation');
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth < 0) {
      problems.push('a closing brace with no opening brace');
      break;
    }
  }
  if (depth !== 0) problems.push(`braces do not balance (depth ${depth} at the end)`);
  return { noComments: noComments.join(''), code: code.join(''), problems };
}

// Index of the brace that closes the one at `openAt`, in text from maskSource().code. -1 if none.
function matchBrace(code, openAt) {
  if (code[openAt] !== '{') return -1;
  let depth = 0;
  for (let i = openAt; i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Every index at which `pattern` matches in `text`, between `from` and `to`.
function findAll(text, pattern, from = 0, to = text.length) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const found = [];
  re.lastIndex = from;
  let m = re.exec(text);
  while (m !== null && m.index < to) {
    found.push(m.index);
    if (m[0].length === 0) re.lastIndex++;
    m = re.exec(text);
  }
  return found;
}

// Every index at which the plain text `needle` occurs in `text`, between `from` and `to`.
// Plain text on purpose: no pattern is built from a string, so nothing needs escaping.
function findAllText(text, needle, from = 0, to = text.length) {
  const found = [];
  let at = text.indexOf(needle, from);
  while (at !== -1 && at < to) {
    found.push(at);
    at = text.indexOf(needle, at + 1);
  }
  return found;
}

// "line 12: the line's text", for a failure message a person can act on.
function whereIs(text, index) {
  const lineNumber = text.slice(0, index).split('\n').length;
  return `line ${lineNumber}: ${text.split('\n')[lineNumber - 1].trim()}`;
}

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// What a start looks like in code. Used inside the listen callback (each must be gated) and
// outside it (none may appear at all).
const START_CALLS = [
  ['.start(', /\.start\s*\(/],
  ['.schedule(', /\.schedule\s*\(/],
  ['.createTask(', /\.createTask\s*\(/],
  ['setInterval(', /\bsetInterval\s*\(/],
  ['new Worker(', /\bnew\s+Worker\s*\(/],
  ['mountBullBoard(', /\bmountBullBoard\s*\(/],
  ['syncPromptSchedules...(', /\bsyncPromptSchedules\w*\s*\(/],
  ['upsertJobScheduler(', /\bupsertJobScheduler\s*\(/],
];
// A require path may be written with either quote or as a template. All three count.
const NODE_CRON_REQUIRE = /require\(\s*['"`]node-cron['"`]\s*\)/;
const BULLMQ_REQUIRE = /require\(\s*['"`]bullmq['"`]\s*\)/;
// './workers', '../workers', './workers/index.js', '../workers/emailNoticeWorker', and so on.
const WORKERS_DIR_REQUIRE = /require\(\s*['"`](?:\.\.?\/)+workers(?:\/[^'"`\n]*)?['"`]\s*\)/;
const NEW_WORKER = /\bnew\s+Worker\s*\(/;

// App source the server can load: server.js and everything under these folders. Tests,
// scripts and migrations are never loaded by the server and are not read here.
const APP_DIRS = ['config', 'middleware', 'models', 'queues', 'routes', 'schedulers', 'services', 'utils', 'workers'];
function appSourceFiles() {
  const files = [SERVER_PATH];
  for (const dir of APP_DIRS) files.push(...jsFilesUnder(path.join(APP_ROOT, dir)));
  return files;
}

// The app files in which `pattern` occurs in real code, as paths from the app root, sorted.
// `view` is the maskSource view to look in. A file that only mentions it in a comment does
// not count. Fail-closed: a file whose raw text matches but which does not scan cleanly is
// listed too, marked, because the scan cannot vouch for what it hid.
function appFilesWithCode(pattern, view) {
  const hits = [];
  for (const file of appSourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    if (!pattern.test(text)) continue;
    const rel = path.relative(APP_ROOT, file).split(path.sep).join('/');
    const scan = maskSource(text);
    if (scan.problems.length > 0) hits.push(`${rel} (did not scan cleanly)`);
    else if (pattern.test(scan[view])) hits.push(rel);
  }
  return hits.sort();
}

// The beginning of every line the server really prints when something starts, read from the
// source: "Deadline scheduler started", "BullMQ workers started", and so on. The owner
// compares deploy-log lines by eye against these in the staging runbook, step (f).
const WORKERS_INDEX_PATH = path.join(APP_ROOT, 'workers', 'index.js');
function realStartedLineBeginnings() {
  const beginnings = [];
  for (const file of [SERVER_PATH, WORKERS_INDEX_PATH]) {
    const text = maskSource(fs.readFileSync(file, 'utf8')).noComments;
    const pattern = /console\.log\(\s*'([^'\n]*?\bstarted)\b/g;
    let m = pattern.exec(text);
    while (m !== null) {
      beginnings.push(m[1]);
      m = pattern.exec(text);
    }
  }
  return beginnings;
}
// What each cron job prints every time its body actually runs, read from the three scheduler
// files that server.js loads at the top. These are the only trace in a deploy log of a job
// running in spite of the off switch (review R-1), so the staging runbook, step (f), tells
// the owner to look for them.
const JOB_RUN_FILES = ['deadlineScheduler.js', 'reminderScheduler.js', 'autoPromotionScheduler.js'];
function realJobRunLines() {
  const lines = [];
  for (const name of JOB_RUN_FILES) {
    const text = maskSource(fs.readFileSync(path.join(SCHEDULERS_DIR, name), 'utf8')).noComments;
    const pattern = /console\.log\([^\n]*?(Running [a-z-]+ check)\b/g;
    let m = pattern.exec(text);
    while (m !== null) {
      lines.push(m[1]);
      m = pattern.exec(text);
    }
  }
  return lines;
}
const KNOWN_JOB_RUN_LINES = ['Running deadline check', 'Running reminder check', 'Running auto-promotion check'];

const KNOWN_STARTED_BEGINNINGS = [
  'Deadline scheduler started',
  'Backup scheduler started',
  'Auto-promotion scheduler started',
  'Reminder scheduler started',
  'Scheduler anomaly sweep started',
  'PendingAuth0Deletion reconciliation sweep started',
  'Group purge sweep started',
  'BullMQ workers started',
];

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

  it('found the eight real "started" boot lines in the source (anti-vacuity)', () => {
    expect(realStartedLineBeginnings()).toEqual(KNOWN_STARTED_BEGINNINGS);
  });

  it('the off message does not say "started" and holds no beginning of a real boot line', () => {
    // The owner is told: the off line must be there, and no line beginning "... started" may
    // be. An off line that itself says "BullMQ workers started" reads, by eye, like the very
    // thing he is looking for. Keep the two apart: describe the off state in other words.
    expect(BACKGROUND_JOBS_OFF_MESSAGE).not.toMatch(/started/i);
    const shared = [
      ...realStartedLineBeginnings(),
      'Deadline scheduler disabled',
      'BullMQ workers disabled',
    ].filter((beginning) => BACKGROUND_JOBS_OFF_MESSAGE.includes(beginning));
    expect(shared).toEqual([]);
    // And nothing the server prints when it starts something begins like the off line.
    for (const beginning of realStartedLineBeginnings()) {
      expect(beginning.startsWith('Background jobs')).toBe(false);
    }
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

describe('M: the text scanner reads what it says it reads', () => {
  // S2 and S3 only see what maskSource shows them. Each case here is a line of source and
  // what must still be visible, or hidden, in the two views. "go();" stands for the code a
  // scan would be looking for after the tricky part.
  const visible = (source) => maskSource(source).code;

  it('keeps every position and line break in both views', () => {
    const source = "const a = 'x'; // note\n/* block\n   two */ go(`t ${a} t`);\nconst r = /a\\/b/;\n";
    const { noComments, code, problems } = maskSource(source);
    expect(problems).toEqual([]);
    expect(noComments).toHaveLength(source.length);
    expect(code).toHaveLength(source.length);
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') {
        expect(noComments[i]).toBe('\n');
        expect(code[i]).toBe('\n');
      }
    }
  });

  it('blanks comments in both views, and string contents in the code view only', () => {
    const { noComments, code, problems } = maskSource("load('./workers'); // start()\n/* stop() */ go();");
    expect(problems).toEqual([]);
    expect(noComments).toContain("load('./workers');");
    expect(noComments).not.toContain('start()');
    expect(noComments).not.toContain('stop()');
    expect(code).toContain('load(');
    expect(code).not.toContain('workers');
    expect(code).toContain('go();');
  });

  it('two slashes inside a string are not a comment', () => {
    const { noComments, code, problems } = maskSource("const u = 'http://localhost'; go();");
    expect(problems).toEqual([]);
    expect(noComments).toContain("'http://localhost'");
    expect(code).toContain('go();');
  });

  it('a regex literal holding two slashes does not hide the rest of its line', () => {
    const { code, problems } = maskSource('console.log(/\\/\\//); cron.schedule(x);');
    expect(problems).toEqual([]);
    expect(code).toContain('cron.schedule(x);');
  });

  it('a regex literal holding quotes, a brace or a slash in a class does not derail the scan', () => {
    const source = "const q = /['\"`{]/; const c = /[/]x/g; go();\nnext('a');";
    const { code, problems } = maskSource(source);
    expect(problems).toEqual([]);
    expect(code).toContain('go();');
    expect(code).toContain('next(');
  });

  it('a regex literal after a keyword is read as one', () => {
    expect(visible('function f(s) { return /\\/\\//.test(s); } go();')).toContain('go();');
  });

  it('a division is not a regex literal', () => {
    const { code, problems } = maskSource('const half = total / 2; const r = (a + b) / c / d[0] / 3; go(); // done');
    expect(problems).toEqual([]);
    expect(code).toContain('total / 2');
    expect(code).toContain('(a + b) / c / d[0] / 3');
    expect(code).toContain('go();');
    expect(code).not.toContain('done');
  });

  it('code inside a template interpolation is read as code', () => {
    const { code, problems } = maskSource('console.log(`before ${job.start()} after`); go();');
    expect(problems).toEqual([]);
    expect(code).toContain('job.start()');
    expect(code).not.toContain('before');
    expect(code).not.toContain('after');
    expect(code).toContain('go();');
  });

  it('an interpolation may hold an object, a string, or another template', () => {
    const source = "log(`a ${JSON.stringify({ b: '}' })} c ${fn(`d ${e.start()} f`)} g`); go();";
    const { code, problems } = maskSource(source);
    expect(problems).toEqual([]);
    expect(code).toContain('JSON.stringify({ b:');
    expect(code).toContain('fn(');
    expect(code).toContain('e.start()');
    expect(code).toContain('go();');
    expect(code).not.toMatch(/[acdfg] /);
  });

  it('reports what it could not read, never passes it quietly', () => {
    expect(maskSource('const r = /abc\nnext();').problems).not.toEqual([]);
    expect(maskSource("const s = 'abc\nnext();").problems).not.toEqual([]);
    expect(maskSource('const t = `abc ${x').problems).not.toEqual([]);
    expect(maskSource('const t = `abc').problems).not.toEqual([]);
    expect(maskSource('function f() { if (x) { go(); }').problems).not.toEqual([]);
  });

  it('KNOWN LIMIT: a regex literal right after a closing bracket is taken for a division', () => {
    // This is the blind spot the comment on maskSource describes. The regex below stands
    // where a division could stand, so it is read as code; its two slashes in a row then
    // look like a comment, and hidden() is hidden with no problem reported. If the scanner
    // is ever taught this case, this test goes red: then update that comment too.
    const { code, problems } = maskSource('if (x) /a\\/\\//.test(y); hidden();');
    expect(problems).toEqual([]);
    expect(code).not.toContain('hidden();');
  });

  it('server.js holds regex literals today, and they are read as such (anti-vacuity)', () => {
    const src = fs.readFileSync(SERVER_PATH, 'utf8');
    const { code, problems } = maskSource(src);
    expect(problems).toEqual([]);
    // The public-route table: its patterns are blanked like strings, its code is kept.
    expect(src).toContain('re: /^\\/games\\/search-all$/');
    expect(code).not.toContain('search-all');
    expect(count(code, "{ method: '   ', re: /")).toBeGreaterThanOrEqual(5);
  });
});

describe('S2: nothing in server.js can start a job outside a gate (read as text)', () => {
  // S1 checks the starts it can name. This group checks the ones nobody has written yet:
  //   - inside the listen callback, EVERY require and EVERY start call is inside a gate, and
  //     outside the gates the callback calls nothing but its logging and the switch reads;
  //   - outside the listen callback (the top of the file, and startServer before listen),
  //     nothing loads a starter and nothing is started.
  // The numbers are pinned on purpose. A new start changes one of them: read the new code,
  // put it behind schedulersOn or workersOn, and only then change the number.
  const src = fs.readFileSync(SERVER_PATH, 'utf8');
  const { noComments, code, problems } = maskSource(src);

  const LISTEN_OPEN = 'app.listen(PORT, () => {';
  const bodyOpen = code.indexOf(LISTEN_OPEN) + LISTEN_OPEN.length - 1;
  const bodyClose = matchBrace(code, bodyOpen);

  const gates = [];
  for (const [kind, opener] of [['scheduler', 'if (schedulersOn) {'], ['worker', 'if (workersOn) {']]) {
    for (const at of findAllText(code, opener, bodyOpen, bodyClose)) {
      const open = at + opener.length - 1;
      gates.push({ kind, open, close: matchBrace(code, open) });
    }
  }
  gates.sort((a, b) => a.open - b.open);
  const gated = (index) => gates.some((gate) => index > gate.open && index < gate.close);

  // The listen callback with every gated block cut out.
  function outsideGates(text) {
    let out = '';
    let cursor = bodyOpen + 1;
    for (const gate of gates) {
      out += `${text.slice(cursor, gate.open)}{}`;
      cursor = gate.close + 1;
    }
    return out + text.slice(cursor, bodyClose);
  }

  // server.js outside the listen callback: everything that runs at load or before listen.
  const outsideListen = (text) => `${text.slice(0, bodyOpen)}{${text.slice(bodyClose)}`;

  it('scans cleanly, and found the listen callback from its first brace to its last (anti-vacuity)', () => {
    expect(problems).toEqual([]);
    expect(count(code, LISTEN_OPEN)).toBe(1);
    expect(bodyClose).toBeGreaterThan(bodyOpen);
    // What follows the callback's closing brace is the end of app.listen( and the catch.
    const end = noComments.indexOf("console.error('Unable to start server:'");
    expect(end).toBeGreaterThan(bodyClose);
    expect(noComments.slice(bodyClose, end)).toMatch(/^\}\);\s*\} catch \(error\) \{\s*$/);
  });

  it('found the nine gates, each closed, none inside another (anti-vacuity)', () => {
    expect(gates.filter((gate) => gate.kind === 'scheduler')).toHaveLength(7);
    expect(gates.filter((gate) => gate.kind === 'worker')).toHaveLength(2);
    let previousClose = bodyOpen;
    for (const gate of gates) {
      expect(gate.open).toBeGreaterThan(previousClose);
      expect(gate.close).toBeGreaterThan(gate.open);
      expect(gate.close).toBeLessThan(bodyClose);
      previousClose = gate.close;
    }
  });

  it('every require in the listen callback is inside a gate (10 of them)', () => {
    // A require inside the callback is there because loading it starts something, or because
    // only a start uses it. Either way it belongs behind a gate.
    const requires = findAll(noComments, /\brequire\s*\(/, bodyOpen, bodyClose);
    expect(requires).toHaveLength(10);
    expect(requires.filter((at) => !gated(at)).map((at) => whereIs(src, at))).toEqual([]);
  });

  it('every start call in the listen callback is inside a gate, and the counts are the known ones', () => {
    const expected = {
      '.start(': 4, // the four cron schedulers
      '.schedule(': 3, // the three sweeps
      '.createTask(': 0,
      'setInterval(': 0,
      'new Worker(': 0,
      'mountBullBoard(': 1,
      'syncPromptSchedules...(': 1,
      'upsertJobScheduler(': 0,
    };
    const found = {};
    const ungated = [];
    for (const [label, pattern] of START_CALLS) {
      const hits = findAll(code, pattern, bodyOpen, bodyClose);
      found[label] = hits.length;
      ungated.push(...hits.filter((at) => !gated(at)).map((at) => whereIs(src, at)));
    }
    expect(ungated).toEqual([]);
    expect(found).toEqual(expected);
  });

  it('outside the gates, the listen callback calls nothing but logging and the switch reads', () => {
    const residue = outsideGates(code);
    // Anti-vacuity: the residue is the ungated part, gates cut out, and it is not empty.
    expect(count(residue, '{}')).toBeGreaterThanOrEqual(9);
    expect(residue).toContain('const jobsOff = backgroundJobsDisabled(process.env);');
    expect(residue).not.toMatch(/\brequire\b/);
    const called = new Set();
    const callPattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
    let m = callPattern.exec(residue);
    while (m !== null) {
      called.add(m[1]);
      m = callPattern.exec(residue);
    }
    // `if` and `catch` are the two keywords that take a bracket here. Anything else that is
    // not in this list is a new ungated call: gate it, or decide it is safe and add it.
    expect([...called].sort()).toEqual([
      'Sentry.captureMessage',
      'backgroundJobsDisabled',
      'catch',
      'console.log',
      'console.warn',
      'if',
      'schedulersEnabled',
      'workersEnabled',
    ]);
  });

  it('outside the listen callback, server.js loads no starter and starts nothing', () => {
    const outsideText = outsideListen(noComments);
    const outsideCode = outsideListen(code);
    // Anti-vacuity: this really is the rest of the file.
    expect(outsideText).toContain("require('./routes/users')");
    expect(outsideText).toContain('const startServer = async () => {');
    expect(outsideText).not.toContain('schedulersOn');

    const forbiddenLoads = [
      ["require('./workers...')", WORKERS_DIR_REQUIRE],
      ["require('./routes/bullBoard')", /require\(\s*['"`]\.\/routes\/bullBoard/],
      ["require('node-cron')", NODE_CRON_REQUIRE],
      ["require('bullmq')", BULLMQ_REQUIRE],
    ];
    const hits = [];
    for (const [label, pattern] of forbiddenLoads) {
      if (pattern.test(outsideText)) hits.push(label);
    }
    for (const [label, pattern] of START_CALLS) {
      if (pattern.test(outsideCode)) hits.push(label);
    }
    expect(hits).toEqual([]);
  });

  it('the only scheduler modules loaded outside a gate are the three that S3 holds to createTask', () => {
    // These three are loaded at the top of server.js. That is safe only while each builds its
    // task with createTask and never starts it itself, which S3 and
    // tests/unit/schedulerStart.test.js pin. Another scheduler module loaded up there has to
    // be read first, then added here.
    const outsideText = outsideListen(noComments);
    const loaded = [];
    const pattern = /require\(\s*['"`]\.\/schedulers\/([\w-]+)(?:\.js)?['"`]\s*\)/g;
    let m = pattern.exec(outsideText);
    while (m !== null) {
      loaded.push(m[1]);
      m = pattern.exec(outsideText);
    }
    expect(loaded.sort()).toEqual(['autoPromotionScheduler', 'deadlineScheduler', 'reminderScheduler']);
  });
});

describe('S3: no scheduler module can start its own task (read as text)', () => {
  // In node-cron 4, schedule() starts the task the moment it is called, and a module that
  // calls .start() on its own task does the same. Either one in a scheduler module makes the
  // job run wherever that module is loaded, outside every gate in server.js.
  const CRON_FILES = [
    'autoPromotionScheduler.js',
    'backupScheduler.js',
    'deadlineScheduler.js',
    'reminderScheduler.js',
  ];
  const files = fs.readdirSync(SCHEDULERS_DIR).filter((name) => name.endsWith('.js')).sort();
  const scanned = files.map((name) => {
    const text = fs.readFileSync(path.join(SCHEDULERS_DIR, name), 'utf8');
    return { name, text, ...maskSource(text) };
  });

  it('read the scheduler modules, the four cron ones among them, and each scans cleanly (anti-vacuity)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files).toEqual(expect.arrayContaining(CRON_FILES));
    expect(scanned.filter((file) => file.problems.length > 0).map((file) => [file.name, file.problems])).toEqual([]);
  });

  it('no file under schedulers/ calls schedule(), in any spelling', () => {
    const offenders = [];
    for (const file of scanned) {
      // cron.schedule(...), require('node-cron').schedule(...), anything.schedule(...)
      for (const at of findAll(file.code, /\.schedule\s*\(/)) offenders.push(`${file.name} ${whereIs(file.text, at)}`);
      // const { schedule } = require('node-cron')
      for (const at of findAll(file.noComments, /\{[^{}]*\bschedule\b[^{}]*\}\s*=\s*require\(\s*['"`]node-cron['"`]\s*\)/)) {
        offenders.push(`${file.name} ${whereIs(file.text, at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no file under schedulers/ starts a task itself', () => {
    const offenders = [];
    for (const file of scanned) {
      for (const at of findAll(file.code, /\.start\s*\(/)) offenders.push(`${file.name} ${whereIs(file.text, at)}`);
      for (const at of findAll(file.code, /\bsetInterval\s*\(/)) offenders.push(`${file.name} ${whereIs(file.text, at)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the four cron files each load node-cron and build exactly one task with cron.createTask', () => {
    for (const name of CRON_FILES) {
      const file = scanned.find((candidate) => candidate.name === name);
      expect(file).toBeDefined();
      expect(findAll(file.noComments, NODE_CRON_REQUIRE)).toHaveLength(1);
      expect(findAll(file.code, /\bcron\.createTask\s*\(/)).toHaveLength(1);
      expect(findAll(file.code, /\.createTask\s*\(/)).toHaveLength(1);
    }
  });

  it('read the whole app, more than fifty files (anti-vacuity for the four app-wide checks)', () => {
    const files = appSourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(SERVER_PATH);
    expect(files).toContain(WORKERS_INDEX_PATH);
    expect(files).toContain(path.join(APP_ROOT, 'routes', 'ballot.js'));
  });

  it('node-cron is loaded only by server.js and those four files', () => {
    // A cron built anywhere else (a route, a service) would run from the moment server.js
    // loads that file. If one is ever needed, build it with createTask, start it behind a
    // gate in server.js, and add the file here.
    expect(appFilesWithCode(NODE_CRON_REQUIRE, 'noComments')).toEqual([
      ...CRON_FILES.map((name) => `schedulers/${name}`),
      'server.js',
    ]);
  });

  it('bullmq is loaded only by files under queues/ and workers/', () => {
    // Worker comes from bullmq. A file that loads bullmq can build one under any name, so
    // this check is what backs the next one against a renamed import.
    const loaders = appFilesWithCode(BULLMQ_REQUIRE, 'noComments');
    expect(loaders.filter((file) => file.startsWith('workers/')).length).toBeGreaterThanOrEqual(6);
    expect(loaders.filter((file) => file.startsWith('queues/')).length).toBeGreaterThanOrEqual(6);
    expect(loaders.filter((file) => !file.startsWith('workers/') && !file.startsWith('queues/'))).toEqual([]);
  });

  it('a BullMQ Worker is built only by files under workers/', () => {
    // Every worker file builds its Worker, and opens its Redis connection, the moment it is
    // loaded. That is safe only because the one way into workers/ is the gated require in
    // server.js. A Worker built in a route or a service would start whenever server.js
    // loads that file, switch or no switch.
    const builders = appFilesWithCode(NEW_WORKER, 'code');
    expect(builders.filter((file) => file.startsWith('workers/')).length).toBeGreaterThanOrEqual(6);
    expect(builders.filter((file) => !file.startsWith('workers/'))).toEqual([]);
  });

  it('nothing outside workers/ loads a worker module, except the one require in server.js', () => {
    // Loading any file under workers/ builds a Worker (see above), so a route that requires
    // one for a helper it exports starts that worker at boot. server.js is the one allowed
    // loader, and S1 and S2 hold its require behind workersOn. If a helper is needed
    // elsewhere, move it out of the worker file.
    const loaders = appFilesWithCode(WORKERS_DIR_REQUIRE, 'noComments').filter((file) => !file.startsWith('workers/'));
    expect(loaders).toEqual(['server.js']);
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

  it('step (f) names the beginning of every real "started" line the owner must not see', () => {
    const listLine = runbook.split('\n').find((line) => line.startsWith('- You should **not** see any line that begins with'));
    expect(listLine).toBeDefined();
    const missing = realStartedLineBeginnings().filter((beginning) => !listLine.includes(`\`${beginning}\``));
    expect(missing).toEqual([]);
    // The list no longer has to explain away an off line that says "started".
    expect(listLine).not.toContain('off line');
  });

  it('found the three job-run lines in the scheduler sources, one per file (anti-vacuity)', () => {
    expect(realJobRunLines()).toEqual(KNOWN_JOB_RUN_LINES);
  });

  it('step (f) tells the owner that no job-run line may appear while the switch is on', () => {
    // The off line and the missing "started" lines say what server.js decided. These lines say
    // what a job actually did. A job that runs in spite of the switch prints one of them and
    // nothing else, so the runbook has to name them exactly as the code prints them.
    const stepF = runbook.slice(
      runbook.indexOf('**(f) Deploy staging for the first time.**'),
      runbook.indexOf('**Switch the background jobs on.**')
    );
    expect(stepF.length).toBeGreaterThan(0);
    const bullet = stepF.split('\n').find((line) => line.startsWith('- ') && line.includes('ten minutes'));
    expect(bullet).toBeDefined();
    const missing = realJobRunLines().filter((jobLine) => !bullet.includes(`\`${jobLine}\``));
    expect(missing).toEqual([]);
    expect(bullet).toContain('**remove that staging deployment**');
    expect(bullet).toContain('tell Claude in words');
  });

  it('carries the Never entry for production', () => {
    expect(runbook).toContain('- Never add `DISABLE_BACKGROUND_JOBS` to production.');
  });

  it('tells the owner the exact value', () => {
    expect(runbook).toContain('Add `DISABLE_BACKGROUND_JOBS` with the value `1`');
  });
});
