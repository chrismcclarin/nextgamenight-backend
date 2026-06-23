// routes/adminMetrics.js
// GET /api/admin/metrics — aggregated monitoring dashboard endpoint
// Operator-only: gated by verifyAuth0Token + requirePlatformAdmin (D-02 / BSEC-02).
const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const { verifyAuth0Token } = require('../middleware/auth0');
const { requirePlatformAdmin } = require('../middleware/adminAuth');

const {
  EmailMetrics,
  MagicToken,
  AvailabilityResponse,
  AvailabilityPrompt
} = require('../models');

// Lazy-load BullMQ queues (Redis may not be available in dev)
function getQueues() {
  try {
    return require('../queues');
  } catch (err) {
    return null;
  }
}

/**
 * GET /api/admin/metrics
 * Returns aggregated KPIs for monitoring dashboard
 * Covers: email deliverability, response rates, queue health, token failures
 */
router.get('/admin/metrics', verifyAuth0Token, requirePlatformAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // last 30 days

    // Email deliverability metrics from EmailMetrics table
    // source_type filter includes both legacy SendGrid and current Resend events
    const liveSourceTypes = ['sendgrid_live', 'resend_live'];
    const [totalDelivered, totalOpens, totalSpam, totalBounce] = await Promise.all([
      EmailMetrics.count({ where: { event_type: 'delivered', source_type: { [Op.in]: liveSourceTypes }, occurred_at: { [Op.gte]: since } } }),
      EmailMetrics.count({ where: { event_type: 'open', sg_machine_open: false, source_type: { [Op.in]: liveSourceTypes }, occurred_at: { [Op.gte]: since } } }),
      EmailMetrics.count({ where: { event_type: 'spamreport', source_type: { [Op.in]: liveSourceTypes }, occurred_at: { [Op.gte]: since } } }),
      EmailMetrics.count({ where: { event_type: 'bounce', source_type: { [Op.in]: liveSourceTypes }, occurred_at: { [Op.gte]: since } } })
    ]);

    // Availability response rate: magic tokens sent vs responses submitted
    const [tokensSent, responsesSubmitted] = await Promise.all([
      MagicToken.count({ where: { createdAt: { [Op.gte]: since } } }),
      AvailabilityResponse.count({ where: { submitted_at: { [Op.ne]: null, [Op.gte]: since } } })
    ]);

    // Token validation failures (expired or revoked tokens in last 30 days)
    const tokenFailures = await MagicToken.count({
      where: {
        status: { [Op.in]: ['revoked'] },
        updatedAt: { [Op.gte]: since }
      }
    });

    // Active prompts count
    const activePrompts = await AvailabilityPrompt.count({ where: { status: 'active' } });

    // BullMQ queue metrics (lazy-loaded — may not be available without Redis)
    let queueMetrics = { available: false, reason: 'Redis not configured or workers disabled' };
    const queues = getQueues();
    if (queues) {
      try {
        const { promptQueue, deadlineQueue, reminderQueue } = queues;

        const [promptCounts, deadlineCounts, reminderCounts] = await Promise.all([
          promptQueue.getJobCounts('completed', 'failed', 'waiting', 'active', 'delayed'),
          deadlineQueue.getJobCounts('completed', 'failed', 'waiting', 'active', 'delayed'),
          reminderQueue.getJobCounts('completed', 'failed', 'waiting', 'active', 'delayed')
        ]);

        queueMetrics = {
          available: true,
          prompts: promptCounts,
          deadlines: deadlineCounts,
          reminders: reminderCounts
        };
      } catch (queueErr) {
        queueMetrics = { available: false, reason: queueErr.message };
      }
    }

    res.json({
      period: '30d',
      generated_at: new Date().toISOString(),
      email: {
        delivered: totalDelivered,
        human_opens: totalOpens,
        spam_reports: totalSpam,
        bounces: totalBounce,
        open_rate: totalDelivered > 0 ? Math.round((totalOpens / totalDelivered) * 1000) / 1000 : null,
        spam_rate: totalDelivered > 0 ? Math.round((totalSpam / totalDelivered) * 1000) / 1000 : null,
        bounce_rate: totalDelivered > 0 ? Math.round((totalBounce / totalDelivered) * 1000) / 1000 : null,
        thresholds: { open_rate_target: 0.20, submission_rate_target: 0.40, spam_rate_max: 0.02 }
      },
      responses: {
        tokens_sent: tokensSent,
        submissions: responsesSubmitted,
        submission_rate: tokensSent > 0 ? Math.round((responsesSubmitted / tokensSent) * 1000) / 1000 : null,
        active_prompts: activePrompts
      },
      tokens: {
        validation_failures_30d: tokenFailures
      },
      queues: queueMetrics
    });
  } catch (err) {
    console.error('[AdminMetrics] Error fetching metrics:', err.message);
    res.status(500).json({ error: 'Failed to fetch metrics', message: err.message });
  }
});

/**
 * POST /api/admin/trigger-prompt-job
 * Manually enqueue a job to the prompts queue for testing.
 * Clears any existing prompt for this group+week so the idempotency
 * check in promptWorker doesn't skip the job.
 * Body: { groupId, settingsId, timezone }
 */
router.post('/admin/trigger-prompt-job', verifyAuth0Token, requirePlatformAdmin, async (req, res) => {
  const queues = getQueues();
  if (!queues) {
    return res.status(503).json({ error: 'Queue system not available' });
  }
  const { groupId, settingsId, timezone = 'UTC', deadlineMinutes } = req.body;
  if (!groupId || !settingsId) {
    return res.status(400).json({ error: 'groupId and settingsId are required' });
  }
  try {
    // Compute the current ISO week (same logic as promptWorker)
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    const weekIdentifier = `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;

    // Delete any existing prompt for this group+week so the idempotency check passes
    const deleted = await AvailabilityPrompt.destroy({
      where: { group_id: groupId, week_identifier: weekIdentifier }
    });
    if (deleted > 0) {
      console.log(`[AdminMetrics] Cleared ${deleted} existing prompt(s) for ${groupId} week ${weekIdentifier} before test run`);
    }

    const job = await queues.promptQueue.add('send-availability-prompt', {
      groupId, settingsId, timezone,
      ...(deadlineMinutes ? { deadlineMinutes } : {})
    });
    res.json({ message: 'Job enqueued', jobId: job.id, clearedExisting: deleted });
  } catch (err) {
    console.error('[AdminMetrics] Failed to enqueue prompt job:', err.message);
    res.status(500).json({ error: 'Failed to enqueue job', message: err.message });
  }
});

module.exports = router;
