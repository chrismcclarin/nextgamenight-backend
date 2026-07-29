// tests/routes/groupSoftDelete.wire-sweep.test.js
//
// Phase 88.2 plan 04 Task 3 (SPEC-REQ-4d) — group soft-delete response sweep.
//
// CLAIM: no response body from the enumerated read surfaces contains a
// soft-deleted group's `id` at ANY nesting depth. The sweep RECURSES the JSON,
// so a nested include is in scope exactly like a flat field.
//
// ===========================================================================
// COVERAGE STATEMENT — auditable, not implied.
//
// SPEC-REQ-4 enumerates 15 files. NINE of them have an HTTP surface and are
// PROVEN HERE BY ASSERTION; the endpoint array below must cover all nine, and a
// reader can check that claim against the array without re-deriving it:
//
//   1. routes/events.js               -> GET /api/events/user/:user_id
//   2. routes/groups.js               -> GET /api/groups/user/:user_id
//                                        GET /api/groups/:group_id
//                                        GET /api/groups/:group_id/users
//                                        GET /api/groups/:group_id/library
//   3. routes/games.js                -> GET /api/games/:id
//   4. routes/lists.js                -> GET /api/lists/games/:group_id/:user_id
//   5. routes/gameReviews.js          -> GET /api/game-reviews/game/:game_id/group/:group_id
//   6. routes/invites.js              -> GET /api/invites/pending
//                                        GET /api/invites/info/:token
//                                        GET /api/invites/group/:group_id/pending
//   7. routes/availability.js         -> GET /api/availability/group/:group_id/heatmap
//   8. routes/availabilityPrompt.js   -> GET /api/groups/:groupId/prompts/active
//                                        GET /api/groups/:groupId/prompts/open
//                                        GET /api/prompts/:promptId/respondents
//   9. routes/groupPromptSettings.js  -> GET /api/groups/:group_id/prompt-settings
//
// The remaining SIX emit no response body and are COVERED BY OTHER MEANS:
//
//   10. services/availabilityService.js      - paranoid model layer (D-01)
//   11. services/authorizationService.js     - paranoid model layer; its
//                                              canReadEventScopedSurface does
//                                              Event.findByPk first and returns
//                                              {allowed:false} on null
//   12. services/promptLifecycleService.js   - paranoid model layer + its own
//                                              Group.findByPk null guard
//   13. services/suggestionService.js        - paranoid model layer
//   14. workers/promptWorker.js              - plan 04 Task 3's F-A3 guard, pinned
//                                              by tests/workers/promptWorker.softDelete.test.js
//   15. workers/reminderWorker.js            - its pre-existing group_not_found guard
//
// THIS SWEEP PROVES THE ENUMERATED SURFACES ONLY — never "the whole API". A grep
// finds includes written one way; it cannot find a leak written another way,
// which is exactly how routes/games.js (no `model: Group` at all, a real leak via
// an unfiltered GameReview include) escaped the original scan. A red here is a
// leak to fix at its owning site, never a row to delete.
// ===========================================================================
//
// EVERY ROW CARRIES A POSITIVE CONTROL. A sweep that returns nothing at all
// would pass vacuously, so each endpoint is exercised TWICE — once against the
// live group and once against the hidden one.
//
// Two control modes, and which one a row uses is a MEASURED fact about that
// handler, not a preference:
//
//   (a) ID-PRESENCE (the default) — the live run's body must CONTAIN the live
//       group's id. Used by the 10 endpoints that actually serialize it.
//
//   (b) GROUP-SCOPED WITNESS (`livePositive`) — six of these handlers return
//       group-scoped content WITHOUT ever echoing the group id (verified by
//       reading their live bodies: the roster, the library, the group's game
//       list, the group's pending invites, the heatmap's member counts, the
//       prompt's respondents). For those, the control is a predicate over
//       content that EXISTS ONLY BECAUSE THE GROUP IS LIVE.
//
//       This is NOT a weaker control, because it is applied TWICE: the live run
//       must SATISFY the predicate and the hidden run must FAIL it. So the row
//       still proves the group-scoped content appeared and then vanished — the
//       same two-sided property mode (a) gets from the id.
//
// If a row's live run goes vacuous, the row proves nothing and the SEED is
// wrong. Fix the seed, never the assertion.
//
// Real-DB (factories; schema built by tests/globalSetup.js; per-test TRUNCATE by
// tests/setup.js). This suite NEVER force-syncs the schema itself.
// Run ALONE (shared-Postgres suite):
//   npm test -- tests/routes/groupSoftDelete.wire-sweep.test.js

