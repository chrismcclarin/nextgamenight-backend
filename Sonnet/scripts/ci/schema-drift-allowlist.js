'use strict';
//
// scripts/ci/schema-drift-allowlist.js
//
// Phase 88.4 (SPEC R6; decision D-07): the ONE place accepted schema drift is recorded, and
// the ONLY way a `migrate-cli-replay` finding is suppressed. `scripts/ci/schema-drift-diff.js`
// `require()`s this file, validates it, and subtracts matching findings.
//
// LINEAGE (D-07): a JS module OVER a JSON file (rationale cannot live as comments in JSON)
// and OVER inlining the list in the differ (policy edits would then touch gate logic, so a
// sign-off edit and a logic edit would be indistinguishable in review).
//
// ---------------------------------------------------------------------------------------
// AN EMPTY ARRAY IS THE CORRECT STATE — IT IS NOT AN OVERSIGHT, AND IT IS NO LONGER
// PROVISIONAL. Updated by Plan 10 (D-88.4-06): this block used to say "Plan 08 adds the
// signed-off entries. Until then: `[]`", which described a pending step. That step has
// HAPPENED and its outcome was zero entries. Corrected in place rather than deleted, so the
// overtaken reason stops propagating instead of being quietly forgotten.
//
// D-08 locked the order and the order RAN: report-only CI -> day-one census read off a real
// CI run -> owner signs off every finding's disposition -> then reconciling migrations and
// allowlist entries. The census (88.4-DRIFT-CENSUS.md in the parent planning repo) recorded
// 43 day-one findings and the owner signed its § 7 on 2026-07-30 dispositioning ALL 43
// `reconcile` and NONE `allowlist`. Plan 08 executed all 43, and CI then measured 164 vs 164
// canonical identities with zero findings — which is what authorized Plan 09 to arm the gate.
//
// So `[]` is now correct BECAUSE the sign-off resolved every instance the other way, not
// while waiting for a sign-off. An entry added from here on is NEW accepted drift and needs
// its own owner-signed `DECISION Phase 88.4` marker block (the `quality` job's
// scripts/ci/verify-allowlist-markers.js enforces that per entry, so an unmarked one cannot
// merge). Reconciling the two sides remains strictly preferred over accepting a difference.
// ---------------------------------------------------------------------------------------
//
// ENTRY CONTRACT — these SEVEN base fields on EVERY entry, plus the kind's own PIN fields
// (see PIN_FIELDS below), plus `accepted` on a `differs` entry. No more and no less:
//
//   side          'migration-only' | 'sync-only' | 'differs'
//   kind          'fk' | 'pk' | 'unique' | 'index' | 'table'
//   table         string — the table name as `pg_class.relname` renders it (UNQUOTED, so
//                 `UserGroups`, never `"UserGroups"`; see the D-03 marker in the differ)
//   keySpec       string — the NORMALIZED key, exactly as the differ prints it. MUST be ''
//                 for kind 'table'.
//   predicate     string — the index predicate as `pg_get_expr` renders it, or '' when none.
//                 MUST be '' for kinds 'fk', 'pk' and 'table' (those records never carry a
//                 predicate, so a non-empty one could only ever produce a DEAD entry that
//                 suppresses nothing while looking like it does).
//   signedOffBy   string, non-empty — who accepted this drift
//   signedOffOn   string, strict `YYYY-MM-DD` — when. A placeholder like '2026-__-__' is
//                 REJECTED: an entry with no real sign-off date is not signed off.
//
// ...plus ONE conditional EIGHTH field:
//
//   accepted      REQUIRED if and only if `side === 'differs'`. Forbidden on
//                 'migration-only' / 'sync-only' (there is no divergence to pin, so the
//                 field would be decorative and misleading). Shape:
//                     { attribute: 'onDelete', migration: 'CASCADE', sync: 'SET NULL' }
//                 `migration` and `sync` must DIFFER, and both are written EXACTLY as the
//                 differ prints them — decoded English for `onDelete` / `onUpdate` /
//                 `matchType` (CASCADE, SET NULL, NO ACTION, RESTRICT, SET DEFAULT, FULL,
//                 PARTIAL, SIMPLE), verbatim Postgres text otherwise, and `(none)` for an
//                 absent value. Copy them off the CI log line; do not re-derive them.
//
// WHY `accepted` EXISTS (T-88.4-13). A `differs` entry keyed on
// (side, kind, table, keySpec, predicate) alone would suppress ANY future divergence on that
// object — not the one the owner reviewed. Sign off `ON DELETE CASCADE (migration) vs SET
// NULL (sync)` and the same entry would silently also accept a later `CASCADE vs RESTRICT`,
// or a `btree vs gin` method flip. `accepted` pins the exact reviewed divergence; the differ
// suppresses ONLY that one, and a DIFFERENT divergence on the same object still fails the
// gate. `attribute` is part of the pin for the same reason one level down: two attributes on
// one object can carry the same value pair (a migration declaring `ON DELETE CASCADE ON
// UPDATE CASCADE` against a model declaring SET NULL for both renders `CASCADE vs SET NULL`
// TWICE), and a values-only pin would let the un-reviewed one through.
//
// ENTRIES PIN TO NORMALIZED IDENTITY, NEVER TO NAMES (D-04). Constraint and index names
// legitimately differ between a migration-built and a sync()-built database — that divergence
// is the very noise the canonicalizer exists to discard, and it is itself a drift axis. An
// entry that named `friendships_pair_unique_uuid` would stop suppressing the moment sync()
// auto-named the same object differently, or would suppress a genuinely different object that
// happened to inherit the name.
//
// "NORMALIZED IDENTITY" MEANS THE **WHOLE** IDENTITY, NOT (side, kind, table, keySpec,
// predicate) — see PIN_FIELDS. That was a real gap, not a hypothetical one: until 2026-07-30
// this header asserted the full-identity contract while `entryMatchesObject` in the differ
// compared only those five fields, so an owner-signed "sync-only FK on user_id -> Users(id)
// SET NULL" entry would ALSO have silently suppressed a later, never-reviewed "sync-only FK on
// user_id -> SomeOtherTable(id) CASCADE" on the same table and column. That is the same
// un-reviewed-drift corridor `accepted` (below) closes for `differs` entries, and it was open
// for presence entries. Closed by requiring the kind's PIN fields on every entry
// (88.4-CODE-REVIEW.md #9). Every pinned value is written EXACTLY as the differ PRINTS it —
// decoded English for onDelete / onUpdate / matchType, `(none)` for an absent value — so the
// `identity pins:` block on a CI finding line is copy-pasteable and nothing has to be
// re-derived. Same rule as `accepted`; do not re-derive from catalog letters.
//
// EVERY ENTRY REQUIRES A FULL MARKER COMMENT BLOCK immediately above it, in this form:
//
//     // DECISION Phase 88.4 <what was accepted> OVER <what was rejected> — <why>
//
// stating which side has the object, why the other side legitimately does not, and what would
// have to change for the entry to be removed. `signedOffBy` / `signedOffOn` record WHO and
// WHEN; the marker records WHY (T-88.4-14). Removing an entry MUST turn `migrate-cli-replay`
// red on that instance — that is SPEC R6 and it is unit-tested in both directions
// (`tests/unit/schema-drift-diff.test.js`).
//
// FORMATTING IS PART OF THE CONTRACT, NOT A STYLE PREFERENCE. Each entry is ONE object
// literal in MULTI-LINE form (one field per line), with SINGLE-QUOTED string values, preceded
// by its own marker block. Plan 05's `quality`-job gate counts marker comment lines in this
// file and pairs them against the entry count, so a single-line or double-quoted entry breaks
// the pairing and can let an UNJUSTIFIED entry through. Do not reformat this file for
// tidiness. (Note for that gate: the token appears exactly ONCE in this header — in the
// template two paragraphs up, deliberately written as a NESTED comment so that an anchored
// count such as `grep -cE '^[[:space:]]*// DECISION Phase 88\.4'` scores it ZERO and counts
// only real entry markers. Count with that anchor, not with a bare substring grep.)
//
// `kind: 'table'` EXISTS SO A TABLE-MISSING FINDING HAS AN ALLOWLIST PATH AT ALL. Without it,
// a whole-table difference the owner consciously accepts would be unsuppressable and the gate
// could only be armed by pretending the difference is not there. Such an entry is identified
// by `side` + `table` alone and MUST carry `keySpec: ''`. It is expected to be RARE — a whole
// table existing on one side only is a far larger claim than one constraint differing — and
// therefore demands an especially thorough marker block: which side has it, why the other side
// legitimately does not, and what would have to change for the entry to be removed. `side:
// 'differs'` is rejected for `kind: 'table'`: a table is present or absent, it does not differ.
//
// DELIBERATE DIVERGENCE FROM `utils/errors.js:71`. That module maps an unknown error code to
// `internal` — it degrades gracefully, because a typo'd code there costs a slightly wrong wire
// status. `validateAllowlist` does the OPPOSITE and THROWS on an unknown field, an
// out-of-enum value, or a wrong-typed value, because here a typo would silently WIDEN accepted
// drift: an entry with a misspelled field name still matches on the fields that did parse, and
// the gate goes quietly green on drift nobody signed off. That is the exact false-green failure
// mode this whole phase exists to prevent (ASVS V5, T-88.4-13). Do not "correct" this module
// to match `errors.js`.

