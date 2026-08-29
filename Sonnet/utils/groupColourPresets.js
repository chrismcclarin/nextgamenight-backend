// utils/groupColourPresets.js
//
// Phase 88.3.1 (SPEC Req 5, CONTEXT D-01) — the eight group colour presets, as the
// BACKEND knows them, plus the fifteen-row legacy old->new remap table.
//
// Transcribed verbatim from 88.3.1-UI-SPEC.md Sections 2.2 (the eight presets) and
// 4.2 (the remap). NEVER re-derive these numbers: Section 4.2 point 1 records that
// Storm's destination turns on a deltaE2000 margin of 0.65 and legacy-orange's on
// 0.72, so two implementations differing in the third decimal would flip a row.
// The fifteen rows are hard-coded literals for exactly that reason; a computed
// nearest-preset path runs ONLY for a stored hex that is not in this table.
//
// WHERE THIS IS USED: middleware/validators.js (the value allowlist),
// migrations/20260828000002-remap-group-colours-to-presets.js (plan 88.3.1-05) and
// scripts/. There is no lib/ directory in this backend, so utils/ is the house
// location for a pure helper reachable from both migrations/ and scripts/.
// CommonJS, in the utils/phoneValidation.js shape.
//
// -----------------------------------------------------------------------------
// DECISION Phase 88.3.1 (D-01): the group's colour is stored as a preset ID (the
// WORD 'blue'), in a nullable STRING column, with the eight-id list COPIED into
// each repo rather than shared.
//
// CHOSEN: a copied eight-id constant per repo, held together by a contract test
// authored from the other repo's source. That is this codebase's house rule for
// cross-repo agreement -- see periodictabletop/src/lib/schemas/identity.contract.test.ts,
// whose header states its fixtures are "authored field-for-field from the route
// res.json(...) source of truth". The BE half of that contract for these ids is
// tests/unit/groupColourPresets.test.js.
//
// REJECTED (1) DataTypes.ENUM for the column. The ENUM cost is on the record at
// migrations/20260322000001-add-pending-role-to-usergroups.js:3-4,15-18: in
// Postgres, `ALTER TYPE ... ADD VALUE` is NON-TRANSACTIONAL, so adding a ninth
// preset would need a migration that cannot roll back and whose down() can only
// log a warning. With STRING + this allowlist, a ninth preset is a one-line
// validator edit and no migration at all.
//
// REJECTED (2) an npm package shared between the two repos. That is a
// supply-chain surface, a publish step and a version-skew failure mode, bought
// for eight strings.
//
// REJECTED (3) storing the resolved HEX (the pre-88.3.1 behaviour). Storing the
// word is what makes a palette re-tune a frontend-only edit with no data
// migration -- decisive because the eight hexes were picked BY EYE (SPEC Req 1)
// and real users arrive immediately after this phase. It is also how SPEC's
// "the stored value never becomes a rendered value" constraint is satisfied
// structurally rather than by discipline.
//
// Changing this is a decision, not a cleanup.
// -----------------------------------------------------------------------------

/**
 * The eight presets, in UI-SPEC Section 2.2 order.
 *
 * ORDER IS LOAD-BEARING. It is the picker's reading order (grid-cols-4: row 1
 * Red/Orange/Amber/Green, row 2 Teal/Blue/Violet/Rose -- the hue wheel, warm to
 * cool) AND the tie-break order for the migration's nearest-preset rule
 * (CONTEXT D-02). Re-sorting this array is a behaviour change to the migration.
 *
 * `dark` is the dark-theme band, `light` the light-theme surface. Both are
 * GROUNDS -- the colour a surface is filled with.
 *
 * THE FOUR INK VALUES ARE DELIBERATELY NOT HERE. UI-SPEC Section 4.1: the ink
 * hexes (the tinted text poles that pair with each ground) are never stored and
 * never sent -- they resolve on the frontend from the preset id, exactly like
 * the grounds do. They live ONLY in periodictabletop/src/lib/groupColourPresets.ts.
 * Adding them here would put a rendering value in the persistence layer, which
 * is the thing SPEC Req 5 and Gate B test 1 forbid. Their absence is the point.
 *
 * The `label` (UI string) is likewise frontend-only -- the backend never renders.
 */
const GROUP_COLOUR_PRESETS = Object.freeze([
  Object.freeze({ id: 'red', dark: '#52151c', light: '#ffd3d4' }),
  Object.freeze({ id: 'orange', dark: '#422200', light: '#ffd6b1' }),
  Object.freeze({ id: 'amber', dark: '#322b00', light: '#e7e0aa' }),
  Object.freeze({ id: 'green', dark: '#004511', light: '#bde9c2' }),
  Object.freeze({ id: 'teal', dark: '#003538', light: '#94edf0' }),
  Object.freeze({ id: 'blue', dark: '#00274d', light: '#c4e1ff' }),
  Object.freeze({ id: 'violet', dark: '#33255a', light: '#dfd9ff' }),
  Object.freeze({ id: 'rose', dark: '#3e133c', light: '#fdd1f8' }),
]);

/**
 * The allowlist the settings-route validator enforces. DERIVED from the array
 * above, never retyped -- a second hand-typed list is a second thing to forget.
 * @type {ReadonlyArray<string>}
 */
