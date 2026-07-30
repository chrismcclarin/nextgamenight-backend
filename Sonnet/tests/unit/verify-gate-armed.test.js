// tests/unit/verify-gate-armed.test.js
// Phase 88.4 / Plan 10 (deferred-items.md D-88.4-05, owner-approved 2026-07-30): unit coverage for
// the ARMED-state gate (scripts/ci/verify-gate-armed.js -> analyze).
//
// WHY THIS FILE IS THE POINT OF THE GATE, not an afterthought. Plan 09 armed the schema drift gate
// by deleting one line from ci.yml, and then discovered that the arming CHECK the plan supplied was
// itself defective in both halves — the half that read ci.yml was two text greps, and both matched
// the ARMED comment that deliberately names the forbidden string. It reported "gate NOT armed"
// against a correctly armed file, and by symmetry could have reported ARMED against a disarmed one.
// A gate whose pass has never been observed failing is not a gate. So every disarm scenario below
// is a fixture, and `analyze` is a pure function of a PARSED workflow precisely so that they can be.
//
// The seven ci.yml-scoped scenarios from Plan 09's nine negative controls are all here (flag on the
// step / at job level / at workflow level; continue-on-error on a step / on the job; from-empty
// assert deleted / reordered after the replay). Plan 09's other two were census-scoped and cannot
// run in the backend repo at all — 88.4-DRIFT-CENSUS.md lives in the parent planning repo, which
// this CI checkout never sees. Three more are added here: the job deleted, the differ step deleted,
// and a D-06 connection-URL key set anywhere in the job.
//
// DB-free: no model import, no connection. Runs in the `npm run test:unit` lane.

const fs = require('fs');
const path = require('path');
const {
  analyze,
  parseWorkflow,
  hasEnvKey,
  REPORT_ONLY_KEY,
  GATED_JOB,
  FORBIDDEN_URL_KEYS,
} = require('../../scripts/ci/verify-gate-armed');

const CI_YML = path.resolve(__dirname, '../../../.github/workflows/ci.yml');

/**
 * A minimal but STRUCTURALLY FAITHFUL armed workflow: the three role-bearing steps of
 * `migrate-cli-replay` in their real order, the sibling `quality` job (so "any scope" checks have
 * somewhere else to look), and the purpose-named URLs at job level. Deliberately trimmed of the
 * steps `analyze` does not read — a fixture that reproduced all ten steps would obscure which
 * property each test turns on.
 */
const armed = () => ({
  name: 'CI',
  jobs: {
    quality: {
      name: 'quality',
      steps: [
        { name: 'Checkout', uses: 'actions/checkout@v4' },
        { name: 'Verify the gate is armed', run: 'node scripts/ci/verify-gate-armed.js' },
      ],
    },
    'migrate-cli-replay': {
      name: 'migrate-cli-replay',
      needs: 'quality',
      env: {
        ADMIN_DB_URL: 'postgres://postgres:password@localhost:5432/postgres',
        MIGRATE_DB_URL: 'postgres://postgres:password@localhost:5432/boardgame_db',
        SYNC_DB_URL: 'postgres://postgres:password@localhost:5432/schema_sync',
      },
      steps: [
        { name: 'Create the sync-side database', run: 'node scripts/ci/create-sync-db.js' },
        {
          name: 'Assert the migration side started EMPTY (before any replay)',
          env: { MIGRATE_DB_URL: '${{ env.MIGRATE_DB_URL }}' },
          run: 'node scripts/ci/assert-migrate-db-empty.js',
        },
        {
          name: 'Migration-side build — baseline + every migration from EMPTY',
          env: { DATABASE_URL: '${{ env.MIGRATE_DB_URL }}' },
          run: 'npx sequelize-cli db:migrate',
        },
        {
          name: 'Sync-side build — sequelize.sync() from models',
          env: { DATABASE_URL: '${{ env.SYNC_DB_URL }}' },
          run: 'node scripts/ci/sync-build-schema.js',
        },
        {
          name: 'Schema drift diff',
          env: { MIGRATE_DB_URL: '${{ env.MIGRATE_DB_URL }}', SYNC_DB_URL: '${{ env.SYNC_DB_URL }}' },
          run: 'node scripts/ci/schema-drift-diff.js',
        },
        {
          name: 'Baseline no-op proof — baseline migration only, against the sync-built DB',
          env: { DATABASE_URL: '${{ env.SYNC_DB_URL }}' },
          run: 'npx sequelize-cli db:migrate --to "$BASELINE"',
        },
      ],
    },
  },
});

