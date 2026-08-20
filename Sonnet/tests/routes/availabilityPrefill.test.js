// tests/routes/availabilityPrefill.test.js
// Integration tests for POST /api/availability-prefill/gcal (CHKIN-05).
// Magic-token-authenticated; uses { consume: false }.

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

if (!process.env.MAGIC_TOKEN_SECRET) {
  process.env.MAGIC_TOKEN_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';
}

const request = require('supertest');
const express = require('express');

// Stub googleCalendarService BEFORE the route requires it so we control the
// freebusy output without hitting the network.
jest.mock('../../services/googleCalendarService', () => ({
  getBusyTimesForDateRange: jest.fn(),
}));

const googleCalendarService = require('../../services/googleCalendarService');
const availabilityPrefillRoutes = require('../../routes/availabilityPrefill');
const {
  User,
  Group,
  AvailabilityPrompt,
  MagicToken,
  TokenAnalytics,
  UserAvailability,
  sequelize,
} = require('../../models');
const { generateToken } = require('../../services/magicTokenService');
// Phase 87.5 Plan 02 — self-CRUD wire + sub-shaped-self-param proofs live here too.
const { stubAuth } = require('../helpers/authStub');
const availabilityRoutes = require('../../routes/availability');
const { makeUser } = require('../factories');

const app = express();
app.use(express.json());
app.use('/api/availability-prefill', availabilityPrefillRoutes);

