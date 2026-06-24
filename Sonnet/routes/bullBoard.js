// routes/bullBoard.js
// Bull Board admin dashboard with Auth0 + admin role protection
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { verifyAuth0Token } = require('../middleware/auth0');
const { requirePlatformAdmin } = require('../middleware/adminAuth');

/**
 * Mount Bull Board dashboard with Auth0 protection
 * @param {Express.Application} app - Express app instance
 */
function mountBullBoard(app) {
  // Lazy require (BTEST-04 / review HIGH-3): destructuring queues fires the
  // queues/index.js getter (which connects Redis). Keep it inside this function
  // so requiring the route module never connects at import.
  const { promptQueue, deadlineQueue, reminderQueue, gcalSyncQueue } = require('../queues');

  // Create server adapter for Express
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  // Create Bull Board with all queues
  createBullBoard({
    queues: [
      new BullMQAdapter(promptQueue),
      new BullMQAdapter(deadlineQueue),
      new BullMQAdapter(reminderQueue),
      // Phase 75 / GCAL-01: register gcal-sync queue in Bull Board for ops visibility (D-CONTEXT)
      new BullMQAdapter(gcalSyncQueue)
    ],
    serverAdapter,
    options: {
      uiConfig: {
        boardTitle: 'Periodic Table Top - Job Queues',
        boardLogo: {
          path: '/logo.png',
          width: '40px',
          height: '40px'
        },
        favIcon: {
          default: '/favicon.ico',
          alternative: '/favicon.ico'
        }
      }
    }
  });

  // Mount with Auth0 + platform-admin protection (D-02 / BSEC-02 — was
  // requireGroupAdmin, which let ANY group owner reach system-wide queues).
  app.use(
    '/admin/queues',
    verifyAuth0Token,
    requirePlatformAdmin,
    serverAdapter.getRouter()
  );

  console.log('Bull Board mounted at /admin/queues (Auth0 + platform-admin protected)');
}

module.exports = mountBullBoard;
