#!/usr/bin/env node
'use strict';
//
// scripts/ci/verify-gate-armed.js
//
// Phase 88.4 Plan 10 (deferred-items.md D-88.4-05, owner-approved 2026-07-30): assert that the
// `migrate-cli-replay` schema-drift gate in `.github/workflows/ci.yml` is still ARMED.
//
// WHY THIS EXISTS. Plan 09 armed the gate by DELETING one line — `SCHEMA_DRIFT_REPORT_ONLY: "1"`
// — from the `Schema drift diff` step. The differ still READS that flag, deliberately, so the
// report-only mechanism stays testable (see the D-08 marker in scripts/ci/schema-drift-diff.js).
// Re-adding that one line silently converts `migrate-cli-replay` back into a job that reports
// GREEN while gating NOTHING. Until this script existed, the only thing preventing that was a
// comment in ci.yml plus code review — both behavioural, neither failing independently of a
// human reading them. Plan 10 makes `migrate-cli-replay` a REQUIRED check on the BE `main`
// branch, at which point a re-added flag produces a required check that is green and vacuous:
// the single worst outcome in this phase's threat model, because everyone downstream then
// believes drift is being caught. That is why the tamper-evidence lands in the same plan as the
// authority.
//
// DECISION Phase 88.4 Plan 10 (D-88.4-05): this gate PARSES THE YAML AND READS EFFECTIVE KEYS,
// OVER the obvious `grep SCHEMA_DRIFT_REPORT_ONLY .github/workflows/ci.yml`. This is not
// fastidiousness — a text grep is STRUCTURALLY INCAPABLE of answering the question here, and
// Plan 09 found that out the hard way. The ARMED comment block that Plan 09 wrote above the
// differ step deliberately NAMES the forbidden string (`RE-ADDING SCHEMA_DRIFT_REPORT_ONLY: "1"
// IS NOT AN OPTION`) so that a developer under CI pressure reads the warning before reaching for
// the shortcut. That warning is worth more than grepability — but it means `grep` now returns a
// hit on a HEALTHY, ARMED file, and a text check therefore cannot distinguish "the flag is set"
// from "the flag is forbidden in prose". Plan 09's own plan-supplied arming check was two such
// regexes; both false-positived on that comment, i.e. it reported the gate DISARMED against a
// correctly armed file, and symmetrically could have reported ARMED against a disarmed one. A
// YAML parse drops comments entirely, so every match below is against a real directive.
// Replacing this with a grep is a decision, not a cleanup — and a wrong one.
//
// WHY MATCHING INSIDE `run:` BODIES IS SAFE (and is not the same mistake). The ordering checks
// below identify steps by the script each one INVOKES (`scripts/ci/assert-migrate-db-empty.js`,
// `sequelize-cli db:migrate`, `scripts/ci/schema-drift-diff.js`) rather than by its `name:`
// string. Those are matches against a shell command that the runner will actually execute, taken
// from the parse tree — not against prose. YAML `#` comments never reach these strings; the
// parser has already discarded them. Identifying steps by `name:` would be the fragile option:
// a step name is documentation and gets reworded, while the command is the behaviour.
//
// WHAT THIS DOES NOT AND CANNOT COVER — named, not overlooked:
//   * Deleting THIS step from ci.yml. A gate cannot catch its own removal; nothing runs to
//     object. Branch protection plus review is the control there, exactly as for every other
//     step in the `quality` job. Deleting the whole `migrate-cli-replay` JOB is different and IS
//     covered twice over: this script fails on the missing job, and a required status check that
//     never reports stays "Expected" forever and blocks the merge on its own.
//   * The census. Plan 09's arming precondition also asserted that all 43 drift findings were
//     dispositioned and that § 7 was signed. Two of its nine negative-control scenarios (a
//     blanked disposition cell, a deleted finding row) are therefore NOT reproduced here, and
//     that is structural rather than a judgement call: 88.4-DRIFT-CENSUS.md lives in the PARENT
//     planning repository, which the backend repo's CI checkout cannot see. A one-time arming
//     precondition is the right shape for that check anyway — it guards a moment, not a state.
//   * The `quality` job's OTHER gates (the marker gate, the grep backstops). Each is its own
//     step; this script's subject is the armed state of the drift gate specifically.
//
// The seven disarm scenarios this DOES block are the seven of Plan 09's nine that live inside
// ci.yml, each of which was negative-controlled there with the mutation verified to have landed
// before the check was run: the flag on the differ step / at job level / at workflow level;
// `continue-on-error` on a step / on the job; the from-empty assert deleted; the from-empty
// assert reordered after the replay. Plus three this adds: the job deleted, the differ step
// deleted, and any member of the D-06 connection-URL chain set anywhere in the job.
//
// USAGE:  node scripts/ci/verify-gate-armed.js [path-to-ci.yml]
// Exits 0 when the gate is armed, 1 with an ::error:: per finding otherwise.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// The workflow lives at the REPO ROOT, not under Sonnet/ — GitHub Actions only reads
// `.github/workflows/` at the root (see the REPO-TOPOLOGY note at the top of ci.yml). This step
// runs with `working-directory: Sonnet`, so the default target is resolved from __dirname rather
// than from cwd: Sonnet/scripts/ci -> ../../.. -> repo root.
const DEFAULT_TARGET = path.resolve(__dirname, '../../../.github/workflows/ci.yml');