describe('POST /api/availability-prefill/gcal', () => {
  let connectedUser;
  let disconnectedUser;
  let testGroup;
  let testPrompt;
  let connectedToken;

  // Schema built once by tests/globalSetup.js; the global beforeEach TRUNCATEs
  // all tables before each test. These /gcal fixtures MUST be re-seeded in this
  // describe-local beforeEach (NOT beforeAll) or they are wiped before the 2nd
  // test of this block (round-3 MEDIUM-3). The sync({force}) is gone — globalSetup
  // owns the schema build.
  beforeEach(async () => {
    googleCalendarService.getBusyTimesForDateRange.mockReset();
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([]);

    connectedUser = await User.create({
      user_id: 'auth0|prefill-connected',
      username: 'GCal Connected',
      email: 'gcal-connected@test.com',
      google_calendar_enabled: true,
      google_calendar_token: 'fake-access-token',
      google_calendar_refresh_token: 'fake-refresh-token',
    });

    disconnectedUser = await User.create({
      user_id: 'auth0|prefill-disconnected',
      username: 'GCal Disconnected',
      email: 'gcal-disconnected@test.com',
      google_calendar_enabled: false,
      google_calendar_token: null,
    });

    testGroup = await Group.create({
      name: 'Prefill Test Group',
      group_id: 'prefill-group-001',
    });

    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W21-prefill',
    });

    connectedToken = await generateToken(connectedUser, testPrompt);
  });

  // ------------------------------------------------------------------
  // Input validation
  // ------------------------------------------------------------------

  it('returns 400 when magic_token is missing', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({ start_date: '2026-05-18', num_days: 7, timezone: 'America/Los_Angeles' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/magic_token/);
  });

  it('returns 400 when start_date format is invalid', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '05/18/2026',
        num_days: 7,
        timezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });

  it('returns 400 when num_days > 14', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 30,
        timezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/num_days/);
  });

  it('returns 400 when num_days < 1', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 0,
        timezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/num_days/);
  });

  it('returns 400 when timezone is invalid', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 7,
        timezone: 'Not/A_Real_Timezone',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timezone/);
  });

  // ------------------------------------------------------------------
  // GCal-not-connected branch
  // ------------------------------------------------------------------

  it('returns 400 when the magic-token user has GCal disconnected', async () => {
    const disconnectedJwt = await generateToken(disconnectedUser, testPrompt);
    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: disconnectedJwt,
        start_date: '2026-05-18',
        num_days: 7,
        timezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Google Calendar is not connected/);
  });

  // ------------------------------------------------------------------
  // Happy path + slot-ID shape
  // ------------------------------------------------------------------

  it('returns slot_ids as ISO UTC strings matching grid generateSlotId format', async () => {
    // No busy slots — every generated slot is free.
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 7,
        timezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.slot_ids)).toBe(true);
    expect(res.body.count).toBe(res.body.slot_ids.length);
    expect(res.body.count).toBeGreaterThan(0);

    // Every slot ID must be an ISO 8601 UTC string with the .000Z suffix
    // (matches AvailabilityGrid.generateSlotId output).
    for (const id of res.body.slot_ids) {
      expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    }
  });

  it('excludes slots whose UTC date+startTime is in the busy set (conservative overlap)', async () => {
    // Phase 88-34 WI-B3 (M6): this fixture used to mark 2026-05-18T02:00Z busy.
    // That instant is local 2026-05-17 19:00 PDT — the day BEFORE the window's
    // first local day — so under the old UTC-midnight bounds it was inside the
    // window only because of the bug M6 fixed (the rollover sliver). Moved to
    // 2026-05-19T02:00Z = local Mon 2026-05-18 19:00 PDT, genuinely inside the
    // window. The assertion (busy slot excluded, adjacent slot free) is
    // unchanged — only the instants were re-anchored to the real local grid.
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([
      { date: '2026-05-19', startTime: '02:00', endTime: '02:30' },
    ]);

    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 7,
        timezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(200);
    expect(res.body.slot_ids).not.toContain('2026-05-19T02:00:00.000Z');
    expect(res.body.slot_ids).toContain('2026-05-19T02:30:00.000Z');
  });

  // ------------------------------------------------------------------
  // { consume: false } assertion (Pitfall 6)
  // ------------------------------------------------------------------

  it('passes { consume: false } when validating the magic token (source-level assertion)', () => {
    // Source-level assertion: the route file must import validateToken with
    // `{ consume: false }`. We can't reliably jest.spyOn the function reference
    // after the route has destructured it at require-time, so we assert the
    // source string directly — this is the cheapest, most stable signal that
    // Pitfall 6 is mitigated.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'availabilityPrefill.js'),
      'utf8'
    );
    expect(source).toMatch(/validateToken\s*\([^)]*\{\s*consume:\s*false\s*\}\s*\)/);
  });

  it('can be called twice in a row without invalidating the token (consume:false in action)', async () => {
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([]);

    const first = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 7,
        timezone: 'America/Los_Angeles',
      });
    const second = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 7,
        timezone: 'America/Los_Angeles',
      });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  // ------------------------------------------------------------------
  // Empty / all-busy case
  // ------------------------------------------------------------------

  it('returns an empty array (count: 0) when every slot is busy', async () => {
    // Use generateTimeSlots to derive what the endpoint will see, then mark
    // every slot as busy.
    // Phase 88-34 WI-B3 (M6): these bounds must MIRROR what the endpoint now
    // computes — one LOCAL day in America/Los_Angeles, i.e. 07:00Z to 07:00Z
    // during PDT — not the old UTC-midnight pair. Deriving from a stale window
    // marks the wrong slots busy and leaves real free slots in the response.
    const availabilityService = require('../../services/availabilityService');
    const startDate = new Date('2026-05-18T07:00:00.000Z'); // 00:00 PDT 2026-05-18
    const endDate = new Date('2026-05-19T07:00:00.000Z');   // 00:00 PDT 2026-05-19 (1 local day)
    const allSlots = availabilityService.generateTimeSlots(startDate, endDate, 'America/Los_Angeles');
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue(
      allSlots.map(s => ({ date: s.date, startTime: s.startTime, endTime: s.endTime }))
    );

    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({
        magic_token: connectedToken,
        start_date: '2026-05-18',
        num_days: 1,
        timezone: 'America/Los_Angeles',
      });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.slot_ids).toEqual([]);
  });
});

