// utils/groupRowLock.js
//
// THE shared Groups-row write guard (Phase 88.2 D-04, extended by the WR-01 fix).
//
// Every transaction whose writes hinge on a group's liveness takes this
// row-level lock as its FIRST statement, then re-reads whatever it needs INSIDE
// the lock. D-04's original contract — "the same query, in the same
// first-position-of-the-transaction form" at every site — was comment-enforced
// across textual copies; this helper makes it structural: a site cannot drift
// from the others without visibly abandoning the shared guard.
//
// Call sites (these are ONE guard, not six — removing any side weakens the rest):
//   softDeleteGroup             services/groupRecoveryService.js
//   restoreGroupByToken         services/groupRecoveryService.js
//   purgeOneGroup               services/groupPurgeSweep.js
//   POST /groups/join-by-token  routes/groups.js
//   acceptInviteTransactional   routes/invites.js  (WR-01)
//   POST /:invite_id/decline    routes/invites.js  (WR-01)
//
// What the lock does NOT do on its own: refuse anything. A soft delete leaves
// the Groups row physically present, so a waiting writer's FK checks succeed
// the moment the lock releases — the lock serializes; only the caller's
// in-lock liveness re-read refuses (see the AF-3 marker at the join-by-token
// site for the full account-deletion-vs-soft-delete analysis).
//
// Raw query rather than findByPk({ lock }): house style
// (services/accountDeletionService.js), and not subject to the paranoid
// clause — several callers must lock a row that is by definition already
// stamped.
const sequelize = require('../config/database');

async function lockGroupRow(groupId, t) {
  await sequelize.query('SELECT id FROM "Groups" WHERE id = :id FOR UPDATE', {
    replacements: { id: groupId },
    type: sequelize.QueryTypes.SELECT,
    transaction: t,
  });
}

module.exports = { lockGroupRow };
