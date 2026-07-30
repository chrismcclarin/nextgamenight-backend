// tests/unit/verify-allowlist-markers.test.js
// Phase 88.4 / Plan 08 (88.4-CODE-REVIEW.md #3 + #10): unit coverage for the ADJACENCY-PAIRED
// allowlist marker gate (scripts/ci/verify-allowlist-markers.js -> analyze), SPEC R6.
//
// WHY THIS FILE EXISTS AT ALL. The gate it verifies used to be four lines of awk + grep inside
// ci.yml, comparing two totals. It passed on three distinct malformed files (an unmarked entry
// masked by a duplicated token, an orphaned block left behind by a deleted entry, and markers
// sitting against the wrong entries) — and there was no way to test any of that, because the
// gate was an inline shell fragment. `analyze` is a PURE function of SOURCE TEXT, so every one of
// those cases is now a fixture below.
//
// The failure mode being guarded is the usual one for this phase: a gate that passes when it
// should fail is indistinguishable from a repo with nothing wrong in it.
//
// DB-free: no model import, no connection. Runs in the `npm run test:unit` lane.

const fs = require('fs');
const path = require('path');
const { analyze } = require('../../scripts/ci/verify-allowlist-markers');

// A minimal stand-in for the allowlist module's shape. Only the `const ENTRIES` array region is
// parsed, so the surrounding module can be elided — but the HEADER's nested marker template is
// reproduced, because scoring that as a real marker is exactly the bug the anchor prevents.
const HEADER = [
  "'use strict';",
  '//',
  '// EVERY ENTRY REQUIRES A FULL MARKER COMMENT BLOCK immediately above it, in this form:',
  '//',
  '//     // DECISION Phase 88.4 <what was accepted> OVER <what was rejected> — <why>',
  '//',
].join('\n');

const ENTRY_BODY = [
  "    side: 'migration-only',",
  "    kind: 'unique',",
  "    table: 'Friendships',",
  "    keySpec: 'LEAST(a, b),GREATEST(a, b)',",
  "    predicate: '',",
  "    includeSpec: '(none)',",
  "    nullsNotDistinct: '(none)',",
  "    signedOffBy: 'owner',",
  "    signedOffOn: '2026-07-30',",
].join('\n');

const marked = (n) =>
  [`  // DECISION Phase 88.4 entry-${n}: accepted X OVER Y — because Z.`, '  {', ENTRY_BODY, '  },'].join(
    '\n'
  );

const unmarked = () => ['  {', ENTRY_BODY, '  },'].join('\n');

const mod = (body) => `${HEADER}\nconst ENTRIES = deepFreezeEntries([\n${body}\n]);\n`;

describe('the day-one file (0 entries) passes and is not a vacuous pass', () => {
  test('an empty array yields 0 entries, 0 markers, 0 errors', () => {
    const r = analyze(mod(''));
    expect(r.entries).toEqual([]);
    expect(r.markers).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test("the module header's own nested marker template is NOT counted (the anchor earns its keep)", () => {
    // A bare `grep -c 'DECISION Phase 88.4'` over the whole file returns 1 here with ZERO real
    // markers, which is how the pre-anchor version of this gate could have passed one unjustified
    // entry forever.
    expect(HEADER).toContain('DECISION Phase 88.4');
    expect(analyze(mod('')).markers).toEqual([]);
  });

  test('the REAL committed allowlist module conforms', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../scripts/ci/schema-drift-allowlist.js'),
      'utf8'
    );
    expect(analyze(src).errors).toEqual([]);
  });

  test('a source with no `const ENTRIES` THROWS rather than passing vacuously', () => {
    // The whole gate lives inside that region. A renamed or reformatted declaration must be a
    // loud failure, never an empty-and-therefore-fine result.
    expect(() => analyze("'use strict';\nmodule.exports = {};\n")).toThrow(/const ENTRIES/);
  });
});

