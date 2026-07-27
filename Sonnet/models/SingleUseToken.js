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
    allowNull: true,
    // References Users.user_id (Auth0 string ID, not UUID).
    // Association in models/index.js uses sourceKey/targetKey: 'user_id'.
    //
    // DECISION Phase 88.2 D-02: NULLABLE, chosen OVER keeping `allowNull: false` and
    // stuffing the deleting owner's Auth0 sub into `group_restore` rows. This is
    // correctness, not tidiness. services/accountDeletionService.js:273 and
    // services/pendingAuth0DeletionSweep.js:187 both run
    // `SingleUseToken.destroy({ where: { user_id: sub } })`. Under D-04 an owner may
    // delete their group and THEN delete their account — with a sub in `user_id` that
    // sequence silently destroys the restore token and leaves the group permanently
    // unclaimable by every remaining member. `group_restore` rows therefore
    // DELIBERATELY leave this NULL; they identify the GROUP, not a user. Re-tightening
    // this to NOT NULL is a decision, not a cleanup. Pinned by a test in
    // tests/routes/singleUseToken.test.js ("a sub-keyed destroy does not reach it").
    // Prod counterpart: migrations/20260725000002-single-use-tokens-group-restore.js
    // (`ALTER COLUMN "user_id" DROP NOT NULL`).
  },
  purpose: {
    type: DataTypes.ENUM('oauth_state', 'rsvp', 'group_restore'),
    allowNull: false,
    // group_restore (Phase 88.2, D-02): backs the emailed group-restore acceptance
    // link. SingleUseToken was chosen over MagicToken (whose prompt_id is
    // allowNull:false with a CASCADE FK to AvailabilityPrompts) and over a new table
    // (this model exists to be the shared one — see the header).
  },
  event_id: {
    type: DataTypes.UUID,
    allowNull: true,
    // RSVP target event; null for oauth_state.
  },
  group_id: {
    type: DataTypes.UUID,
    allowNull: true,
    // group_restore target group; null for EVERY other purpose.
    //
    // DECISION Phase 88.2 D-02: NO foreign key, chosen OVER an ON DELETE CASCADE FK to
    // Groups. The FK would have auto-cleaned tokens when a group is finally purged; it
    // was rejected to keep this table uniform with the sibling `event_id` above, which
    // carries no FK either. The consequence is deliberate and load-bearing: plan 08's
    // purge sweep deletes `single_use_tokens WHERE group_id = :id` EXPLICITLY (exactly
    // as it must for GroupInvite — see 88.2-CASCADE-AUDIT.md, which found no
    // GroupInvites->Groups FK in the migration-built database at all). Deleting that
    // explicit sweep line on the assumption a cascade covers it ORPHANS tokens.
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
    {
      // DECISION Phase 88.2 D-02 (MED #26): `group_id` LEADS, chosen OVER
      // ('purpose', 'group_id', 'status'). Plan 08's purge sweep deletes with
      // `where: { group_id }` ALONE, and Postgres will not use an index whose leading
      // column the predicate does not constrain — a purpose-leading key would force a
      // sequential scan of the fastest-growing token table in the schema (it
      // accumulates every OAuth state nonce and every RSVP magic link), inside the
      // purge transaction that already holds SELECT ... FOR UPDATE on the Groups row.
      // Leading with group_id serves BOTH real consumers: the group_id-only purge
      // delete, and plan 07's sibling revocation (group_id + purpose + status).
      // NOT for the restore preview — that resolves by nonce via
      // single_use_tokens_nonce_unique and needs no group index at all.
      // Do NOT "fix" this by narrowing the purge delete to purpose:'group_restore'
      // instead: group_id has no FK, so nothing cascades, and rows of other purposes
      // carrying that group_id would be left pointing at a group that no longer exists.
      fields: ['group_id', 'purpose', 'status'],
      name: 'single_use_tokens_group_purpose_status',
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
 * @param {Object} [options] - Optional call options.
 * @param {import('sequelize').Transaction} [options.transaction] - Run the consume
 *   INSIDE a caller-supplied transaction, so a rollback un-consumes the token.
 *
 *   DECISION Phase 88.2 D-04: an optional `transaction` pass-through was chosen OVER
 *   leaving `consumeByNonce` transaction-blind and writing the consume inline at the
 *   restore call site. Before this parameter existed the consume always ran on its own
 *   connection: a group-restore transaction that consumed the token and then rolled
 *   back (a later step failing, a lock timeout) would BURN the token permanently and
 *   leave the group unclaimable with no way to re-issue — 88.2-RESEARCH.md F-12,
 *   Pitfall 9. Omitting it is still valid and is what both pre-existing callers do
 *   (routes/googleAuth.js:168, routes/rsvp.js:248); they are unchanged.
 *
 *   The atomic single-UPDATE shape is preserved verbatim. Do NOT convert this to
 *   findOne-then-update to "make the transaction case clearer" — that reintroduces the
 *   check-then-mark race the whole function exists to avoid (T-88.2-07).
 * @returns {Promise<Object|null>} The consumed row (with its pre-update field
 *   values, plus the now-'used' status) if consumption succeeded, else null.
 */
SingleUseToken.consumeByNonce = async function consumeByNonce(nonce, options = {}) {
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
      transaction: options.transaction,
    }
  );
  // Postgres `returning: true` yields the affected rows array as the 2nd tuple
  // element. Zero rows -> already used / expired / revoked -> consume failed.
  if (!rows || rows.length === 0) return null;
  return rows[0];
};

module.exports = SingleUseToken;