const job = (doc) => doc.jobs[GATED_JOB];
const stepNamed = (doc, needle) => job(doc).steps.find((s) => s.name.includes(needle));
const joined = (errors) => errors.join('\n');

describe('verify-gate-armed — the armed fixture is clean (so every failure below is the mutation)', () => {
  test('the armed workflow produces zero errors and reports its evidence', () => {
    const { errors, evidence } = analyze(armed());
    expect(errors).toEqual([]);
    expect(joined(evidence)).toContain('absent as an env key at workflow, job AND step level');
    expect(joined(evidence)).toContain('step order holds');
    expect(joined(evidence)).toContain('no `continue-on-error` key');
  });

  // THE headline property. Plan 09's plan-supplied check failed exactly here.
  test('a comment that NAMES the forbidden flag does not score as a hit (parse, not grep)', () => {
    const source = [
      'name: CI',
      'jobs:',
      '  migrate-cli-replay:',
      '    steps:',
      '      - name: Assert the migration side started EMPTY',
      '        run: node scripts/ci/assert-migrate-db-empty.js',
      '      - name: Migration-side build',
      '        run: npx sequelize-cli db:migrate',
      '      - name: Schema drift diff',
      '        # ======================= THE GATE IS ARMED =======================',
      '        # RE-ADDING `SCHEMA_DRIFT_REPORT_ONLY: "1"` IS NOT AN OPTION. It is named here',
      '        # because it is the one-line shortcut a developer under CI pressure reaches for.',
      '        # Do not substitute continue-on-error for it either.',
      '        run: node scripts/ci/schema-drift-diff.js',
    ].join('\n');

    // Sanity: the raw text really does contain both forbidden tokens, so this fixture would
    // defeat a grep-based check. That is the whole reason the gate parses.
    expect(source).toContain(REPORT_ONLY_KEY);
    expect(source).toContain('continue-on-error');

    expect(analyze(parseWorkflow(source)).errors).toEqual([]);
  });
});