const SIDES = ['migration-only', 'sync-only', 'differs'];
const KINDS = ['fk', 'pk', 'unique', 'index', 'table'];

// The fields EVERY entry carries. `accepted` is conditional and handled separately; the
// per-kind PIN fields are below.
const BASE_FIELDS = ['side', 'kind', 'table', 'keySpec', 'predicate', 'signedOffBy', 'signedOffOn'];
const ACCEPTED_FIELDS = ['attribute', 'migration', 'sync'];

// The identity attributes an entry must pin BEYOND the base five (side, kind, table, keySpec,
// predicate) — i.e. every remaining field of the differ's IDENTITY_FIELDS row for that kind.
//
// DECISION Phase 88.4 (88.4-CODE-REVIEW.md #9): named per-kind fields OVER having each entry pin
// the raw `identityOf()` STRING and comparing it exactly. The identity string is the mechanically
// simpler pin, and it was rejected because it is unreviewable: it renders as
// `fk|Events|game_id|Games|id|c|c|s` — RAW catalog letters, positional, with no field names — so
// the one artifact whose entire purpose is to make accepted drift legible to a human reviewer
// would become the least legible thing in the repo, and `accepted`'s documented decoded-English
// convention would contradict it two fields away. Named fields cost more validation code and are
// worth it. Switching to an identity-string pin is a decision, not a cleanup.
//
// KEPT IN THIS MODULE, NOT IN THE DIFFER, because this is the ENTRY CONTRACT and this module owns
// that. The risk that follows — a future phase promoting a field in the differ's IDENTITY_FIELDS
// (as 88.4 itself just did with includeSpec / nullsNotDistinct) and forgetting to add it here,
// silently reopening the subset-matching corridor — is closed STRUCTURALLY rather than by this
// comment: `tests/unit/schema-drift-diff.test.js` asserts PIN_FIELDS[kind] is exactly
// IDENTITY_FIELDS[kind] minus the DIFFERS prefix minus `predicate`, for every kind. Adding a
// field there without adding it here fails that test.
const PIN_FIELDS = {
  fk: ['parentTable', 'parentColumns', 'onDelete', 'onUpdate', 'matchType'],
  // A pk's identity IS the DIFFERS prefix (kind, table, keySpec), so it has nothing left to pin.
  pk: [],
  unique: ['includeSpec', 'nullsNotDistinct'],
  index: ['method', 'includeSpec', 'nullsNotDistinct'],
  // A whole-table entry is identified by (side, table) alone — see the `kind: 'table'` note above.
  table: [],
};

