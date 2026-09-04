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
    type: DataTypes.ENUM('oauth_state', 'rsvp', 'group_restore', 'email_change_verify'),
    allowNull: false,
    // group_restore (Phase 88.2, D-02): backs the emailed group-restore acceptance
    // link. SingleUseToken was chosen over MagicToken (whose prompt_id is
    // allowNull:false with a CASCADE FK to AvailabilityPrompts) and over a new table
    // (this model exists to be the shared one — see the header).
    //
    // email_change_verify (Phase 88.8, D-07/D-35; owner-ruled 2026-09-04): backs the
    // emailed CODE that proves a user controls the address they are changing TO. The
    // pending address itself lives in `target` below. Chosen over a new table for the
    // same reason group_restore was — the account-deletion sweep already destroys
    // these rows by `user_id = sub` (services/accountDeletionService.js:286,
    // services/pendingAuth0DeletionSweep.js:203) and a new table would silently opt
    // out of it, which post-A12 would strand a real pending email address.
    // Prod counterpart:
    // migrations/20260902000004-single-use-tokens-email-change-verify.js.
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
  target: {
    type: DataTypes.STRING,
    allowNull: true,
    // The PENDING address an email_change_verify token proves; NULL for every other
    // purpose. Post-SPEC-A12 this is the ONLY place a requested-but-unverified
    // address is ever stored.
    //
    // DECISION Phase 88.8 D-35: the pending address lives HERE, on the token row,
    // chosen OVER two alternatives.
    //   (a) A `pending_email` column on Users — REJECTED. It reintroduces the second
    //       address column SPEC A12 deleted and duplicates this one, giving two
    //       sources of truth for the same fact.
    //   (b) Writing the pending address straight into `Users.email` behind a
    //       verified flag — the shape the phone flow uses at routes/users.js
    //       (`user.update({ phone: result.e164, phone_verified: false })`) — REJECTED
    //       AS DANGEROUS. `phone` is not an identity key and `email` is: an
    //       unverified address sitting in the identity column is matched by all three
    //       invite-acceptance gates (routes/invites.js:593, :664, :757) and returned
    //       by friend search (routes/friendships.js:146), so anyone could type a
    //       stranger's address, never verify it, and be matched to that stranger's
    //       invites. Keeping it here makes the identity column
    //       verified-by-construction rather than verified-by-remembering-a-guard.
    //
    // RETENTION (T-88.8-71, accepted and recorded, not silent): the address persists
    // on used/revoked rows until the account-deletion sweep destroys them
    // (services/accountDeletionService.js:286,
    // services/pendingAuth0DeletionSweep.js:203). Token rows are never serialized to
    // the wire — the consumers build narrow responses (routes/groups.js:691,
    // services/groupRecoveryService.js:414).
    //
    // NO INDEX, deliberately: plan 09 never looks a token up BY address. It resolves
    // by `nonce` (single_use_tokens_nonce_unique) or by `purpose + user_id` (the
    // leading prefix of single_use_tokens_purpose_user_event_status). Do not add one
    // for symmetry — it would index a personal address for no reader.
    //
    // Prod counterpart: migrations/20260902000005-add-target-to-single-use-tokens.js.
  },
  send_failed_at: {
    type: DataTypes.DATE,
    allowNull: true,
    // The mail carrying this token was REFUSED BY THE PROVIDER, so the row exists but
    // no code was ever delivered. NULL on every row whose mail was not refused, and
    // NULL for every purpose that sends no mail.
    //
    // DECISION Phase 88.8 (owner ruling 2026-09-04, review round 4 defect 2 — "keep
    // the token"). A reader who finds a nullable timestamp on a token table with one
    // consumer will otherwise read it as dead weight, so:
    //
    // WHAT IT IS FOR. Plan 09's per-user hourly mail budget (D-10, N=3) counts
    // email_change_verify rows CREATED in the last hour. It must count at MINT time,
    // inside the locked transaction — counting anything only known AFTER the mail
    // leaves reopens the T-88.8-42 burst hole the lock exists to close. This column is
    // the compensating write that lets a row stop counting AFTER the fact. The
    // predicate plan 09 depends on is:
    //     createdAt > now() - interval '1 hour' AND send_failed_at IS NULL
    //
    // CHOSEN OVER four alternatives:
    //   (a) DESTROYING the row on a provider refusal (what plan 09 said before the
    //       ruling) — REJECTED. It left the user with no way out: plan 09's resend
    //       handler reads the address to re-send from the ACTIVE TOKEN ROW, so with
    //       the row gone Resend answered the validation envelope forever, Verify had
    //       no nonce to match, and a reload computed `pending_email_change: null` and
    //       dropped the section to idle — while the response still said
    //       `outcome: 'code_sent'` and plan 13 still rendered awaiting-code. One
    //       nullable timestamp buys back all three.
    //   (b) LETTING THE FAILED ATTEMPT CONSUME THE BUDGET (no column at all) —
    //       REJECTED. A provider outage would spend a user's three-per-hour allowance
    //       on mails that never left, and the shipped remedy for a refused send is
    //       Resend, which mints again.
    //   (c) BACK-DATING `createdAt` so the row falls out of the count window —
    //       REJECTED. It falsifies a timestamp other code and any future audit reads;
    //       that is the fragile-shortcut class this project bans outright.
    //   (d) A FOURTH `status` ENUM value — REJECTED. The row must stay 'active' to
    //       remain consumable by consumeByNonce's `status = 'active'` predicate, and
    //       CONTEXT D-07 records that a Postgres ENUM value cannot be dropped by
    //       down().
    //
    // Mirrors the nullable-timestamp-as-state-marker idiom plan 88.8-02 ships twice on
    // Users (orphaned_at, email_changed_at) and the same reasoning D-36 records for a
    // nullable DATE over a boolean: same guard cost, and it records WHEN.
    //
    // NO INDEX: the count already rides the leading `purpose, user_id` prefix of
    // single_use_tokens_purpose_user_event_status below; `send_failed_at IS NULL` is a
    // filter over rows that prefix has already narrowed to one user, so D-39's "NO new
    // index is required" survives intact.
    //
    // Prod counterpart:
    // migrations/20260902000006-add-send-failed-at-to-single-use-tokens.js.
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
