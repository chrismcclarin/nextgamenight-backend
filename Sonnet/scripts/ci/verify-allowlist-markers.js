#!/usr/bin/env node
'use strict';
//
// scripts/ci/verify-allowlist-markers.js
//
// Phase 88.4 (SPEC R6; 88.4-CODE-REVIEW.md #3 + #10): assert that EVERY entry in
// `scripts/ci/schema-drift-allowlist.js` carries its own `DECISION Phase 88.4` marker block on
// the lines IMMEDIATELY above it — and that no marker block is orphaned.
//
// WHY THIS IS A SCRIPT AND NOT THE SHELL GATE IT REPLACES. The `quality` job previously compared
// two TOTALS: `ENTRIES.length` against an anchored `grep -c` of marker lines sliced from
// `const ENTRIES` onward, failing only when markers < entries. SPEC R6's acceptance is a
// PER-ENTRY property, and two totals cannot express it:
//   (a) one entry whose marker block repeats the token on two lines satisfies the count while a
//       SECOND entry carries no marker at all — accepted schema drift with no recorded rationale,
//       passing the gate that exists to catch precisely that;
//   (b) markers > entries (a stale block left behind when an entry was deleted) passed silently,
//       leaving rationale that describes drift which is no longer accepted — actively misleading
//       to the next reader, who has no way to tell it is orphaned;
//   (c) markers sitting against the WRONG entries passed, since position was never checked.
// The old step's own comment conceded that pairing was "enforced upstream by the allowlist
// module's own header" — i.e. by a comment, i.e. not enforced.
//
// DECISION Phase 88.4 (#3/#10): a bracket+brace-depth scanner in a committed, UNIT-TESTED script,
// OVER a larger `node -e` inline in ci.yml and OVER more awk. A gate whose whole purpose is to catch
// sloppy edits to a security-relevant policy file must not itself be an unverifiable one-liner;
// `tests/unit/verify-allowlist-markers.test.js` drives this parser over conforming and
// deliberately-broken sources, which is impossible for an inline script. Moving this back inline
// is a decision, not a cleanup.
//
// THREE INDEPENDENT CHECKS, deliberately overlapping so no single parsing mistake can green the
// whole gate (each is reported separately, and all are reported before exiting):
//   1. ADJACENCY  — every entry object literal at the array's top level is immediately preceded by
//                   a contiguous `//` comment run containing an anchored marker line.
//   2. NO ORPHANS — every anchored marker line inside the array region belongs to such a run.
//   3. COUNTS     — exactly one anchored marker line per entry. A wrapped marker block carries the
//                   token on its FIRST line only (the form the module header prescribes), so
//                   markers != entries means a duplicated token or an orphan.
// Check 3 is arithmetically implied by 1 + 2 today; it is kept because it fails on a DIFFERENT
// signal (a total) and would still catch a bug in the parser that powers the other two.
//
// USAGE:  node scripts/ci/verify-allowlist-markers.js [path]
// Exits 0 when conforming (including for an EMPTY allowlist, which is a correct state), 1 otherwise.

const fs = require('fs');
const path = require('path');

const DEFAULT_TARGET = path.resolve(__dirname, 'schema-drift-allowlist.js');

// The array region opener. Matched loosely on `const ENTRIES` so a reformat of the
// `deepFreezeEntries([` call cannot silently take the parser out of the region and pass
// vacuously — `analyze` throws instead when it cannot find the array.
const REGION_START = /^\s*const\s+ENTRIES\s*=/;

// Anchored exactly as the retired shell gate anchored it, and for the same reason: the allowlist
// module's HEADER quotes the required marker form once as a nested comment, so an anchored match
// scores it zero. A bare substring search returns a hit with ZERO real markers.
const MARKER = /^\s*\/\/\s*DECISION Phase 88\.4/;

const IS_COMMENT = /^\s*\/\//;
const IS_BLANK = /^\s*$/;

