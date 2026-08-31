// tests/unit/colourDistance.test.js
// Phase 88.3.1 plan 04 — the BACKEND HALF of a cross-repo agreement fixture.
//
// THE CROSS-REPO AGREEMENT (88.3.1-RESEARCH.md Pitfall 5, CONTEXT D-02)
// ---------------------------------------------------------------------
// `CROSS_REPO_DELTA_E_FIXTURES` and `CROSS_REPO_LSTAR_FIXTURES` below are mirrored VERBATIM
// from `periodictabletop/src/lib/colourDistance.test.ts` (plan 88.3.1-01) — identical pairs,
// identical expected numbers. `utils/colourDistance.js` is a verbatim port of that repo's
// `src/lib/colourDistance.ts` + `src/lib/wcag.ts:129-243`, and the two repos share no
// directory and cannot import each other. Asserting the SAME numbers independently on both
// sides is the ONLY mechanism that can turn a divergence into a RED TEST rather than a
// silently wrong permanent migration row.
//
// **Changing a number in either block without changing it in the frontend fixture is a
// defect, not a fix.** What it would otherwise cost, precisely:
//
//   - DeltaE2000. The plan 88.3.1-05 migration picks each group's preset by nearest distance.
//     `Storm #27272a` sits 15.56 from the new dark `blue` band and 16.21 from `teal` — a
//     margin of **0.65**. `legacy orange #fff3e0` sits 11.29 from the new light `orange`
//     surface and 12.01 from `amber` — a margin of **0.72**. A sign or quadrant slip in one
//     repo's CIEDE2000 moves a distance by more than either margin and permanently writes the
//     wrong preset, with a green suite on both sides.
//
//   - L*. The same migration's computed arm FIRST branches on lightness: an unknown hex with
//     `lStar < 50` is matched against the eight DARK bands, `>= 50` against the eight LIGHT
//     surfaces. An L*-only divergence is completely invisible to the DeltaE block — both
//     repos would agree on every distance and disagree about which set of eight to measure
//     against, which is a worse failure than a wrong distance. Hence a second, separate
//     fixture.
//
// DB-FREE, and it MUST STAY THAT WAY: no model-layer import, no `../../models`, no
// destructive schema rebuild (the 83.1 shared-DB hazard — RESEARCH Pitfall 4).
// `utils/colourDistance.js` is pure maths with no dependency of any kind. Runs under
// `npm run test:unit` (jest.unit.config.js, no Postgres) AND under the default `npm test`.
//
// FLOORS, NOT ACTUALS (RESEARCH Pitfall 6). The palette's own DeltaE minima and hue gaps are
// NOT asserted here — the eight-preset id list is owned by `tests/unit/groupColourPresets.test.js`
// and the palette values by frontend `src/lib/groupColourPresets.test.ts` (plan 88.3.1-03).
// What is asserted here is the ARITHMETIC. The two decision margins are asserted as RANGES,
// never as point values, so a fourth-decimal difference cannot make "update the number" look
// like the fix — the claim being protected is "the runner-up is farther, but only just".
//
// The remap table itself belongs to plan 88.3.1-05's migration test, not here.

const { deltaE2000, oklch, relativeLuminance, lStar } = require('../../utils/colourDistance');

/**
 * CROSS-REPO FIXTURE 1 — DeltaE2000. Mirrored verbatim from frontend
 * `src/lib/colourDistance.test.ts`. Values re-derived independently in `88.3.1-RESEARCH.md`
 * `## The Palette, Independently Verified` (2026-08-28). Two decimal places: the decisions
 * these numbers drive have margins of 0.65 and 0.72, so 2dp is three times finer than the
 * tightest call in the phase.
 */
const CROSS_REPO_DELTA_E_FIXTURES = [
  {
    a: '#27272a',
    b: '#00274d',
    expected: 15.56,
    why: 'Storm (legacy) vs the new dark `blue` band — the WINNER of the tightest row in the phase',
  },
  {
    a: '#27272a',
    b: '#003538',
    expected: 16.21,
    why: 'Storm vs the new dark `teal` band — the runner-up; the gap to the row above is 0.65 and it is what decides Storm',
  },
  {
    a: '#fff3e0',
    b: '#ffd6b1',
    expected: 11.29,
    why: 'legacy orange vs the new light `orange` surface — the WINNER',
  },
  {
    a: '#fff3e0',
    b: '#e7e0aa',
    expected: 12.01,
    why: 'legacy orange vs the new light `amber` surface — the runner-up; gap 0.72',
  },
];

