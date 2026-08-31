// scripts/census-group-colours.js
//
// Phase 88.3.1 plan 05 Task 1 (SPEC Req 6, CONTEXT D-03) — the DRY RUN for
// migrations/20260828000002-remap-group-colours-to-presets.js.
//
// Purpose: CONTEXT D-03 makes the owner's glance at this printed table the
// confirmation dialog for the phase's one destructive act. Run it against
// PRODUCTION and paste the output into 88.3.1-05-SUMMARY.md BEFORE BE PR-2
// merges. The per-row census is also the only exact-restore source for the
// migration's deliberately-lossy down().
//
// READ-ONLY: no write calls of any kind. Output to stdout only.
//
// WHY THIS IS A SIBLING SCRIPT AND NOT A `--dry-run` FLAG ON THE MIGRATION
// (88.3.1-RESEARCH.md Pitfall 2 — this is the load-bearing part): railway.json's
// deploy.preDeployCommand runs `npm run migrate:apply` (= `npx sequelize-cli
// db:migrate`) with NO ARGUMENTS on every deploy. A flag would therefore never be
// passed, and the real UPDATE would run automatically the moment the PR merged —
// the owner would never see this table at all.
//
// THIS OUTPUT IS PASTED INTO A COMMITTED DOCUMENT (plan 05 AMENDMENT L).
// `.planning/` is committed in full and never pruned (CLAUDE.md), so nothing
// user-authored may appear here: NO group names, NO connection strings, NO
// credentials, NO background_image_url values. The SELECTs below name only
// `id`, `background_color` and `color_preset` — a machine id, a hex, and a preset
// word — and reduce background_image_url to a BOOLEAN in SQL so the URL itself is
// never read into this process. The house precedent is 88-34-SUMMARY.md:264-284,
// the last production census this project committed: count-only SQL, not one
// user-authored string. Redaction-by-construction, not redaction-by-discipline.
//
// Usage:
//   local : npm run census:group-colours   (or: node scripts/census-group-colours.js)
//   prod  : railway run -- node scripts/census-group-colours.js
//
//   The Node path is used rather than psql because the local Homebrew psql is
//   14.21 — older than the servers — so a psql census is version-fragile; this
//   one is version-agnostic (same pattern as scripts/run-migration-prod.js).
//
// Exit codes (plan 05 AMENDMENT O — the STOP condition gets a MACHINE signal, not
// just prose a human has to read):
//   0  clean: every coloured row is one of the fifteen known values
//   1  the script itself crashed
//   2  at least one UNKNOWN stored value was found — something outside the
//      fifteen. STOP and surface it to the owner; the migration must not
//      quietly absorb it. The verdict block is printed FIRST either way, so the
//      exit code never costs the operator the diagnostic.

require('dotenv').config();