/**
 * Character-level scan of the `const ENTRIES = deepFreezeEntries([ ... ])` region, tracking the
 * ARRAY bracket depth and the object brace depth so an entry object literal can be recognized as
 * "a `{` directly inside the array". Quote- and comment-aware, so a brace inside a predicate
 * string or inside a comment is never counted.
 *
 * Deliberately NOT a JS parser: a parser would discard COMMENT positions, and comment positions
 * are the entire subject of this gate.
 *
 * TRACKING THE BRACKET DEPTH IS LOAD-BEARING, not tidiness. Brace depth alone cannot tell where
 * the array ENDS — and the day-one file writes the whole thing as `deepFreezeEntries([])` on ONE
 * line, with no braces at all, so a brace-only scanner runs straight past it into
 * `validateAllowlist`'s body and reports every `{` in that function as an unmarked allowlist
 * entry. (Observed: 7 phantom errors against the correct committed file.)
 *
 * @param {string} source
 * @param {number} startOffset character offset of the `const ENTRIES` line
 * @returns {{entryLines: number[], endLine: number}} 1-based line numbers
 */
function scanEntryRegion(source, startOffset) {
  const entryLines = [];
  let line = 1;
  for (let k = 0; k < startOffset; k++) if (source[k] === '\n') line++;

  let bracket = 0; // depth inside the ENTRIES array literal
  let brace = 0; // depth inside an entry object literal
  let opened = false; // the array's `[` has been seen
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = startOffset; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') {
      line++;
      inLineComment = false;
      continue;
    }
    if (inLineComment) continue;
    if (inBlockComment) {
      if (ch === '*' && source[i + 1] === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') {
      bracket++;
      opened = true;
      continue;
    }
    if (ch === ']') {
      bracket--;
      if (opened && bracket === 0) return { entryLines, endLine: line };
      continue;
    }
    if (ch === '{') {
      // An entry is an object literal DIRECTLY inside the array. `accepted: { ... }` sits at
      // brace depth 1 and is correctly not counted; a `{` inside a nested array would sit at
      // bracket depth 2 and likewise is not an entry.
      if (bracket === 1 && brace === 0) entryLines.push(line);
      brace++;
      continue;
    }
    if (ch === '}') brace--;
  }

  if (!opened) {
    throw new Error(
      'found the `const ENTRIES` declaration but no `[` opening its array literal. Refusing to ' +
        'guess at the region boundaries — a wrong boundary greens unmarked entries silently.'
    );
  }
  throw new Error(
    'the `const ENTRIES` array literal is never closed. Refusing to report on a region whose ' +
      'end cannot be located.'
  );
}

/**
 * Analyze an allowlist module's SOURCE TEXT. Pure — no filesystem, no `require` of the target —
 * so the unit tests can drive it with hand-written sources including broken ones.
 *
 * @param {string} source
 * @returns {{entries: number[], markers: number[], errors: string[]}} 1-based line numbers
 */
