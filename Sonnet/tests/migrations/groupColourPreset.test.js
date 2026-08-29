// tests/migrations/groupColourPreset.test.js
//
// Phase 88.3.1 plan 05 Task 3 (SPEC Req 6, CONTEXT D-02/D-03, UI-SPEC 10.1 test 15).
//
// Proves migrations/20260828000002-remap-group-colours-to-presets.js on Postgres:
//   (a) all FIFTEEN known legacy values land on their UI-SPEC 4.2 destination and
//       have background_color nulled
//   (b) every "unset" spelling — #ffffff, #FFFFFF, #fff, #FFF, NULL, '' — is
//       BYTE-UNCHANGED in both columns (AMENDMENT M: the app's own predicate is
//       case-insensitive and 3-digit tolerant, and those variants exist in the data)
//   (c) the migration's own per-row rowCount logs sum to fifteen
//   (d) a second up() is a no-op: throws nothing, changes nothing, logs 0 everywhere
//   (e) down() restores a CANONICAL hex per preset, and the six-way `blue` merge
//       comes back as Navy #172554 for all six — asserted as RECORDED LOSSINESS,
//       not as a bug (CONTEXT D-03)
//   (f) the COMPUTED fallback arm picks its candidate set by CIE L*: a hex under
//       L* 50 is compared ONLY against the eight dark bands and one at or above
//       ONLY against the eight light surfaces. This pins the BRANCH, not just the
//       winner (see the #767676 / #777777 note below).
//   (g) an unparseable stored value is LEFT UNTOUCHED and logged — never remapped
//       (threat T-88.3.1-10: a null distance is not a zero distance)
//
// SCHEMA RESTORE — the non-negotiable part (tests/migrations/rekey.test.js:35-44,
// :83-96). This file must leave the CURRENT schema behind: Groups.color_preset
// PRESENT. The rekey lesson (fixed 2026-07-29) is that a migration-replay test
// that leaves an OLDER schema behind poisons every suite that runs after it in
// the same `npm test` — that is precisely why the BE suite is green today. This
// file's scenarios do not currently call 20260828000001's down(), but the
// afterAll re-runs its up() unconditionally so that adding such a scenario later
// cannot silently strip the column from every downstream suite. Its up() is
// guarded by describeTable, so re-running it on an intact schema is a logged
// no-op.
//
// NOTE: tests/setup.js runs truncateAll in beforeEach, so every scenario is fully
// self-contained inside a single `it` (seed -> up -> assert, no beforeEach in
// between). Never split a seed and its assertion across two tests.
//
// Run it ALONE first (it mutates data across the whole Groups table), then run the
// FULL suite — a file that passes alone and reds in the full run is the
// cross-suite leakage signature and this is exactly the kind of file that causes it:
//   npm test -- tests/migrations/groupColourPreset.test.js --forceExit --testTimeout=25000

const crypto = require('crypto');
const Sequelize = require('sequelize');
const { QueryTypes } = Sequelize;
const { sequelize } = require('../../models');
const { GROUP_COLOUR_PRESETS } = require('../../utils/groupColourPresets');
const { deltaE2000, lStar } = require('../../utils/colourDistance');

const remap = require('../../migrations/20260828000002-remap-group-colours-to-presets.js');

const qi = () => sequelize.getQueryInterface();
const uuid = () => crypto.randomUUID();

// See the SCHEMA RESTORE note in the header: leave the CURRENT schema behind
// (Groups.color_preset present), not a pre-88.3.1 one.
const schemaRestoreMigrations = [
  require('../../migrations/20260828000001-add-color-preset-to-groups.js'),
];

afterAll(async () => {
  for (const migration of schemaRestoreMigrations) {
    await migration.up(qi(), Sequelize);
  }
});

// --- low-level helpers (copied from rekey.test.js:113-123 and :149-166) ------

/** Raw INSERT (bypasses the model so a pre-migration row can be seeded verbatim). */
async function insertRow(table, cols) {
  const keys = Object.keys(cols);
  const colList = keys.map((k) => `"${k}"`).join(', ');
  const valList = keys.map((k) => `:${k}`).join(', ');
  const rows = await sequelize.query(
    `INSERT INTO "${table}" (${colList}) VALUES (${valList}) RETURNING id`,
    { replacements: cols, type: QueryTypes.SELECT }
  );
  return rows[0].id;
}