describe('verify-gate-armed — CHECK 1, the report-only flag at every inherited scope', () => {
  test('flag on the differ step is caught (Plan 09 scenario 1)', () => {
    const doc = armed();
    stepNamed(doc, 'Schema drift diff').env[REPORT_ONLY_KEY] = '1';
    const { errors } = analyze(doc);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('THE SCHEMA DRIFT GATE IS DISARMED');
    expect(errors[0]).toContain('Schema drift diff');
  });

  test('flag at job level is caught — inherited by every step (Plan 09 scenario 2)', () => {
    const doc = armed();
    job(doc).env[REPORT_ONLY_KEY] = '1';
    const { errors } = analyze(doc);
    expect(joined(errors)).toContain(`job \`${GATED_JOB}\``);
    expect(joined(errors)).toContain('DISARMED');
  });

  test('flag at workflow level is caught — inherited by every job (Plan 09 scenario 6)', () => {
    const doc = armed();
    doc.env = { [REPORT_ONLY_KEY]: '1' };
    const { errors } = analyze(doc);
    expect(joined(errors)).toContain('workflow level');
    expect(joined(errors)).toContain('DISARMED');
  });

  test('flag on an UNRELATED job is still caught — "any scope" means any', () => {
    const doc = armed();
    doc.jobs.quality.env = { [REPORT_ONLY_KEY]: '1' };
    expect(joined(analyze(doc).errors)).toContain('job `quality`');
  });

  test('the value does not matter — the KEY is the finding', () => {
    // scripts/ci/schema-drift-diff.js only suppresses on exactly '1', so `'0'` does not disarm
    // today. It is still reported: the key's presence is a one-character edit away from
    // disarming, and there is no legitimate reason for it to be in this file at all.
    for (const value of ['0', '', 'false', null, 1]) {
      const doc = armed();
      stepNamed(doc, 'Schema drift diff').env[REPORT_ONLY_KEY] = value;
      expect(analyze(doc).errors).toHaveLength(1);
    }
  });

  test('a DIFFERENTLY-CASED key is NOT reported — it would not disarm anything', () => {
    // Documented limitation, not an oversight: env keys are case-sensitive on Linux runners, so
    // `schema_drift_report_only` is never read by process.env.SCHEMA_DRIFT_REPORT_ONLY. Reporting
    // it would be a finding that describes no hazard.
    const doc = armed();
    stepNamed(doc, 'Schema drift diff').env.schema_drift_report_only = '1';
    expect(analyze(doc).errors).toEqual([]);
  });

  test('an env block that is not a mapping fails rather than reading as empty', () => {
    const doc = armed();
    stepNamed(doc, 'Schema drift diff').env = 'SCHEMA_DRIFT_REPORT_ONLY=1';
    expect(joined(analyze(doc).errors)).toContain('is not a mapping');
  });

  test('an absent env block on every scope is fine', () => {
    const doc = armed();
    delete job(doc).env;
    for (const s of job(doc).steps) delete s.env;
    expect(analyze(doc).errors).toEqual([]);
  });
});

describe('verify-gate-armed — CHECK 2, continue-on-error as the substitute shortcut', () => {
  test('continue-on-error: true on the job is caught (Plan 09 scenario 8)', () => {
    const doc = armed();
    job(doc)['continue-on-error'] = true;
    expect(joined(analyze(doc).errors)).toContain(`\`continue-on-error\` is set on the \`${GATED_JOB}\` job`);
  });

  test('continue-on-error: FALSE is also caught — the key, not the value', () => {
    // A loaded gun that flips with a one-character edit, and ci.yml's ARMED block says not to
    // introduce the key at all.
    const doc = armed();
    job(doc)['continue-on-error'] = false;
    expect(analyze(doc).errors).toHaveLength(1);
  });

  test('continue-on-error on the differ step is caught (Plan 09 scenario 3)', () => {
    const doc = armed();
    stepNamed(doc, 'Schema drift diff')['continue-on-error'] = true;
    const { errors } = analyze(doc);
    expect(joined(errors)).toContain('Schema drift diff');
    expect(joined(errors)).toContain('continue-on-error');
  });

  test('continue-on-error on ANY step of the job is caught, not just the differ', () => {
    const doc = armed();
    stepNamed(doc, 'Sync-side build')['continue-on-error'] = true;
    expect(joined(analyze(doc).errors)).toContain('Sync-side build');
  });
});

describe('verify-gate-armed — CHECK 3, the D-06 connection-URL chain', () => {
  test.each(FORBIDDEN_URL_KEYS)('%s at job level is caught', (key) => {
    const doc = armed();
    job(doc).env[key] = 'postgres://x@y:5432/z';
    expect(joined(analyze(doc).errors)).toContain('FALSE GREEN, not a convenience (D-06)');
  });

  test.each(FORBIDDEN_URL_KEYS)('%s on a step is caught', (key) => {
    const doc = armed();
    stepNamed(doc, 'Migration-side build').env[key] = 'postgres://x@y:5432/z';
    expect(joined(analyze(doc).errors)).toContain(key);
  });

  test('a forbidden key at workflow level reaches this job and is caught', () => {
    const doc = armed();
    doc.env = { PGDATABASE_URL: 'postgres://x@y:5432/z' };
    expect(joined(analyze(doc).errors)).toContain('PGDATABASE_URL');
  });

  test('step-scoped DATABASE_URL is NOT a finding — it is how this job works', () => {
    // Four steps legitimately set it, each pointing at a different database. Reporting it would
    // make the gate unusable and it is not in FORBIDDEN_URL_KEYS for exactly that reason.
    expect(FORBIDDEN_URL_KEYS).not.toContain('DATABASE_URL');
    expect(analyze(armed()).errors).toEqual([]);
  });
});