/**
 * CROSS-REPO FIXTURE 2 — CIE L*. Mirrored verbatim from frontend
 * `src/lib/colourDistance.test.ts`, where `lStar` is imported from `src/lib/wcag.ts` (its sole
 * owner there). Here it comes from the ported `utils/colourDistance.js`, because the backend
 * has no `wcag` module.
 *
 * The last two rows are ONE HEX STEP apart and straddle the migration's 50 threshold from
 * either side — `#767676` at 49.64 takes the DARK arm, `#777777` at 50.03 takes the LIGHT
 * arm. That is the tightest possible pin on the branch itself: any divergence large enough to
 * flip a real group's arm moves at least one of these two off its expected value.
 */
const CROSS_REPO_LSTAR_FIXTURES = [
  { hex: '#27272a', expected: 15.75, arm: 'DARK (< 50)', why: 'Storm — the dark-arm remap row with the 0.65 margin' },
  { hex: '#fff3e0', expected: 96.3, arm: 'LIGHT (>= 50)', why: 'legacy orange — the light-arm remap row with the 0.72 margin' },
  { hex: '#767676', expected: 49.64, arm: 'DARK (< 50)', why: 'one step BELOW the 50 threshold — must take the dark arm' },
  { hex: '#777777', expected: 50.03, arm: 'LIGHT (>= 50)', why: 'one step ABOVE the 50 threshold — must take the light arm' },
];

/** The eight dark bands, `88.3.1-UI-SPEC.md` section 2.2. The palette itself is plan 88.3.1-03's. */
const DARK_BANDS = [
  '#52151c', // red
  '#422200', // orange
  '#322b00', // amber
  '#004511', // green
  '#003538', // teal
  '#00274d', // blue
  '#33255a', // violet
  '#3e133c', // rose
];

describe('deltaE2000 — the cross-repo agreement fixture (RESEARCH Pitfall 5)', () => {
  it.each(CROSS_REPO_DELTA_E_FIXTURES)(
    'DeltaE2000($a, $b) is $expected — $why',
    ({ a, b, expected }) => {
      expect(deltaE2000(a, b)).toBeCloseTo(expected, 2);
    },
  );

  it('the Storm margin is a real but SUB-1.0 gap — the tightest decision in the phase', () => {
    // UI-SPEC section 4.2 point 2. Asserted as a RANGE, never as `toBe(0.65)`: the claim being
    // protected is "teal is farther than blue, but only just", and a point assertion on the
    // margin would red on a fourth decimal and invite someone to "update the number".
    const toBlue = deltaE2000('#27272a', '#00274d');
    const toTeal = deltaE2000('#27272a', '#003538');
    expect(toBlue).not.toBeNull();
    expect(toTeal).not.toBeNull();
    const margin = toTeal - toBlue;
    // actual 0.6453 — recorded, not asserted. If this ever goes <= 0 the migration's Storm
    // row has flipped to `teal` and UI-SPEC section 4.2 is wrong.
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(1);
  });

  it('the legacy-orange margin is likewise positive and sub-1.0', () => {
    const toOrange = deltaE2000('#fff3e0', '#ffd6b1');
    const toAmber = deltaE2000('#fff3e0', '#e7e0aa');
    const margin = toAmber - toOrange; // actual 0.7221
    expect(margin).toBeGreaterThan(0);
    expect(margin).toBeLessThan(1);
  });
});

describe('lStar — the cross-repo agreement fixture (companion to the DeltaE block)', () => {
  it.each(CROSS_REPO_LSTAR_FIXTURES)('lStar($hex) is $expected, arm $arm — $why', ({ hex, expected }) => {
    expect(lStar(hex)).toBeCloseTo(expected, 2);
  });

  it('the 50 threshold the remap branches on falls BETWEEN the two grey rows', () => {
    // The BRANCH itself, not just the numbers feeding it. `#767676` (49.64) and `#777777`
    // (50.03) are one hex step apart. A divergence that moved either grey across 50 would send
    // an unknown hex to the wrong set of eight candidates, and no DeltaE2000 assertion
    // anywhere could notice.
    expect(lStar('#767676')).toBeLessThan(50);
    expect(lStar('#777777')).toBeGreaterThanOrEqual(50);
  });

  it('lStar is TOTAL — a malformed or hostile input returns null, never a plausible lightness', () => {
    // Threat T-88.3.1-11. Plan 88.3.1-05's fallback arm is handed arbitrary
    // `Groups.background_color` values; a number returned for an input that was never
    // understood would silently pick a band set. `null` must leave the row untouched.
    expect(lStar(null)).toBeNull();
    expect(lStar(undefined)).toBeNull();
    expect(lStar('nope')).toBeNull();
    expect(lStar('')).toBeNull();
    expect(lStar(42)).toBeNull();
    expect(lStar('#12345')).toBeNull();
    expect(relativeLuminance('nope')).toBeNull();
    expect(relativeLuminance(null)).toBeNull();
  });

  it('lStar is CIE L* (0-100), not OKLab L (0-1) — the two scales must never be substituted', () => {
    // Recorded as a test rather than only as a comment because plan 88.3.1-05's dark/light
    // branch compares a lightness against 50. Handing it `oklch().L` (a 0-1 number) would
    // send EVERY colour down the dark arm, silently. REJECTED alternative 4 in the module header.
    for (const hex of DARK_BANDS) {
      expect(oklch(hex).L).toBeLessThan(1);
      expect(lStar(hex)).toBeGreaterThan(1);
    }
    expect(lStar('#ffffff')).toBeCloseTo(100, 2);
    expect(lStar('#000000')).toBeCloseTo(0, 2);
  });
});

