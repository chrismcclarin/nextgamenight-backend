// scripts/report-account-hygiene.js
//
// Phase 88.8 plan 05 Task 3 (SPEC R6 / BOPS-05, CONTEXT D-18) — the account-hygiene
// report. It lists every Users row that needs a HUMAN decision, with what that row owns.
//
// Reports (a row may be in several classes):
//   1. synthetic email        — the address is a <sub>@auth0.local placeholder, so this
//                               person has no real address on file
//   2. non-sub-shaped user_id — a "ghost" row: user_id is not `<strategy>|<id>`, which
//                               is what a Users.id UUID written into user_id looks like
//   3. orphaned_at set        — a row this phase's SPEC R5 branch (b) released
//   4. Auth0 identity gone    — getUserById returned a hard 404
//   5. email never proved     — a REAL stored address whose Auth0 record says
//                               email_verified is not true. THE ONLY SECURITY CLASS
//                               HERE: Users.email is an AUTHORIZATION gate (the three
//                               invite-acceptance handlers accept only when
//                               user.email === invite.invited_email —
//                               routes/invites.js:593, :664, :757), and until Phase 88.8
//                               the JIT provisioner persisted the raw token email with
//                               no email_verified check (routes/users.js:216), so the
//                               shipped population can hold addresses their owner never
//                               proved control of. Plans 01/04 fix that FORWARD only and
//                               plan 04's repair rules then bless those rows by design,
//                               so without this class the vulnerable population is
//                               frozen and invisible. Deleting this class without
//                               replacing the route to the owner is a decision, not a
//                               cleanup.
//
// AN UNAVAILABLE MANAGEMENT API IS NEVER REPORTED AS A DELETED IDENTITY. Classes 4 and 5
// need the vendor; when the call THROWS the row is marked `unknown`, never `gone`. That
// distinction is the difference between a report the owner can act on and one that
// invents orphans during an outage — and acting on a false orphan means hand-deleting a
// live person's account.
//
// READ-ONLY: no write calls of any kind. Output to stdout only.
//
// DO NOT PASTE THIS OUTPUT INTO A COMMITTED DOCUMENT. It prints real stored email
// addresses on purpose — an operator cannot act on `unknown@...` (threat register
// T-88.8-25, accepted). `.planning/` is committed in full and never pruned, so the house
// rule for a census that IS pasted is redaction-by-construction
// (scripts/census-group-colours.js:20-30). This one is for a terminal you are looking at.
//
// Usage:
//   local : npm run report:account-hygiene   (or: node scripts/report-account-hygiene.js)
//   prod  : railway run -- node scripts/report-account-hygiene.js
//   flags : --limit N   cap the Auth0 identity scan at the first N rows (default: no cap)
//
// Exit codes: 0 always for a completed run (this is a report, not a gate); 1 if the
// script itself crashed. An INCOMPLETE census is signalled in the SUMMARY line and by a
// WARNING, not by an exit code, because a partial answer is still worth reading.

// DECISION Phase 88.8 plan 05: dotenv is loaded ONLY when this file is the entry point,
// chosen OVER the unconditional `require('dotenv').config()` at the top of
// scripts/audit-event-timezones.js:21 that this script otherwise copies.
// The reason is mechanical, not stylistic: tests/scripts/reportAccountHygiene.test.js
// invokes main() IN-PROCESS, and by then tests/setup.js has already loaded `.env.test`.
// dotenv does not overwrite variables that are already set, but it DOES add ones that
// are missing — so an unconditional call would merge the development `.env` into the
// test process, and a `DATABASE_URL` present there but absent from `.env.test` would
// silently point the whole suite at the DEVELOPMENT database (config/database.js prefers
// DATABASE_URL when it exists). It must still run BEFORE `require('../models')` below,
// which reads the config at require time — hence the guard here rather than inside the
// runner block at the bottom.
if (require.main === module) {
  require('dotenv').config();
}

const { sequelize, User, UserGroup, EventParticipation } = require('../models');
const auth0Service = require('../services/auth0Service');
const { isSyntheticAddress } = require('../services/provisioningService');

// Auth0's Free-tier Management API limit is burst 2 / sustained 2 requests per second,
// with no per-endpoint override for GET /api/v2/users/{id}; higher tiers are looser, so
// 600 ms satisfies every tier. Which tier this tenant is on is the owner's to know — the
// pacing is chosen to be safe on the lowest.
const MANAGEMENT_PACE_MS = 600;