// DECISION Phase 88.3.1-11: reuse scripts/run-migration-prod.js's public-URL remap
// here, rather than having the operator hand-assemble a connection string, and
// rather than teaching config/database.js a new "prefer public" mode.
//
// WHY THIS EXISTS AT ALL. The Usage block above says
//   prod : railway run -- node scripts/census-group-colours.js
// and that alone does NOT work. `railway run` injects the service's variables but
// does NOT put your laptop on Railway's private network (Phase 74 operational
// note). config/database.js:16-19 then picks, by priority,
//   POSTGRES_PRIVATE_URL || POSTGRES_URL || DATABASE_URL || PGDATABASE_URL
// and Railway's DATABASE_URL names the INTERNAL host postgres.railway.internal,
// which does not resolve off-platform. Measured 2026-08-30, banner PrivateURL=false:
//   HostNotFoundError: getaddrinfo ENOTFOUND postgres.railway.internal
//
// The house already solved this. scripts/run-migration-prod.js:50-55 remaps
// DATABASE_PUBLIC_URL (Railway's *.proxy.rlwy.net TCP proxy) onto DATABASE_URL and
// blanks the three higher-priority names BEFORE config/database.js is required.
// This script's own header cites that script as "the same pattern" -- it just never
// copied the preamble. This is that copy, kept deliberately identical to it so the
// two cannot drift into two different ways of reaching production.
//
// REJECTED: (a) appending ?sslmode=require ourselves -- run-migration-prod.js passes
// the URL verbatim and is proven against this Postgres, so rewriting the string here
// would deviate from a working precedent on a guess; if the server ever does demand
// TLS, adding sslmode=require to the URL is the one-line fix. (b) making
// config/database.js prefer the public URL -- that would change how the DEPLOYED
// service connects, which is the opposite of what is wanted; internally the private
// URL is correct and SSL-free by design.
//
// TARGETING: this remap fires when DATABASE_PUBLIC_URL is present, i.e. under
// `railway run`.
//
// CORRECTED 2026-08-30 (code review #10). This comment used to claim the remap
// "cannot silently point a local census at production" because "a local run sees no
// such variable". That is a claim about the OPERATOR'S ENVIRONMENT, not a control
// this script enforces: `require('dotenv').config()` runs above and populates
// process.env from `.env`, so any operator whose `.env` carries DATABASE_PUBLIC_URL
// gets a production connection from a command that reads as local. The sibling
// scripts/run-migration-prod.js fails CLOSED instead -- it errors when the variable
// is absent, so it can only ever mean "prod". This one is conditional, so it can
// silently mean either.
//
// The impact is bounded -- this script issues only SELECTs, so the worst case is an
// unintended production READ, never a write. It is corrected rather than re-armed
// because this script IS the CONTEXT D-03 confirmation gate for a destructive
// unattended production UPDATE, and a gate whose targeting is described rather than
// enforced is weak in BOTH directions: a run the operator believes is production but
// is actually local would approve the migration against the wrong dataset.
//
// THE ONLY REAL CONTROL IS THE BANNER. config/database.js prints the host it actually
// reached on every run (protocol/host/port/database/user -- never the password).
// READ IT before trusting any census output, and before pasting that output into a
// SUMMARY as the D-03 approval record.
//
// UNVERIFIED, deliberately: whether a local `.env` here actually carries
// DATABASE_PUBLIC_URL was NOT checked. Env files are off-limits by project rule
// (CLAUDE.md), so the trigger condition is plausible and unconfirmed -- which is
// itself the reason to rely on the banner rather than on an assumption about `.env`.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  process.env.POSTGRES_URL = '';
  process.env.POSTGRES_PRIVATE_URL = '';
  process.env.PGDATABASE_URL = '';
  console.log('Using Railway PUBLIC proxy URL (DATABASE_PUBLIC_URL) - off-platform run.');
}

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../models');
const { GROUP_COLOUR_PRESETS, LEGACY_COLOUR_REMAP } = require('../utils/groupColourPresets');
const {
  COLOURED_ROW_SQL,
  normaliseHex,
  knownRemapFor,
  decideFor,
} = require('../utils/groupColourRemap');

const EXIT_CLEAN = 0;
const EXIT_CRASH = 1;
const EXIT_UNKNOWN_VALUE = 2;

const rule = (char = '=') => console.log(char.repeat(78));
const pad = (s, n) => String(s).padEnd(n);
const fixed = (n, d = 2) => (typeof n === 'number' ? n.toFixed(d) : String(n));