const GATED_JOB = 'migrate-cli-replay';

// The env key whose PRESENCE disarms the drift gate. Checked at all three scopes that GitHub
// Actions merges into a step's environment.
const REPORT_ONLY_KEY = 'SCHEMA_DRIFT_REPORT_ONLY';

// D-06's forbidden connection-URL keys. `migrate-cli-replay` deliberately points different steps
// at DIFFERENT databases, and both config/database.js and config/sequelize-cli.config.js resolve
// POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL. The first two OUTRANK
// the step-scoped DATABASE_URL, so either would silently redirect the migrate step; PGDATABASE_URL
// is the chain's TAIL, so it captures every step that does not set DATABASE_URL — which is most of
// them. In all three cases the differ would end up comparing a half-built schema against itself
// and PASSING. ci.yml states this in a "READ BEFORE ADDING ANY env KEY TO THIS JOB" comment; this
// list is what makes it enforced rather than merely stated. DATABASE_URL itself is deliberately
// NOT here: it is legitimately step-scoped four times in this job.
const FORBIDDEN_URL_KEYS = ['POSTGRES_PRIVATE_URL', 'POSTGRES_URL', 'PGDATABASE_URL'];

// Step identification, by the command the runner executes (see the header note on why this is a
// parse-tree match and not prose).
//   REPLAY excludes `--to`, because the baseline no-op proof step ALSO runs `sequelize-cli
//   db:migrate` — scoped to the baseline filename. Matching it as the replay would make the
//   ordering assertions pass against the wrong step.
const STEP_SIGNATURES = {
  fromEmpty: (run) => run.includes('scripts/ci/assert-migrate-db-empty.js'),
  replay: (run) => /sequelize-cli\s+db:migrate/.test(run) && !run.includes('--to'),
  differ: (run) => run.includes('scripts/ci/schema-drift-diff.js'),
};

/**
 * Case-sensitive membership test over an `env:` mapping. GitHub Actions env keys ARE
 * case-sensitive on Linux runners, and a `schema_drift_report_only` would not be read by
 * `process.env.SCHEMA_DRIFT_REPORT_ONLY` — so a case-insensitive check here would report a
 * finding that does not disarm anything. Non-object env (a scalar, a `${{ }}` expression) is
 * reported by the caller as unreadable rather than silently treated as empty.
 *
 * @param {unknown} env
 * @param {string} key
 * @returns {boolean}
 */
function hasEnvKey(env, key) {
  return !!env && typeof env === 'object' && !Array.isArray(env) && Object.prototype.hasOwnProperty.call(env, key);
}

/**
 * Collect every `env:` mapping GitHub Actions would merge, tagged with a human-readable scope.
 * Workflow-level env is inherited by every job and every step, and job-level env by every step
 * in that job, which is why the flag has to be hunted at all three levels and not only on the
 * differ step: an inherited disarm is invisible at the step that it disarms.
 *
 * @param {object} doc the parsed workflow
 * @returns {Array<{scope: string, env: unknown}>}
 */