require('dotenv').config({ path: '.env.test' });
process.env.NODE_ENV = 'test';

// Routers that mount verifyAuth0Token per-route — stub it; the harness injects
// req.user below (mirrors wire-sweep.test.js).
jest.mock('../../middleware/auth0', () => ({
  verifyAuth0Token: (req, _res, next) => next(),
  optionalAuth: (req, _res, next) => next(),
}));

// users.js / groups.js reach for the Auth0 Management API on profile-fixup
// branches — never let a test hit the network.
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('not configured in tests')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

// The prompt-settings + availability-prompt routers reach for Redis-backed
// BullMQ and Resend. Stub them so requiring/exercising the routers never boots
// Redis or hits the network.
jest.mock('../../schedulers/promptScheduler', () => ({
  upsertSinglePromptScheduler: jest.fn().mockResolvedValue(),
  removePromptScheduler: jest.fn().mockResolvedValue(),
}));
jest.mock('../../services/reminderService', () => ({
  scheduleReminders: jest.fn().mockResolvedValue({ scheduled: false }),
  scheduleDeadlineJob: jest.fn().mockResolvedValue({ scheduled: false }),
}));
jest.mock('../../services/emailService', () => {
  const actual = jest.requireActual('../../services/emailService');
  actual.send = jest.fn().mockResolvedValue({ success: true });
  actual.isConfigured = jest.fn().mockReturnValue(true);
  return actual;
});

const request = require('supertest');
const express = require('express');

const eventsRoutes = require('../../routes/events');
const groupsRoutes = require('../../routes/groups');
const gamesRoutes = require('../../routes/games');
const listsRoutes = require('../../routes/lists');
const gameReviewsRoutes = require('../../routes/gameReviews');
const invitesRoutes = require('../../routes/invites');
const availabilityRoutes = require('../../routes/availability');
const availabilityPromptRoutes = require('../../routes/availabilityPrompt');
const groupPromptSettingsRoutes = require('../../routes/groupPromptSettings');

const {
  Event,
  EventParticipation,
  Game,
  Group,
  GroupInvite,
  UserGroup,
  AvailabilityPrompt,
  GroupPromptSettings,
  UserAvailability,
} = require('../../models');
const { makeUser, makeGroup, addToGroup, makeGameReview } = require('../factories');

// ---------------------------------------------------------------------------
// Recursive scanner: does this JSON contain `needle` at ANY depth, in a value
// OR a key? Keys are wire values too — a group-id-keyed map must red the sweep,
// not pass it.
// ---------------------------------------------------------------------------
function collectIdHits(node, needle, path = '$', hits = []) {
  if (typeof node === 'string') {
    if (node === needle || node.includes(needle)) hits.push(`${path} = ${node}`);
    return hits;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectIdHits(v, needle, `${path}[${i}]`, hits));
    return hits;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === needle || k.includes(needle)) hits.push(`${path}.<key> = ${k}`);
      collectIdHits(v, needle, `${path}.${k}`, hits);
    }
    return hits;
  }
  return hits;
}

// A body is "vacuous" if it proves nothing: an empty array, an empty object, or
// null. A positive control that lands on a vacuous body is a broken seed.
function isVacuous(body) {
  if (body === null || body === undefined) return true;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === 'object') return Object.keys(body).length === 0;
  return false;
}

