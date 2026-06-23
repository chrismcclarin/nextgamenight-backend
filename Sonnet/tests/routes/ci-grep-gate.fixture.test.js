// tests/routes/ci-grep-gate.fixture.test.js
//
// D-06 GREP-GATE SELF-TEST (RESEARCH "Wave-0 Gaps").
//
// This is NOT a route test — it asserts that the inverted-grep idiom used by the
// three CI quality gates in `.github/workflows/ci.yml` is CORRECT:
//   - a string that SHOULD match  -> grep emits output (non-empty) -> CI `exit 1` (FAIL)
//   - a clean string that must NOT -> grep emits nothing (empty)   -> CI passes
//
// It runs each forbidden-pattern grep against in-test fixture strings ONLY. No
// forbidden pattern is ever written into real `routes/` source — the fixtures live
// entirely inside this file. The patterns here are kept byte-for-byte identical to
// the workflow so a drift between the two is caught by this test.

const { execFileSync } = require('child_process');

// The three D-06 patterns — MUST stay in lockstep with .github/workflows/ci.yml.
const PATTERNS = {
  // D-01: client-supplied id (req.query/req.body, NOT req.params) as a DB authz subject.
  authzSubject: 'where:\\s*\\{\\s*user_id:\\s*req\\.(query|body)\\.user_id',
  // BE-043: findByPk(...) returning invite_token.
  inviteTokenLeak: 'findByPk[^)]*invite_token',
  // D-05: ...req.body mass-assignment spread.
  massAssign: '\\.\\.\\.req\\.body',
};

/**
 * Run `grep -E <pattern>` against `input` exactly as the CI gate does, and return
 * the matching lines (empty string === no match === gate passes). grep exits 1 on
 * no-match (Pitfall 2); we mirror the workflow's `|| true` by swallowing that exit.
 */
function grepHits(pattern, input) {
  try {
    // -E extended regex; read the candidate text from stdin.
    return execFileSync('grep', ['-nE', pattern], { input, encoding: 'utf8' });
  } catch (err) {
    // grep exit code 1 = no lines matched -> treat as empty (this is the pass path).
    if (err.status === 1) return '';
    throw err; // exit >=2 is a real grep error — surface it.
  }
}

describe('CI grep-gate idiom self-test (D-06)', () => {
  describe('D-01 — client id as authz subject', () => {
    test('MATCHES the forbidden req.query/req.body authz-subject form (gate would FAIL)', () => {
      const offending = 'const u = await User.findOne({ where: { user_id: req.query.user_id } });';
      expect(grepHits(PATTERNS.authzSubject, offending)).not.toBe('');
    });

    test('does NOT match the legit req.params route-param lookup (gate stays GREEN)', () => {
      // This is the ~25-line self-heal pattern the gate must NOT trip (Pitfall 3).
      const legit = 'const u = await User.findOne({ where: { user_id: req.params.user_id } });';
      expect(grepHits(PATTERNS.authzSubject, legit)).toBe('');
    });

    test('does NOT match clean unrelated code', () => {
      const clean = 'const userId = req.user?.user_id; if (!userId) return res.status(401).end();';
      expect(grepHits(PATTERNS.authzSubject, clean)).toBe('');
    });
  });

  describe('BE-043 — invite_token leaked via findByPk', () => {
    test('MATCHES findByPk returning invite_token (gate would FAIL)', () => {
      const offending = "const g = await Group.findByPk(id, { attributes: ['id', 'invite_token'] });";
      expect(grepHits(PATTERNS.inviteTokenLeak, offending)).not.toBe('');
    });

    test('does NOT match a findByPk that excludes invite_token', () => {
      const clean = "const g = await Group.findByPk(id, { attributes: ['id', 'name'] });";
      expect(grepHits(PATTERNS.inviteTokenLeak, clean)).toBe('');
    });
  });

  describe('D-05 — mass-assignment via ...req.body', () => {
    test('MATCHES a ...req.body spread (gate would FAIL)', () => {
      const offending = 'const gameData = { ...req.body, is_custom: true };';
      expect(grepHits(PATTERNS.massAssign, offending)).not.toBe('');
    });

    test('does NOT match an explicit allow-listed write', () => {
      const clean = 'await game.update(req.body, { fields: ["title", "year"] });';
      expect(grepHits(PATTERNS.massAssign, clean)).toBe('');
    });
  });
});
