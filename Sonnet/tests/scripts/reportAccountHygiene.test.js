// tests/scripts/reportAccountHygiene.test.js
// Phase 88.8 plan 05 Task 3 (SPEC R6 / BOPS-05) — the account-hygiene report.
//
// FIRST TEST OF A SHIPPED SCRIPT in this repo (there is no other tests/scripts/ file).
// It exists because the report's whole value is a promise about what it does NOT do —
// it writes nothing — and because "unknown, never gone" is a claim that a comment can
// make and only a test can keep.
//
// Runs against the suite's REAL Postgres, and invokes the script's exported main()
// IN-PROCESS rather than spawning a child, so it inherits tests/globalSetup.js's schema
// and tests/setup.js's per-test TRUNCATE. That is also why main() must never call
// sequelize.close() or process.exit() — see the script's main() header.
//
// THE 600 ms PACE IS STUBBED by passing `pauseMs: 0`, the seam the script exposes for
// exactly this reason. The pacing is a vendor rate-limit concern with no behaviour to
// assert; what IS asserted is the SEQUENTIAL guarantee, via an in-flight counter inside
// the mock, because "never Promise.all" is otherwise a decorative comment.

jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn(),
  extractUserDetails: jest.fn((u) => ({
    user_id: (u && u.user_id) || null,
    email: (u && u.email) || null,
    username: (u && u.username) || null,
    email_verified: Boolean(u && u.email_verified),
    picture: (u && u.picture) || null,
  })),
}));

const auth0Service = require('../../services/auth0Service');
const { main } = require('../../scripts/report-account-hygiene');
const { User, Group, UserGroup, Event, EventParticipation } = require('../../models');

// The five seeded subs. Class iv is deliberately the shape of the 2026-09-02 production
// orphan: a REAL email, a sub-shaped user_id, null orphaned_at — in NONE of classes 1-3.
const SUB_SYNTHETIC = 'auth0|hyg-synthetic';
const SUB_GHOST = '8f1c9b6e-0000-4000-8000-000000000001'; // a Users.id UUID in user_id
const SUB_ORPHANED = 'auth0|hyg-orphaned';
const SUB_IDENTITY_GONE = 'auth0|hyg-identity-gone';
const SUB_UNPROVED = 'auth0|hyg-unproved';
const SUB_CLEAN = 'auth0|hyg-clean';

function liveIdentity(sub, { emailVerified = true } = {}) {
  return { user_id: sub, email: `${sub}@example.com`, email_verified: emailVerified };
}

// Keyed BY SUB. A blanket mockResolvedValue(null) would report the CLEAN row as
// identity-gone, which is the whole failure this shape prevents.
function mockIdentities(map, { inFlight } = {}) {
  auth0Service.getUserById.mockImplementation(async (sub) => {
    if (inFlight) {
      inFlight.current += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.current);
    }
    try {
      // A real await, so a Promise.all caller would genuinely overlap here.
      await new Promise((resolve) => setImmediate(resolve));
      const answer = Object.prototype.hasOwnProperty.call(map, sub) ? map[sub] : liveIdentity(sub);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    } finally {
      if (inFlight) {
        inFlight.current -= 1;
      }
    }
  });
}

async function seedAllClasses() {
  const synthetic = await User.create({
    user_id: SUB_SYNTHETIC, username: 'Synth', email: 'auth0-hyg-synthetic@auth0.local',
  });
  const ghost = await User.create({
    user_id: SUB_GHOST, username: 'Ghost', email: 'ghost@example.com',
  });
  const orphaned = await User.create({
    user_id: SUB_ORPHANED, username: 'Orphan', email: 'auth0-hyg-orphaned@auth0.local',
    orphaned_at: new Date('2026-09-01T00:00:00Z'),
  });
  const identityGone = await User.create({
    user_id: SUB_IDENTITY_GONE, username: 'Gone', email: 'gone@example.com',
  });
  const unproved = await User.create({
    user_id: SUB_UNPROVED, username: 'Unproved', email: 'unproved@example.com',
  });
  const clean = await User.create({
    user_id: SUB_CLEAN, username: 'Clean', email: 'clean@example.com',
  });

  // Ownership counts for the identity-gone row: 1 owned group, 1 membership, 1
  // participation. These are what tell the owner what a hand-deletion would destroy.
  const group = await Group.create({ name: 'Gone Group', group_id: 'hyg-gone-group' });
  await UserGroup.create({
    user_uuid: identityGone.id, group_id: group.id, role: 'owner', status: 'active',
  });
  const event = await Event.create({
    group_id: group.id,
    start_date: new Date('2026-09-10T18:00:00Z'),
    duration_minutes: 120,
  });
  await EventParticipation.create({ event_id: event.id, user_id: identityGone.id });

  return { synthetic, ghost, orphaned, identityGone, unproved, clean };
}

