// tests/routes/singleUseToken.test.js
// D-04 / BSEC-03: atomic single-use consume of the SingleUseToken table.
//
// Proves the Pattern-2 `UPDATE … WHERE status='active' RETURNING` contract:
//   - a token consumes exactly once; a second consume of the same nonce yields zero rows
//   - two CONCURRENT consumes of the same active nonce -> exactly one succeeds (race-free)
//
// Phase 88.2 (D-02 / D-04 / SPEC-REQ-9) adds the `group_restore` purpose block below:
//   - a group-scoped, user-less token can be minted and outlives the 30-day window
//   - a sub-keyed bulk destroy CANNOT reach it (T-88.2-05 — otherwise deleting your
//     account after deleting your group makes the group permanently unclaimable)
//   - the consume rides inside a caller transaction; a rollback un-consumes (T-88.2-06)
//   - the group index leads with group_id so plan 08's group_id-only purge can use it
//
// Real-DB test (sequelize.sync force:true), mirroring magicAuth.test.js. Runs
// against the Postgres service container in CI; sandbox-skips with no DB.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const { SingleUseToken, User, sequelize } = require('../../models');

const TEST_USER_ID = 'auth0|single-use-test';

describe('SingleUseToken atomic single-use consume', () => {
  // Schema built once by tests/globalSetup.js; global beforeEach TRUNCATEs all
  // tables. single_use_tokens.user_id has a FK to Users.user_id — seed the
  // referenced user per-test (beforeEach), or every mint fails the FK constraint.
  beforeEach(async () => {
    await User.findOrCreate({
      where: { user_id: TEST_USER_ID },
      defaults: { user_id: TEST_USER_ID, username: 'single-use-test', email: 'single-use-test@example.com' },
    });
  });

  function newNonce() {
    return crypto.randomBytes(32).toString('base64url');
  }

  async function mintActive(overrides = {}) {
    return SingleUseToken.create({
      nonce: newNonce(),
      user_id: 'auth0|single-use-test',
      purpose: 'oauth_state',
      frontend_url: 'http://localhost:3000',
      status: 'active',
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
      ...overrides,
    });
  }

  it('Test 1: consumes an active token once; the second consume of the same nonce returns null (zero rows)', async () => {
    const row = await mintActive();

    const first = await SingleUseToken.consumeByNonce(row.nonce);
    expect(first).not.toBeNull();
    expect(first.status).toBe('used');
    expect(first.user_id).toBe('auth0|single-use-test');

    const second = await SingleUseToken.consumeByNonce(row.nonce);
    expect(second).toBeNull();

    // Row is durably 'used'.
    const reloaded = await SingleUseToken.findByPk(row.id);
    expect(reloaded.status).toBe('used');
    expect(reloaded.used_at).not.toBeNull();
  });

  it('Test 1b: an expired token cannot be consumed (zero rows)', async () => {
    const row = await mintActive({ expires_at: new Date(Date.now() - 1000) });
    const result = await SingleUseToken.consumeByNonce(row.nonce);
    expect(result).toBeNull();
  });

  it('Test 2: two concurrent consumes of the same active nonce -> EXACTLY ONE succeeds', async () => {
    const row = await mintActive();

    const [a, b] = await Promise.all([
      SingleUseToken.consumeByNonce(row.nonce),
      SingleUseToken.consumeByNonce(row.nonce),
    ]);

    const successes = [a, b].filter((r) => r !== null);
    expect(successes).toHaveLength(1);

    const reloaded = await SingleUseToken.findByPk(row.id);
    expect(reloaded.status).toBe('used');
  });
});

