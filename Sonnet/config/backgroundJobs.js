// config/backgroundJobs.js
// Single source of truth for "do the scheduled jobs, the sweeps and the BullMQ workers
// start on this boot?". Read once by server.js inside its listen callback.
//
// DECISION quick-261119-w61 (owner ruling N1 = A): ONE off switch, DISABLE_BACKGROUND_JOBS,
// read only in this file, and it counts only when it is exactly the string '1'. Set, it
// stops every scheduler, sweep and worker in ANY NODE_ENV, production included. Unset, or
// set to anything else, every start decision is the condition server.js always used:
// NODE_ENV exactly 'production', or the matching ENABLE_ variable exactly 'true'.
//   - Rejected (a), a third clause added to each of server.js's nine conditions: nine
//     copies of one rule, and not testable without booting server.js, which needs Postgres.
//   - Rejected (b), ENABLE_SCHEDULER / ENABLE_WORKERS set to 'false' meaning "off" in
//     production mode: production's own copies of those two variables were never read, so a
//     value production ignores today could silence its reminders on the next deploy.
//   - Strict compare over trimming or case folding (' 1', 'true', 'TRUE', 'yes' do NOT
//     count): production has no such variable, so no typo can silence it. The cost is on
//     the staging side: a typo there leaves the jobs ON. That is why server.js prints
//     BACKGROUND_JOBS_OFF_MESSAGE at boot and the staging runbook
//     (docs/staging-environment.md, step (f)) makes the owner look for that line.
//   - Named trade-off with Phase 88.2 D-05 (server.js, "flip a switch"): D-05 turned down
//     a log-only purge month because a switch somebody has to remember to flip gets
//     forgotten. This switch is bounded instead: staging only, its first deploy only, a
//     runbook step that deletes it, a Sentry warning wherever Sentry runs, and a "Never"
//     entry for production in the runbook.
// Changing any of this is a decision, not a cleanup. tests/unit/backgroundJobs.test.js
// pins it; a red run there means production could be silenced or staging left loud.
//
// Pure on purpose: this file loads nothing, so the unit lane can test it with no database,
// no Redis and no network.

// One line, quoted word for word in docs/staging-environment.md (the unit test holds the
// two in lockstep). The owner reads the deploy log for it.
// Worded to share nothing with a real boot line (review R-3): it never says "started", and
// it holds no beginning of a line the server prints when something starts ("BullMQ workers
// started ...", workers/index.js). The owner tells the two apart by eye, so an off line that
// says "started" reads like the thing he must not see. The same unit test holds this.
const BACKGROUND_JOBS_OFF_MESSAGE =
  'Background jobs are OFF (DISABLE_BACKGROUND_JOBS): scheduled jobs, sweeps and BullMQ workers are NOT running; Bull Board is not mounted';

/**
 * True only when DISABLE_BACKGROUND_JOBS is exactly the string '1'.
 * No trimming, no case folding, no truthiness.
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
function backgroundJobsDisabled(env = process.env) {
  return env.DISABLE_BACKGROUND_JOBS === '1';
}

/**
 * Do the cron schedulers and the sweeps start?
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
function schedulersEnabled(env = process.env) {
  return (
    !backgroundJobsDisabled(env) &&
    (env.NODE_ENV === 'production' || env.ENABLE_SCHEDULER === 'true')
  );
}

/**
 * Do the BullMQ workers start (and is the Bull Board dashboard mounted)?
 *
 * @param {Object} [env=process.env]
 * @returns {boolean}
 */
function workersEnabled(env = process.env) {
  return (
    !backgroundJobsDisabled(env) &&
    (env.NODE_ENV === 'production' || env.ENABLE_WORKERS === 'true')
  );
}

module.exports = {
  BACKGROUND_JOBS_OFF_MESSAGE,
  backgroundJobsDisabled,
  schedulersEnabled,
  workersEnabled,
};