describe('deltaE2000 — identity, symmetry and totality', () => {
  it.each(DARK_BANDS)('identity: the distance from %s to itself is exactly 0', (hex) => {
    expect(deltaE2000(hex, hex)).toBe(0);
  });

  it('symmetry: argument order never changes the distance (to 10dp)', () => {
    // CIEDE2000 is symmetric, and an `Rt` / mean-hue quadrant bug breaks symmetry FIRST —
    // before it breaks any of the fixture values above. This is the cheapest early warning
    // the formula has, so it is asserted over every fixture pair and every band pair.
    for (const { a, b } of CROSS_REPO_DELTA_E_FIXTURES) {
      expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
    }
    for (const a of DARK_BANDS) {
      for (const b of DARK_BANDS) {
        expect(deltaE2000(a, b)).toBeCloseTo(deltaE2000(b, a), 10);
      }
    }
  });

  it('totality: a malformed or hostile input returns null, never a plausible number', () => {
    // Threats T-88.3.1-01 / T-88.3.1-10. `deltaE2000` is handed arbitrary
    // `Groups.background_color` values by the plan 88.3.1-05 migration. A number returned for
    // an input that was never understood is the dangerous outcome — 0 in particular reads as
    // "a perfect match", so a caller must branch on `null` and leave the row untouched.
    expect(deltaE2000(null, '#ffffff')).toBeNull();
    expect(deltaE2000(undefined, '#ffffff')).toBeNull();
    expect(deltaE2000('nope', '#ffffff')).toBeNull();
    expect(deltaE2000('not-a-hex', '#ffffff')).toBeNull();
    expect(deltaE2000('', '#ffffff')).toBeNull();
    expect(deltaE2000('#ffffff', 42)).toBeNull();
    expect(deltaE2000('#12345', '#ffffff')).toBeNull();
    expect(oklch(42)).toBeNull();
    expect(oklch(null)).toBeNull();
    expect(oklch('rgb(1, 2)')).toBeNull();
  });
});

describe('oklch — structure', () => {
  it('white is L ~ 1 with no chroma, black is L ~ 0', () => {
    const white = oklch('#ffffff');
    expect(white).not.toBeNull();
    expect(white.L).toBeCloseTo(1, 3);
    expect(white.C).toBeLessThan(0.001);
    expect(oklch('#000000').L).toBeCloseTo(0, 3);
  });

  it('a near-neutral has no meaningful hue — which is exactly why Storm is a hard remap row', () => {
    // `#f5f5f5` and `#27272a` are both effectively achromatic. `h` is numerically defined for
    // them but carries no perceptual information, so the nearest-preset rule cannot lean on
    // hue for a grey; it has to fall back on DeltaE2000, where Storm's two candidates sit
    // 0.65 apart. A caller must check `C` before trusting `h`.
    expect(oklch('#f5f5f5').C).toBeLessThan(0.005);
    expect(oklch('#27272a').C).toBeLessThan(0.02);
  });

  it('every dark band returns a finite hue inside [0, 360) and a real chroma', () => {
    // The >= 30 degree pairwise hue-gap floor itself is plan 88.3.1-03's assertion, on the
    // palette module. All this file claims is that the function returns usable numbers for the
    // eight real inputs — no NaN from an atan2 edge, no 360 wrap-around off-by-one.
    for (const hex of DARK_BANDS) {
      const value = oklch(hex);
      expect(value).not.toBeNull();
      expect(Number.isFinite(value.h)).toBe(true);
      expect(value.h).toBeGreaterThanOrEqual(0);
      expect(value.h).toBeLessThan(360);
      expect(value.C).toBeGreaterThan(0.03); // actual range 0.051-0.104 (UI-SPEC section 2.2)
      expect(value.L).toBeGreaterThan(0);
      expect(value.L).toBeLessThan(1);
    }
  });
});