function collectEnvScopes(doc) {
  const scopes = [{ scope: 'workflow level (`env:` at the top of the file)', env: doc.env }];
  const jobs = doc.jobs && typeof doc.jobs === 'object' ? doc.jobs : {};
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') continue;
    scopes.push({ scope: `job \`${jobId}\` (\`env:\` on the job)`, env: job.env });
    const steps = Array.isArray(job.steps) ? job.steps : [];
    steps.forEach((step, i) => {
      if (!step || typeof step !== 'object') return;
      const label = step.name ? `"${step.name}"` : `#${i + 1}`;
      scopes.push({ scope: `job \`${jobId}\` step ${label} (\`env:\` on the step)`, env: step.env });
    });
  }
  return scopes;
}

/**
 * The whole verdict as a pure function of a PARSED workflow, so every disarm scenario is a unit
 * test fixture rather than something that can only be observed by breaking real CI. Mirrors
 * scripts/ci/verify-allowlist-markers.js's `analyze` and scripts/ci/assert-migrate-db-empty.js's
 * `verdict`.
 *
 * Every check runs and every finding is reported before the caller exits — a partial report on a
 * multiply-disarmed file would send someone round the loop twice.
 *
 * @param {object} doc the parsed .github/workflows/ci.yml
 * @returns {{errors: string[], evidence: string[]}}
 */