// Kinds whose canonical record NEVER carries a predicate (see IDENTITY_FIELDS in the differ).
const PREDICATE_FREE_KINDS = ['fk', 'pk', 'table'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function deepFreezeEntries(entries) {
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      if (entry.accepted && typeof entry.accepted === 'object') Object.freeze(entry.accepted);
      Object.freeze(entry);
    }
  }
  return Object.freeze(entries);
}

// ---------------------------------------------------------------------------------------
// THE ALLOWLIST. Empty by design BECAUSE the owner's day-one census sign-off (2026-07-30, § 7)
// dispositioned all 43 findings `reconcile` and accepted none — not while awaiting that
// sign-off, which is what this line used to say (D-88.4-06). See the header block above.
// Add entries here in the multi-line, single-quoted, marker-preceded form documented above.
// ---------------------------------------------------------------------------------------
const ENTRIES = deepFreezeEntries([]);

/**
 * Validate the accepted-drift policy. THROWS on anything it does not fully understand — a
 * malformed policy file is a crash, not a finding (T-88.4-13). Called by the differ at module
 * load, where the throw is unreachable by report-only suppression.
 *
 * @param {object[]} entries
 * @returns {object[]} the same array, when every entry is conforming
 */
function validateAllowlist(entries) {
  const fail = (msg) => {
    throw new Error(`[88.4] schema-drift-allowlist: ${msg}`);
  };

  if (!Array.isArray(entries)) {
    fail(`expected an array of entries, got ${entries === null ? 'null' : typeof entries}.`);
  }

  entries.forEach((entry, i) => {
    const at = `entry[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${at} is not a plain object.`);
    }

    // `side` and `kind` are validated FIRST, because the set of fields the entry is allowed to
    // carry is KIND-DEPENDENT (PIN_FIELDS) — an `onDelete` on an index entry has to be rejected
    // as unknown, not accepted as decoration.
    if (!SIDES.includes(entry.side)) {
      fail(`${at}.side is ${JSON.stringify(entry.side)}; must be one of ${SIDES.map((s) => `'${s}'`).join(', ')}.`);
    }
    if (!KINDS.includes(entry.kind)) {
      fail(`${at}.kind is ${JSON.stringify(entry.kind)}; must be one of ${KINDS.map((k) => `'${k}'`).join(', ')}.`);
    }

    const pins = PIN_FIELDS[entry.kind];
    const required = [...BASE_FIELDS, ...pins];
    const keys = Object.keys(entry);
    const allowed = new Set([...required, 'accepted']);
    for (const k of keys) {
      if (!allowed.has(k)) {
        fail(
          `${at} (kind '${entry.kind}') carries unknown field "${k}". Allowed: ` +
            `${required.join(', ')} (+ "accepted" on a differs entry). An unknown field is ` +
            `REJECTED rather than ignored: a typo'd field name would still match on the fields ` +
            `that did parse and would silently widen accepted drift.`
        );
      }
    }
    for (const f of required) {
      if (!Object.prototype.hasOwnProperty.call(entry, f)) {
        fail(
          `${at} (kind '${entry.kind}') is missing required field "${f}".` +
            (pins.includes(f)
              ? ` Every entry pins the FULL normalized identity, not just (side, kind, table, ` +
                `keySpec, predicate) — a partial pin suppresses objects nobody reviewed. Copy the ` +
                `value from the finding's "identity pins:" line in the CI log; use '(none)' for ` +
                `an absent value.`
              : '')
        );
      }
      if (typeof entry[f] !== 'string') {
        fail(`${at}.${f} must be a string, got ${entry[f] === null ? 'null' : typeof entry[f]}.`);
      }
      if (pins.includes(f) && entry[f].length === 0) {
        fail(
          `${at}.${f} is an empty string. Pin fields are written exactly as the differ PRINTS ` +
            `them, and the differ prints '(none)' for an absent value — an empty string matches ` +
            `nothing and would leave a DEAD entry that reads as though it suppresses something.`
        );
      }
    }

    if (entry.table.length === 0) {
      fail(`${at}.table is empty; name the table as pg_class.relname renders it (unquoted).`);
    }
    if (entry.signedOffBy.length === 0) {
      fail(`${at}.signedOffBy is empty; an entry with no recorded signer is not signed off.`);
    }
    if (!ISO_DATE.test(entry.signedOffOn) || Number.isNaN(Date.parse(entry.signedOffOn))) {
      fail(
        `${at}.signedOffOn is "${entry.signedOffOn}"; must be a real YYYY-MM-DD date. A ` +
          `placeholder (e.g. '2026-__-__') is rejected — an entry with no sign-off date is not ` +
          `signed off.`
      );
    }

    if (entry.kind === 'table') {
      if (entry.keySpec !== '') {
        fail(
          `${at} is kind 'table' but carries keySpec "${entry.keySpec}". A table entry is ` +
            `identified by (side, table) alone and MUST use keySpec: '' — there is no per-object key.`
        );
      }
      if (entry.side === 'differs') {
        fail(
          `${at} is kind 'table' with side 'differs'. A table is present or absent, it does not ` +
            `differ; use 'migration-only' or 'sync-only'.`
        );
      }
    } else if (entry.keySpec.length === 0) {
      fail(
        `${at} is kind '${entry.kind}' with an empty keySpec. Only kind 'table' may omit the key; ` +
          `pin the NORMALIZED key exactly as the differ prints it (never a constraint or index name).`
      );
    }

    if (PREDICATE_FREE_KINDS.includes(entry.kind) && entry.predicate !== '') {
      fail(
        `${at} is kind '${entry.kind}' but carries predicate "${entry.predicate}". A ` +
          `${entry.kind} record never has a predicate, so this entry could only ever be DEAD — ` +
          `it would suppress nothing while reading as though it does. Use predicate: ''.`
      );
    }

    const hasAccepted = Object.prototype.hasOwnProperty.call(entry, 'accepted');
    if (entry.side === 'differs') {
      if (!hasAccepted) {
        fail(
          `${at} has side 'differs' but no "accepted" field. A differs entry MUST pin the exact ` +
            `reviewed divergence, e.g. accepted: { attribute: 'onDelete', migration: 'CASCADE', ` +
            `sync: 'SET NULL' } — an unpinned differs entry would suppress ANY future divergence ` +
            `on this object, not the one that was signed off.`
        );
      }
      const acc = entry.accepted;
      if (acc === null || typeof acc !== 'object' || Array.isArray(acc)) {
        fail(`${at}.accepted must be a plain object { attribute, migration, sync }.`);
      }
      for (const k of Object.keys(acc)) {
        if (!ACCEPTED_FIELDS.includes(k)) {
          fail(
            `${at}.accepted carries unknown field "${k}". Allowed: ${ACCEPTED_FIELDS.join(', ')}.`
          );
        }
      }
      for (const f of ACCEPTED_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(acc, f)) {
          fail(`${at}.accepted is missing required field "${f}".`);
        }
        if (typeof acc[f] !== 'string') {
          fail(`${at}.accepted.${f} must be a string, got ${acc[f] === null ? 'null' : typeof acc[f]}.`);
        }
      }
      if (acc.attribute.length === 0) {
        fail(
          `${at}.accepted.attribute is empty. Name the diverging attribute exactly as the differ ` +
            `prints it (e.g. 'onDelete', 'onUpdate', 'matchType', 'predicate', 'method', ` +
            `'parentTable', 'parentColumns').`
        );
      }
      if (acc.migration === acc.sync) {
        fail(
          `${at}.accepted pins migration and sync to the same value ("${acc.migration}"). That is ` +
            `not a divergence; the entry would match nothing.`
        );
      }
      // CONSISTENCY between the object pin and the accepted divergence. When the diverging
      // attribute is itself a PIN field, the entry now states its value TWICE — once as the pin
      // and once as `accepted.migration`. The differ keys a DIFFERS finding on the MIGRATION-side
      // object (see the `predicate: mRec.predicate` marker in differsFinding), so the pin must
      // carry the MIGRATION value. Disagreeing values would produce an entry that validates,
      // reads as reviewed, and matches nothing — the DEAD-entry failure mode, which the differ
      // only reports as an "UNUSED entry" line a reader has to notice.
      if (pins.includes(acc.attribute) && entry[acc.attribute] !== acc.migration) {
        fail(
          `${at} pins ${acc.attribute}: '${entry[acc.attribute]}' but accepted.migration is ` +
            `'${acc.migration}'. A DIFFERS finding is keyed on the MIGRATION-side object, so when ` +
            `the diverging attribute is also a pin field the two MUST agree. Set ` +
            `${acc.attribute} to the migration-side value ('${acc.migration}'); the sync-side ` +
            `value lives only in accepted.sync.`
        );
      }
    } else if (hasAccepted) {
      fail(
        `${at} has side '${entry.side}' but carries an "accepted" field. A presence/absence entry ` +
          `has no divergence to pin, so the field would be decorative and misleading — the object ` +
          `is simply present on one side only. Remove it.`
      );
    }
  });

  return entries;
}

module.exports = { ENTRIES, validateAllowlist, PIN_FIELDS };