describe('verify-gate-armed — CHECK 4, the role-bearing steps and their order', () => {
  test('the from-empty assert deleted is caught (Plan 09 scenario 7)', () => {
    const doc = armed();
    job(doc).steps = job(doc).steps.filter((s) => !s.run.includes('assert-migrate-db-empty'));
    expect(joined(analyze(doc).errors)).toContain('has no step running the from-empty assert');
  });

  test('the from-empty assert moved AFTER the replay is caught (Plan 09 scenario 4)', () => {
    const doc = armed();
    const steps = job(doc).steps;
    const fe = steps.findIndex((s) => s.run.includes('assert-migrate-db-empty'));
    const [moved] = steps.splice(fe, 1);
    steps.splice(
      steps.findIndex((s) => s.run === 'npx sequelize-cli db:migrate') + 1,
      0,
      moved
    );
    expect(joined(analyze(doc).errors)).toContain('AFTER the replay');
  });

  test('the differ step deleted is caught', () => {
    const doc = armed();
    job(doc).steps = job(doc).steps.filter((s) => !s.run.includes('schema-drift-diff'));
    expect(joined(analyze(doc).errors)).toContain('has no step running the drift diff itself');
  });

  test('the differ moved BEFORE the replay is caught', () => {
    const doc = armed();
    const steps = job(doc).steps;
    const df = steps.findIndex((s) => s.run.includes('schema-drift-diff'));
    const [moved] = steps.splice(df, 1);
    steps.unshift(moved);
    expect(joined(analyze(doc).errors)).toContain('BEFORE the replay');
  });

  test('a duplicated role-bearing step is caught (the ordering claim would be ambiguous)', () => {
    const doc = armed();
    job(doc).steps.push({ name: 'Second diff', run: 'node scripts/ci/schema-drift-diff.js' });
    expect(joined(analyze(doc).errors)).toContain('has 2 steps running');
  });

  test('the --to baseline proof is NOT mistaken for the unscoped replay', () => {
    // If it were, deleting the real replay would still "find" one and the ordering assertions
    // would pass against the wrong step — the baseline proof runs LAST, after the differ.
    const doc = armed();
    job(doc).steps = job(doc).steps.filter((s) => s.run !== 'npx sequelize-cli db:migrate');
    const { errors } = analyze(doc);
    expect(joined(errors)).toContain('has no step running the migration-side replay');
  });

  test('a step with no `run` (a `uses:` action) is skipped, not crashed on', () => {
    const doc = armed();
    job(doc).steps.unshift({ name: 'Checkout', uses: 'actions/checkout@v4' });
    expect(analyze(doc).errors).toEqual([]);
  });
});

