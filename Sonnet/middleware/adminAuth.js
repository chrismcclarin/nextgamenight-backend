// middleware/adminAuth.js
// Role-based admin authorization middleware
const { UserGroup, User } = require('../models');
const { Op } = require('sequelize');

/**
 * Require the authenticated user to be an owner or admin of at least one active group.
 * Must be placed AFTER verifyAuth0Token in the middleware chain (needs req.user.user_id).
 *
 * D-11 (Phase 87.1, BINT-02) — A3: this middleware was an ADDITIONAL direct-query
 * D-11 site (it bypasses getUserRoleInGroup). UserGroup is now keyed on `user_uuid`
 * (Users.id), so the caller's Auth0 id is resolved to the Users row ONCE before the
 * membership query; comparing user_uuid against an Auth0 string is always-false and
 * would silently 403 every legitimate group admin. Fail-closed (403) when no Users
 * row exists. requirePlatformAdmin below is DELIBERATELY left unchanged.
 */
const requireGroupAdmin = async (req, res, next) => {
  try {
    const userId = req.user && req.user.user_id;

    if (!userId) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const membership = await UserGroup.findOne({
      where: {
        user_uuid: user.id,
        role: { [Op.in]: ['owner', 'admin'] },
        status: 'active'
      }
    });

    if (!membership) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (err) {
    console.error('Admin auth middleware error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

/**
 * Require the authenticated user to be the platform operator (D-02 / BSEC-02).
 * Distinct from requireGroupAdmin (group-level owner/admin) — this gates
 * operator-only system surfaces. The check is a single DB-flag read of the
 * DB-only `is_platform_admin` column. Must be placed AFTER verifyAuth0Token
 * (needs req.user.user_id).
 *
 * Uses .unscoped() + explicit attributes:['is_platform_admin'] so a future
 * User defaultScope (D-03 / Plan 06) cannot hide the flag, and so the flag is
 * the ONLY column fetched (never serialized downstream).
 */
const requirePlatformAdmin = async (req, res, next) => {
  try {
    const userId = req.user && req.user.user_id;

    if (!userId) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const user = await User.unscoped().findOne({
      where: { user_id: userId },
      attributes: ['is_platform_admin']
    });

    if (!user || !user.is_platform_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  } catch (err) {
    console.error('Platform admin auth middleware error:', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports = { requireGroupAdmin, requirePlatformAdmin };
