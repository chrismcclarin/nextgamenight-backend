// utils/groupColourRemap.js
//
// Phase 88.3.1 plan 05 (SPEC Req 6, CONTEXT D-02/D-03) — the ONE definition of
// "what does this stored Groups.background_color become?".
//
// Pure maths + pure data: no models, no DB, no network, no npm dependency. It
// composes the two modules that already exist:
//   * utils/groupColourPresets.js  — GROUP_COLOUR_PRESETS + the fifteen-row
//                                    LEGACY_COLOUR_REMAP literal table (plan 02)
//   * utils/colourDistance.js      — deltaE2000 + CIE lStar, the verbatim port
//                                    of the frontend maths (plan 04)
//
// -----------------------------------------------------------------------------
// DECISION Phase 88.3.1 (D-02/D-03): the read-only census script and the remap
// migration share THIS module; neither computes its own nearest-preset answer.
//
// CHOSEN: one decision function, two callers. `scripts/census-group-colours.js`
// prints what will happen and `migrations/20260828000002-remap-group-colours-to-
// presets.js` then does it. CONTEXT D-03 makes the owner's glance at the printed
// table the confirmation dialog for a permanent UPDATE — which is only a
// confirmation if the printed answer and the written answer come from the same
// code. Two copies of this logic could disagree in the third decimal and the
// owner would approve one mapping while the migration wrote another.
//
// REJECTED (1) a copy of the nearest-preset loop in each of the two files. The
// margins this decision turns on are 0.65 (Storm) and 0.72 (legacy orange) —
// 88.3.1-RESEARCH.md Pitfall 5. "Duplication is never a peer option" is a
// project tenet (CLAUDE.md), and this is the case it was written for.
//
// REJECTED (2) putting these helpers in utils/colourDistance.js. That file
// declares itself a LINE-FOR-LINE port of two frontend modules and says a change
// is made THERE first — remap policy has no frontend twin and would break that
// contract.
//
// REJECTED (3) putting them in utils/groupColourPresets.js. That file is frozen
// DATA whose shape is mirrored by a cross-repo contract test; adding branching
// policy to it muddies what the contract is pinning.
//
// Changing this is a decision, not a cleanup.
// -----------------------------------------------------------------------------
//
// TOTALITY (threat T-88.3.1-10). `nearestPresetFor` returns `null` — never a
// number, never a throw — when the stored value cannot be parsed, because
// `deltaE2000`/`lStar` return `null` for an unparseable hex and a `null` coerced
// to 0 reads as a PERFECT MATCH. Both callers must branch on `null` and leave
// the row alone.

'use strict';

const { deltaE2000, lStar } = require('./colourDistance');
const { GROUP_COLOUR_PRESETS, LEGACY_COLOUR_REMAP } = require('./groupColourPresets');

/**
 * The legacy "no colour chosen" sentinel, byte-for-byte the frontend's rule:
 * periodictabletop/src/lib/colorUtils.js:140 —
 *   const UNSET_BACKGROUND_PATTERN = /^#(?:fff|ffffff)$/i;
 *
 * CASE-INSENSITIVE AND 3-DIGIT TOLERANT ON PURPOSE (plan 05 AMENDMENT M). The
 * settings picker defaulted to white and persisted it, and colorUtils.js:136-138
 * records that `#FFFFFF` and `#fff` variants EXIST in the data. A strict
 * lowercase `#ffffff` equality would treat those rows as coloured, remap them to
 * a real preset and null their background_color — irreversibly giving a
 * colourless group a colour. There is one correct answer here; it is not a
 * choice.
 */
const UNSET_BACKGROUND_PATTERN = /^#(?:fff|ffffff)$/i;

/**
 * True when a stored background_color means "this group has no colour".
 * @param {unknown} value
 * @returns {boolean}
 */
function isUnsetBackgroundColour(value) {
  if (!value || typeof value !== 'string') return true;
  return UNSET_BACKGROUND_PATTERN.test(value.trim());
}

/**
 * The SQL half of `isUnsetBackgroundColour`, negated: rows this phase considers
 * COLOURED. `lower(btrim(...)) NOT IN ('#fff','#ffffff')` is the exact SQL
 * equivalent of the case-insensitive, 3-digit-tolerant pattern above.
 *
 * ONE STRING, used by the census, by up()'s per-row statements and by up()'s
 * computed-arm scan — so the thing the owner is shown and the thing that is
 * mutated cannot drift apart.
 *
 * Deliberately unqualified (`background_color`, no table alias) — every consumer
 * queries "Groups" directly.
 * @type {string}
 */
const COLOURED_ROW_SQL = `background_color IS NOT NULL
       AND btrim(background_color) <> ''
       AND lower(btrim(background_color)) NOT IN ('#fff', '#ffffff')`;

/**
 * Lowercase + trim a stored hex for comparison against the fifteen literals.
 * Returns null for anything that is not a string.
 *
 * MATCHING IS CASE-INSENSITIVE (AMENDMENT M's rule applied to the known rows as
 * well as the unset ones): the pre-59-05 picker's shape validator only ever
 * checked /^#[0-9a-f]{6}$/i, so `#1E1E2E` is a Charcoal row in the wild. Matching
 * it case-sensitively would push a KNOWN row down the computed arm — and the
 * whole reason the fifteen are literals is that two of them turn on a margin
 * under 0.75 and must never be recomputed.
 * @param {unknown} value
 * @returns {string|null}
 */