describe('verify-gate-armed — the job itself, and unreadable input', () => {
  test('the whole migrate-cli-replay job deleted is caught', () => {
    const doc = armed();
    delete doc.jobs[GATED_JOB];
    const { errors } = analyze(doc);
    expect(joined(errors)).toContain(`there is no \`${GATED_JOB}\` job`);
  });

  test.each([[null], [undefined], ['a string'], [[1, 2]]])(
    'a workflow that is not a mapping (%p) fails rather than passing vacuously',
    (doc) => {
      expect(joined(analyze(doc).errors)).toContain('did not parse to a mapping');
    }
  );

  test('every finding is reported, not just the first — a multiply-disarmed file reports once', () => {
    const doc = armed();
    doc.env = { [REPORT_ONLY_KEY]: '1' };
    job(doc)['continue-on-error'] = true;
    job(doc).env.POSTGRES_URL = 'postgres://x@y:5432/z';
    job(doc).steps = job(doc).steps.filter((s) => !s.run.includes('assert-migrate-db-empty'));
    const { errors } = analyze(doc);
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(joined(errors)).toContain('DISARMED');
    expect(joined(errors)).toContain('continue-on-error');
    expect(joined(errors)).toContain('POSTGRES_URL');
    expect(joined(errors)).toContain('from-empty assert');
  });
});

describe('verify-gate-armed — parseWorkflow uses the SAFE schema', () => {
  test('a `!!js/function` tag is refused rather than constructed', () => {
    // js-yaml 3's `load` would build a real function from this; `safeLoad` throws. v4 removed
    // safeLoad and made `load` safe, so preferring safeLoad-when-present is safe under both.
    const source = ['name: CI', "evil: !!js/function 'function(){return 1}'"].join('\n');
    expect(() => parseWorkflow(source)).toThrow();
  });

  test('ordinary YAML still parses', () => {
    expect(parseWorkflow('jobs:\n  a:\n    steps: []\n')).toEqual({ jobs: { a: { steps: [] } } });
  });
});

describe('verify-gate-armed — the REAL committed workflow', () => {
  // The synthetic fixtures prove the logic; this proves it against the file that actually ships.
  // It also means a disarming edit reds the fast unit lane locally, not only the quality job.
  test('.github/workflows/ci.yml exists at the repo root', () => {
    expect(fs.existsSync(CI_YML)).toBe(true);
  });

  test('the committed ci.yml reports the gate ARMED with zero errors', () => {
    const { errors, evidence } = analyze(parseWorkflow(fs.readFileSync(CI_YML, 'utf8')));
    expect(errors).toEqual([]);
    expect(joined(evidence)).toContain('step order holds');
  });

  test('the committed ci.yml WOULD defeat a text grep — the ARMED comment names the flag', () => {
    // Guards the reason this gate parses instead of grepping. If this ever stops being true, the
    // warning has been removed from ci.yml and the ARMED block needs re-reading, not this test
    // deleting.
    const raw = fs.readFileSync(CI_YML, 'utf8');
    expect(raw).toContain(REPORT_ONLY_KEY);
    expect(raw).toContain('continue-on-error');
  });

  test('the quality job actually WIRES this gate up', () => {
    // Honest limitation: a gate cannot catch its own deletion — if the step is gone, nothing runs
    // to object. This assertion is the independent layer: the unit lane fails even though the
    // quality step would not.
    const doc = parseWorkflow(fs.readFileSync(CI_YML, 'utf8'));
    const runs = (doc.jobs.quality.steps || []).map((s) => s.run || '').join('\n');
    expect(runs).toContain('scripts/ci/verify-gate-armed.js');
  });
});

describe('verify-gate-armed — hasEnvKey', () => {
  test('own properties only; arrays and non-objects are not env mappings', () => {
    expect(hasEnvKey({ A: 1 }, 'A')).toBe(true);
    expect(hasEnvKey({ A: undefined }, 'A')).toBe(true); // `A:` with no value is still a key
    expect(hasEnvKey({}, 'A')).toBe(false);
    expect(hasEnvKey(null, 'A')).toBe(false);
    expect(hasEnvKey(undefined, 'A')).toBe(false);
    expect(hasEnvKey('A=1', 'A')).toBe(false);
    expect(hasEnvKey([['A', 1]], 'A')).toBe(false);
  });

  test('inherited prototype keys are not env keys', () => {
    expect(hasEnvKey({}, 'toString')).toBe(false);
    expect(hasEnvKey({}, 'constructor')).toBe(false);
  });
});