// =====================================================================
// CHKIN-06 — saved-availability pre-fill
// =====================================================================
describe('POST /api/availability-prefill/saved', () => {
  // We use America/Los_Angeles so the pattern matcher takes the explicit
  // slotToLocal branch (deterministic) instead of the server-local
  // getDay() fallback (host-TZ-dependent).
  const TZ = 'America/Los_Angeles';
  // Phase 88-34 WI-B3 (M6): start_date is a LOCAL calendar date. The window is
  // local Mon 2026-05-18 .. Sun 2026-05-24 (was documented here as Sun 05-17 ..
  // Sat 05-23, which described the pre-M6 UTC-midnight window, not the grid).
  const WEEK_START = '2026-05-18';

  let recurringUser;       // has a Mon-19:00-22:00 recurring pattern
  let overrideUser;        // has the same pattern + a Mon override that subtracts 20:00-21:00
  let emptyUser;           // ZERO saved data — Pitfall 3 guard target
  let testGroup;
  let testPrompt;
  let recurringToken;
  let overrideToken;
  let emptyToken;

  // Schema built once by tests/globalSetup.js; the global beforeEach TRUNCATEs
  // all tables, so the /saved fixtures must be re-seeded per-test (beforeEach),
  // not beforeAll (round-3 MEDIUM-3).
  beforeEach(async () => {
    await TokenAnalytics.destroy({ where: {} });

    recurringUser = await User.create({
      user_id: 'auth0|prefill-saved-recurring',
      username: 'Saved Recurring',
      email: 'saved-recurring@test.com',
      google_calendar_enabled: false,
      google_calendar_token: null,
      timezone: TZ,
    });

    overrideUser = await User.create({
      user_id: 'auth0|prefill-saved-override',
      username: 'Saved Override',
      email: 'saved-override@test.com',
      google_calendar_enabled: false,
      google_calendar_token: null,
      timezone: TZ,
    });

    emptyUser = await User.create({
      user_id: 'auth0|prefill-saved-empty',
      username: 'Saved Empty',
      email: 'saved-empty@test.com',
      google_calendar_enabled: false,
      google_calendar_token: null,
      timezone: TZ,
    });

    testGroup = await Group.create({
      name: 'Prefill Saved Test Group',
      group_id: 'prefill-saved-group-001',
    });

    testPrompt = await AvailabilityPrompt.create({
      group_id: testGroup.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W21-saved-prefill',
    });

    // Recurring user: Monday 19:00-22:00 LA local → 3 hours × 2 slots/hr = 6 slots
    // Local Mon 19:00 PDT == UTC Tue 02:00. So the expected slot IDs are
    // 2026-05-19T02:00, 02:30, 03:00, 03:30, 04:00, 04:30 (UTC).
    await UserAvailability.create({
      user_uuid: recurringUser.id, // Phase 87.5: table rekeyed to user_uuid (Users.id)
      type: 'recurring_pattern',
      pattern_data: { dayOfWeek: 1, startTime: '19:00', endTime: '22:00', timezone: TZ },
      start_date: '2026-05-01',
      end_date: null,
      is_available: null,
      timezone: TZ,
    });

    // Override user: same recurring pattern PLUS an override that marks
    // Mon 2026-05-18 local 20:00-21:00 as NOT available. The expected
    // override-beats-recurring result is the recurring 6 slots MINUS
    // 20:00 and 20:30 local = 4 slots.
    await UserAvailability.create({
      user_uuid: overrideUser.id, // Phase 87.5: table rekeyed to user_uuid (Users.id)
      type: 'recurring_pattern',
      pattern_data: { dayOfWeek: 1, startTime: '19:00', endTime: '22:00', timezone: TZ },
      start_date: '2026-05-01',
      end_date: null,
      is_available: null,
      timezone: TZ,
    });
    await UserAvailability.create({
      user_uuid: overrideUser.id, // Phase 87.5: table rekeyed to user_uuid (Users.id)
      type: 'specific_override',
      pattern_data: { date: '2026-05-18', startTime: '20:00', endTime: '21:00', isAvailable: false },
      start_date: '2026-05-18',
      end_date: '2026-05-18',
      is_available: false,
      timezone: TZ,
    });

    recurringToken = await generateToken(recurringUser, testPrompt);
    overrideToken = await generateToken(overrideUser, testPrompt);
    emptyToken = await generateToken(emptyUser, testPrompt);
  });

  // ------------------------------------------------------------------
  // Input validation (mirrors /gcal)
  // ------------------------------------------------------------------

  it('returns 400 when magic_token is missing', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({ start_date: WEEK_START, num_days: 7, timezone: TZ });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/magic_token/);
  });

  it('returns 400 when start_date format is invalid', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: recurringToken,
        start_date: '05/18/2026',
        num_days: 7,
        timezone: TZ,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/YYYY-MM-DD/);
  });

  it('returns 400 when num_days > 14', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: recurringToken,
        start_date: WEEK_START,
        num_days: 30,
        timezone: TZ,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/num_days/);
  });

  it('returns 400 when num_days < 1', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: recurringToken,
        start_date: WEEK_START,
        num_days: 0,
        timezone: TZ,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/num_days/);
  });

  it('returns 400 when timezone is invalid', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: recurringToken,
        start_date: WEEK_START,
        num_days: 7,
        timezone: 'Not/A_Real_Timezone',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/timezone/);
  });

  // ------------------------------------------------------------------
  // Happy path — recurring pattern
  // ------------------------------------------------------------------

  it('returns slot_ids for a user with a recurring Monday pattern', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: recurringToken,
        start_date: WEEK_START,
        num_days: 7,
        timezone: TZ,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.slot_ids)).toBe(true);
    expect(res.body.count).toBe(res.body.slot_ids.length);

    // 3 hours × 2 30-min slots = 6 slots on Mon 19:00-22:00 LA local
    // Mon 19:00 PDT = UTC Tue 02:00 → expect six consecutive UTC slots.
    expect(res.body.count).toBe(6);
    expect(res.body.slot_ids).toEqual(
      expect.arrayContaining([
        '2026-05-19T02:00:00.000Z',
        '2026-05-19T02:30:00.000Z',
        '2026-05-19T03:00:00.000Z',
        '2026-05-19T03:30:00.000Z',
        '2026-05-19T04:00:00.000Z',
        '2026-05-19T04:30:00.000Z',
      ])
    );

    // All IDs match the grid's generateSlotId format
    for (const id of res.body.slot_ids) {
      expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    }
  });

  // ------------------------------------------------------------------
  // Override-beats-recurring (research Pattern 2 / CONTEXT D-CHKIN-06)
  // ------------------------------------------------------------------

  it('subtracts a specific override that flips a recurring slot to unavailable', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: overrideToken,
        start_date: WEEK_START,
        num_days: 7,
        timezone: TZ,
      });

    expect(res.status).toBe(200);
    // 6 recurring slots minus 20:00 and 20:30 LA local = 4 slots
    // 20:00 LA Mon = 03:00 UTC Tue, 20:30 LA = 03:30 UTC Tue
    expect(res.body.count).toBe(4);
    expect(res.body.slot_ids).toEqual(
      expect.arrayContaining([
        '2026-05-19T02:00:00.000Z',
        '2026-05-19T02:30:00.000Z',
        '2026-05-19T04:00:00.000Z',
        '2026-05-19T04:30:00.000Z',
      ])
    );
    // The override-subtracted slots must NOT be present
    expect(res.body.slot_ids).not.toContain('2026-05-19T03:00:00.000Z');
    expect(res.body.slot_ids).not.toContain('2026-05-19T03:30:00.000Z');
  });

  // ------------------------------------------------------------------
  // Pitfall 3 guard — zero-pattern user must NOT paint the whole grid
  // ------------------------------------------------------------------

  it('returns empty slot_ids for a user with ZERO saved patterns (Pitfall 3 guard)', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: emptyToken,
        start_date: WEEK_START,
        num_days: 7,
        timezone: TZ,
      });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.slot_ids).toEqual([]);
  });

  // ------------------------------------------------------------------
  // { consume: false } assertion (Pitfall 6)
  // ------------------------------------------------------------------

  it('passes { consume: false } when validating the magic token (source-level assertion)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'routes', 'availabilityPrefill.js'),
      'utf8'
    );
    // Two occurrences expected: /gcal handler (plan 02) + /saved handler (plan 03)
    const matches = source.match(/validateToken\s*\([^)]*\{\s*consume:\s*false\s*\}\s*\)/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('can be called twice in a row without invalidating the token (consume:false in action)', async () => {
    const first = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: recurringToken,
        start_date: WEEK_START,
        num_days: 7,
        timezone: TZ,
      });
    const second = await request(app)
      .post('/api/availability-prefill/saved')
      .send({
        magic_token: recurringToken,
        start_date: WEEK_START,
        num_days: 7,
        timezone: TZ,
      });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.count).toBe(first.body.count);
  });
});