describe('CHECK 1 — adjacency: every entry needs its OWN marker block', () => {
  test('one properly marked entry passes', () => {
    const r = analyze(mod(marked(1)));
    expect(r.entries).toHaveLength(1);
    expect(r.markers).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  test('three properly marked entries pass', () => {
    const r = analyze(mod([marked(1), marked(2), marked(3)].join('\n')));
    expect(r.entries).toHaveLength(3);
    expect(r.errors).toEqual([]);
  });

  test('an UNMARKED entry fails even when the total count is satisfied elsewhere', () => {
    // THE #10 CASE, exactly: entry 1 carries a two-line marker block, entry 2 carries none. Two
    // markers, two entries — the retired count-based gate passed this.
    const twoTokenBlock = [
      '  // DECISION Phase 88.4 entry-1: accepted X OVER Y — because Z.',
      '  // DECISION Phase 88.4 entry-1 (continued): and also because W.',
      '  {',
      ENTRY_BODY,
      '  },',
    ].join('\n');
    const r = analyze(mod([twoTokenBlock, unmarked()].join('\n')));
    expect(r.entries).toHaveLength(2);
    expect(r.markers).toHaveLength(2); // the count comparison alone sees nothing wrong
    expect(r.errors.some((e) => /NO 'DECISION Phase 88.4' marker/.test(e))).toBe(true);
  });

  test('a BLANK line between the marker block and the entry breaks adjacency', () => {
    // Deliberate: a marker separated by a blank line reads as belonging to whatever came before
    // it, which is the ambiguity this gate closes.
    const separated = [
      '  // DECISION Phase 88.4 entry-1: accepted X OVER Y — because Z.',
      '',
      '  {',
      ENTRY_BODY,
      '  },',
    ].join('\n');
    const r = analyze(mod(separated));
    expect(r.errors.some((e) => /NO 'DECISION Phase 88.4' marker/.test(e))).toBe(true);
  });

  test('markers sitting against the WRONG entries fail (position is checked, not just presence)', () => {
    // Both markers stacked above entry 1; entry 2 bare. Counts agree, positions do not.
    const stacked = [
      '  // DECISION Phase 88.4 entry-1: accepted X OVER Y — because Z.',
      '  // DECISION Phase 88.4 entry-2: accepted P OVER Q — because R.',
      '  {',
      ENTRY_BODY,
      '  },',
      '  {',
      ENTRY_BODY,
      '  },',
    ].join('\n');
    const r = analyze(mod(stacked));
    expect(r.entries).toHaveLength(2);
    expect(r.markers).toHaveLength(2);
    expect(r.errors.some((e) => /NO 'DECISION Phase 88.4' marker/.test(e))).toBe(true);
  });

  test('a wrapped block whose continuation lines are plain `//` passes, and counts as ONE marker', () => {
    const wrapped = [
      '  // DECISION Phase 88.4 entry-1: allowlisted the Friendships pair-unique index OVER',
      '  // reconciling it into models/Friendship.js, because <reason wrapped across lines>.',
      '  // Removing this entry MUST turn migrate-cli-replay red on that instance (SPEC R6).',
      '  {',
      ENTRY_BODY,
      '  },',
    ].join('\n');
    const r = analyze(mod(wrapped));
    expect(r.markers).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
});

describe('CHECK 2 — no orphaned marker blocks', () => {
  test('a marker left behind after its entry was deleted fails', () => {
    // THE #3 CASE: markers > entries passed silently before, leaving rationale describing drift
    // that is no longer accepted while reading as though it still is.
    const orphan = [
      marked(1),
      '  // DECISION Phase 88.4 entry-2: accepted P OVER Q — because R.',
    ].join('\n');
    const r = analyze(mod(orphan));
    expect(r.entries).toHaveLength(1);
    expect(r.markers).toHaveLength(2);
    expect(r.errors.some((e) => /ORPHANED/.test(e))).toBe(true);
  });

  test('a marker AFTER the last entry (trailing rationale) is reported as orphaned', () => {
    const trailing = [
      marked(1),
      '  // DECISION Phase 88.4 stale: this object was reconciled in a later phase.',
    ].join('\n');
    expect(analyze(mod(trailing)).errors.some((e) => /ORPHANED/.test(e))).toBe(true);
  });
});

describe('CHECK 3 — counts, reported on a different signal from checks 1 and 2', () => {
  test('a duplicated token on one entry is called out by the count check too', () => {
    const dup = [
      '  // DECISION Phase 88.4 entry-1: accepted X OVER Y — because Z.',
      '  // DECISION Phase 88.4 entry-1: (accidental second token line)',
      '  {',
      ENTRY_BODY,
      '  },',
    ].join('\n');
    const r = analyze(mod(dup));
    // Adjacency and orphan checks both PASS here (the run is adjacent and both markers are
    // claimed by it) — the count check is the only one that fires, which is why it is kept.
    expect(r.errors.some((e) => /NO 'DECISION Phase 88.4' marker/.test(e))).toBe(false);
    expect(r.errors.some((e) => /ORPHANED/.test(e))).toBe(false);
    expect(r.errors.some((e) => /count mismatch/.test(e))).toBe(true);
  });
});

describe('the parser handles the entry shapes the module contract actually permits', () => {
  test("a nested multi-line `accepted:` object is NOT mistaken for a second entry", () => {
    const differs = [
      '  // DECISION Phase 88.4 entry-1: accepted CASCADE-vs-SET-NULL OVER reconciling — reason.',
      '  {',
      "    side: 'differs',",
      "    kind: 'fk',",
      "    table: 'UserGroups',",
      "    keySpec: 'user_uuid',",
      "    predicate: '',",
      "    parentTable: 'Users',",
      "    parentColumns: 'id',",
      "    onDelete: 'CASCADE',",
      "    onUpdate: 'NO ACTION',",
      "    matchType: 'SIMPLE',",
      '    accepted: {',
      "      attribute: 'onDelete',",
      "      migration: 'CASCADE',",
      "      sync: 'SET NULL',",
      '    },',
      "    signedOffBy: 'owner',",
      "    signedOffOn: '2026-07-30',",
      '  },',
    ].join('\n');
    const r = analyze(mod(differs));
    expect(r.entries).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  test('a brace inside a single-quoted value is not counted as an entry', () => {
    // A predicate can legitimately contain braces, e.g. an array-literal cast.
    const braceInValue = [
      '  // DECISION Phase 88.4 entry-1: accepted X OVER Y — because Z.',
      '  {',
      "    side: 'migration-only',",
      "    kind: 'unique',",
      "    table: 'AvailabilityPrompts',",
      "    keySpec: 'group_id',",
      "    predicate: '(status = ANY (ARRAY[{pending}]))',",
      "    includeSpec: '(none)',",
      "    nullsNotDistinct: '(none)',",
      "    signedOffBy: 'owner',",
      "    signedOffOn: '2026-07-30',",
      '  },',
    ].join('\n');
    const r = analyze(mod(braceInValue));
    expect(r.entries).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });

  test('content after the array closes is out of scope (a later marker in the file is ignored)', () => {
    const src =
      `${HEADER}\nconst ENTRIES = deepFreezeEntries([\n${marked(1)}\n]);\n` +
      '// DECISION Phase 88.4 something else entirely, far below the array.\n' +
      'module.exports = { ENTRIES };\n';
    const r = analyze(src);
    expect(r.entries).toHaveLength(1);
    expect(r.markers).toHaveLength(1);
    expect(r.errors).toEqual([]);
  });
});