function analyze(source) {
  const src = String(source);
  const lines = src.split('\n');
  const startIdx = lines.findIndex((l) => REGION_START.test(l));
  if (startIdx === -1) {
    throw new Error(
      'could not find the `const ENTRIES = ...` declaration. Refusing to pass vacuously: a ' +
        'renamed or reformatted declaration would otherwise take this gate out of the array ' +
        'region and green every unmarked entry in the file.'
    );
  }

  const startOffset = lines.slice(0, startIdx).reduce((n, l) => n + l.length + 1, 0);
  const { entryLines, endLine } = scanEntryRegion(src, startOffset);

  const errors = [];
  const entries = entryLines;
  const markers = []; // 1-based line numbers of anchored marker lines INSIDE the region
  const claimed = new Set();

  // Markers are collected over the region only. A `DECISION Phase 88.4` comment elsewhere in the
  // file (the module header's template, or a marker on some unrelated const) is out of scope.
  for (let i = startIdx; i < endLine && i < lines.length; i++) {
    if (MARKER.test(lines[i])) markers.push(i + 1);
  }

  // CHECK 1 — adjacency. For each entry, walk UP the contiguous `//` comment run directly above
  // it. A BLANK line breaks the run on purpose: a marker separated from its entry by a blank line
  // reads as belonging to whatever came before it, which is the ambiguity being closed.
  for (const lineNo of entries) {
    const runMarkers = [];
    let j = lineNo - 2; // 0-based index of the line directly above
    while (j >= startIdx && IS_COMMENT.test(lines[j])) {
      if (MARKER.test(lines[j])) runMarkers.push(j + 1);
      j--;
    }
    if (runMarkers.length === 0) {
      errors.push(
        `line ${lineNo}: allowlist entry has NO 'DECISION Phase 88.4' marker on the lines ` +
          `immediately above it. Every entry needs its own full ` +
          `'// DECISION Phase 88.4 <accepted> OVER <rejected> — <why>' block, with no blank ` +
          `line between the block and the entry.`
      );
    } else {
      for (const n of runMarkers) claimed.add(n);
    }
  }

  // CHECK 2 — no orphans. Every anchored marker inside the region must belong to a run that was
  // credited to an entry above.
  for (const n of markers) {
    if (!claimed.has(n)) {
      errors.push(
        `line ${n}: ORPHANED 'DECISION Phase 88.4' marker — it is not immediately above any ` +
          `allowlist entry. Either an entry was deleted and its rationale was left behind ` +
          `(delete the block: it now describes drift that is no longer accepted, and reads as ` +
          `though it still is), or a blank line separates it from the entry it belongs to.`
      );
    }
  }

  // CHECK 3 — counts. One anchored line per entry; a wrapped block carries the token on its FIRST
  // line only. Reported even when 1 and 2 passed, because it fails on a different signal.
  if (markers.length !== entries.length) {
    errors.push(
      `count mismatch: ${entries.length} entr(y/ies) but ${markers.length} anchored marker ` +
        `line(s). Expect exactly one anchored 'DECISION Phase 88.4' line per entry — wrap the ` +
        `reason across as many lines as it needs, but repeat the token on NONE of the ` +
        `continuation lines (continuation lines are plain '//'). More markers than entries also ` +
        `means an orphan; fewer means an unmarked entry.`
    );
  }

  return { entries, markers, errors };
}

module.exports = { analyze, scanEntryRegion, MARKER, REGION_START };

if (require.main === module) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TARGET;
  const rel = path.relative(process.cwd(), target) || target;

  if (!fs.existsSync(target)) {
    console.error(
      `::error::[88.4-markers] ${rel} is missing. scripts/ci/schema-drift-diff.js require()s it, ` +
        `so its absence fails the migrate-cli-replay job in a far less obvious place. Restore it ` +
        `— an EMPTY ENTRIES array is the correct day-one state (D-08), so there is no reason to ` +
        `delete the file.`
    );
    process.exitCode = 1;
  } else {
    let result;
    try {
      result = analyze(fs.readFileSync(target, 'utf8'));
    } catch (err) {
      console.error(`::error::[88.4-markers] ${rel}: ${err && err.message ? err.message : err}`);
      process.exitCode = 1;
      result = null;
    }

    if (result) {
      console.log(
        `[88.4-markers] ${rel}: ${result.entries.length} entr(y/ies), ` +
          `${result.markers.length} anchored DECISION marker(s).`
      );
      if (result.errors.length) {
        for (const e of result.errors) {
          console.error(
            `::error::[88.4-markers] ${rel} ${e} An allowlist entry without its own rationale is ` +
              `accepted schema drift that nobody's reasoning is attached to: it suppresses a ` +
              `migrate-cli-replay finding forever while reading in review as though somebody ` +
              `weighed it, so the next reader stops looking (D-07 / SPEC R6). If you are ` +
              `deliberately removing this requirement, change the gate and say why in the same commit.`
          );
        }
        process.exitCode = 1;
      } else if (result.entries.length === 0) {
        console.log(
          '[88.4-markers] PASS — 0 entries need 0 markers. An EMPTY allowlist is the CORRECT ' +
            'state until the day-one drift census is signed off (D-08); this is not a broken or ' +
            'vacuous gate. It also verified that the `const ENTRIES` array was actually FOUND, ' +
            'so an empty pass cannot come from a parser that lost its way.'
        );
      } else {
        console.log(
          `[88.4-markers] PASS — every entry is immediately preceded by its own marker block, ` +
            `no marker is orphaned, and the counts agree.`
        );
      }
    }
  }
}