// =====================================================================
// Phase 87.5 Plan 02 (BINT-02) — routes/availability.js self-CRUD wire + rollout-window proofs.
//
// After the UserAvailability rekey (user_uuid FK) and the deletion of the 87.4
// emission-translation helpers, two behaviors must be proven BEHAVIORALLY (not
// just by symbol-absence greps):
//
//   T-875-02-WIRE: the create-response and GET /patterns rows must still emit a
//   `user_id` field (the FE availability schema only optionally reads it, so a
//   silently-omitted key would still parse and ship undetected) whose VALUE is
//   the caller's Users.id UUID — proving the wire contract did not narrow when
//   the emit helpers were deleted.
//
//   T-875-02-SELF: the create + findAll caller-UUID resolution must work when
//   the self-param arrives SUB-shaped (the shape 100% of production traffic sends
//   during the D-02 rollout window, before the FE PR switches to UUID-shaped
//   self-params). objectAuth.matchesSelf only memoizes req.selfUuid on its
//   UUID-shaped arm; a regression to `req.selfUuid`-only resolution would 404/500
//   every sub-shaped caller in prod. Driving a sub-shaped param here catches that.
// =====================================================================
describe('routes/availability.js self-CRUD — UUID wire + sub-shaped rollout window (87.5-02)', () => {
  function makeApp(actor) {
    const a = express();
    a.use(express.json());
    a.use(stubAuth(actor ? { user_id: actor.user_id } : undefined));
    a.use('/api/availability', availabilityRoutes);
    return a;
  }

  const recurringBody = {
    dayOfWeek: 2,
    startTime: '19:00',
    endTime: '21:00',
    start_date: '2026-06-01',
    timezone: 'UTC',
  };

  // The global beforeEach in tests/setup.js TRUNCATEs all tables, so seed fresh here.
  let user;
  beforeEach(async () => {
    user = await makeUser();
  });

  it('T-875-02-WIRE: create-response and GET /patterns emit user_id === caller Users.id UUID', async () => {
    const appMe = makeApp(user);

    // Create a recurring pattern. Self-param is the caller's own sub (frozen-FE shape).
    const createRes = await request(appMe)
      .post(`/api/availability/user/${encodeURIComponent(user.user_id)}/recurring`)
      .send(recurringBody);

    expect(createRes.status).toBe(201);
    // The wire field NAME is unchanged (`user_id`) and its VALUE is the caller's UUID.
    expect(createRes.body).toHaveProperty('user_id');
    expect(createRes.body.user_id).toBe(user.id);
    // UUID, never the Auth0 sub.
    expect(createRes.body.user_id).not.toBe(user.user_id);
    expect(String(createRes.body.user_id)).not.toContain('|');
    // Wire shape stays identical to pre-rekey — the internal user_uuid key is not leaked.
    expect(createRes.body).not.toHaveProperty('user_uuid');

    // GET /patterns must emit the same user_id UUID on every row.
    const listRes = await request(appMe)
      .get(`/api/availability/user/${encodeURIComponent(user.user_id)}/patterns`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThan(0);
    for (const row of listRes.body) {
      expect(row).toHaveProperty('user_id');
      expect(row.user_id).toBe(user.id);
      expect(row).not.toHaveProperty('user_uuid');
    }
  });

  it('T-875-02-SELF: create + GET /patterns resolve the caller UUID from a SUB-shaped self-param (rollout window)', async () => {
    const appMe = makeApp(user);

    // Sub-shaped self-param — matchesSelf takes its sub arm and never memoizes
    // req.selfUuid, so a req.selfUuid-only resolver would fail here.
    const createRes = await request(appMe)
      .post(`/api/availability/user/${encodeURIComponent(user.user_id)}/override`)
      .send({ date: '2026-06-02', startTime: '18:00', endTime: '20:00', isAvailable: true });

    expect(createRes.status).toBe(201);
    expect(createRes.body.user_id).toBe(user.id);

    // The write actually landed on user_uuid = caller's Users.id (not a null key).
    const persisted = await UserAvailability.findOne({ where: { user_uuid: user.id } });
    expect(persisted).not.toBeNull();
    expect(persisted.user_uuid).toBe(user.id);

    // GET /patterns (sub-shaped self-param) resolves the caller UUID and returns the row.
    const listRes = await request(appMe)
      .get(`/api/availability/user/${encodeURIComponent(user.user_id)}/patterns`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);
    expect(listRes.body[0].user_id).toBe(user.id);
  });
});

// NOTE: no sequelize.close() here — the connection lifecycle is owned solely by
// tests/globalTeardown.js (BTEST-02). Closing mid-run kills the shared
// connection for every later serial suite.

// ---------------------------------------------------------------------------
// Phase 88-34 Task 3 (WI-B3) — walk MAJOR M6: the prefill window is the LOCAL
// day grid the user actually sees, not a UTC-midnight window laid over it.
//
// Old bounds: [start_date T00:00Z, +N UTC days). In PDT (UTC-7) the last local
// day's 17:00 is already 00:00Z on the day AFTER the end bound, so the whole
// last evening was silently dropped — and a sliver of the day BEFORE day 1 was
// silently included.
//
// Fork C (owner-ruled 2026-08-20): NO ±1 widening. AvailabilityForm submits
// every returned slot id verbatim, so out-of-window slots would be PERSISTED as
// phantom availability. The anti-phantom guard below pins that.
// ---------------------------------------------------------------------------
describe('Phase 88-34 WI-B3 — prefill window from local-day bounds (M6, fork C)', () => {
  const TZ = 'America/Los_Angeles';
  const WEEK_START = '2026-05-18';          // local Mon; window is local Mon 05-18 .. Sun 05-24
  const LOCAL_START_UTC = '2026-05-18T07:00:00.000Z'; // 00:00 PDT on day 1
  const LOCAL_END_UTC = '2026-05-25T07:00:00.000Z';   // 00:00 PDT on the day AFTER day 7

  let lastDayUser;   // Sunday 17:00-22:00 pattern — the clipped evening
  let group;
  let prompt;
  let lastDayToken;

  beforeEach(async () => {
    googleCalendarService.getBusyTimesForDateRange.mockReset();
    googleCalendarService.getBusyTimesForDateRange.mockResolvedValue([]);

    lastDayUser = await User.create({
      user_id: 'auth0|prefill-m6-lastday',
      username: 'M6 Last Day',
      email: 'm6-lastday@test.com',
      google_calendar_enabled: false,
      google_calendar_token: null,
      timezone: TZ,
    });

    group = await Group.create({ name: 'M6 Group', group_id: 'prefill-m6-group' });
    prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: '2026-W21-m6',
    });

    // Sunday (dayOfWeek 0) 17:00-22:00 LA local. 2026-05-24 is the window's
    // LAST local day. Local 17:00 PDT == 2026-05-25T00:00Z — i.e. exactly the
    // OLD end bound, so all ten of these slots used to fall outside the window.
    await UserAvailability.create({
      user_uuid: lastDayUser.id,
      type: 'recurring_pattern',
      pattern_data: { dayOfWeek: 0, startTime: '17:00', endTime: '22:00', timezone: TZ },
      start_date: '2026-05-01',
      end_date: null,
      is_available: null,
      timezone: TZ,
    });

    lastDayToken = await generateToken(lastDayUser, prompt);
  });

  it('(M6 regression) the last local day\'s EVENING is in the saved-prefill response', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({ magic_token: lastDayToken, start_date: WEEK_START, num_days: 7, timezone: TZ })
      .expect(200);

    // 17:00-22:00 local = 10 half-hour slots, all of them on 2026-05-25 in UTC.
    expect(res.body.count).toBe(10);
    expect(res.body.slot_ids).toContain('2026-05-25T00:00:00.000Z'); // 17:00 PDT — the first clipped slot
    expect(res.body.slot_ids).toContain('2026-05-25T04:30:00.000Z'); // 21:30 PDT — the last one
  });

  it('(anti-phantom guard, fork C) NO returned instant falls outside the requested local window', async () => {
    const res = await request(app)
      .post('/api/availability-prefill/saved')
      .send({ magic_token: lastDayToken, start_date: WEEK_START, num_days: 7, timezone: TZ })
      .expect(200);

    const startMs = Date.parse(LOCAL_START_UTC);
    const endMs = Date.parse(LOCAL_END_UTC);
    expect(res.body.slot_ids.length).toBeGreaterThan(0);
    for (const id of res.body.slot_ids) {
      const ms = Date.parse(id);
      expect(ms).toBeGreaterThanOrEqual(startMs);
      expect(ms).toBeLessThan(endMs);
    }
  });

  it('(anti-phantom guard) the /gcal endpoint spans EXACTLY the local window, no rollover sliver', async () => {
    const gcalUser = await User.create({
      user_id: 'auth0|prefill-m6-gcal',
      username: 'M6 GCal',
      email: 'm6-gcal@test.com',
      google_calendar_enabled: true,
      google_calendar_token: 'fake-access-token',
      timezone: TZ,
    });
    const gcalToken = await generateToken(gcalUser, prompt);

    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({ magic_token: gcalToken, start_date: WEEK_START, num_days: 7, timezone: TZ })
      .expect(200);

    // Zero busy events => every slot in the window is free: 7 local days x 48.
    expect(res.body.count).toBe(7 * 48);
    const sorted = [...res.body.slot_ids].sort();
    expect(sorted[0]).toBe(LOCAL_START_UTC);
    // Last slot starts 30 minutes before the end bound (half-open window).
    expect(sorted[sorted.length - 1]).toBe('2026-05-25T06:30:00.000Z');
    // The old UTC-midnight anchor pulled in local Sunday 05-17 17:00 onward.
    expect(res.body.slot_ids).not.toContain('2026-05-18T00:00:00.000Z');
  });

  // The window bound is measured with Intl AT the instant, so a DST transition
  // inside the window shortens/lengthens it correctly. 2026-03-08 is US
  // spring-forward: the 7-day window is 167 hours, not 168.
  it('(DST) a window spanning spring-forward is 167 local hours, with PST and PDT bounds', async () => {
    const dstUser = await User.create({
      user_id: 'auth0|prefill-m6-dst',
      username: 'M6 DST',
      email: 'm6-dst@test.com',
      google_calendar_enabled: true,
      google_calendar_token: 'fake-access-token',
      timezone: TZ,
    });
    const dstToken = await generateToken(dstUser, prompt);

    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({ magic_token: dstToken, start_date: '2026-03-06', num_days: 7, timezone: TZ })
      .expect(200);

    const sorted = [...res.body.slot_ids].sort();
    expect(sorted[0]).toBe('2026-03-06T08:00:00.000Z');        // 00:00 PST (UTC-8)
    expect(sorted[sorted.length - 1]).toBe('2026-03-13T06:30:00.000Z'); // end bound 07:00Z = 00:00 PDT (UTC-7)
    expect(res.body.count).toBe(167 * 2);
  });

  // Fixed-offset arithmetic silently breaks for zones whose offset is not a
  // whole number of hours. Asia/Kathmandu is +05:45.
  it('(sub-hour offset) Asia/Kathmandu bounds land at :15 past the hour, not on the hour', async () => {
    const kUser = await User.create({
      user_id: 'auth0|prefill-m6-ktm',
      username: 'M6 Kathmandu',
      email: 'm6-ktm@test.com',
      google_calendar_enabled: true,
      google_calendar_token: 'fake-access-token',
      timezone: 'Asia/Kathmandu',
    });
    const kToken = await generateToken(kUser, prompt);

    const res = await request(app)
      .post('/api/availability-prefill/gcal')
      .send({ magic_token: kToken, start_date: WEEK_START, num_days: 7, timezone: 'Asia/Kathmandu' })
      .expect(200);

    // 00:00 local on 2026-05-18 == 2026-05-17T18:15Z. generateTimeSlots only
    // emits :00/:30 marks, so the first slot inside [18:15Z, ...) is 18:30Z.
    const sorted = [...res.body.slot_ids].sort();
    expect(sorted[0]).toBe('2026-05-17T18:30:00.000Z');
    expect(sorted[sorted.length - 1]).toBe('2026-05-24T18:00:00.000Z');
    for (const id of res.body.slot_ids) {
      expect(Date.parse(id)).toBeGreaterThanOrEqual(Date.parse('2026-05-17T18:15:00.000Z'));
      expect(Date.parse(id)).toBeLessThan(Date.parse('2026-05-24T18:15:00.000Z'));
    }
  });
});
