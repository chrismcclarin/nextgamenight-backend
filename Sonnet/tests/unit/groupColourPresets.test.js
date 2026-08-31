// tests/unit/groupColourPresets.test.js
//
// Phase 88.3.1 plan 02 — the BACKEND half of the cross-repo preset contract.
//
// WHY THIS FILE EXISTS. utils/groupColourPresets.js justifies duplicating the
// eight preset ids in this repo by citing the house cross-repo pattern: a
// constant copied per repo, held together by a contract test authored from the
// other side's source of truth (periodictabletop/src/lib/schemas/identity.contract.test.ts
// does exactly this — "authored field-for-field from the route res.json(...)
// source of truth"). Without this file the backend id list would have NO
// committed test at all, and the duplication would be unguarded.
//
// THE FAILURE IT CATCHES is poly-repo deploy skew, which is a real and routine
// state here: the frontend ships on Vercel and the backend on Railway, from two
// separate repositories with two separate merges. A ninth preset added on one
// side only is ACCEPTED AND STORED by the backend while the frontend renders
// those groups uncoloured (or vice versa). This test is the STRUCTURAL half of
// that guard; the frontend's resolver logger.warn on an unknown id is the
// behavioural backstop. Structural first: a warn in a browser console nobody is
// watching is not a gate.
//
// THE VECTOR BELOW IS AUTHORED FROM 88.3.1-UI-SPEC.md Section 2.2 — the same
// table the frontend module is transcribed from, in the same order — NOT from
// utils/groupColourPresets.js. Re-deriving it from the module under test would
// make this file vacuous. If this test reds, do not "fix" it by copying the new
// module values in: check whether the OTHER repo moved too, and whether a
// migration is owed.
const {
  GROUP_COLOUR_PRESETS,
  GROUP_COLOUR_PRESET_IDS,
  LEGACY_COLOUR_REMAP,
} = require('../../utils/groupColourPresets');

// UI-SPEC Section 2.2, transcribed. Order is load-bearing: it is the picker's
// reading order AND the tie-break order for the migration's nearest-preset rule.
const SPEC_PRESETS = [
  { id: 'red', dark: '#52151c', light: '#ffd3d4' },
  { id: 'orange', dark: '#422200', light: '#ffd6b1' },
  { id: 'amber', dark: '#322b00', light: '#e7e0aa' },
  { id: 'green', dark: '#004511', light: '#bde9c2' },
  { id: 'teal', dark: '#003538', light: '#94edf0' },
  { id: 'blue', dark: '#00274d', light: '#c4e1ff' },
  { id: 'violet', dark: '#33255a', light: '#dfd9ff' },
  { id: 'rose', dark: '#3e133c', light: '#fdd1f8' },
];

describe('groupColourPresets — cross-repo contract (Phase 88.3.1, D-01)', () => {
  it('exposes exactly the eight UI-SPEC 2.2 ids, in UI-SPEC 2.2 order', () => {
    // toEqual on the ARRAY, not a set/sort — order is part of the contract.
    expect(GROUP_COLOUR_PRESET_IDS).toEqual([
      'red', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'rose',
    ]);
    expect(GROUP_COLOUR_PRESET_IDS).toEqual(SPEC_PRESETS.map((p) => p.id));
  });

  it('carries the locked dark band and light surface for each preset', () => {
    expect(GROUP_COLOUR_PRESETS.map((p) => ({ id: p.id, dark: p.dark, light: p.light })))
      .toEqual(SPEC_PRESETS);
  });

  it('stores NO ink values — they are rendering-only and must never reach the wire', () => {
    // UI-SPEC 4.1: the four ink hexes resolve on the frontend from the preset id.
    // A ground that gained an `inkDark`/`inkLight` here would be a rendering value
    // living in the persistence layer, which is what SPEC Req 5 forbids.
    for (const preset of GROUP_COLOUR_PRESETS) {
      expect(Object.keys(preset).sort()).toEqual(['dark', 'id', 'light']);
    }
  });

  it('is frozen — the allowlist cannot be mutated at runtime', () => {
    expect(Object.isFrozen(GROUP_COLOUR_PRESETS)).toBe(true);
    expect(Object.isFrozen(GROUP_COLOUR_PRESET_IDS)).toBe(true);
    expect(Object.isFrozen(LEGACY_COLOUR_REMAP)).toBe(true);
  });

  it('ids are lowercase, id-shaped, and collide with no legacy preset NAME', () => {
    // UI-SPEC 4.1: the ids must be tellable from a hex and from garbage with no
    // ambiguity, because the settings validator distinguishes exactly those three.
    const LEGACY_NAMES = ['charcoal', 'slate', 'navy', 'indigo', 'forest', 'wine', 'espresso', 'storm'];
    for (const id of GROUP_COLOUR_PRESET_IDS) {
      expect(id).toMatch(/^[a-z]+$/);
      expect(LEGACY_NAMES).not.toContain(id);
    }
    expect(new Set(GROUP_COLOUR_PRESET_IDS).size).toBe(8);
  });
});

