'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88.3.1 plan 05 (SPEC Req 6, CONTEXT D-02/D-03) — the one-time DATA remap
// that moves every coloured group off a stored hex and onto a preset id.
//
// This is the phase's ONE destructive act. Its confirmation dialog is
// `scripts/census-group-colours.js`, run against production and pasted into
// 88.3.1-05-SUMMARY.md for the owner's glance BEFORE this PR merges (CONTEXT
// D-03). Both files reach their answer through the SAME module,
// utils/groupColourRemap.js, so what the owner approved and what runs here cannot
// diverge.
//
// SCHEMA vs DATA are two files, following the house precedent recorded at
// 20260820000001-events-status-default-scheduled.js:19-20. The column is added by
// 20260828000001 (plan 02); this file only writes rows.
//
// ---------------------------------------------------------------------------
// IDEMPOTENT BY CONSTRUCTION (the 20260820000003-clamp-oversize-names.js:29-33
// pattern). Every statement carries `color_preset IS NULL`, which is the exact
// negation of its own post-condition (`color_preset = <the preset>`), so a second
// run matches zero rows. The migrate-cli-replay CI job depends on this.
//
// ---------------------------------------------------------------------------
// WHAT IS NEVER TOUCHED. `#ffffff`, `#FFFFFF`, `#fff`, `#FFF`, NULL and `''` all
// mean "this group has no colour" — the settings picker defaulted to white and
// persisted it. That predicate is CASE-INSENSITIVE and 3-DIGIT TOLERANT because
// the app's own definition is (periodictabletop/src/lib/colorUtils.js:140,
// `/^#(?:fff|ffffff)$/i`, whose comment at :136-138 records that those variants
// EXIST in the data). A stricter lowercase-only check would remap a colourless
// group to a real preset and null its background_color — irreversibly giving it a
// colour. The predicate is imported from utils/groupColourRemap.js
// (COLOURED_ROW_SQL) so the census, up() and the computed scan share one string.
// down()'s guard is `background_color IS NULL`, which is strictly narrower and so
// cannot reach an unset row at all.
//
// MATCHING THE FIFTEEN IS ALSO CASE-INSENSITIVE (`lower(btrim(...))`). The
// pre-59-05 picker's validator only ever checked hex SHAPE (/^#[0-9a-f]{6}$/i), so
// `#1E1E2E` is a Charcoal row in the wild. Matching case-sensitively would push a
// KNOWN row down the computed arm — and the entire reason the fifteen are literals
// is that two of them must never be recomputed.
//
// ---------------------------------------------------------------------------
// DECISION Phase 88.3.1 (D-02/D-03): FIFTEEN HARD-CODED LITERALS plus a computed
// fallback arm, with the read-only dry-run census as the confirmation gate.
//
// CHOSEN: the fifteen values known to exist in the wild take their destination
// from the literal table in utils/groupColourPresets.js and are NEVER recomputed
// at migration time; only a stored hex OUTSIDE that table reaches the deltaE2000
// path.
//
// REJECTED (1) computing all fifteen at migration time. Storm `#27272a`'s
// destination turns on a deltaE2000 margin of 0.65 (blue 15.56 vs teal 16.21) and
// legacy orange `#fff3e0`'s on 0.72 (orange 11.29 vs amber 12.01). Two
// implementations differing in the THIRD DECIMAL would flip a permanent mutation,
// and both would ship green (88.3.1-RESEARCH.md Pitfall 5).
//
// REJECTED (2) a hand-written mapping with NO computed arm. It would silently
// skip any stored hex outside the fifteen, and RESEARCH assumptions A1 (the seven
// legacy light hexes are the complete pre-59-05 set) and A2 (prod holds nothing
// else) are UNVERIFIED until the census runs against production.
//
// REJECTED (3) mapping everything to one default preset — violates SPEC Req 6.
//
// REJECTED (4) a `--dry-run` flag on THIS file. railway.json's
// deploy.preDeployCommand runs `npm run migrate:apply` with NO ARGUMENTS on every
// deploy, so the flag would never arrive and the real run would happen
// automatically at merge, before anyone saw the table (RESEARCH Pitfall 2). That
// is why the dry run is a sibling script.
//
// Changing this is a decision, not a cleanup.
// ---------------------------------------------------------------------------
//
// down() IS LOSSY IN TWO SEPARATE WAYS, AND BOTH ARE STATED IN NUMBERS RATHER
// THAN IMPLIED. It is a SCHEMA ESCAPE HATCH, NOT A DATA RESTORE.
//
//   LOSS 1 — MERGE GROUPS. `blue` received SIX of the fifteen old values
//   (Charcoal, Slate, Navy, Storm, legacy blue, legacy grey) — 40% of the
//   mapping. Their source hexes are deliberately NOT repeated here; they live in
//   utils/groupColourPresets.js and nowhere else. down() can only put ONE hex
//   back per preset, so all six return as Navy #172554. `violet` received two
//   (Indigo, legacy purple) and both return as Indigo #1e1b4b; `orange` received
//   two (Espresso, legacy orange) and both return as Espresso #2c1f14. Exact
//   per-row restore comes from the census pasted into 88.3.1-05-SUMMARY.md, BY
//   HAND. The owner accepted this under the friends-and-family latitude (CONTEXT
//   D-03), WHICH EXPIRES WITH THIS PHASE.
//
//   LOSS 2 — down() CANNOT TELL A PRESET THIS MIGRATION WROTE FROM ONE A USER
//   CHOSE AFTERWARDS (plan 05 AMENDMENT P). Its `color_preset = :id AND
//   background_color IS NULL` matches both, so a rollback rewrites live user
//   choices as legacy hexes those groups NEVER HAD — inventing history rather
//   than restoring it. Every day this migration is live, that population grows.
//   Between LOSS 1 and LOSS 2, a down-then-up round trip is NOT identity. This is
//   deliberately NOT fixed with a marker column: that is new schema existing only
//   for a rollback path, and the pasted census is already the exact-restore
//   source.

