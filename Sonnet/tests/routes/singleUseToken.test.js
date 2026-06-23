// tests/routes/singleUseToken.test.js
// D-04 / BSEC-03: atomic single-use consume of the SingleUseToken table.
//
// Proves the Pattern-2 `UPDATE … WHERE status='active' RETURNING` contract:
//   - a token consumes exactly once; a second consume of the same nonce yields zero rows
//   - two CONCURRENT consumes of the same active nonce -> exactly one succeeds (race-free)
//
// Real-DB test (sequelize.sync force:true), mirroring magicAuth.test.js. Runs
// against the Postgres service container in CI; sandbox-skips with no DB.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const { SingleUseToken, User, sequelize } = require('../../models');

const TEST_USER_ID = 'auth0|single-use-test';

describe('SingleUseToken atomic single-use consume', () => {
  beforeAll(async () => {
    await sequelize.sync({ force: true });
    // single_use_tokens.user_id has a FK to Users.user_id — seed the referenced
    // user, or every mint fails the foreign-key constraint.
    await User.findOrCreate({
      where: { user_id: TEST_USER_ID },
      defaults: { user_id: TEST_USER_ID, username: 'single-use-test', email: 'single-use-test@example.com' },
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    await SingleUseToken.destroy({ where: {} });
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