async function censusGroupColours() {
  console.log('');
  rule();
  console.log('  Phase 88.3.1 — group colour remap CENSUS (READ-ONLY dry run)');
  console.log('  CONTEXT D-03: paste this whole output into 88.3.1-05-SUMMARY.md and get');
  console.log('  the owner\'s glance BEFORE BE PR-2 merges.');
  rule();

  // The census must run BEFORE the remap on a database that may or may not have
  // had BE PR-1 (migration 20260828000001) deployed yet — the whole point is that
  // it runs first. Probe for the column instead of assuming it, so this script
  // works on either side of that deploy and on a dev DB that is behind.
  const groupsTable = await sequelize.getQueryInterface().describeTable('Groups');
  const hasPresetColumn = Boolean(groupsTable.color_preset);
  if (!hasPresetColumn) {
    console.log('\n  NOTE: Groups.color_preset does NOT exist on this database — migration');
    console.log('  20260828000001 (BE PR-1) has not been applied here. The census still shows');
    console.log('  exactly what the remap would do; the "already carrying a color_preset"');
    console.log('  idempotency line below is necessarily 0. On PRODUCTION this column WILL');
    console.log('  exist at the D-03 gate, because BE PR-1 merges first.');
  }

  // Only the three columns this census reads, plus a BOOLEAN derived in SQL so a
  // user-authored image URL is never pulled into this process (AMENDMENT L/AD).
  // DISCLOSURE added 2026-08-30 (code review #19): `Group` is `paranoid: true`
  // (`models/Group.js`), but this is hand-written SQL, so Sequelize's
  // `deletedAt IS NULL` clause never applies -- soft-deleted groups inside the Phase
  // 88.2 recovery window ARE counted here and ARE remapped by the migration's up().
  // Remapping them is the right behaviour (a restored group should render with the new
  // palette). What was wrong was showing them to the owner indistinguishably from live
  // rows, in the table that IS the approval dialog for a permanent UPDATE. `is_live`
  // now says which is which; no filter is applied and no behaviour changed.
  const rows = await sequelize.query(
    `SELECT id,
            background_color,
            ${hasPresetColumn ? 'color_preset' : 'NULL::text AS color_preset'},
            ("deletedAt" IS NULL) AS is_live,
            (background_image_url IS NOT NULL AND btrim(background_image_url) <> '') AS has_image
       FROM "Groups"
      WHERE ${COLOURED_ROW_SQL}
      ORDER BY background_color, id`,
    { type: QueryTypes.SELECT }
  );
  const softDeletedCount = rows.filter((r) => r.is_live === false).length;

  const totalGroups = (
    await sequelize.query('SELECT COUNT(*)::int AS n FROM "Groups"', { type: QueryTypes.SELECT })
  )[0].n;

  // ---------------------------------------------------------------------------
  // 1. PER-ROW CENSUS — the exact-restore source for the lossy down().
  //    AMENDMENT L: group id + old hex only. No names. AMENDMENT N: unbounded
  //    per-row print ACCEPTED as-is by the owner on 2026-08-29 (friends-and-family
  //    scale, tens of rows); the suggested count-line-plus-`--all` guard was
  //    considered and declined. Not an oversight.
  // ---------------------------------------------------------------------------
  console.log('\n1. PER-ROW CENSUS — every coloured group (no names, by design)\n');
  console.log(`   ${pad('group id', 38)} ${pad('old hex', 10)} ${pad('state', 8)} destination`);
  console.log(`   ${'-'.repeat(38)} ${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(24)}`);
  let alreadyPreset = 0;
  for (const row of rows) {
    const decision = decideFor(row.background_color);
    let destination;
    if (row.color_preset) {
      alreadyPreset += 1;
      destination = `(already ${row.color_preset} — untouched)`;
    } else if (!decision) {
      destination = 'UNPARSEABLE — LEFT UNTOUCHED';
    } else {
      destination = `${decision.to} (${decision.arm.toUpperCase()})`;
    }
    console.log(
      `   ${pad(row.id, 38)} ${pad(normaliseHex(row.background_color), 10)} ` +
        `${pad(row.is_live === false ? 'DELETED' : 'live', 8)} ${destination}`
    );
  }
  if (rows.length === 0) console.log('   (no coloured groups)');
  console.log(
    `\n   ${rows.length} coloured row(s) of ${totalGroups} group(s) total` +
      (softDeletedCount > 0
        ? ` — ${rows.length - softDeletedCount} live, ${softDeletedCount} SOFT-DELETED.`
        : ' (all live).')
  );
  if (softDeletedCount > 0) {
    console.log(
      '      ^ soft-deleted rows are inside the Phase 88.2 recovery window. They ARE remapped by\n' +
        '        up(), deliberately, so a restored group renders with the new palette — but they are\n' +
        '        marked here because this table is the owner approval record and a purge-pending row\n' +
        '        should not read as a live one.'
    );
  }

  // ---------------------------------------------------------------------------
  // 2. DISTINCT-VALUE CENSUS — this is the assertion-closing output, not a
  //    nicety. 88.3.1-RESEARCH.md assumptions A1 (the seven legacy light hexes
  //    are the complete pre-59-05 set) and A2 (prod holds nothing outside the
  //    fifteen) are both UNVERIFIED, and this is the only instrument that closes
  //    them.
  // ---------------------------------------------------------------------------
  const byHex = new Map();
  for (const row of rows) {
    const hex = normaliseHex(row.background_color);
    if (!byHex.has(hex)) byHex.set(hex, { hex, count: 0, raw: row.background_color, withImage: 0 });
    const bucket = byHex.get(hex);
    bucket.count += 1;
    if (row.has_image) bucket.withImage += 1;
  }
  const distinct = [...byHex.values()].sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex));

  console.log('\n2. DISTINCT-VALUE CENSUS — closes RESEARCH assumptions A1 and A2\n');
  console.log(`   ${pad('stored value', 10)} ${pad('rows', 6)} ${pad('classification', 20)} legacy label`);
  console.log(`   ${'-'.repeat(10)} ${'-'.repeat(6)} ${'-'.repeat(20)} ${'-'.repeat(20)}`);
  const unknowns = [];
  for (const d of distinct) {
    const known = knownRemapFor(d.hex);
    if (!known) unknowns.push(d);
    console.log(
      `   ${pad(d.hex, 10)} ${pad(d.count, 6)} ${pad(known ? 'known (1 of 15)' : 'UNKNOWN', 20)} ${known ? known.label : '-'}`
    );
  }
  if (distinct.length === 0) console.log('   (none)');

  // ---------------------------------------------------------------------------
  // 3. OLD -> NEW MAPPING TABLE. For a KNOWN value the destination comes from
  //    LEGACY_COLOUR_REMAP and is NEVER recomputed — the literal is authoritative
  //    (UI-SPEC 4.2 point 1), because Storm's row turns on a 0.65 margin and
  //    legacy orange's on 0.72. An UNKNOWN value is computed here and labelled
  //    COMPUTED.
  // ---------------------------------------------------------------------------
  console.log('\n3. OLD -> NEW MAPPING (known rows are LITERALS, never recomputed)\n');
  console.log(
    `   ${pad('old hex', 10)} ${pad('->', 3)} ${pad('preset', 8)} ${pad('dE2000', 8)} ${pad('runner-up', 10)} ${pad('its dE', 8)} ${pad('margin', 8)} ${pad('rows', 5)} arm`
  );
  console.log(`   ${'-'.repeat(76)}`);
  let unparseable = 0;
  for (const d of distinct) {
    const decision = decideFor(d.hex);
    if (!decision) {
      unparseable += 1;
      console.log(`   ${pad(d.hex, 10)} ${pad('->', 3)} UNPARSEABLE — the migration will LEAVE THESE ${d.count} ROW(S) UNTOUCHED`);
      continue;
    }
    console.log(
      `   ${pad(d.hex, 10)} ${pad('->', 3)} ${pad(decision.to, 8)} ${pad(fixed(decision.deltaE), 8)} ` +
        `${pad(decision.runnerUp, 10)} ${pad(fixed(decision.runnerUpDeltaE), 8)} ${pad(fixed(decision.margin), 8)} ` +
        `${pad(d.count, 5)} ${decision.arm === 'known' ? 'literal' : `COMPUTED (${decision.band} band)`}`
    );
  }
  if (distinct.length === 0) console.log('   (nothing to map)');

  console.log('\n   For reference, the full fifteen-row literal table (whether or not it is live here):\n');
  for (const row of LEGACY_COLOUR_REMAP) {
    const live = byHex.get(row.from);
    console.log(
      `   ${pad(row.from, 10)} ${pad(row.label, 15)} -> ${pad(row.to, 8)} dE ${pad(fixed(row.deltaE), 7)} ` +
        `runner-up ${pad(row.runnerUp, 8)} margin ${pad(fixed(row.margin), 6)} live rows: ${live ? live.count : 0}`
    );
  }

  // ---------------------------------------------------------------------------
  // 4. MERGE GROUPS — grouped by DESTINATION, because that is where down() is
  //    lossy. UI-SPEC 4.2 point 3: `blue` absorbs six of fifteen, 40% of the
  //    mapping. Groups, not pairs.
  // ---------------------------------------------------------------------------
  console.log('\n4. MERGE GROUPS — which old values collapse together (where down() is lossy)\n');
  const merges = new Map(GROUP_COLOUR_PRESETS.map((p) => [p.id, []]));
  for (const row of LEGACY_COLOUR_REMAP) {
    merges.get(row.to).push({ ...row, liveRows: byHex.get(row.from) ? byHex.get(row.from).count : 0 });
  }
  for (const d of distinct) {
    const decision = decideFor(d.hex);
    if (decision && decision.arm === 'computed') {
      merges.get(decision.to).push({ from: d.hex, label: 'UNKNOWN (computed)', liveRows: d.count });
    }
  }
  for (const [presetId, sources] of merges) {
    if (sources.length === 0) continue;
    const liveTotal = sources.reduce((sum, s) => sum + s.liveRows, 0);
    const lossy = sources.length > 1 ? '  <-- LOSSY on down(): only one canonical hex can be restored' : '';
    console.log(`   ${pad(presetId, 8)} <- ${sources.length} old value(s), ${liveTotal} live row(s)${lossy}`);
    for (const s of sources) {
      console.log(`      ${pad(s.from, 10)} ${pad(s.label, 20)} ${s.liveRows} live row(s)`);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. THE TWO TIGHT ROWS — the 20260820000003-clamp-oversize-names.js:35-42
  //    STOP-condition idiom: flagged loudly, both candidates, both distances,
  //    the margin and the live count.
  // ---------------------------------------------------------------------------
  console.log('');
  rule('!');
  console.log('  5. TWO TIGHT ROWS — READ THESE BEFORE APPROVING');
  rule('!');

  const storm = knownRemapFor('#27272a');
  const stormLive = byHex.get('#27272a') ? byHex.get('#27272a').count : 0;
  console.log(`\n  (a) Storm #27272a -> ${storm.to} ${fixed(storm.deltaE)} vs ${storm.runnerUp} ${fixed(storm.deltaE + storm.margin)}, MARGIN 0.65`);
  console.log(`      LIVE ROWS: ${stormLive}`);
  console.log('      This is not "nearest preset", it is "least-bad of two poor matches". Storm is');
  console.log('      achromatic (OKLCH C 0.005) and this palette has no achromatic member. The margin');
  console.log('      only widened from 0.05 to 0.65 because Teal\'s hue moved 6deg for an unrelated');
  console.log('      reason, which is precisely why it cannot be relied on.');
  console.log('      UI-SPEC 2.7, verbatim: a "7 hues + 1 neutral" variant of the palette would map');
  console.log('      Storm at deltaE 0.77 instead of 15.56, and it is a ONE-ROW TABLE EDIT.');
  console.log('      => If Charcoal / Slate / Storm hold a meaningful share of the live groups above,');
  console.log('         put that variant to the owner WITH THESE COUNTS before merging. UI-SPEC 4.2');
  console.log('         calls this the single highest-value thing the dry run buys.');

  const legacyOrange = knownRemapFor('#fff3e0');
  const orangeLive = byHex.get('#fff3e0') ? byHex.get('#fff3e0').count : 0;
  console.log(`\n  (b) legacy orange #fff3e0 -> ${legacyOrange.to} ${fixed(legacyOrange.deltaE)} vs ${legacyOrange.runnerUp} ${fixed(legacyOrange.deltaE + legacyOrange.margin)}, MARGIN 0.72`);
  console.log(`      LIVE ROWS: ${orangeLive}`);
  console.log('      New in palette rev3 — it was 3.07 against the rev2 light band, and light `amber`');
  console.log('      gaining chroma moved it toward the cream. Any future light-band edit MUST re-run');
  console.log('      UI-SPEC 4.2 before this migration is trusted again.');

  const charcoalSlateStorm = ['#1e1e2e', '#1e293b', '#27272a']
    .reduce((sum, hex) => sum + (byHex.get(hex) ? byHex.get(hex).count : 0), 0);

  // ---------------------------------------------------------------------------
  // 6. VERDICT — audit-event-timezones.js:163-180 shape.
  // ---------------------------------------------------------------------------
  const changing = rows.filter((r) => !r.color_preset && decideFor(r.background_color)).length;
  const untouchedUnparseable = rows.filter((r) => !r.color_preset && !decideFor(r.background_color)).length;
  const unsetRows = totalGroups - rows.length;
  const withImage = rows.filter((r) => r.has_image).length;

  console.log('');
  rule();
  console.log('  6. VERDICT');
  rule();
  console.log(`    groups total:                         ${totalGroups}`);
  console.log(`    rows that WILL CHANGE:                ${changing}`);
  console.log(`    rows already carrying a color_preset: ${alreadyPreset}  (untouched — idempotency predicate)`);
  console.log(`    rows unparseable, LEFT UNTOUCHED:     ${untouchedUnparseable}`);
  console.log(`    rows unset (#ffffff/#fff/null/'', any case), NEVER touched: ${unsetRows}`);
  console.log(`    distinct stored values:               ${distinct.length}`);
  console.log(`    UNKNOWN values (outside the fifteen):  ${unknowns.length}`);
  console.log(`    Charcoal + Slate + Storm live rows:    ${charcoalSlateStorm}  (the UI-SPEC 2.7 neutral-preset input)`);
  // AMENDMENT AD — a VISIBILITY line, not a STOP condition and not a repair.
  console.log(`    rows with BOTH a colour and an image:  ${withImage}`);
  console.log('      ^ not a stop condition and NOT repaired here. The UI has enforced');
  console.log('        colour-or-image exclusivity both ways for some time: handleSelectDefaultColor');
  console.log('        clears the image when a colour is picked, and handleUseCustomBackground clears');
  console.log('        the colour when an image is set. The renderer gives the image priority when both');
  console.log('        exist (the groupHomePage ground class). So these are legacy rows that predate or bypassed');
  console.log('        that UI, and the remap does not make them worse: image-wins before, image-wins');
  console.log('        after — behaviour identical either side. Nulling a column here would be silent');
  console.log('        data loss on a value the owner may still want. The count exists because it is');
  console.log('        the input to the Phase 88.6 scrim decision (.planning/deferred/phase-88.6.md);');
  console.log('        if it is 0, that decision gets much cheaper.');

  if (unknowns.length > 0) {
    console.log('');
    rule('!');
    console.log('    STOP CONDITION: an UNKNOWN stored value is present.');
    console.log('    RESEARCH assumption A2 (prod holds nothing outside the fifteen) is FALSE here.');
    console.log('    These values are NOT something the migration should quietly absorb — the whole');
    console.log('    reason the fifteen are literals is that two of them turn on a margin under 0.75.');
    console.log('    Surface each one to the owner with its computed destination, runner-up and margin');
    console.log('    (section 3 above) before BE PR-2 merges. Exiting 2.');
    for (const u of unknowns) console.log(`      ${u.hex}  ${u.count} row(s)`);
    rule('!');
  }

  console.log('');
  console.log('  NEXT STEP FOR THE OPERATOR: paste this ENTIRE output into');
  console.log('  .planning/phases/88.3.1-.../88.3.1-05-SUMMARY.md and record the owner\'s glance');
  console.log('  there. That glance is the CONTEXT D-03 gate and it BLOCKS the BE PR-2 merge.');
  rule();
  console.log('');

  await sequelize.close();
  process.exit(unknowns.length > 0 ? EXIT_UNKNOWN_VALUE : EXIT_CLEAN);
}

censusGroupColours().catch((err) => {
  console.error('Census failed:', err);
  process.exit(EXIT_CRASH);
});
