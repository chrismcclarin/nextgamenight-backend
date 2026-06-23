// models/SingleUseToken.js
// Dedicated single-use token table (D-04 / BSEC-03).
// Backs BOTH the Google OAuth state nonce (BE-001/BE-024) and the single-use
// RSVP magic links (BE-071). Consume is ATOMIC via an
// `UPDATE … WHERE status='active' RETURNING` (see routes consumers / Pattern 2),
// never check-then-mark.
//
// STRUCTURAL analog: models/MagicToken.js — but explicitly NOT reusable.
// SingleUseToken intentionally has NO prompt_id FK / CASCADE (which would
// cascade-delete unrelated nonces), a three-value status ENUM that adds 'used',
// and extra columns (frontend_url, event_id, email_batch_id, rsvp_status, used_at).
const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');

const SingleUseToken = sequelize.define('SingleUseToken', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  nonce: {
    type: DataTypes.STRING,
    allowNull: false,
    // Uniqueness is declared ONCE, via the named `single_use_tokens_nonce_unique`
    // index below — NOT also as a column-level `unique: true`. Declaring both made
    // sync({force:true}) try to create two unique constraints on `nonce`, which
    // collides ("relation single_use_tokens_nonce_unique already exists") in the
    // Jest harness. The named index is the single source of truth.
    // OAuth: crypto.randomBytes(32).base64url server-stored nonce.
    // RSVP: the HMAC token string (the signature layer stays; the row adds exp + single-use).
  },
  user_id: {
    type: DataTypes.STRING,
    allowNull: false,
    // References Users.user_id (Auth0 string ID, not UUID).
    // Association in models/index.js uses sourceKey/targetKey: 'user_id'.
  },
  purpose: {
    type: DataTypes.ENUM('oauth_state', 'rsvp'),
    allowNull: false,
  },
  event_id: {
    type: DataTypes.UUID,
    allowNull: true,
    // RSVP target event; null for oauth_state.
  },
  email_batch_id: {
    type: DataTypes.UUID,
    allowNull: true,
    // Groups the three (yes/maybe/no) rsvp rows minted for one email so
    // consuming one revokes its siblings. Null for oauth_state.
  },
  rsvp_status: {
    type: DataTypes.STRING,
    allowNull: true,
    // 'yes' | 'maybe' | 'no' for rsvp rows — lets /respond match the specific link.
    // Null for oauth_state.
  },
  frontend_url: {
    type: DataTypes.STRING,
    allowNull: true,
    // OAuth: the allow-listed redirect stored alongside the nonce (kills BE-024 open redirect).
    // Null for rsvp.
  },
  status: {
    type: DataTypes.ENUM('active', 'used', 'revoked'),
    allowNull: false,
    defaultValue: 'active',
    // active: consumable
    // used:   atomically consumed (single-use)
    // revoked: invalidated (sibling consumed, or superseded by a resend)
  },
  expires_at: {
    type: DataTypes.DATE,
    allowNull: false,
    // DB-row expiry — NOT a signed-payload exp, so in-flight HMAC links don't
    // all break by a signature change.
  },
  used_at: {
    type: DataTypes.DATE,
    allowNull: true,
    // Set on atomic consume.
  },
}, {
  // Explicit snake_case table name — the migration creates `single_use_tokens`,
  // and prod runs migrations only (no sync). Without this, Sequelize pluralizes
  // the model name to `SingleUseTokens`, so every query would hit a nonexistent
  // table in prod (CR-01). Matches the repo convention (Feedback→feedback,
  // EmailMetrics→email_metrics).
  tableName: 'single_use_tokens',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['nonce'],
      name: 'single_use_tokens_nonce_unique',
    },
    {
      // Atomic-consume WHERE (status, expires_at).
      fields: ['status', 'expires_at'],
      name: 'single_use_tokens_status_expires_at',
    },
    {
      // Sibling revocation by batch.
      fields: ['email_batch_id'],
      name: 'single_use_tokens_email_batch_id',
    },
    {
      // Resend-revoke query (purpose, user_id, event_id, status).
      fields: ['purpose', 'user_id', 'event_id', 'status'],
      name: 'single_use_tokens_purpose_user_event_status',
    },
  ],
});

/**
 * Atomically consume a single-use token by nonce (Pattern 2).
 *
 * Race-free: a single `UPDATE … WHERE status='active' AND expires_at > now`
 * either flips exactly one active row to 'used' or affects zero rows. Two
 * concurrent calls therefore yield exactly one success — never check-then-mark.
 *
 * @param {string} nonce - The token nonce to consume.
 * @returns {Promise<Object|null>} The consumed row (with its pre-update field
 *   values, plus the now-'used' status) if consumption succeeded, else null.
 */
SingleUseToken.consumeByNonce = async function consumeByNonce(nonce) {
  if (!nonce) return null;
  const [, rows] = await SingleUseToken.update(
    { status: 'used', used_at: new Date() },
    {
      where: {
        nonce,
        status: 'active',
        expires_at: { [Op.gt]: new Date() },
      },
      returning: true,
    }
  );
  // Postgres `returning: true` yields the affected rows array as the 2nd tuple
  // element. Zero rows -> already used / expired / revoked -> consume failed.
  if (!rows || rows.length === 0) return null;
  return rows[0];
};

module.exports = SingleUseToken;
