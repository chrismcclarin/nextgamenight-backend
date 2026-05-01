// schedulers/autoPromotionScheduler.js
// Auto-promotes pending group members to 'member' after 24 hours
const cron = require('node-cron');
const { UserGroup } = require('../models');
const { Op } = require('sequelize');
const { recordRun } = require('../services/schedulerHealthService');

// Check interval - default every 15 minutes, configurable via env
const AUTO_PROMOTE_INTERVAL = process.env.AUTO_PROMOTE_INTERVAL || '*/15 * * * *';

/**
 * Auto-promotion scheduler job
 * Finds all UserGroup records where role is 'pending', status is 'active',
 * and joined_at is more than 24 hours ago. Promotes them to 'member'.
 */
const autoPromotionJob = cron.schedule(AUTO_PROMOTE_INTERVAL, async () => {
  console.log(`[${new Date().toISOString()}] Running auto-promotion check...`);

  try {
    await recordRun('auto_promotion', async () => {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

      // Find all pending members past the 24h threshold
      const results = await UserGroup.findAll({
        where: {
          role: 'pending',
          status: 'active',
          joined_at: { [Op.lt]: cutoff },
        },
      });

      console.log(`Found ${results.length} pending members eligible for auto-promotion`);

      if (results.length > 0) {
        // Batch-update all eligible members to 'member' role
        await UserGroup.update(
          { role: 'member' },
          { where: { id: { [Op.in]: results.map(r => r.id) } } }
        );

        // Log each promoted member
        for (const r of results) {
          console.log(`Auto-promoted user ${r.user_id} in group ${r.group_id}`);
        }
      }
      // sent = users promoted (this scheduler does not send emails; "sent" is
      // the generic produced-output metric used by the anomaly detector).
      return { sent: results.length, skipped: 0 };
    });
  } catch (error) {
    console.error('Auto-promotion scheduler error:', error);
  }
}, {
  scheduled: false, // Don't start automatically - server.js will start it
  timezone: 'UTC',
});

module.exports = { autoPromotionJob };