/** Capture console.log emitted while `fn` runs so we can assert the migration's own counts. */
async function withLogCapture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

/** Sum of the "N row(s)" counts the migration logs for its literal + computed arms. */
function loggedRowTotal(lines) {
  return lines
    .filter((l) => / -> /.test(l) && /: \d+ row\(s\)$/.test(l))
    .reduce((sum, l) => sum + Number(l.match(/: (\d+) row\(s\)$/)[1]), 0);
}

/** Seed one Group carrying `backgroundColor` (which may be null). Returns its id. */
async function seedGroup(backgroundColor) {
  const id = uuid();
  const now = new Date();
  await insertRow('Groups', {
    id,
    name: `G ${id.slice(0, 8)}`,
    group_id: `g-${id}`,
    background_color: backgroundColor,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function readGroup(id) {
  const rows = await sequelize.query(
    'SELECT background_color, color_preset FROM "Groups" WHERE id = :id',
    { replacements: { id }, type: QueryTypes.SELECT }
  );
  return rows[0];
}

/**
 * The nearest preset to `hex` among ONE band's grounds, computed here in the test
 * rather than imported from the code under test. This is what makes scenario (f)
 * pin the BRANCH: the expectation is "nearest among the DARK candidate set",
 * derived independently, so a flipped L* threshold reds it.
 */
function nearestInBand(hex, band) {
  return GROUP_COLOUR_PRESETS
    .map((p) => ({ id: p.id, d: deltaE2000(hex, p[band]) }))
    .sort((a, b) => a.d - b.d)[0].id;
}

// ---------------------------------------------------------------------------
// THE FIFTEEN, PINNED AS LITERALS IN THIS FILE (UI-SPEC 10.1 test 15).
//
// Deliberately NOT imported from utils/groupColourPresets.js. The point is that
// this test must FAIL if the shared table is edited: these are the exact rows the
// owner is asked to approve at the CONTEXT D-03 gate, and two of them (Storm at
// margin 0.65, legacy orange at 0.72) would flip on a third-decimal change.
// ---------------------------------------------------------------------------
const FIFTEEN = [
  // dark legacy presets (L* < 50 -> compared against the dark bands)
  { hex: '#1e1e2e', label: 'Charcoal', to: 'blue' },
  { hex: '#1e293b', label: 'Slate', to: 'blue' },
  { hex: '#172554', label: 'Navy', to: 'blue' },
  { hex: '#1e1b4b', label: 'Indigo', to: 'violet' },
  { hex: '#14332a', label: 'Forest', to: 'teal' },
  { hex: '#3b1030', label: 'Wine', to: 'rose' },
  { hex: '#2c1f14', label: 'Espresso', to: 'orange' },
  { hex: '#27272a', label: 'Storm', to: 'blue' }, // TIGHT: margin 0.65 vs teal
  // light legacy values (L* >= 50 -> compared against the light surfaces)
  { hex: '#e3f2fd', label: 'legacy blue', to: 'blue' },
  { hex: '#e8f5e9', label: 'legacy green', to: 'green' },
  { hex: '#f3e5f5', label: 'legacy purple', to: 'violet' },
  { hex: '#fff3e0', label: 'legacy orange', to: 'orange' }, // TIGHT: margin 0.72 vs amber
  { hex: '#fce4ec', label: 'legacy pink', to: 'red' },
  { hex: '#f5f5f5', label: 'legacy grey', to: 'blue' },
  { hex: '#fffde7', label: 'legacy yellow', to: 'amber' },
];

/** The six old values that collapse into `blue` — where down() is materially lossy. */
const SIX_INTO_BLUE = ['#1e1e2e', '#1e293b', '#172554', '#27272a', '#e3f2fd', '#f5f5f5'];

/** Every spelling of "this group has no colour". */
const UNSET_SPELLINGS = ['#ffffff', '#FFFFFF', '#fff', '#FFF', null, ''];

const CANONICAL_DOWN_HEX = {
  red: '#fce4ec',
  orange: '#2c1f14',
  amber: '#fffde7',
  green: '#e8f5e9',
  teal: '#14332a',
  blue: '#172554',
  violet: '#1e1b4b',
  rose: '#3b1030',
};

// =============================================================================

describe('20260828000002 remap-group-colours-to-presets', () => {
  it('maps all fifteen known values to their UI-SPEC 4.2 destination and nulls background_color', async () => {
    const ids = {};
    for (const row of FIFTEEN) ids[row.hex] = await seedGroup(row.hex);

    const logs = await withLogCapture(() => remap.up(qi()));

    for (const row of FIFTEEN) {
      const after = await readGroup(ids[row.hex]);
      expect({ hex: row.hex, preset: after.color_preset })
        .toEqual({ hex: row.hex, preset: row.to });
      expect(after.background_color).toBeNull();
    }

    // (c) the migration's own per-row counts sum to fifteen
    expect(loggedRowTotal(logs)).toBe(15);
  });

  it('never touches an unset row — #ffffff, #FFFFFF, #fff, #FFF, NULL and empty string are byte-unchanged', async () => {
    // AMENDMENT M. A lowercase-only `#ffffff` check would remap #FFFFFF/#fff/#FFF
    // to a real preset and null background_color, irreversibly giving a
    // colourless group a colour.
    const ids = [];
    for (const spelling of UNSET_SPELLINGS) ids.push([spelling, await seedGroup(spelling)]);
    const coloured = await seedGroup('#14332a'); // proves up() actually ran

    await withLogCapture(() => remap.up(qi()));

    for (const [spelling, id] of ids) {
      const after = await readGroup(id);
      expect({ spelling, bg: after.background_color, preset: after.color_preset })
        .toEqual({ spelling, bg: spelling, preset: null });
    }
    expect((await readGroup(coloured)).color_preset).toBe('teal');
  });

  it('matches the fifteen case-insensitively, so an uppercase legacy hex stays on the LITERAL arm', async () => {
    // The pre-59-05 picker only validated hex SHAPE (/^#[0-9a-f]{6}$/i), so
    // #1E1E2E is a Charcoal row in the wild. If it fell through to the computed
    // arm it would be recomputed — and recomputing a known row is the one thing
    // the fifteen literals exist to prevent.
    const id = await seedGroup('#1E1E2E');

    const logs = await withLogCapture(() => remap.up(qi()));

    const after = await readGroup(id);
    expect(after.color_preset).toBe('blue');
    expect(after.background_color).toBeNull();
    expect(logs.some((l) => /#1e1e2e \(Charcoal\) -> blue: 1 row\(s\)/.test(l))).toBe(true);
    expect(logs.some((l) => /COMPUTED/.test(l))).toBe(false);
  });

  it('is idempotent: a second up() throws nothing, changes nothing and logs zero for every statement', async () => {
    const ids = {};
    for (const row of FIFTEEN) ids[row.hex] = await seedGroup(row.hex);

    await withLogCapture(() => remap.up(qi()));
    const firstPass = {};
    for (const row of FIFTEEN) firstPass[row.hex] = await readGroup(ids[row.hex]);

    const logs2 = await withLogCapture(() => remap.up(qi()));

    expect(loggedRowTotal(logs2)).toBe(0);
    for (const row of FIFTEEN) {
      expect(await readGroup(ids[row.hex])).toEqual(firstPass[row.hex]);
    }
  });

  it('down() restores a canonical hex per preset, and all SIX blue sources come back as Navy #172554', async () => {
    // RECORDED LOSSINESS, NOT A BUG (CONTEXT D-03). `blue` absorbed six of the
    // fifteen and down() can only put one hex back per preset. Exact per-row
    // restore comes from the census pasted into 88.3.1-05-SUMMARY.md, by hand.
    const ids = {};
    for (const row of FIFTEEN) ids[row.hex] = await seedGroup(row.hex);

    await withLogCapture(() => remap.up(qi()));
    await withLogCapture(() => remap.down(qi()));

    for (const hex of SIX_INTO_BLUE) {
      const after = await readGroup(ids[hex]);
      expect({ from: hex, bg: after.background_color, preset: after.color_preset })
        .toEqual({ from: hex, bg: '#172554', preset: null });
    }

    // Every other row also lands on its preset's canonical hex.
    for (const row of FIFTEEN) {
      const after = await readGroup(ids[row.hex]);
      expect(after.background_color).toBe(CANONICAL_DOWN_HEX[row.to]);
      expect(after.color_preset).toBeNull();
    }
  });

  it('COMPUTED arm, DARK side: a hex under L* 50 is judged ONLY against the eight dark bands', async () => {
    // #767676 has L* 49.6370 — just under the threshold. Its nearest DARK band is
    // `teal`; its nearest LIGHT surface would be `blue`. So this assertion reds if
    // the L* threshold is flipped or if OKLab lightness is substituted for CIE L*.
    // (#123456 is seeded too because plan 05 names it, but note it is L* 21.04 —
    // DARK, not light — and it maps to `blue` in BOTH bands, so it cannot pin the
    // branch on its own. Only the #767676 / #777777 pair can.)
    expect(lStar('#767676')).toBeLessThan(50);
    const expected = nearestInBand('#767676', 'dark');
    expect(expected).toBe('teal');
    expect(nearestInBand('#767676', 'light')).not.toBe(expected);

    const darkEdge = await seedGroup('#767676');
    const darkPlain = await seedGroup('#123456');

    const logs = await withLogCapture(() => remap.up(qi()));

    const after = await readGroup(darkEdge);
    expect(after.color_preset).toBe(expected);
    expect(after.background_color).toBeNull();
    expect((await readGroup(darkPlain)).color_preset).toBe(nearestInBand('#123456', 'dark'));

    // the decision is logged with its band, distance, runner-up and margin
    expect(logs.some((l) => /COMPUTED #767676 \(L\* 49\.64, dark band\) -> teal/.test(l))).toBe(true);
  });

  it('COMPUTED arm, LIGHT side: a hex at or above L* 50 is judged ONLY against the eight light surfaces', async () => {
    // #777777 has L* 50.0344 — one byte away from #767676 and on the other side of
    // the threshold. Its nearest LIGHT surface is `blue`; its nearest DARK band
    // would be `teal`. The pair is the tightest available pin on the branch.
    expect(lStar('#777777')).toBeGreaterThanOrEqual(50);
    const expected = nearestInBand('#777777', 'light');
    expect(expected).toBe('blue');
    expect(nearestInBand('#777777', 'dark')).not.toBe(expected);

    const lightEdge = await seedGroup('#777777');

    const logs = await withLogCapture(() => remap.up(qi()));

    const after = await readGroup(lightEdge);
    expect(after.color_preset).toBe(expected);
    expect(after.background_color).toBeNull();
    expect(logs.some((l) => /COMPUTED #777777 \(L\* 50\.03, light band\) -> blue/.test(l))).toBe(true);
  });

  it('leaves an UNPARSEABLE stored colour completely untouched and logs it loudly', async () => {
    // Threat T-88.3.1-10, the half plan 04 handed to this plan: deltaE2000 and
    // lStar return NULL for an unparseable hex, and a null coerced to 0 reads as a
    // PERFECT MATCH — it would remap the row to whatever it compared against
    // first. Untouched-and-logged is the correct failure mode; the row keeps
    // rendering through the legacy tint fallback, exactly as it does today.
    const garbage = await seedGroup('not-a-colour');
    const shortHex = await seedGroup('#12345');
    const control = await seedGroup('#3b1030');

    const logs = await withLogCapture(() => remap.up(qi()));

    for (const [value, id] of [['not-a-colour', garbage], ['#12345', shortHex]]) {
      const after = await readGroup(id);
      expect({ value, bg: after.background_color, preset: after.color_preset })
        .toEqual({ value, bg: value, preset: null });
      expect(logs.some((l) => l.includes('UNPARSEABLE') && l.includes(value))).toBe(true);
    }

    // the migration still did its job for everything else
    expect((await readGroup(control)).color_preset).toBe('rose');
    expect(logs.some((l) => /skipped 2 unparseable row\(s\)/.test(l))).toBe(true);
  });
});
