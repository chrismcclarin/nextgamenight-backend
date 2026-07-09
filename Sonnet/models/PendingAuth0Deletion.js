// models/PendingAuth0Deletion.js
// Phase 87.2 (REQ-6, D-08) — durable Auth0-deletion marker.
//
// WHY A SEPARATE TABLE (not a column on Users): the Users row is HARD-DELETED in
// the same transaction that enqueues the pending Auth0 deletion. A flag column on
// Users would vanish with the row. This marker must OUTLIVE the deleted user so a
// later worker/sweep (plan 87.2-05) can retry the Auth0 Management-API delete for
// the tombstone window. Therefore: NO foreign key to Users.
//
// auth0_sub is the natural dedupe key (UNIQUE) — one pending deletion per subject.
// email is ops context ONLY (the deletion-notice email is already sent in-request);
// it is nulled at completion / past the exhaustion horizon (plan 87.2-05,
// T-87.2-03). No tokens/secrets are stored here.
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PendingAuth0Deletion = sequelize.define('PendingAuth0Deletion', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  auth0_sub: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true, // natural dedupe — one pending deletion per Auth0 subject
    // The Auth0 subject identifier (e.g. "google-oauth2|1075...") of the deleted
    // user. Survives the Users-row delete so the worker can retry the Auth0 delete.
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    // Ops context only; nulled at completion / past the exhaustion horizon.
  },
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    // Worker retry counter.
  },
  last_attempt_at: {
    type: DataTypes.DATE,
    allowNull: true,
    // Timestamp of the most recent worker retry; null until first attempt.
  },
}, {
  tableName: 'PendingAuth0Deletions',
  timestamps: true,
});

/**
 * Shared tombstone guard (Phase 87.2 / Plan 05, SPEC Req 6). Returns true when a
 * PendingAuth0Deletion row exists for the given Auth0 sub — PENDING **or** COMPLETED.
 *
 * Auth0 deletion does not revoke already-issued access tokens (up to ~24h TTL), so a
 * still-valid token — or a THIRD PARTY searching the deleted user's email — could
 * otherwise re-materialize the user's PII as a fresh Users row. Every Users create /
 * findOrCreate site keys THIS check on the sub of the row BEING CREATED (not merely the
 * caller's token sub) and refuses when it returns true. The row persists through the
 * retention window (Task 2's completed_at + Task 3's purge), so a completed tombstone
 * still blocks re-provisioning until the retention window closes.
 *
 * @param {string} sub - the Auth0 subject of the row about to be created.
 * @param {{ transaction?: import('sequelize').Transaction }} [options]
 * @returns {Promise<boolean>}
 */
PendingAuth0Deletion.isTombstoned = async function isTombstoned(sub, options = {}) {
  if (!sub) return false;
  const row = await PendingAuth0Deletion.findOne({
    where: { auth0_sub: sub },
    attributes: ['id'],
    ...options,
  });
  return !!row;
};

module.exports = PendingAuth0Deletion;