const CLASSES = Object.freeze({
  SYNTHETIC_EMAIL: 'synthetic email',
  NON_SUB_USER_ID: 'non-sub-shaped user_id',
  ORPHANED: 'orphaned_at set',
  IDENTITY_GONE: 'identity gone',
  EMAIL_UNPROVED: 'email never proved by Auth0',
  IDENTITY_UNKNOWN: 'identity unknown',
});

/**
 * An Auth0 sub is `<connection strategy>|<identifier>`.
 *
 * DECISION Phase 88.8 plan 05: the shape test is GENERIC (`something|something`), chosen
 * OVER the retired cleanup-ghost-users.js's two-literal allowlist
 * (`NOT LIKE 'auth0|%' AND NOT LIKE 'google-oauth2|%'`). The allowlist would report a
 * perfectly healthy `windowslive|...` or `apple|...` row as a ghost the moment the owner
 * enables another connection, and a report that cries wolf is a report nobody reads. The
 * class this actually exists to catch is a Users.id UUID written into user_id (the
 * keyspace-mixing defect described at services/provisioningService.js's KEYSPACE
 * DISCIPLINE block) — a UUID contains no pipe, so the generic shape catches it.
 * Narrowing this back to the two literals is a decision, not a cleanup.
 */
function isSubShaped(userId) {
  return typeof userId === 'string' && /^[^|\s]+\|.+$/.test(userId);
}

