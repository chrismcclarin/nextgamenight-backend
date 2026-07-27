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

const { execFileSync, execSync } = require('child_process');

// The D-06 patterns — MUST stay in lockstep with .github/workflows/ci.yml.
const PATTERNS = {
  // D-01: client-supplied id (req.query/req.body, NOT req.params) as a DB authz subject.
  authzSubject: 'where:\\s*\\{\\s*user_id:\\s*req\\.(query|body)\\.user_id',
  // BE-043: findByPk(...) returning invite_token.
  inviteTokenLeak: 'findByPk[^)]*invite_token',
  // D-05: ...req.body mass-assignment spread.
  massAssign: '\\.\\.\\.req\\.body',
  // 88.2 / F-02: destroy() on one of the three paranoid models (Group/UserGroup/Event)
  // or the four instance-variable names they are bound to in this codebase. Byte-for-byte
  // identical to the regex in the "force-less destroy on a paranoid model" gate.
  forcelessParanoidDestroy:
    '\\b(Group|UserGroup|Event|group|userGroup|event|targetUserGroup)\\.destroy\\(',
};

// The two filter stages the F-02 gate applies AFTER the regex, byte-for-byte from ci.yml.
const F02_COMMENT_FILTER = '^[^:]+:[0-9]+:[[:space:]]*(//|\\*)';
const F02_FORCE_FILTER = 'force:[[:space:]]*true';

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

/**
 * Run the F-02 gate's FULL two-stage pipeline — regex, then the comment filter, then the
 * `force: true` filter — exactly as `.github/workflows/ci.yml` composes it.
 *
 * This exists because the F-02 gate is a PIPELINE, not a regex: a test that only checked
 * `grepHits(PATTERNS.forcelessParanoidDestroy, ...)` would pass happily while the real
 * gate was broken (or silently loosened) at stage 2 or 3.
 *
 * The real gate runs `grep -rnE ... routes/ ...`, whose output lines are
 * `<file>:<line>:<content>`. Reading fixtures from stdin instead gives `<line>:<content>`,
 * which the comment filter's `^[^:]+:[0-9]+:` anchor would never match. The `sed` below
 * re-attaches a fake filename so the fixture text flows through the identical filters.
 */
function f02GateHits(input) {
  const cmd = [
    `grep -nE '${PATTERNS.forcelessParanoidDestroy.replace(/'/g, `'\\''`)}'`,
    `sed 's|^|routes/fixture.js:|'`,
    `grep -vE '${F02_COMMENT_FILTER}'`,
    `grep -vE '${F02_FORCE_FILTER}'`,
  ].join(' | ');
  // Mirror the workflow's `|| true` — grep exits 1 on no-match, which is the PASS path.
  return execSync(`${cmd} || true`, { input, encoding: 'utf8', shell: '/bin/sh' });
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

  // ---- 88.2 / F-02 — force-less destroy on a paranoid model -------------------
  //
  // Group, UserGroup and Event are `paranoid: true` as of plan 88.2-01, so an
  // unforced `destroy` on any of them is an UPDATE deletedAt, not a DELETE. Every
  // assertion here runs the gate's FULL pipeline via f02GateHits(), never the regex
  // alone — see that helper's comment for why that distinction is load-bearing.
  describe('F-02 — force-less destroy on a paranoid model (88.2)', () => {
    test('MATCHES an unforced destroy on a paranoid model (gate would FAIL)', () => {
      const offending = 'await event.destroy({ transaction: t });';
      expect(f02GateHits(offending)).not.toBe('');
    });

    test('does NOT match a FORCED destroy — and the SECOND stage is what filters it', () => {
      const forced = 'await event.destroy({ transaction: t, force: true });';
      // Stage 1 (the regex) DOES match — proving the line is only spared by the
      // `force: true` filter downstream. If someone ever loosens that filter, this
      // pair is what tells them the regex was never the thing protecting them.
      expect(grepHits(PATTERNS.forcelessParanoidDestroy, forced)).not.toBe('');
      expect(f02GateHits(forced)).toBe('');
    });

    test('does NOT match a destroy on a NON-paranoid model', () => {
      // EventParticipation is not paranoid. The regex requires the literal `.`
      // straight after `Event`, so `EventParticipation.destroy(` never matches —
      // which is correct, `force` there would be noise.
      const clean = 'await EventParticipation.destroy({ where: { event_id } });';
      expect(f02GateHits(clean)).toBe('');
    });

    test('does NOT match a commented-out destroy', () => {
      const commented = '  // await event.destroy({ transaction: t });';
      expect(f02GateHits(commented)).toBe('');
    });

    // --- MED #22: the gate is LINE-scoped ---
    test('MULTI-LINE destroy with force on a later line is STILL a hit (known constraint)', () => {
      // This is the gate's real behavior, not a bug, and Task 1 of plan 88.2-03
      // depends on knowing it: `force: true` MUST go on the `.destroy(` line itself.
      // The fixture makes the constraint explicit rather than leaving the next person
      // to rediscover it via a red build. The fix for a false positive is to REFORMAT
      // THE CALL — never to loosen the pattern.
      const multiline = [
        'await UserGroup.destroy({',
        "  where: { user_uuid: user.id, status: 'invited' },",
        '  force: true,',
        '});',
      ].join('\n');
      expect(f02GateHits(multiline)).not.toBe('');
    });

    // --- MED #11: the filter matches `force: true`, not the substring `force` ---
    test('a line containing "force" WITHOUT force: true is STILL a hit', () => {
      // This is what the tightened `force:[[:space:]]*true` filter buys. A bare
      // `grep -v 'force'` would exempt this line — and `enforce`, `forceRefresh`, a
      // variable named `forced`, any trailing comment with the word in it — turning an
      // accidental word choice into a permanent hole in a data-retention control.
      // THIS TEST IS WHAT STOPS SOMEONE RELAXING THE FILTER BACK.
      const sneaky = 'await event.destroy({ transaction: t }); // TODO: should we force this?';
      expect(f02GateHits(sneaky)).not.toBe('');
    });

    // --- Known allowlist gap, named rather than hidden ---
    test('an ALIASED instance name is NOT matched — this is the known allowlist gap', () => {
      // NOT a passing case to be proud of. The allowlist is exactly four identifiers
      // (group|userGroup|event|targetUserGroup), so a paranoid-model instance bound to
      // any other name is invisible to this gate. Do NOT "fix" it by broadening stage 1
      // to any `.destroy(` — that matches the dozens of legitimate non-paranoid destroys
      // and the noise gets the gate weakened or deleted. The right move when introducing
      // such a variable is to use an allowlisted name, or add the new one to BOTH the
      // workflow regex and PATTERNS.forcelessParanoidDestroy above.
      const invisible = 'await membership.destroy({ transaction: t });';
      expect(f02GateHits(invisible)).toBe('');
    });
  });
});