// ---------------------------------------------------------------------------
// Phase 88.2 — the group-restore extension (D-02, D-04, SPEC-REQ-9).
// ---------------------------------------------------------------------------
describe('SingleUseToken group_restore purpose (Phase 88.2)', () => {
  // Same seeding rule as the suite above: the sync-built DB puts a FK on
  // single_use_tokens.user_id -> Users.user_id, so any row that DOES name a user needs
  // that user to exist. group_restore rows name none, which is the whole point.
  beforeEach(async () => {
    await User.findOrCreate({
      where: { user_id: TEST_USER_ID },
      defaults: { user_id: TEST_USER_ID, username: 'single-use-test', email: 'single-use-test@example.com' },
    });
  });

  function newNonce() {
    return crypto.randomBytes(32).toString('base64url');
  }

  // A normal, user-owned token — the row a sub-keyed destroy IS supposed to reach.
  async function mintActiveFor(userId) {
    return SingleUseToken.create({
      nonce: newNonce(),
      user_id: userId,
      purpose: 'oauth_state',
      frontend_url: 'http://localhost:3000',
      status: 'active',
      expires_at: new Date(Date.now() + 60 * 60 * 1000),
    });
  }

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  // Mints exactly what plan 06 will mint: a token that names a GROUP and no user.
  async function mintGroupRestore(overrides = {}) {
    return SingleUseToken.create({
      nonce: newNonce(),
      user_id: null,
      purpose: 'group_restore',
      group_id: crypto.randomUUID(),
      status: 'active',
      // purge_after + 2 days. Deliberately PAST the 30-day recovery window.
      expires_at: new Date(Date.now() + THIRTY_DAYS_MS + 2 * 24 * 60 * 60 * 1000),
      ...overrides,
    });
  }

  it('Test 3: mints a group-scoped, user-less token whose expiry OUTLIVES the 30-day window', async () => {
    // SPEC-REQ-9 / MED #23: the acceptance link must outlive the recovery window, so
    // that `Groups.purge_after` — not the token — is what refuses a late acceptance.
    // A user arriving on day 31 must get "this group was already purged", not a
    // generic "invalid link". That only works if expires_at has no cap; it is a plain
    // DATE column, and this test is what pins that.
    const row = await mintGroupRestore();

    const reloaded = await SingleUseToken.findByPk(row.id);
    expect(reloaded.purpose).toBe('group_restore');
    expect(reloaded.user_id).toBeNull();
    expect(reloaded.group_id).toBe(row.group_id);
    expect(reloaded.group_id).not.toBeNull();
    expect(reloaded.expires_at.getTime()).toBeGreaterThan(Date.now() + THIRTY_DAYS_MS);
  });

  it('Test 4: the group index is named single_use_tokens_group_purpose_status and LEADS with group_id', async () => {
    // MED #26. Plan 08's purge sweep deletes with `where: { group_id }` ALONE, and
    // Postgres will not use an index whose leading column the predicate does not
    // constrain. A ('purpose', 'group_id', 'status') key would sequential-scan the
    // fastest-growing token table in the schema inside the purge transaction.
    //
    // Asserted on BOTH sources: the model declaration (what sync() and any future
    // reader sees) and the live index in the database (what the planner actually gets).
    const declared = SingleUseToken.options.indexes.find(
      (i) => i.name === 'single_use_tokens_group_purpose_status'
    );
    expect(declared).toBeDefined();
    expect(declared.fields[0]).toBe('group_id');
    expect(declared.fields).toEqual(['group_id', 'purpose', 'status']);

    const [rows] = await sequelize.query(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'single_use_tokens'
         AND indexname = 'single_use_tokens_group_purpose_status';`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/\(group_id, purpose, status\)/);

    // The four pre-existing indexes are untouched.
    for (const name of [
      'single_use_tokens_nonce_unique',
      'single_use_tokens_status_expires_at',
      'single_use_tokens_email_batch_id',
      'single_use_tokens_purpose_user_event_status',
    ]) {
      expect(SingleUseToken.options.indexes.some((i) => i.name === name)).toBe(true);
    }
  });

  it('Test 5: a sub-keyed bulk destroy does NOT reach a group_restore token (T-88.2-05 / D-04)', async () => {
    // accountDeletionService.js:273 and pendingAuth0DeletionSweep.js:187 both run
    // `SingleUseToken.destroy({ where: { user_id: sub } })`. If a group_restore row
    // carried the deleting owner's sub, an owner who deletes their group and then
    // their account would destroy the restore token and leave the group permanently
    // unclaimable by every remaining member. user_id NULL is what prevents that.
    const restoreToken = await mintGroupRestore();
    const ownersOwnToken = await mintActiveFor(TEST_USER_ID);

    const destroyed = await SingleUseToken.destroy({ where: { user_id: TEST_USER_ID } });

    expect(destroyed).toBe(1);
    expect(await SingleUseToken.findByPk(ownersOwnToken.id)).toBeNull();

    const survivor = await SingleUseToken.findByPk(restoreToken.id);
    expect(survivor).not.toBeNull();
    expect(survivor.purpose).toBe('group_restore');
    expect(survivor.status).toBe('active');
  });

  it('Test 6: consumeByNonce inside a ROLLED-BACK transaction leaves the token active and re-consumable (T-88.2-06)', async () => {
    // Pitfall 9 (88.2-RESEARCH.md F-12): before consumeByNonce took a transaction it
    // always ran on its own connection, so a restore transaction that consumed the
    // token and then failed a later step would BURN the token permanently — the group
    // stays deleted and the link can never be used again.
    const row = await mintGroupRestore();

    const t = await sequelize.transaction();
    const consumed = await SingleUseToken.consumeByNonce(row.nonce, { transaction: t });
    expect(consumed).not.toBeNull();
    expect(consumed.status).toBe('used');
    await t.rollback();

    const afterRollback = await SingleUseToken.findByPk(row.id);
    expect(afterRollback.status).toBe('active');
    expect(afterRollback.used_at).toBeNull();

    // And it is genuinely re-consumable, not merely 'active'-looking.
    const second = await SingleUseToken.consumeByNonce(row.nonce);
    expect(second).not.toBeNull();
    expect(second.status).toBe('used');
  });

  it('Test 7: consumeByNonce inside a COMMITTED transaction leaves the token used', async () => {
    const row = await mintGroupRestore();

    const t = await sequelize.transaction();
    const consumed = await SingleUseToken.consumeByNonce(row.nonce, { transaction: t });
    expect(consumed).not.toBeNull();
    await t.commit();

    const afterCommit = await SingleUseToken.findByPk(row.id);
    expect(afterCommit.status).toBe('used');
    expect(afterCommit.used_at).not.toBeNull();

    expect(await SingleUseToken.consumeByNonce(row.nonce)).toBeNull();
  });

  it('Test 8: two CONCURRENT consumes of the same group_restore nonce -> EXACTLY ONE succeeds', async () => {
    // T-88.2-07: the atomic single-UPDATE shape must survive the transaction
    // parameter being added. Two members racing on the same emailed restore link must
    // not both become owner.
    const row = await mintGroupRestore();

    const [a, b] = await Promise.all([
      SingleUseToken.consumeByNonce(row.nonce),
      SingleUseToken.consumeByNonce(row.nonce),
    ]);

    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    expect((await SingleUseToken.findByPk(row.id)).status).toBe('used');
  });
});