function analyze(doc) {
  const errors = [];
  const evidence = [];

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return {
      errors: [
        'the workflow did not parse to a mapping. Refusing to report the gate ARMED against ' +
          'something this script could not read — an unreadable workflow is a failure, not a pass.',
      ],
      evidence,
    };
  }

  // ---- CHECK 1 — the report-only flag is not an env key at ANY scope --------------------
  for (const { scope, env } of collectEnvScopes(doc)) {
    if (env !== undefined && env !== null && (typeof env !== 'object' || Array.isArray(env))) {
      errors.push(
        `${scope} has an \`env:\` that is not a mapping, so its keys cannot be read. Refusing ` +
          `to treat an unreadable env block as empty.`
      );
      continue;
    }
    if (hasEnvKey(env, REPORT_ONLY_KEY)) {
      errors.push(
        `${REPORT_ONLY_KEY} is set as an env key at ${scope}. THE SCHEMA DRIFT GATE IS ` +
          `DISARMED: scripts/ci/schema-drift-diff.js reads this flag and, when it is "1", prints ` +
          `its findings and exits 0 — so \`${GATED_JOB}\` reports GREEN while gating NOTHING, ` +
          `and it is a REQUIRED check, so everyone downstream believes drift is being caught. ` +
          `Workflow- and job-level env are inherited by every step, so this disarms the differ ` +
          `even when it is not set on the differ step itself. If a drift finding is failing your ` +
          `PR: reconcile the two sides, or add an owner-signed entry to ` +
          `scripts/ci/schema-drift-allowlist.js pinned to the object's normalized identity. ` +
          `Re-arming report-only mode is the owner's decision, not a red PR's — and it means ` +
          `deleting this gate in the same commit, deliberately and visibly (D-88.4-05).`
      );
    }
  }
  if (!errors.length) {
    evidence.push(
      `${REPORT_ONLY_KEY} is absent as an env key at workflow, job AND step level — checked as ` +
        `parsed KEYS, so the ARMED comment naming the string does not score as a hit`
    );
  }

  // ---- the gated job must exist ---------------------------------------------------------
  const job = doc.jobs && typeof doc.jobs === 'object' ? doc.jobs[GATED_JOB] : undefined;
  if (!job || typeof job !== 'object') {
    errors.push(
      `there is no \`${GATED_JOB}\` job in this workflow. It is the ONLY place backend CI runs ` +
        `the real sequelize-cli migration path and the only place migration-vs-model schema ` +
        `drift is detected; without it the Railway pre-deploy step is the first-ever real CLI ` +
        `run of every migration. It is also a required status check on \`main\`, so a merge ` +
        `would block on a check that can never report. Restore the job.`
    );
    return { errors, evidence };
  }

  const steps = Array.isArray(job.steps) ? job.steps : [];

  // ---- CHECK 2 — continue-on-error is not a key on the job or any of its steps ----------
  // The substitute shortcut for the flag: it swallows the differ's non-zero exit just as
  // effectively, AND it would additionally swallow a genuine differ CRASH — which report-only
  // mode deliberately does not (the flag suppresses findings only). So this is the strictly
  // worse of the two disarms and it must be checked as a KEY: `continue-on-error: false` is
  // harmless in effect, but its presence is a loaded gun that flips with a one-character edit,
  // and ci.yml's own comment says not to substitute it at all.
  if (Object.prototype.hasOwnProperty.call(job, 'continue-on-error')) {
    errors.push(
      `\`continue-on-error\` is set on the \`${GATED_JOB}\` job (value: ` +
        `${JSON.stringify(job['continue-on-error'])}). Remove the key entirely. A job-level ` +
        `continue-on-error makes every failure in the job advisory, which disarms the drift ` +
        `gate AND would additionally swallow a genuine differ crash — something report-only ` +
        `mode deliberately never did. ci.yml's ARMED block names this as the substitute ` +
        `shortcut not to reach for.`
    );
  }
  steps.forEach((step, i) => {
    if (!step || typeof step !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(step, 'continue-on-error')) {
      const label = step.name ? `"${step.name}"` : `#${i + 1}`;
      errors.push(
        `\`continue-on-error\` is set on \`${GATED_JOB}\` step ${label} (value: ` +
          `${JSON.stringify(step['continue-on-error'])}). Remove the key entirely — see the ` +
          `job-level explanation above. No step in this job may be advisory: each one is either ` +
          `building a side of the comparison or performing it.`
      );
    }
  });

  // ---- CHECK 3 — the D-06 connection-URL chain is not set anywhere in this job ----------
  const jobScopes = [
    { scope: `the \`${GATED_JOB}\` job's \`env:\``, env: job.env },
    ...steps.map((step, i) => ({
      scope: `\`${GATED_JOB}\` step ${step && step.name ? `"${step.name}"` : `#${i + 1}`}`,
      env: step && typeof step === 'object' ? step.env : undefined,
    })),
  ];
  // Workflow-level env reaches this job too, so it is checked as well.
  jobScopes.unshift({ scope: 'workflow level', env: doc.env });
  for (const { scope, env } of jobScopes) {
    for (const key of FORBIDDEN_URL_KEYS) {
      if (hasEnvKey(env, key)) {
        errors.push(
          `${key} is set at ${scope}. This is a FALSE GREEN, not a convenience (D-06). ` +
            `config/database.js and config/sequelize-cli.config.js both resolve ` +
            `POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL, and 32 of ` +
            `the post-baseline migrations open their own connection through that chain. ` +
            `POSTGRES_PRIVATE_URL and POSTGRES_URL OUTRANK the step-scoped DATABASE_URL this ` +
            `job relies on; PGDATABASE_URL captures every step that does not set DATABASE_URL. ` +
            `Any of the three can point the migrate step and the differ at the same database, ` +
            `where the diff compares a schema against itself and PASSES. Use the purpose-named ` +
            `MIGRATE_DB_URL / SYNC_DB_URL / ADMIN_DB_URL instead.`
        );
      }
    }
  }

  // ---- CHECK 4 — the differ and from-empty steps exist, in the right order --------------
  const found = {};
  for (const [role, matches] of Object.entries(STEP_SIGNATURES)) {
    const hits = [];
    steps.forEach((step, i) => {
      const run = step && typeof step === 'object' && typeof step.run === 'string' ? step.run : '';
      if (run && matches(run)) hits.push(i);
    });
    found[role] = hits;
  }

  const ROLE_DESC = {
    fromEmpty:
      'the from-empty assert (`node scripts/ci/assert-migrate-db-empty.js`). It is what makes ' +
      'the words "from EMPTY" true: without it the property the whole job rests on is nothing ' +
      'but the freshness of the postgres service container, and a pre-seeded SequelizeMeta ' +
      'makes db:migrate skip, makes verify-migration-chain.js pass anyway, and makes the drift ' +
      'diff compare a schema the migration chain never built (88.4-CODE-REVIEW.md #11)',
    replay:
      'the migration-side replay (`npx sequelize-cli db:migrate`, unscoped — the `--to` ' +
      'baseline no-op proof is a different step)',
    differ: 'the drift diff itself (`node scripts/ci/schema-drift-diff.js`) — the gate',
  };

  for (const role of ['fromEmpty', 'replay', 'differ']) {
    if (found[role].length === 0) {
      errors.push(`\`${GATED_JOB}\` has no step running ${ROLE_DESC[role]}. Restore it.`);
    } else if (found[role].length > 1) {
      errors.push(
        `\`${GATED_JOB}\` has ${found[role].length} steps running ${ROLE_DESC[role]} (steps ` +
          `${found[role].map((i) => i + 1).join(', ')}). Exactly one is expected — with two, ` +
          `the ordering assertions below cannot say which one they are about.`
      );
    }
  }

  const single = (role) => (found[role].length === 1 ? found[role][0] : null);
  const fe = single('fromEmpty');
  const rp = single('replay');
  const df = single('differ');

  if (fe !== null && rp !== null && fe > rp) {
    errors.push(
      `the from-empty assert runs at step ${fe + 1}, AFTER the replay at step ${rp + 1}. It ` +
        `MUST run before. A post-hoc check cannot fire before the database has already been ` +
        `written to, so it can no longer distinguish "was empty" from "is now full because we ` +
        `just filled it" — it becomes a check that passes by construction.`
    );
  }
  if (rp !== null && df !== null && rp > df) {
    errors.push(
      `the drift diff runs at step ${df + 1}, BEFORE the replay at step ${rp + 1}. The differ ` +
        `would read an empty migration side and report every object as sync-only — or, worse, ` +
        `find both sides empty and pass.`
    );
  }
  if (fe !== null && rp !== null && df !== null && fe < rp && rp < df) {
    evidence.push(
      `step order holds: from-empty assert (${fe + 1}) -> replay (${rp + 1}) -> drift diff ` +
        `(${df + 1})`
    );
  }
  if (!Object.prototype.hasOwnProperty.call(job, 'continue-on-error')) {
    evidence.push(
      `no \`continue-on-error\` key on the job or on any of its ${steps.length} steps`
    );
  }

  return { errors, evidence };
}