function pause(ms) {
  if (!ms) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the report. Returns a result object and NEVER closes the connection or exits the
 * process — both of those live only in the runner block at the bottom, mirroring
 * migrations/20260408000001-add-sms-welcome-sent-at-to-users.js:32-34. The retired
 * cleanup-ghost-users.js did both INSIDE main() (:34-35, :46-47, :95-97), and lifting
 * that shape would close the Jest worker's only connection mid-suite the moment a test
 * invoked main() in-process.
 *
 * @param {{ limit?: number|null, pauseMs?: number, log?: Function, auth0?: object }} options
 *   pauseMs is injectable ONLY so the test suite does not sleep 600 ms per seeded row;
 *   production always uses MANAGEMENT_PACE_MS.
 * @returns {Promise<{ listed: Array, checked: number, total: number, unknown: number,
 *                     skipped: number, managementFailed: boolean }>}
 */
async function main(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : null;
  const pauseMs = options.pauseMs === undefined ? MANAGEMENT_PACE_MS : options.pauseMs;
  const log = options.log || console.log;
  const auth0 = options.auth0 || auth0Service;

  log('=== Account hygiene report (Phase 88.8, SPEC R6 / BOPS-05) ===');
  log('READ-ONLY: no write calls of any kind. Output to stdout only.');
  log('An unavailable Management API prints `unknown`, NEVER `gone`.');
  log('Do not paste this output into a committed document — it contains real addresses.');
  log('');

  // Ordered by the surrogate PK so the scan is stable and a --limit run always covers
  // the SAME prefix. Never offset-page an unordered SELECT: it can skip or duplicate.
  // Read through withContactInfo, or `email` is not in the projection at all
  // (models/User.js defaultScope excludes it) and every class below would misfire.
  const rows = await User.scope('withContactInfo').findAll({
    attributes: ['id', 'user_id', 'email', 'orphaned_at', 'email_changed_at'],
    order: [['id', 'ASC']],
  });
  const total = rows.length;

  const findings = new Map(); // row.id -> { row, classes: Set, identity: string }
  const noteClass = (row, klass) => {
    if (!findings.has(row.id)) {
      findings.set(row.id, { row, classes: new Set(), identity: 'ok' });
    }
    findings.get(row.id).classes.add(klass);
  };

  // --- Classes 1-3: pure database, no vendor call ---------------------------
  for (const row of rows) {
    if (isSyntheticAddress(row.email)) {
      noteClass(row, CLASSES.SYNTHETIC_EMAIL);
    }
    if (!isSubShaped(row.user_id)) {
      noteClass(row, CLASSES.NON_SUB_USER_ID);
    }
    if (row.orphaned_at !== null && row.orphaned_at !== undefined) {
      noteClass(row, CLASSES.ORPHANED);
    }
  }

  // --- Classes 4-5: one Auth0 lookup per row, STRICTLY sequential -----------
  // EVERY row by default. SPEC R6 and ROADMAP success criterion 4 both say "every", and
  // the live specimen this exists for (the 2026-09-02 orphan: a real email, a sub-shaped
  // user_id, no orphaned_at) is in NONE of classes 1-3 — a scan bounded to those rows
  // would never find the row that started this phase.
  //
  // Never Promise.all and never batched: the vendor limit is per-second, and a burst is
  // the one shape that turns a report into a 429 storm.
  const scanWindow = limit ? rows.slice(0, limit) : rows;
  const skipped = total - scanWindow.length;
  let checked = 0;
  let unknown = 0;
  let managementFailed = false;

  for (let i = 0; i < scanWindow.length; i += 1) {
    const row = scanWindow[i];

    if (managementFailed) {
      // STOP RULE: after the first throw we do not call again. services/auth0Service.js
      // discards the HTTP status when it rethrows, so a 429 and an outage are
      // indistinguishable from here — a retry cannot be targeted, and plan 14 step 4 has
      // the owner run this while the Management API may still be broken, so the cost of
      // a run during an outage is bounded to ONE call.
      unknown += 1;
      noteClass(row, CLASSES.IDENTITY_UNKNOWN);
      findings.get(row.id).identity = 'unknown';
      continue;
    }

    if (i > 0) {
      await pause(pauseMs);
    }

    let identity;
    try {
      identity = await auth0.getUserById(row.user_id);
    } catch (_managementUnavailable) {
      managementFailed = true;
      unknown += 1;
      noteClass(row, CLASSES.IDENTITY_UNKNOWN);
      findings.get(row.id).identity = 'unknown';
      continue;
    }

    checked += 1;

    if (identity === null) {
      noteClass(row, CLASSES.IDENTITY_GONE);
      findings.get(row.id).identity = 'gone';
      continue;
    }

    // Class 5 rides on the SAME answer — zero extra vendor calls. extractUserDetails
    // already returns email_verified (services/auth0Service.js:325).
    const details = auth0.extractUserDetails(identity) || {};
    if (!isSyntheticAddress(row.email) && details.email_verified !== true) {
      noteClass(row, CLASSES.EMAIL_UNPROVED);
    }
  }

  // --- Ownership counts, for the LISTED rows only ---------------------------
  // These are the whole point: they tell the owner what a hand-deletion would destroy.
  const listed = [];
  for (const { row, classes, identity } of findings.values()) {
    const [groupsOwned, memberships, participations] = await Promise.all([
      UserGroup.count({ where: { user_uuid: row.id, role: 'owner' } }),
      UserGroup.count({ where: { user_uuid: row.id } }),
      EventParticipation.count({ where: { user_id: row.id } }),
    ]);
    listed.push({
      id: row.id,
      sub: row.user_id,
      email: row.email,
      identity,
      classes: [...classes],
      groupsOwned,
      memberships,
      participations,
    });
  }
  listed.sort((a, b) => String(a.id).localeCompare(String(b.id)));

  if (listed.length === 0) {
    log('none');
  } else {
    log(`${listed.length} row(s) need a human decision:`);
    log('');
    for (const item of listed) {
      log(`  sub=${item.sub}`);
      log(`    email=${item.email}`);
      log(`    class=${item.classes.join(' + ')}   auth0_identity=${item.identity}`);
      log(
        `    groups_owned=${item.groupsOwned}  memberships=${item.memberships}  participations=${item.participations}`
      );
      log('');
    }
  }

  log(`SUMMARY: checked ${checked}/${total}  unknown=${unknown}`);
  if (managementFailed) {
    log(`${unknown} rows not checked: Management API unavailable`);
  }
  if (skipped > 0) {
    log(`--limit ${limit} in effect: ${skipped} row(s) beyond the cap were not scanned`);
  }
  if (unknown > 0 || skipped > 0) {
    log(
      'WARNING: this census is INCOMPLETE. Record it as incomplete, not as zero orphans — ' +
        'an unchecked row is not a clean row.'
    );
  }

  return { listed, checked, total, unknown, skipped, managementFailed };
}

module.exports = { main, isSubShaped, CLASSES, MANAGEMENT_PACE_MS };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const limitIndex = argv.indexOf('--limit');
  const limit = limitIndex === -1 ? null : Number.parseInt(argv[limitIndex + 1], 10);

  main({ limit })
    .then(async () => {
      await sequelize.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Account hygiene report failed:', err.message);
      try {
        await sequelize.close();
      } catch (_closeFailed) {
        // Nothing useful to do — we are already exiting non-zero.
      }
      process.exit(1);
    });
}
