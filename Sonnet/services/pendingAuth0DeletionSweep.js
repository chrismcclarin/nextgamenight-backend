// services/pendingAuth0DeletionSweep.js
// Phase 87.2 / Plan 05 Task 3 (REQ-6, D-08) — PendingAuth0Deletion reconciliation sweep.
//
// The durable marker + queue (plans 87.2-01/03) survive most failure modes, but three
// residuals remain that only a periodic sweep can close:
//
//   PASS 1 — STALE PENDING MARKERS: a marker with no live queue job (Redis was down at
//   enqueue time, or the job exhausted its D-06 retry ladder) would strand a working
//   Auth0 login pointing at deleted data forever. The sweep re-fires or directly
//   resolves them. CRITICAL: liveness is gated on the job's STATE, not mere existence —
//   removeOnFail:false means a job that exhausted all 10 attempts still EXISTS in the
//   queue; treating it as live would permanently defeat this backstop after exactly the
//   ~17h outage it exists for.
//
//   PASS 2 — GHOST-ROW DESTROY: a still-valid token that slipped past the create-site
//   guards (e.g. a create path added later without the guard) must not leave a permanent
//   PII remnant. Any Users row matching a tombstoned sub is destroyed (firing the 87.1
//   CASCADE/SET NULL graph), plus the sub-keyed no-FK rows a ghost session may have
//   minted (MagicToken / SingleUseToken). Other ghost-window remnants (JSONB scrub
//   surfaces) are an accepted, documented residual: the ghost lives at most one sweep
//   interval (~30 min).
//
//   PASS 3 — RETENTION PURGE: completed tombstones older than the 24h retention window
//   (>= max access-token TTL, so no live token can outlast its tombstone) are destroyed.
//   Pending rows (completed_at NULL) are NEVER purged.
//
// Telemetry discipline mirrors schedulerHealthService: the sweep NEVER throws — every
// pass and every per-marker remediation is individually try/caught so one bad marker
// cannot starve the rest, and the cron callback in server.js adds an outer catch.
//
// The queue is lazy-required INSIDE the function (Pitfall 4) — a module-top destructure
// would open Redis at import time.

const { Op } = require('sequelize');
const {
  PendingAuth0Deletion,
  User,
  MagicToken,
  SingleUseToken,
} = require('../models');

// A pending marker younger than this is presumed in-flight (the in-request enqueue /
// first worker attempt needs a moment) — RESEARCH: sweep re-enqueues markers older
// than ~5 min with no live job.
const STALE_PENDING_MS = 5 * 60 * 1000;
// D-06 retry ladder coverage (10 attempts, exponential 60s) is ~17h. Past that the
// email column serves no further purpose (the sub-only tombstone keeps working);
// null it so a stranded pending row does not retain PII indefinitely (T-87.2-03).
const EXHAUSTION_HORIZON_MS = 17 * 60 * 60 * 1000;
// Tombstone retention: >= the max Auth0 access-token TTL (~24h) so no still-valid
// token can outlast its tombstone.
const RETENTION_MS = 24 * 60 * 60 * 1000;

// BullMQ states that mean "the retry lane is still working on it" — skip.
const LIVE_JOB_STATES = new Set(['waiting', 'delayed', 'active', 'waiting-children', 'prioritized']);

/**
 * Run one sweep. Returns per-pass counters (used by tests + the cron log line).
 * Never throws.
 */