/**
 * Parse with the SAFE schema explicitly. js-yaml 3's `load` enables custom types including
 * `!!js/function`; its `safeLoad` does not, and v4 removed `safeLoad` and made `load` safe by
 * default. Preferring `safeLoad` when present therefore gets the safe schema under both majors.
 * This matters because the file being parsed is the checked-out revision under test rather than
 * a trusted constant — defense in depth rather than the only control (a fork PR already supplies
 * the scripts this job runs), but the safe schema costs nothing.
 *
 * @param {string} source
 * @returns {object}
 */
function parseWorkflow(source) {
  return typeof yaml.safeLoad === 'function' ? yaml.safeLoad(source) : yaml.load(source);
}

module.exports = {
  analyze,
  parseWorkflow,
  collectEnvScopes,
  hasEnvKey,
  GATED_JOB,
  REPORT_ONLY_KEY,
  FORBIDDEN_URL_KEYS,
  STEP_SIGNATURES,
};

if (require.main === module) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TARGET;
  const rel = path.relative(process.cwd(), target) || target;

  if (!fs.existsSync(target)) {
    console.error(
      `::error::[88.4-armed] ${rel} is missing. That is the workflow file itself — without it ` +
        `there is no CI at all, and no gate to verify. This script fails rather than passing ` +
        `vacuously on an absent target.`
    );
    process.exitCode = 1;
  } else {
    let doc;
    try {
      doc = parseWorkflow(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      console.error(
        `::error::[88.4-armed] ${rel} did not parse as YAML: ${err && err.message ? err.message : err}`
      );
      process.exitCode = 1;
    }

    if (process.exitCode !== 1) {
      const { errors, evidence } = analyze(doc);
      for (const line of evidence) console.log(`[88.4-armed] ${line}`);
      if (errors.length) {
        for (const e of errors) console.error(`::error::[88.4-armed] ${rel}: ${e}`);
        process.exitCode = 1;
      } else {
        console.log(
          `[88.4-armed] PASS — the \`${GATED_JOB}\` schema drift gate is ARMED. A drift finding ` +
            `fails the job and blocks the PR.`
        );
      }
    }
  }
}