describe('LEGACY_COLOUR_REMAP — the fifteen hard-coded rows (UI-SPEC 4.2)', () => {
  it('has fifteen rows and every destination is a real preset id', () => {
    expect(LEGACY_COLOUR_REMAP).toHaveLength(15);
    for (const row of LEGACY_COLOUR_REMAP) {
      expect(GROUP_COLOUR_PRESET_IDS).toContain(row.to);
      expect(GROUP_COLOUR_PRESET_IDS).toContain(row.runnerUp);
      expect(row.from).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('pins the two TIGHT rows the D-03 dry-run must print highlighted', () => {
    // These two are "least-bad of two", not "nearest" — a third-decimal difference
    // between two implementations would flip them, which is why the fifteen rows
    // are literals and not computed. UI-SPEC 4.2 points 1, 2 and 4.
    const storm = LEGACY_COLOUR_REMAP.find((r) => r.from === '#27272a');
    expect(storm).toMatchObject({ to: 'blue', runnerUp: 'teal', margin: 0.65 });

    const legacyOrange = LEGACY_COLOUR_REMAP.find((r) => r.from === '#fff3e0');
    expect(legacyOrange).toMatchObject({ to: 'orange', runnerUp: 'amber', margin: 0.72 });

    // No OTHER row is that tight — if a third one appears, the dry-run's
    // highlight list is out of date.
    const tight = LEGACY_COLOUR_REMAP.filter((r) => r.margin < 1.0).map((r) => r.from);
    expect(tight.sort()).toEqual(['#27272a', '#fff3e0']);
  });

  it('pins the merge groups down() cannot un-merge — blue absorbs six of fifteen', () => {
    const toBlue = LEGACY_COLOUR_REMAP.filter((r) => r.to === 'blue').map((r) => r.from);
    expect(toBlue.sort()).toEqual(
      ['#172554', '#1e1e2e', '#1e293b', '#27272a', '#e3f2fd', '#f5f5f5'].sort()
    );

    // Every preset receives at least one old value — there are no orphans
    // (UI-SPEC 4.2 merge-group table).
    const destinations = new Set(LEGACY_COLOUR_REMAP.map((r) => r.to));
    expect([...destinations].sort()).toEqual([...GROUP_COLOUR_PRESET_IDS].sort());
  });

  it("the e2e fixture's Navy hex maps to the preset id the fixture dual-writes", () => {
    // scripts/e2e-fixtures.js stores background_color '#172554' AND
    // color_preset 'blue'. If the remap ever sent Navy somewhere else, the
    // fixture's pair would be internally inconsistent and the frontend contrast
    // probe would render one colour before the cutover and another after.
    const navy = LEGACY_COLOUR_REMAP.find((r) => r.from === '#172554');
    expect(navy.to).toBe('blue');
  });
});