async function runPendingAuth0DeletionSweep() {
  const now = Date.now();
  const counters = {
    stale_seen: 0,
    refired: 0,
    reenqueued: 0,
    direct_resolved: 0,
    skipped_live: 0,
    emails_nulled: 0,
    ghosts_destroyed: 0,
    purged: 0,
  };

  // ---- PASS 1: stale pending markers (completed_at IS NULL, older than ~5 min) ----
  try {
    const stalePending = await PendingAuth0Deletion.findAll({
      where: {
        completed_at: null,
        createdAt: { [Op.lt]: new Date(now - STALE_PENDING_MS) },
      },
    });
    counters.stale_seen = stalePending.length;

    for (const marker of stalePending) {
      try {
        // Lazy require (Pitfall 4) — never destructure the queue at module top.
        const { auth0CleanupQueue } = require('../queues');
        const jobId = `auth0-cleanup-${marker.auth0_sub}`; // deterministic (D-06)
        const job = await auth0CleanupQueue.getJob(jobId);

        if (job) {
          const state = await job.getState();
          if (LIVE_JOB_STATES.has(state)) {
            // Retry lane is alive — leave it to the worker.
            counters.skipped_live++;
            continue;
          }
          if (state === 'failed') {
            // Attempts exhausted (retained by removeOnFail:false). NOT live — re-fire
            // it. A naive re-add with the same jobId would silently no-op against the
            // retained job, so retry() the existing job instead.
            await job.retry();
            await marker.update({
              attempts: marker.attempts + 1,
              last_attempt_at: new Date(),
            });
            counters.refired++;
            continue;
          }
          // 'completed' (worker succeeded but the marker update was lost) or an
          // unknown state: fall through to direct-resolve below.
        }

        if (!job) {
          // No job at all (Redis was down at enqueue time). Re-enqueue with the
          // deterministic jobId — safe, nothing retained to collide with.
          const { auth0CleanupQueue: queue } = require('../queues');
          await queue.add(
            'cleanup',
            { sub: marker.auth0_sub }, // sub ONLY — no tokens ever enter Redis (T-87.2-12)
            { jobId }
          );
          await marker.update({
            attempts: marker.attempts + 1,
            last_attempt_at: new Date(),
          });
          counters.reenqueued++;
          continue;
        }

        // Direct-resolve: the job exists in a terminal-but-not-failed state while the
        // marker is still pending. deleteUser is 404-idempotent, so calling it again is
        // safe; on success mark the row completed (completed_at + email nulled — NOT
        // destroy, per Task 2 retention).
        const auth0Service = require('./auth0Service');
        await auth0Service.deleteUser(marker.auth0_sub);
        await marker.update({
          completed_at: new Date(),
          email: null,
          attempts: marker.attempts + 1,
          last_attempt_at: new Date(),
        });
        counters.direct_resolved++;
      } catch (markerErr) {
        // One bad marker must not starve the rest; the next sweep retries it.
        console.error(
          `[auth0Sweep] Remediation failed for marker ${marker.auth0_sub} (non-fatal):`,
          markerErr.message
        );
      }
    }

    // Exhaustion-horizon PII hygiene: null the email on pending rows older than ~17h
    // (the retry ladder is spent; the sub-only tombstone keeps working).
    const [nulled] = await PendingAuth0Deletion.update(
      { email: null },
      {
        where: {
          completed_at: null,
          email: { [Op.ne]: null },
          createdAt: { [Op.lt]: new Date(now - EXHAUSTION_HORIZON_MS) },
        },
      }
    );
    counters.emails_nulled = nulled || 0;
  } catch (passErr) {
    console.error('[auth0Sweep] Pass 1 (stale pending) failed (non-fatal):', passErr.message);
  }

  // ---- PASS 2: ghost-row destroy (EVERY tombstone row, pending or completed) ----
  try {
    const tombstones = await PendingAuth0Deletion.findAll({ attributes: ['auth0_sub'] });
    for (const t of tombstones) {
      try {
        const sub = t.auth0_sub;
        const ghost = await User.findOne({ where: { user_id: sub } });
        if (ghost) {
          // A row slipped past the guards — erase it (fires the 87.1 CASCADE/SET NULL
          // graph) and page-worthy log it: this indicates an unguarded create path.
          console.warn(`[auth0Sweep] GHOST Users row found for tombstoned sub ${sub} — destroying (REQ-6 backstop).`);
          await ghost.destroy();
          counters.ghosts_destroyed++;
        }
        // Sub-keyed no-FK rows a ghost session may have minted — a bare User.destroy
        // fires only the FK graph and would leave these.
        await MagicToken.destroy({ where: { user_id: sub } });
        await SingleUseToken.destroy({ where: { user_id: sub } });
      } catch (ghostErr) {
        console.error(
          `[auth0Sweep] Ghost cleanup failed for ${t.auth0_sub} (non-fatal):`,
          ghostErr.message
        );
      }
    }
  } catch (passErr) {
    console.error('[auth0Sweep] Pass 2 (ghost destroy) failed (non-fatal):', passErr.message);
  }

  // ---- PASS 3: retention purge (completed_at older than 24h; NEVER pending rows) ----
  try {
    counters.purged = await PendingAuth0Deletion.destroy({
      where: {
        // Explicit non-NULL guard: a row with completed_at NULL is still pending and
        // must never be purged (SQL NULL < x is already false, but be explicit).
        completed_at: { [Op.ne]: null, [Op.lt]: new Date(now - RETENTION_MS) },
      },
    });
  } catch (passErr) {
    console.error('[auth0Sweep] Pass 3 (retention purge) failed (non-fatal):', passErr.message);
  }

  const active =
    counters.stale_seen + counters.ghosts_destroyed + counters.purged + counters.emails_nulled;
  if (active > 0) {
    console.log('[auth0Sweep] Sweep completed:', JSON.stringify(counters));
  }
  return counters;
}

module.exports = { runPendingAuth0DeletionSweep };