// Harness: inject a verified req.user ahead of every router.
let currentActor = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentActor) req.user = { user_id: currentActor, email: currentActor.email };
  next();
});
// Prefixes taken from server.js's mount table, NOT from the router files.
app.use('/api/events', eventsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/groups', groupPromptSettingsRoutes); // server.js mounts this at /api/groups
app.use('/api/games', gamesRoutes);
app.use('/api/lists', listsRoutes);
app.use('/api/game-reviews', gameReviewsRoutes);
app.use('/api/invites', invitesRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api', availabilityPromptRoutes); // server.js mounts this at /api

describe('88.2 SPEC-REQ-4d — a soft-deleted group never reaches the wire', () => {
  let caller;
  let live;
  let dead;

  // ONE shared Game across both groups' reviews, so GET /api/games/:id exercises
  // Task 5's join with a LIVE and a HIDDEN review on the same parent row.
  // Re-created per test: tests/setup.js TRUNCATEs every table before each test, so
  // a handle held across tests points at a row that no longer exists (FK violation).
  let sharedGame = null;

  beforeEach(async () => {
    caller = await makeUser({ username: 'sd-sweep-caller' });
    sharedGame = await Game.create({ name: 'Sweep Shared Game', is_custom: true });
    live = await seedWorld('sweep-live', 'Sweep Live Group');
    dead = await seedWorld('sweep-dead', 'Sweep Doomed Group');
    currentActor = caller.user_id;
  });

  async function seedWorld(slug, name) {
    const group = await makeGroup({ group_id: `${slug}-${Date.now()}`, name });
    // The caller is an OWNER of both, so the owner/admin-gated rows
    // (invites/group/:id/pending, prompt-settings) are reachable.
    await addToGroup(caller, group, 'owner');

    const event = await Event.create({
      group_id: group.id,
      game_id: sharedGame.id,
      title: `${name} Night`,
      start_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'scheduled',
      created_by: caller.user_id,
    });
    await EventParticipation.create({ event_id: event.id, user_id: caller.id });

    await makeGameReview(caller, group, sharedGame, { rating: 4, review_text: `${slug}-review` });

    // A pending invite addressed to the CALLER's own email, so it lands in
    // GET /api/invites/pending, plus one for a stranger so
    // GET /api/invites/group/:group_id/pending is non-empty.
    const invite = await GroupInvite.create({
      group_id: group.id,
      invited_email: caller.email.toLowerCase(),
      invited_by_uuid: caller.id,
      token: `${slug}-invite-token`,
      status: 'pending',
    });
    await GroupInvite.create({
      group_id: group.id,
      invited_email: `stranger-${slug}@example.com`,
      invited_by_uuid: caller.id,
      token: `${slug}-stranger-token`,
      status: 'pending',
    });

    const prompt = await AvailabilityPrompt.create({
      group_id: group.id,
      game_id: sharedGame.id,
      prompt_date: new Date(),
      deadline: new Date(Date.now() + 72 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: `${slug}-W01`,
    });

    await GroupPromptSettings.create({
      group_id: group.id,
      schedule_timezone: 'UTC',
      template_config: { schedules: [{ id: `${slug}-sched`, is_active: true, game_id: null }] },
    });

    // At least one availability record so the heatmap renders non-empty.
    // UserAvailability is NOT group-scoped (no group_id column) — it is a per-user
    // recurring pattern that the heatmap intersects with the group's roster, so one
    // row for the caller serves both groups. Seeded only once.
    const existingAvail = await UserAvailability.count({ where: { user_uuid: caller.id } });
    if (existingAvail === 0) {
      await UserAvailability.create({
        user_uuid: caller.id, // re-keyed onto user_uuid (Phase 87.5)
        type: 'recurring_pattern',
        pattern_data: { dayOfWeek: 5, startTime: '18:00', endTime: '22:00' },
        start_date: '2026-01-01',
        timezone: 'UTC',
      });
    }

    return { group, event, invite, prompt, game: sharedGame };
  }

  // Stamp Group + UserGroup + Event with ONE shared timestamp — the discipline
  // plan 06 implements and plan 07's stamp-matched restore depends on.
  async function softDeleteGroup(group) {
    const deletedAt = new Date();
    await Group.update({ deletedAt }, { where: { id: group.id }, silent: true });
    await UserGroup.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
    await Event.update({ deletedAt }, { where: { group_id: group.id }, silent: true });
    return deletedAt;
  }

  // -------------------------------------------------------------------------
  // Data-driven endpoint table. A future phase ADDS A ROW here rather than a
  // copy-pasted block. `file` names the file the path ACTUALLY lives in — see
  // the library row, which is routes/groups.js and NOT routes/games.js.
  // -------------------------------------------------------------------------
  const ENDPOINTS = [
    {
      name: 'GET /api/events/user/:user_id',
      file: 'routes/events.js',
      path: (w, c) => `/api/events/user/${c.user_id}`,
      deadStatus: 'any',
    },
    {
      name: 'GET /api/groups/user/:user_id',
      file: 'routes/groups.js',
      path: (w, c) => `/api/groups/user/${c.user_id}`,
      deadStatus: 'any',
    },
    {
      // 403, NOT 404 — and that is CORRECT, not a defect to fix here.
      // Verified in routes/groups.js: the handler runs isActiveMember(caller,
      // group_id) and returns 403 'Access denied to this group' BEFORE
      // Group.findByPk. Once UserGroup is paranoid (plan 01) the caller's own
      // membership row is stamped, so isActiveMember denies and findByPk is never
      // reached. Do NOT "correct" this back to 404: membership is the gate, and
      // membership is itself hidden. Unlike deletion-impact (AF-2) this handler is
      // deliberately NOT reordered — no SPEC criterion requires a 404 from it, and
      // answering existence before authorization would widen disclosure for no
      // benefit. The sweep's real job on this row is unchanged and still met: a 403
      // body trivially does not contain the group's id.
      name: 'GET /api/groups/:group_id',
      file: 'routes/groups.js',
      path: (w) => `/api/groups/${w.group.id}`,
      deadStatus: 403,
    },
    {
      name: 'GET /api/groups/:group_id/users',
      file: 'routes/groups.js',
      path: (w) => `/api/groups/${w.group.id}/users`,
      deadStatus: 'non2xxOrEmpty',
      // Never echoes the group id — it returns the ROSTER. The witness is that the
      // roster is non-empty, which is true only while the group's UserGroup rows
      // are unstamped.
      livePositive: (body) => Array.isArray(body) && body.length > 0,
    },
    {
      // routes/groups.js, NOT routes/games.js. The plan's original list mislabelled
      // this row, which meant its games.js line item covered nothing at all.
      name: 'GET /api/groups/:group_id/library',
      file: 'routes/groups.js',
      path: (w) => `/api/groups/${w.group.id}/library`,
      deadStatus: 'non2xxOrEmpty',
      // Returns { games, members } and never the group id. The witness is the
      // group's member list.
      livePositive: (body) => Array.isArray(body?.members) && body.members.length > 0,
    },
    {
      // Task 5 (AF-10): the live group's review must be present and the hidden
      // group's absent, on the SAME shared game.
      name: 'GET /api/games/:id',
      file: 'routes/games.js',
      path: (w) => `/api/games/${w.game.id}`,
      deadStatus: 'any',
    },
    {
      name: 'GET /api/lists/games/:group_id/:user_id',
      file: 'routes/lists.js',
      path: (w, c) => `/api/lists/games/${w.group.id}/${c.id}`,
      deadStatus: 'any',
      // Returns the group's game list with group-scoped aggregates (avg_rating,
      // review_count derived from THIS group's reviews) but no group id. The
      // witness is a non-empty list.
      livePositive: (body) => Array.isArray(body) && body.length > 0,
    },
    {
      name: 'GET /api/game-reviews/game/:game_id/group/:group_id',
      file: 'routes/gameReviews.js',
      path: (w) => `/api/game-reviews/game/${w.game.id}/group/${w.group.id}`,
      deadStatus: 'any',
    },
    {
      name: 'GET /api/invites/pending',
      file: 'routes/invites.js',
      path: () => '/api/invites/pending',
      deadStatus: 'any',
    },
    {
      name: 'GET /api/invites/info/:token',
      file: 'routes/invites.js',
      path: (w) => `/api/invites/info/${w.invite.token}`,
      deadStatus: 404,
      // This endpoint returns { group_name, inviter_name, member_count } and never
      // emits the group id, so the positive control is the NAME.
      livePresence: (w) => w.group.name,
    },
    {
      name: 'GET /api/invites/group/:group_id/pending',
      file: 'routes/invites.js',
      path: (w) => `/api/invites/group/${w.group.id}/pending`,
      deadStatus: 'any',
      // Returns this group's pending invites without echoing the group id. The
      // witness is a non-empty invite list.
      livePositive: (body) => Array.isArray(body) && body.length > 0,
    },
    {
      name: 'GET /api/availability/group/:group_id/heatmap',
      file: 'routes/availability.js',
      path: (w) => `/api/availability/group/${w.group.id}/heatmap`,
      deadStatus: 'any',
      // Returns slot aggregates keyed by date, never the group id. The witness is
      // totalGroupMembers, which counts the group's ACTIVE UserGroup rows and goes
      // to zero once they are stamped.
      livePositive: (body) => (body?.totalGroupMembers ?? 0) > 0,
    },
    {
      name: 'GET /api/groups/:groupId/prompts/active',
      file: 'routes/availabilityPrompt.js',
      path: (w) => `/api/groups/${w.group.id}/prompts/active`,
      deadStatus: 'any',
    },
    {
      name: 'GET /api/groups/:groupId/prompts/open',
      file: 'routes/availabilityPrompt.js',
      path: (w) => `/api/groups/${w.group.id}/prompts/open`,
      deadStatus: 'any',
    },
    {
      // Deliberately included: routes/availabilityPrompt.js holds two
      // AvailabilityPrompt-rooted { model: Group } includes on a NON-paranoid root
      // — exactly the Group: null ghost shape RESEARCH F-06 describes, and the one
      // case in the enumeration where the central filter provably does not drop the
      // row. Task 7 closes it; this row proves it on the wire.
      name: 'GET /api/prompts/:promptId/respondents',
      file: 'routes/availabilityPrompt.js',
      path: (w) => `/api/prompts/${w.prompt.id}/respondents`,
      deadStatus: 404,
      // Returns the group's roster as respondents, without the group id. The
      // witness is a non-empty respondent list; on a hidden group the endpoint
      // 404s and the body is an error object, so the predicate fails.
      livePositive: (body) => Array.isArray(body) && body.length > 0,
    },
    {
      name: 'GET /api/groups/:group_id/prompt-settings',
      file: 'routes/groupPromptSettings.js',
      path: (w) => `/api/groups/${w.group.id}/prompt-settings`,
      deadStatus: 'any',
    },
  ];

  // The coverage statement in the header must match the array — assert it rather
  // than trusting the prose, so the claim is auditable in CI.
  it('the endpoint array covers all NINE SPEC-REQ-4-enumerated route files, across at least 16 distinct paths', () => {
    const files = [...new Set(ENDPOINTS.map((e) => e.file))].sort();
    expect(files).toEqual([
      'routes/availability.js',
      'routes/availabilityPrompt.js',
      'routes/events.js',
      'routes/gameReviews.js',
      'routes/games.js',
      'routes/groupPromptSettings.js',
      'routes/groups.js',
      'routes/invites.js',
      'routes/lists.js',
    ]);
    expect(files).toHaveLength(9);

    const paths = new Set(ENDPOINTS.map((e) => e.name));
    expect(paths.size).toBeGreaterThanOrEqual(16);

    // No row may claim a file it does not live in: the library row is groups.js.
    const library = ENDPOINTS.find((e) => e.name.includes('/library'));
    expect(library.file).toBe('routes/groups.js');
  });

  describe.each(ENDPOINTS.map((e) => [e.name, e]))('%s', (_name, ep) => {
    it('POSITIVE CONTROL: the live group\'s response is non-vacuous and carries its identifier', async () => {
      const res = await request(app).get(ep.path(live, caller)).send();

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(isVacuous(res.body)).toBe(false);

      if (ep.livePositive) {
        // Mode (b): this handler never serializes the group id — assert the
        // group-scoped witness instead. The hidden run below asserts its inverse.
        if (!ep.livePositive(res.body)) {
          throw new Error(
            `POSITIVE CONTROL FAILED for ${ep.name} (${ep.file}): the LIVE group's ` +
              `group-scoped witness did not fire, so the absence assertion below ` +
              `proves nothing. Fix the SEED, never the assertion.\n` +
              `Body: ${JSON.stringify(res.body).slice(0, 500)}`
          );
        }
        return;
      }

      // Mode (a): id presence.
      const needle = ep.livePresence ? ep.livePresence(live) : live.group.id;
      const hits = collectIdHits(res.body, needle);
      if (hits.length === 0) {
        throw new Error(
          `POSITIVE CONTROL FAILED for ${ep.name} (${ep.file}): the LIVE group's ` +
            `identifier "${needle}" is absent from a 2xx body, so the absence ` +
            `assertion below proves nothing. Fix the SEED, never the assertion.\n` +
            `Body: ${JSON.stringify(res.body).slice(0, 500)}`
        );
      }
    });

    it('the soft-deleted group\'s id is absent from the response at every nesting depth', async () => {
      await softDeleteGroup(dead.group);

      const res = await request(app).get(ep.path(dead, caller)).send();

      if (typeof ep.deadStatus === 'number') {
        expect(res.status).toBe(ep.deadStatus);
      } else if (ep.deadStatus === 'non2xxOrEmpty') {
        const twoXX = res.status >= 200 && res.status < 300;
        expect(!twoXX || isVacuous(res.body)).toBe(true);
      }

      const hits = collectIdHits(res.body, dead.group.id);
      if (hits.length > 0) {
        throw new Error(
          `SOFT-DELETED GROUP ID ON THE WIRE from ${ep.name} (${ep.file}) — ` +
            `SPEC-REQ-4 violation. Fix at the owning site, never by deleting this ` +
            `row:\n  ${hits.join('\n  ')}`
        );
      }

      // The group NAME must not leak either — an id-only assertion would pass on a
      // body that spells the hidden group out in prose.
      expect(JSON.stringify(res.body)).not.toContain(dead.group.name);

      // Mode (b) rows: the group-scoped witness that fired for the LIVE group must
      // NOT fire here. This is what keeps a witness-based control two-sided — it
      // proves the group-scoped content actually vanished, not merely that a body
      // happened to omit a uuid it never emits.
      if (ep.livePositive) {
        expect(ep.livePositive(res.body)).toBe(false);
      }
    });
  });

  // Cross-cutting: one hidden group must not contaminate the live one.
  it('hiding one group leaves the OTHER group fully readable — the filter is scoped, not global', async () => {
    await softDeleteGroup(dead.group);

    const res = await request(app).get(`/api/groups/user/${caller.user_id}`).send();
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    expect(body).toContain(live.group.id);
    expect(body).not.toContain(dead.group.id);
  });

  // Task 5 (AF-10) on the shared game, asserted here as well as in games.test.js:
  // the sweep proves the id is absent, that suite proves the review shape.
  it('GET /api/games/:id keeps the LIVE group\'s review while dropping the hidden group\'s', async () => {
    await softDeleteGroup(dead.group);

    const res = await request(app).get(`/api/games/${live.game.id}`).send();
    expect(res.status).toBe(200);

    const reviews = res.body.GameReviews || [];
    expect(reviews.some((r) => r.group_id === live.group.id)).toBe(true);
    expect(reviews.some((r) => r.group_id === dead.group.id)).toBe(false);
  });
});