function normaliseHex(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/** @type {Map<string, typeof LEGACY_COLOUR_REMAP[number]>} */
const KNOWN_REMAP_BY_HEX = new Map(LEGACY_COLOUR_REMAP.map((row) => [row.from, row]));

/**
 * The authoritative row for one of the fifteen known legacy values, or null.
 * NEVER recompute a known row — the literal is the authority (UI-SPEC 4.2 point 1).
 * @param {unknown} value
 * @returns {object|null}
 */
function knownRemapFor(value) {
  const hex = normaliseHex(value);
  if (hex === null) return null;
  return KNOWN_REMAP_BY_HEX.get(hex) || null;
}

/**
 * The computed fallback arm: the nearest preset to a stored hex that is NOT one
 * of the fifteen.
 *
 * CONTEXT D-02's rule, exactly: CIE L* < 50 compares against the eight dark
 * bands, L* >= 50 against the eight light surfaces; nearest by deltaE2000; ties
 * break by GROUP_COLOUR_PRESETS order.
 *
 * L* COMES FROM `utils/colourDistance.js`'s `lStar` AND NOTHING ELSE — never a
 * hand-rolled lightness formula and never `oklch(hex).L`. `oklch().L` is OKLab
 * lightness on a 0-1 scale; CIE L* is 0-100, and plan 04's proof 2a measured that
 * substituting one for the other sends EVERY colour down the dark arm. The two
 * receipts that pin this branch are `#767676` -> 49.6370 (dark arm) and
 * `#777777` -> 50.0344 (light arm) — one byte apart, opposite sides.
 *
 * @param {unknown} value a stored background_color
 * @returns {{
 *   hex: string, band: 'dark'|'light', lStar: number,
 *   to: string, deltaE: number, runnerUp: string, runnerUpDeltaE: number, margin: number
 * }|null} null when the value cannot be parsed — the caller MUST leave that row
 *   untouched rather than treating a missing distance as a match (T-88.3.1-10).
 */
function nearestPresetFor(value) {
  const hex = normaliseHex(value);
  if (hex === null) return null;

  const L = lStar(hex);
  if (L === null) return null;

  const band = L < 50 ? 'dark' : 'light';

  // Built in GROUP_COLOUR_PRESETS order, then sorted with Array#sort — which is
  // STABLE (spec-required since ES2019), so equal distances keep table order.
  // That IS the documented tie-break; do not swap in a comparator that "breaks
  // ties" some other way.
  const scored = [];
  for (const preset of GROUP_COLOUR_PRESETS) {
    const distance = deltaE2000(hex, preset[band]);
    if (distance === null) return null; // a preset ground failed to parse — refuse to guess
    scored.push({ id: preset.id, deltaE: distance });
  }
  scored.sort((a, b) => a.deltaE - b.deltaE);

  const [winner, runnerUp] = scored;
  return {
    hex,
    band,
    lStar: L,
    to: winner.id,
    deltaE: winner.deltaE,
    runnerUp: runnerUp.id,
    runnerUpDeltaE: runnerUp.deltaE,
    margin: runnerUp.deltaE - winner.deltaE,
  };
}

/**
 * The full decision for any stored value: the literal row when it is one of the
 * fifteen, the computed answer when it is not, `null` when it cannot be parsed.
 * `arm` says which path produced it, so the census and the deploy log can label
 * the row KNOWN or COMPUTED with the same word.
 * @param {unknown} value
 * @returns {{arm:'known'|'computed', to:string, deltaE:number, runnerUp:string,
 *   runnerUpDeltaE:number, margin:number, label:string|null, band:'dark'|'light'|null}|null}
 */
function decideFor(value) {
  const known = knownRemapFor(value);
  if (known) {
    return {
      arm: 'known',
      to: known.to,
      deltaE: known.deltaE,
      runnerUp: known.runnerUp,
      runnerUpDeltaE: known.deltaE + known.margin,
      margin: known.margin,
      label: known.label,
      band: null,
    };
  }
  const computed = nearestPresetFor(value);
  if (!computed) return null;
  return {
    arm: 'computed',
    to: computed.to,
    deltaE: computed.deltaE,
    runnerUp: computed.runnerUp,
    runnerUpDeltaE: computed.runnerUpDeltaE,
    margin: computed.margin,
    label: null,
    band: computed.band,
  };
}

/**
 * The canonical old hex `down()` restores for each preset: the row that mapped to
 * that preset with the SMALLEST deltaE. Declared as an explicit literal table
 * rather than derived at runtime, so a rollback statement can never change shape
 * because someone re-sorted a data file.
 *
 * THIS IS LOSSY AND THE LOSS IS NAMED IN NUMBERS. `blue` received SIX of the
 * fifteen (Charcoal, Slate, Navy, Storm, legacy blue, legacy grey); all six come
 * back as Navy `#172554`. `violet` received two (Indigo, legacy purple) and
 * `orange` received two (Espresso, legacy orange). Exact per-row restore comes
 * from the census pasted into 88.3.1-05-SUMMARY.md, by hand (CONTEXT D-03).
 * @type {Readonly<Record<string,string>>}
 */
const CANONICAL_DOWN_HEX = Object.freeze({
  red: '#fce4ec', // legacy pink, deltaE 7.00
  orange: '#2c1f14', // Espresso, deltaE 9.91
  amber: '#fffde7', // legacy yellow, deltaE 10.99
  green: '#e8f5e9', // legacy green, deltaE 12.54
  teal: '#14332a', // Forest, deltaE 6.72
  blue: '#172554', // Navy, deltaE 4.81 — the six-way merge lands here
  violet: '#1e1b4b', // Indigo, deltaE 4.57
  rose: '#3b1030', // Wine, deltaE 3.41
});

module.exports = {
  UNSET_BACKGROUND_PATTERN,
  isUnsetBackgroundColour,
  COLOURED_ROW_SQL,
  normaliseHex,
  knownRemapFor,
  nearestPresetFor,
  decideFor,
  CANONICAL_DOWN_HEX,
};