const GROUP_COLOUR_PRESET_IDS = Object.freeze(GROUP_COLOUR_PRESETS.map((p) => p.id));

/**
 * The fifteen known legacy stored values and where each one maps, transcribed
 * from UI-SPEC Section 4.2. Consumed by the remap migration (plan 88.3.1-05).
 *
 * Rule that produced these (recorded here so the table can be re-checked, NOT so
 * it can be recomputed at runtime): stored L* < 50 compares against the eight
 * dark bands, L* >= 50 against the eight light surfaces; nearest by deltaE2000;
 * ties break by GROUP_COLOUR_PRESETS order. '#ffffff' / null / '' stay unset.
 *
 *   from     - the legacy stored hex, lowercase
 *   label    - the legacy preset's name in the pre-88.3.1 picker (dry-run print)
 *   to       - the new preset id
 *   deltaE   - deltaE2000 from `from` to the winning preset's ground
 *   runnerUp - the second-nearest preset id
 *   margin   - runnerUp's deltaE minus the winner's; SMALL MEANS UNSAFE
 *
 * TWO ROWS ARE TIGHT AND THE D-03 DRY-RUN MUST PRINT BOTH HIGHLIGHTED WITH BOTH
 * CANDIDATES (UI-SPEC Section 4.2 points 2 and 4):
 *   - Storm '#27272a' -> blue at margin 0.65. This is "least-bad of two poor
 *     matches", not "nearest": Storm is achromatic (OKLCH C 0.005) and this
 *     palette has no achromatic member. The margin only widened from 0.05 to
 *     0.65 because Teal's hue moved 6deg for an unrelated reason, which is
 *     precisely why it cannot be relied on.
 *   - legacy orange '#fff3e0' -> orange at margin 0.72, new in rev3 (it was
 *     3.07 against the rev2 light band) because light `amber` gained chroma and
 *     moved toward the cream.
 *
 * `blue` absorbs six of the fifteen (Charcoal, Slate, Navy, Storm, legacy blue,
 * legacy grey), so the migration's down() is materially lossy there -- it can
 * restore only a canonical hex per preset, not the six originals. Exact per-row
 * restore comes from the pasted census, by hand (CONTEXT D-03).
 */
const LEGACY_COLOUR_REMAP = Object.freeze([
  // --- dark legacy presets (L* < 50, compared against the dark bands) ---
  Object.freeze({ from: '#1e1e2e', label: 'Charcoal', to: 'blue', deltaE: 11.06, runnerUp: 'violet', margin: 2.04 }),
  Object.freeze({ from: '#1e293b', label: 'Slate', to: 'blue', deltaE: 7.18, runnerUp: 'violet', margin: 5.03 }),
  Object.freeze({ from: '#172554', label: 'Navy', to: 'blue', deltaE: 4.81, runnerUp: 'violet', margin: 1.78 }),
  Object.freeze({ from: '#1e1b4b', label: 'Indigo', to: 'violet', deltaE: 4.57, runnerUp: 'blue', margin: 4.45 }),
  Object.freeze({ from: '#14332a', label: 'Forest', to: 'teal', deltaE: 6.72, runnerUp: 'green', margin: 8.03 }),
  Object.freeze({ from: '#3b1030', label: 'Wine', to: 'rose', deltaE: 3.41, runnerUp: 'violet', margin: 9.62 }),
  Object.freeze({ from: '#2c1f14', label: 'Espresso', to: 'orange', deltaE: 9.91, runnerUp: 'amber', margin: 2.73 }),
  // TIGHT ROW 1 of 2 -- see the block comment above. Do not "tidy" to teal.
  Object.freeze({ from: '#27272a', label: 'Storm', to: 'blue', deltaE: 15.56, runnerUp: 'teal', margin: 0.65 }),

  // --- light legacy values (L* >= 50, compared against the light surfaces) ---
  Object.freeze({ from: '#e3f2fd', label: 'legacy blue', to: 'blue', deltaE: 7.89, runnerUp: 'violet', margin: 7.05 }),
  Object.freeze({ from: '#e8f5e9', label: 'legacy green', to: 'green', deltaE: 12.54, runnerUp: 'amber', margin: 2.15 }),
  Object.freeze({ from: '#f3e5f5', label: 'legacy purple', to: 'violet', deltaE: 8.27, runnerUp: 'rose', margin: 2.43 }),
  // TIGHT ROW 2 of 2 -- see the block comment above. Do not "tidy" to amber.
  Object.freeze({ from: '#fff3e0', label: 'legacy orange', to: 'orange', deltaE: 11.29, runnerUp: 'amber', margin: 0.72 }),
  Object.freeze({ from: '#fce4ec', label: 'legacy pink', to: 'red', deltaE: 7.00, runnerUp: 'rose', margin: 4.09 }),
  Object.freeze({ from: '#f5f5f5', label: 'legacy grey', to: 'blue', deltaE: 13.92, runnerUp: 'violet', margin: 1.82 }),
  Object.freeze({ from: '#fffde7', label: 'legacy yellow', to: 'amber', deltaE: 10.99, runnerUp: 'green', margin: 4.74 }),
]);

module.exports = {
  GROUP_COLOUR_PRESETS,
  GROUP_COLOUR_PRESET_IDS,
  LEGACY_COLOUR_REMAP,
};