const {
  COLOURED_ROW_SQL,
  nearestPresetFor,
} = require('../utils/groupColourRemap');
const { LEGACY_COLOUR_REMAP } = require('../utils/groupColourPresets');

// The fifteen rows are NOT restated here — one definition, shared with
// scripts/census-group-colours.js (project tenet: duplication is never a peer
// option). The L* used for the computed arm's dark/light branch and the
// deltaE2000 used for its distances both come from utils/colourDistance.js, the
// verbatim port of the frontend maths, reached through utils/groupColourRemap.js.
// NEVER a hand-rolled lightness formula, and never OKLab lightness — that is a
// 0-1 scale where CIE L* is 0-100, and plan 04's proof 2a measured that the
// substitution sends EVERY colour down the dark arm.

const LOG = '[88.3.1]';

/**
 * The canonical old hex down() restores for each preset: the row that mapped to
 * that preset with the SMALLEST deltaE. An EXPLICIT LITERAL TABLE in this file,
 * not derived at runtime, so a rollback can never change shape because someone
 * re-sorted a data file in utils/.
 */
const CANONICAL_DOWN_HEX = Object.freeze({
  red: '#fce4ec', // legacy pink, dE 7.00
  orange: '#2c1f14', // Espresso, dE 9.91 — also receives legacy orange
  amber: '#fffde7', // legacy yellow, dE 10.99
  green: '#e8f5e9', // legacy green, dE 12.54
  teal: '#14332a', // Forest, dE 6.72
  blue: '#172554', // Navy, dE 4.81 — the SIX-way merge lands here (LOSS 1)
  violet: '#1e1b4b', // Indigo, dE 4.57 — also receives legacy purple
  rose: '#3b1030', // Wine, dE 3.41
});

// Both arms use bind parameters, not interpolation (plan 05 AMENDMENT Q). The
// values come from the database rather than a user request, so this is
// defence-in-depth rather than a live injection path — but this is an unattended
// UPDATE against production and the two arms must not differ in shape for no
// reason. "The safe one is the one we happened to write out" is not a control.
// ONE statement serves BOTH arms — the literal table and the computed fallback —
// so they cannot differ in shape, in guard, or in parameterisation. Only the two
// bound values change.
const REMAP_SQL = `
  UPDATE "Groups"
     SET color_preset = :to,
         background_color = NULL
   WHERE color_preset IS NULL
     AND lower(btrim(background_color)) = :from`;

const RESTORE_SQL = `
  UPDATE "Groups"
     SET background_color = :hex,
         color_preset = NULL
   WHERE color_preset = :id
     AND background_color IS NULL`;