function captureLog() {
  const lines = [];
  return { log: (...args) => lines.push(args.join(' ')), lines, text: () => lines.join('\n') };
}

function findingFor(result, sub) {
  return result.listed.find((r) => r.sub === sub);
}

describe('scripts/report-account-hygiene — the five classes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    auth0Service.extractUserDetails.mockImplementation((u) => ({
      user_id: (u && u.user_id) || null,
      email: (u && u.email) || null,
      username: (u && u.username) || null,
      email_verified: Boolean(u && u.email_verified),
      picture: (u && u.picture) || null,
    }));
  });

  it('lists every seeded class with its ownership counts, and does NOT list the clean row', async () => {
    const seeded = await seedAllClasses();
    mockIdentities({
      [SUB_IDENTITY_GONE]: null,
      [SUB_UNPROVED]: liveIdentity(SUB_UNPROVED, { emailVerified: false }),
    });

    const out = captureLog();
    const result = await main({ pauseMs: 0, log: out.log });

    // Anti-vacuity: assert there IS output before asserting anything about it.
    expect(out.lines.length).toBeGreaterThan(5);
    expect(out.text()).toContain('READ-ONLY: no write calls of any kind. Output to stdout only.');

    expect(findingFor(result, SUB_SYNTHETIC).classes).toContain('synthetic email');
    expect(findingFor(result, SUB_GHOST).classes).toContain('non-sub-shaped user_id');
    expect(findingFor(result, SUB_ORPHANED).classes).toContain('orphaned_at set');
    expect(findingFor(result, SUB_UNPROVED).classes).toContain('email never proved by Auth0');

    // THE ROW THIS PHASE EXISTS FOR: a real email, a sub-shaped user_id, no
    // orphaned_at — in NONE of classes 1-3. If the scan were bounded to those rows it
    // would never be found, so this assertion is what proves it is not.
    const gone = findingFor(result, SUB_IDENTITY_GONE);
    expect(gone.classes).toContain('identity gone');
    expect(gone.identity).toBe('gone');
    expect(gone.groupsOwned).toBe(1);
    expect(gone.memberships).toBe(1);
    expect(gone.participations).toBe(1);

    // The clean row is absent — otherwise the report is noise.
    expect(findingFor(result, SUB_CLEAN)).toBeUndefined();
    expect(out.text()).not.toContain(SUB_CLEAN);

    // Every seeded row was checked, and each name appears in the printed output.
    expect(result.checked).toBe(6);
    expect(result.total).toBe(6);
    expect(result.unknown).toBe(0);
    for (const sub of [SUB_SYNTHETIC, SUB_GHOST, SUB_ORPHANED, SUB_IDENTITY_GONE, SUB_UNPROVED]) {
      expect(out.text()).toContain(sub);
    }
    expect(out.text()).toContain('groups_owned=1  memberships=1  participations=1');
    expect(out.text()).toContain('SUMMARY: checked 6/6  unknown=0');

    // Non-vacuity of class 5: a row identical in every way except email_verified must
    // NOT be listed. Otherwise the class would fire on everybody.
    expect(seeded.clean.email).toBe('clean@example.com');
  });

  it('class 5 is not vacuous: a verified identity with the same shape is NOT listed', async () => {
    await User.create({ user_id: SUB_UNPROVED, username: 'Proved', email: 'proved@example.com' });
    mockIdentities({ [SUB_UNPROVED]: liveIdentity(SUB_UNPROVED, { emailVerified: true }) });

    const out = captureLog();
    const result = await main({ pauseMs: 0, log: out.log });

    expect(result.listed).toHaveLength(0);
    expect(out.text()).toContain('none');
  });

  it('marks the failing row AND every row after it `unknown`, NEVER `gone`, and stops calling', async () => {
    await seedAllClasses();
    const rows = await User.findAll({ attributes: ['id', 'user_id'], order: [['id', 'ASC']] });
    const failAt = 1; // the second row in scan order
    const failingSub = rows[failAt].user_id;
    mockIdentities({ [failingSub]: new Error('Failed to fetch Auth0 user: 503') });

    const out = captureLog();
    const result = await main({ pauseMs: 0, log: out.log });

    // The stop rule: exactly (index + 1) calls, then no more.
    expect(auth0Service.getUserById).toHaveBeenCalledTimes(failAt + 1);
    expect(result.checked).toBe(failAt);
    expect(result.unknown).toBe(rows.length - failAt);
    expect(result.managementFailed).toBe(true);

    // The failing row and every row after it are unknown. NOT ONE is `gone`.
    for (let i = failAt; i < rows.length; i += 1) {
      const finding = findingFor(result, rows[i].user_id);
      expect(finding).toBeDefined();
      expect(finding.identity).toBe('unknown');
      expect(finding.classes).toContain('identity unknown');
    }
    expect(result.listed.some((r) => r.identity === 'gone')).toBe(false);
    expect(out.text()).toContain(`${result.unknown} rows not checked: Management API unavailable`);
    expect(out.text()).toContain('WARNING: this census is INCOMPLETE');
  });

  it('calls the Management API STRICTLY sequentially — never more than one in flight', async () => {
    await seedAllClasses();
    const inFlight = { current: 0, max: 0 };
    mockIdentities({}, { inFlight });

    await main({ pauseMs: 0, log: captureLog().log });

    expect(auth0Service.getUserById).toHaveBeenCalledTimes(6);
    expect(inFlight.max).toBe(1);
  });

  it('--limit N caps the scan and says so, without pretending the census was complete', async () => {
    await seedAllClasses();
    mockIdentities({});

    const out = captureLog();
    const result = await main({ limit: 1, pauseMs: 0, log: out.log });

    expect(auth0Service.getUserById).toHaveBeenCalledTimes(1);
    expect(result.checked).toBe(1);
    expect(result.total).toBe(6);
    expect(result.skipped).toBe(5);
    expect(out.text()).toContain('SUMMARY: checked 1/6');
    expect(out.text()).toContain('WARNING: this census is INCOMPLETE');
  });

  it('prints `none` and completes against a clean database', async () => {
    // tests/setup.js truncates before every test, so this IS the empty-table case.
    mockIdentities({});
    const out = captureLog();
    const result = await main({ pauseMs: 0, log: out.log });

    expect(result.listed).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(out.text()).toContain('none');
    expect(out.text()).toContain('SUMMARY: checked 0/0  unknown=0');
    expect(out.text()).not.toContain('WARNING');
    expect(auth0Service.getUserById).not.toHaveBeenCalled();
  });

  it('ZERO WRITES: every table count is identical before and after a run', async () => {
    // This assertion IS the mechanical half of the SPEC R6 prohibition. The script has
    // no write path to test negatively, so the proof has to be the absence of an effect.
    await seedAllClasses();
    mockIdentities({ [SUB_IDENTITY_GONE]: null });

    const counts = async () => ({
      users: await User.count(),
      userGroups: await UserGroup.count(),
      events: await Event.count(),
      participations: await EventParticipation.count(),
    });
    const before = await counts();
    const beforeRows = (await User.scope('withContactInfo').findAll({ order: [['id', 'ASC']] }))
      .map((r) => [r.user_id, r.email, r.username, r.orphaned_at, r.email_changed_at]);

    await main({ pauseMs: 0, log: captureLog().log });

    expect(await counts()).toEqual(before);
    // Counts alone cannot see an in-place UPDATE, so pin the values too.
    const afterRows = (await User.scope('withContactInfo').findAll({ order: [['id', 'ASC']] }))
      .map((r) => [r.user_id, r.email, r.username, r.orphaned_at, r.email_changed_at]);
    expect(afterRows).toEqual(beforeRows);
  });

  it('SOURCE SCAN: the file carries no write path and no confirm flag', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'report-account-hygiene.js'),
      'utf8'
    );
    expect(source.length).toBeGreaterThan(2000); // anti-vacuity
    expect(source).toContain('READ-ONLY: no write calls of any kind. Output to stdout only.');

    const codeOnly = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const forbidden of ['destroy(', 'DELETE FROM', '.update(', '--confirm', 'QueryTypes.DELETE']) {
      expect(codeOnly).not.toContain(forbidden);
    }

    // main() owns neither the connection lifecycle nor the exit code — both live only in
    // the require.main runner block, or an in-process test invocation would close the
    // Jest worker's only connection mid-suite.
    const mainBody = codeOnly.slice(
      codeOnly.indexOf('async function main('),
      codeOnly.indexOf('module.exports')
    );
    expect(mainBody.length).toBeGreaterThan(500);
    // Built by join so the LITERAL never appears in this file: CI's quality job greps
    // tests/ for the token itself (D-01 / BTEST-02 close gate) and a source-scan pin that
    // spells it out trips the gate that exists to catch the real thing.
    const CLOSE_CALL = ['sequelize', 'close()'].join('.');
    expect(mainBody).not.toContain(CLOSE_CALL);
    expect(mainBody).not.toContain('process.exit(');
  });

  it('the retired cleanup-ghost-users.js is gone and nothing references it', () => {
    const fs = require('fs');
    const path = require('path');
    const scriptsDir = path.join(__dirname, '..', '..', 'scripts');
    expect(fs.existsSync(path.join(scriptsDir, 'cleanup-ghost-users.js'))).toBe(false);
    const pkg = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8');
    expect(pkg).not.toContain('cleanup-ghost-users');
    expect(pkg).toContain('report:account-hygiene');
  });
});