/** Distinct stored values that are coloured, unmapped, and NOT one of the fifteen. */
const UNKNOWN_SCAN_SQL = `
  SELECT lower(btrim(background_color)) AS hex, COUNT(*)::int AS n
    FROM "Groups"
   WHERE color_preset IS NULL
     AND ${COLOURED_ROW_SQL}
     AND lower(btrim(background_color)) NOT IN (:known)
   GROUP BY 1
   ORDER BY 1`;

const affected = (metadata) =>
  metadata && typeof metadata.rowCount === 'number' ? metadata.rowCount : 0;

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    let knownRows = 0;
    let computedRows = 0;
    let skippedRows = 0;

    // --- arm 1: the fifteen literals -------------------------------------
    for (const row of LEGACY_COLOUR_REMAP) {
      const [, metadata] = await sequelize.query(REMAP_SQL, {
        replacements: { to: row.to, from: row.from },
      });
      const n = affected(metadata);
      knownRows += n;
      console.log(`${LOG} ${row.from} (${row.label}) -> ${row.to}: ${n} row(s)`);
    }

    // --- arm 2: the computed fallback ------------------------------------
    // Reached ONLY by a stored value that is coloured and is not one of the
    // fifteen. RESEARCH assumptions A1/A2 say this should find nothing; they are
    // UNVERIFIED, which is exactly why the arm exists.
    const unknowns = await sequelize.query(UNKNOWN_SCAN_SQL, {
      replacements: { known: LEGACY_COLOUR_REMAP.map((r) => r.from) },
      type: sequelize.QueryTypes.SELECT,
    });

    for (const { hex, n } of unknowns) {
      const decision = nearestPresetFor(hex);

      // A null distance is NOT a zero distance. deltaE2000/lStar return null for
      // an unparseable stored hex, and a null coerced to 0 reads as a PERFECT
      // MATCH — it would remap the row to whatever it compared against first
      // (threat T-88.3.1-10). Untouched-and-logged is the correct failure mode:
      // the row keeps rendering through the legacy tint fallback, which is
      // exactly what it does today.
      if (!decision) {
        skippedRows += n;
        console.log(
          `${LOG} !! UNPARSEABLE stored colour ${JSON.stringify(hex)} — ${n} row(s) LEFT UNTOUCHED. ` +
            'No distance could be computed, and a missing distance is not a match. ' +
            'These rows keep their background_color and keep rendering through the legacy tint fallback. ' +
            'Surface them to the owner.'
        );
        continue;
      }

      const [, metadata] = await sequelize.query(REMAP_SQL, {
        replacements: { to: decision.to, from: hex },
      });
      const changed = affected(metadata);
      computedRows += changed;
      console.log(
        `${LOG} COMPUTED ${hex} (L* ${decision.lStar.toFixed(2)}, ${decision.band} band) -> ` +
          `${decision.to} dE ${decision.deltaE.toFixed(2)}, runner-up ${decision.runnerUp} ` +
          `dE ${decision.runnerUpDeltaE.toFixed(2)}, margin ${decision.margin.toFixed(2)}: ${changed} row(s)`
      );
    }

    console.log(
      `${LOG} remap summary — changed ${knownRows + computedRows} row(s) ` +
        `(${knownRows} by literal, ${computedRows} computed), ` +
        `skipped ${skippedRows} unparseable row(s), ` +
        'left every unset row (#ffffff/#fff/NULL/empty, any case) untouched.'
    );
  },

  async down(queryInterface) {
    const sequelize = queryInterface.sequelize;
    let restored = 0;

    // Read the two LOSS paragraphs at the top of this file before relying on
    // anything below. This restores a CANONICAL hex per preset; it does not
    // restore the data.
    for (const [id, hex] of Object.entries(CANONICAL_DOWN_HEX)) {
      const [, metadata] = await sequelize.query(RESTORE_SQL, {
        replacements: { id, hex },
      });
      const n = affected(metadata);
      restored += n;
      console.log(`${LOG} down: ${id} -> ${hex}: ${n} row(s)`);
    }

    console.log(
      `${LOG} down summary — restored ${restored} row(s) to a CANONICAL hex. ` +
        'This is a schema escape hatch, not a data restore: six old values collapsed into `blue` ' +
        'and all six come back as Navy #172554, and any preset a USER chose after the remap has ' +
        'just been rewritten as a legacy hex that group never had. Exact per-row restore comes ' +
        'from the census in 88.3.1-05-SUMMARY.md, by hand.'
    );
  },
};
