// scripts/seed-sample-data.js
const crypto = require('crypto');
const { Op } = require('sequelize');
const {
  User, Group, UserGroup, Game, Event, EventParticipation, GameReview,
  AvailabilityPrompt, AvailabilityResponse, AvailabilitySuggestion,
  // Phase 88-34 Task 5 (WI-B4): these five were NOT imported before — the seed
  // could not produce future events, friendships, a game collection, recurring
  // availability or a pending invite, so five Test-2 walk gates were reachable
  // only by hand-seeding the DB (and that hand-seeded state is exactly what a
  // reseed destroys).
  Friendship, UserGame, UserAvailability, GroupInvite,
  // Phase 88.9 round 1b (walk fixtures): a ballot and prompt schedules, so the
  // look walk's rows render from a fresh seed instead of hand-staged rows.
  GroupPromptSettings, EventBallotOption,
  // Quick 261103-glx: the seed now mints rsvp + group_restore tokens, so it must
  // also clear them (see the G2 marker in the clearing block).
  SingleUseToken,
  // Quick 261115-seed-r3: the capture fixtures seed RSVP answers, so the model joins the
  // import and the clearing block.
  EventRsvp,
  sequelize,
} = require('../models');
const heatmapService = require('../services/heatmapService');
const { assertNotProductionDb } = require('./lib/assert-not-production-db');
const { softDeleteGroup } = require('../services/groupRecoveryService');
// DECISION quick-261103-glx G4: Alice's RSVP links are minted by the route module's
// own mintRsvpBatch / generateRsvpUrl — one definition of the HMAC payload and the
// three-row batch — chosen OVER inlining them (scripts/e2e-fixtures.js inlines because
// it once hung on the route module's timers; this script exits explicitly, so the
// hang cannot recur here). Called through the module OBJECT, not destructured, so the
// pinning test (tests/scripts/seedSampleData.test.js) can spy the mint.
const rsvpLinks = require('../routes/rsvp');

// DECISION quick-261103-glx G6: under CI a failed seed prints ONLY the error's name
// and message, chosen OVER the whole error object, because a Sequelize error carries
// `sql` and `parameters`, and this seed's token writes inline nonces into them — the
// same reasoning scripts/e2e-fixtures.js records ("Log ONLY the error's name and
// message"); both CI jobs that run this seed write to PUBLIC Actions logs. Locally the
// full object stays, for debugging. Read at call time, so a test can toggle CI.
function seedErrorForLog(error) {
  if (!process.env.CI) return error;
  return `${error && error.name}: ${error && error.message}`;
}

// Sample data arrays
// NOTE: user_id should match your Auth0 'sub' claim value
// To get your Auth0 sub: Log in to the app and check browser console
// Or check Auth0 Dashboard > Users > [User] > User ID field
// You can also set these via environment variables:
//   AUTH0_ALICE_SUB, AUTH0_BOB_SUB, etc.
// Alice's fallback sub, used when AUTH0_ALICE_SUB is unset. Named (quick 261103-glx,
// scoped-check WR-02) so the RSVP-link notice at the end can compare the sub Alice was
// actually seeded on against it; exported for the seed's tests.
const ALICE_PLACEHOLDER_SUB = 'auth0|6959f749afc6f7d1e7fb1635';
const sampleUsers = [
  { 
    user_id: process.env.AUTH0_ALICE_SUB || ALICE_PLACEHOLDER_SUB,
    username: 'Alice', 
    email: 'alice@example.com' 
  },
  { 
    user_id: process.env.AUTH0_BOB_SUB || 'auth0|695a019d225a2081ca41297b', 
    username: 'Bob', 
    email: 'bob@example.com' 
  },
  { 
    user_id: process.env.AUTH0_CHARLIE_SUB || 'auth0|695a0258225a2081ca4129d5', 
    username: 'Charlie', 
    email: 'charlie@example.com' 
  },
  { 
    user_id: process.env.AUTH0_DIANA_SUB || 'auth0|695a02a92c3ca58370cd94c0', 
    username: 'Diana', 
    email: 'diana@example.com' 
  },
  { 
    user_id: process.env.AUTH0_EVE_SUB || 'auth0|695a02f2f066d9582838c311', 
    username: 'Eve', 
    email: 'eve@example.com' 
  },
  { 
    user_id: process.env.AUTH0_FRANK_SUB || 'auth0|695a0327b7305395a05774dc', 
    username: 'Frank', 
    email: 'frank@example.com' 
  },
  // Phase 88.9 round 1b (walk fixtures): a member who owns NO games, with a name
  // long enough to wrap the 375px profile title (walk rows W152 / #29). The
  // local walk signs in as this user for those two captures (the Alice-login
  // runbook's repoint); nothing else references the account. CAUTION (quick
  // 261103-glx): any repoint that moves Alice's sub breaks the RSVP links the seed
  // prints — they carry and are signed over the sub as seeded — so walk the RSVP
  // rows first, or reseed afterwards.
  {
    user_id: process.env.AUTH0_BART_SUB || 'auth0|695a0399c0ffee0000000001',
    username: 'Bartholomew Featherstonehaugh-Cholmondeley',
    email: 'bartholomew@example.com'
  },
];

const sampleGroups = [
  { group_id: 'weekend-warriors', name: 'Weekend Warriors' },
  { group_id: 'strategy-squad', name: 'Strategy Squad' },
  { group_id: 'casual-gamers', name: 'Casual Gamers' },
  // Phase 88.9 round 1b (walk fixtures): Alice is a member of NEITHER. Dice
  // Dynasty hosts the event she attends as a guest; No Games Yet is the group
  // none of whose members own a game.
  { group_id: 'dice-dynasty', name: 'Dice Dynasty' },
  { group_id: 'no-games-yet', name: 'No Games Yet' },
  // Phase 88.9 round 2 (quick 261103-glx): soft-deleted at the END of the seed
  // (the token-fixtures section) so /restore/group/[token] is walkable; hidden
  // from every list by the paranoid clause until someone restores it.
  { group_id: 'retired-raiders', name: 'Retired Raiders' },
  // Quick 261110-ugi: appended at index 6 so every existing groups[N] stays put; see sub-block (e) U3.
  { group_id: 'photo-club', name: 'Photo Club' }, // 88.9-R2 fixture — Photo Club (N16)
  // Quick 261115-seed-r3: appended at index 7 so every existing groups[N] stays put; see sub-block (f) R6.
  // The colour rides in the create defaults (no later update), so the row is written once.
  { group_id: 'amber-aces', name: 'Amber Aces', color_preset: 'amber' }, // 88.9-R3 fixture — amber, image-less group (P64-1)
];

const sampleGames = [
  // Popular board games
  {
    name: 'Catan',
    bgg_id: 13,
    year_published: 1995,
    min_players: 3,
    max_players: 4,
    playing_time: 60,
    theme: 'Strategy',
    description: 'Build settlements, trade resources, and expand your civilization.',
    is_custom: false,
    url: 'https://boardgamegeek.com/boardgame/13/catan'
  },
  {
    name: 'Ticket to Ride',
    bgg_id: 9209,
    year_published: 2004,
    min_players: 2,
    max_players: 5,
    playing_time: 60,
    theme: 'Family',
    description: 'Collect train cards and claim railway routes across North America.',
    is_custom: false,
    url: 'https://boardgamegeek.com/boardgame/9209/ticket-to-ride'
  },
  {
    name: 'Wingspan',
    bgg_id: 266524,
    year_published: 2019,
    min_players: 1,
    max_players: 5,
    playing_time: 70,
    theme: 'Strategy',
    description: 'Attract birds to your wildlife preserves.',
    is_custom: false,
    url: 'https://boardgamegeek.com/boardgame/266524/wingspan'
  },
  {
    name: 'Azul',
    bgg_id: 230802,
    year_published: 2017,
    min_players: 2,
    max_players: 4,
    playing_time: 45,
    theme: 'Abstract',
    description: 'Create beautiful tile patterns inspired by Portuguese azulejos.',
    is_custom: false,
    url: 'https://boardgamegeek.com/boardgame/230802/azul'
  },
  {
    name: 'Codenames',
    bgg_id: 178900,
    year_published: 2015,
    min_players: 2,
    max_players: 8,
    playing_time: 15,
    theme: 'Party',
    description: 'Give one-word clues to help your team identify secret agents.',
    is_custom: false,
    url: 'https://boardgamegeek.com/boardgame/178900/codenames'
  },
  {
    name: 'Gloomhaven',
    bgg_id: 174430,
    year_published: 2017,
    min_players: 1,
    max_players: 4,
    playing_time: 120,
    theme: 'Adventure',
    description: 'Cooperative campaign-based dungeon crawler with legacy elements.',
    is_custom: false,
    url: 'https://boardgamegeek.com/boardgame/174430/gloomhaven'
  },
  {
    name: 'Custom Card Game',
    is_custom: true,
    min_players: 2,
    max_players: 4,
    playing_time: 30,
    theme: 'Custom',
    description: 'A custom card game created by our group.'
  },
  {
    name: 'House Rules Monopoly',
    is_custom: true,
    min_players: 2,
    max_players: 6,
    playing_time: 180,
    theme: 'Classic',
    description: 'Monopoly with our own house rules.'
  }
];

// DECISION quick-261103-glx G1: seedDatabase takes { syncSchema, closeConnection } so the
// Jest suite (tests/scripts/seedSampleData.test.js) can run the seed IN-PROCESS against the
// schema tests/globalSetup.js builds, on the suite's own shared connection. Chosen OVER a
// child process (a child resolves its database through dotenv layering on top of the
// worker's .env.test load — a second source of truth for WHICH database a mass delete
// hits) and OVER syncing inside the suite (the suite already owns the schema, so a second
// alter sync could only leave later suites a different one). Whether Sequelize's postgres
// alter re-emits a unique constraint per column-level unique on every run was read from
// Sequelize 6.37.8 source (postgres query-generator changeColumnQuery appends ADD UNIQUE
// whenever the definition ends in UNIQUE), not measured here; the design does not depend
// on it. The defaults keep `npm run seed`'s schema sync and connection close
// exactly as before. The guard below stays the first statement in BOTH modes. Removing
// the options is a decision, not a cleanup.
async function seedDatabase({ syncSchema = true, closeConnection = true } = {}) {
  try {
    // Phase 87.8 Plan 02 Task 0 (T-87.8-05): default-deny guard BEFORE the first
    // destructive statement. The sync({ alter: true }) below is itself
    // schema-destructive, not just the destroy({ where: {} }) block — so the guard
    // must run before BOTH. Throws on NODE_ENV=production and on any non-local DB
    // host unless ALLOW_DESTRUCTIVE_SEED=1 is explicitly set.
    assertNotProductionDb(sequelize);

    console.log('🌱 Starting database seeding...\n');
    console.log('📝 Note: Make sure your database exists and is configured in .env\n');

    // Test connection first
    try {
      await sequelize.authenticate();
      console.log('✅ Database connection established.\n');
    } catch (error) {
      console.error('❌ Database connection failed!');
      console.error('   Please ensure:');
      console.error('   1. PostgreSQL is running');
      console.error('   2. Database exists (create it with: CREATE DATABASE boardgame_db;)');
      console.error('   3. .env file has correct database credentials\n');
      throw error;
    }

    // Sync database (skipped only when the caller supplies the schema — G1 above)
    if (syncSchema) {
      await sequelize.sync({ alter: true });
      console.log('✅ Database synced\n');
    } else {
      console.log('⏭️  Schema sync skipped — the caller supplied the schema (syncSchema: false)\n');
    }

    // Clear existing data (optional - comment out if you want to keep existing data)
    console.log('🗑️  Clearing existing data...');
    // F-02: the three paranoid models are FORCED (Event/UserGroup/Group) — a
    // reseed must WIPE rows, not accumulate soft-deleted ones run after run.
    //
    // Phase 87.8 Plan 02 (R8): the availability check-in rows follow the SAME
    // wipe-then-recreate idempotency convention as the rest of this block (no
    // upsert idiom needed). FK order: suggestions and responses reference the
    // prompt, and the prompt references group_id — so all three go before
    // Group.destroy. None of the three models is paranoid (confirmed against the
    // model files), so a plain destroy fully removes rows — no force needed.
    //
    // Phase 88-34 Task 5 (WI-B4): the four newly-seeded models join the wipe
    // list, in FK order — GroupInvite references Groups and Users; Friendship,
    // UserGame and UserAvailability reference Users — so all four go BEFORE
    // Group.destroy and User.destroy. A model seeded but not wiped accumulates
    // duplicates run after run (and for GroupInvite, whose token column is
    // UNIQUE, the second run would hard-fail).
    await AvailabilitySuggestion.destroy({ where: {} });
    await AvailabilityResponse.destroy({ where: {} });
    await AvailabilityPrompt.destroy({ where: {} });
    await GameReview.destroy({ where: {} });
    await EventParticipation.destroy({ where: {} });
    await GroupInvite.destroy({ where: {} });
    // DECISION quick-261103-glx G2: clear ONLY the two token purposes this seed
    // mints (rsvp, group_restore), chosen OVER a full wipe — oauth_state and
    // email_change_verify rows are not the seed's, so it does not own them. And
    // an explicit delete, chosen OVER relying on the user_id cascade from
    // User.destroy below. That cascade (models/index.js ("SingleUseToken.belongsTo(User")
    // ON DELETE CASCADE; in prod since migrations/20260730000003-reconcile-single-use-tokens-user-fk.js)
    // already takes every user-keyed token of EVERY purpose with the users, so
    // this clear matters for rows with no user — group_restore rows carry
    // user_id NULL, are reached by no cascade, and would otherwise accumulate one
    // per reseed — and for any database not yet migrated past 20260730000003.
    await SingleUseToken.destroy({ where: { purpose: { [Op.in]: ['rsvp', 'group_restore'] } } });
    await Friendship.destroy({ where: {} });
    await UserGame.destroy({ where: {} });
    await UserAvailability.destroy({ where: {} });
    // Phase 88.9 round 1b: ballot options reference Events, prompt settings
    // reference Groups — both go before their parents, same convention.
    await EventBallotOption.destroy({ where: {} });
    // Quick 261115-seed-r3: RSVP answers reference Events and Users. Both parents cascade to
    // them, so this explicit clear is the "a model seeded is a model wiped" convention above,
    // and the cover for any database whose foreign keys were not built with the cascade.
    await EventRsvp.destroy({ where: {} });
    await Event.destroy({ where: {}, force: true });
    await UserGroup.destroy({ where: {}, force: true });
    await Game.destroy({ where: {} });
    await GroupPromptSettings.destroy({ where: {} });
    await Group.destroy({ where: {}, force: true });
    await User.destroy({ where: {} });
    console.log('✅ Existing data cleared\n');

    // Create Users
    console.log('👥 Creating users...');
    const users = [];
    for (const userData of sampleUsers) {
      const [user, created] = await User.findOrCreate({
        where: { user_id: userData.user_id },
        defaults: userData
      });
      users.push(user);
      if (created) console.log(`   ✓ Created user: ${user.username}`);
    }
    console.log(`✅ Created ${users.length} users\n`);

    // DECISION quick-261115-seed-r3 R1 (capture rows P68-2 / X36b and P59-4): Alice, the walk
    // login, carries the SMS entitlement and a VERIFIED phone, so her Profile renders the phone
    // row with its Remove control (and, once a Remove is answered in the browser, the
    // "phone removed" SMS banner P59-4 asks about: one seed serves both). Chosen OVER (a) a
    // second walk user (the walk signs in as the one Auth0 account mapped to Alice, and this is
    // a state Alice can hold), OVER (b) patching the self read in the browser at capture time
    // (plan 88.9-68's hand-off and row P68-2 name it a seed change), and OVER (c) any real
    // number: +1 202 555 0143 sits in 555-0100..0199, the block reserved for fiction, so no
    // text can reach a person even on a machine with a live SMS provider configured.
    // notification_preferences stay null (email on, SMS off), so notificationService never
    // picks the SMS channel for her; sms_welcome_sent_at is stamped, so a walk that ticks an SMS
    // box cannot fire the one-time welcome text either. This is a fixture write: no route or
    // service writes sms_enabled, and that stays true. Alice is also the CI login identity, and
    // FE e2e stages its SMS states on a row that has none, so scripts/e2e-fixtures.js clears
    // these fields again in CI (pinned in tests/unit/e2e-fixtures-guard.test.js). Removing the
    // entitlement re-blocks P68-2; swapping in a real number is never a cleanup.
    await users[0].update({ // 88.9-R3 fixture — SMS entitlement + verified fictional phone (P68-2, P59-4)
      sms_enabled: true,
      phone: '+12025550143',
      phone_verified: true,
      sms_welcome_sent_at: new Date(),
    });
    console.log('   ✓ Alice: SMS entitlement + verified phone on a reserved fictional number (no SMS opted in)\n');

    // Create Groups
    console.log('👥 Creating groups...');
    const groups = [];
    for (const groupData of sampleGroups) {
      const [group, created] = await Group.findOrCreate({
        where: { group_id: groupData.group_id },
        defaults: groupData
      });
      groups.push(group);
      if (created) console.log(`   ✓ Created group: ${group.name}`);
    }
    console.log(`✅ Created ${groups.length} groups\n`);

    // Create UserGroup relationships
    console.log('🔗 Linking users to groups...');
    const userGroups = [
      // Weekend Warriors: Alice (owner), Bob, Charlie, Diana
      { user: users[0], group: groups[0], role: 'owner' },
      { user: users[1], group: groups[0], role: 'admin' },
      { user: users[2], group: groups[0], role: 'member' },
      { user: users[3], group: groups[0], role: 'member' },
      
      // Strategy Squad: Frank (owner), Bob, Charlie (admin), Eve — plus Alice, Diana and
      // Bartholomew below (7 members; see the 88.9 round-2 note)
      { user: users[5], group: groups[1], role: 'owner' },
      { user: users[1], group: groups[1], role: 'member' },
      { user: users[2], group: groups[1], role: 'admin' },
      { user: users[4], group: groups[1], role: 'member' },
      
      // Casual Gamers: Diana (owner), Eve, Frank
      { user: users[3], group: groups[2], role: 'owner' },
      { user: users[4], group: groups[2], role: 'member' },
      { user: users[5], group: groups[2], role: 'member' },

      // Phase 88.9 round 1b (walk fixtures). Alice as a PLAIN member of two more
      // groups (the walk's member-view rows); Dice Dynasty WITHOUT her — she is a
      // guest at its event (the walk block below); and No Games Yet, whose members
      // own no game at all, so create-event's Suggestions slot renders its empty
      // hint (W152). suggestionService pools EVERY active member's UserGame rows,
      // so Alice (3 games) and Bob (1) must stay OUT of No Games Yet.
      { user: users[0], group: groups[1], role: 'member' },
      { user: users[0], group: groups[2], role: 'member' },
      // Phase 88.9 round 2 (lane-B page 3 item D2, register row #77 — the +N overflow
      // chip). The home card's collapsed MemberChipStack shows COLLAPSED_LIMIT = 4 OTHER
      // members and a "+N" chip for the rest
      // (periodictabletop/src/app/components/MemberChipStack.tsx). No seeded group gave
      // Alice more than 4 others, so the chip never rendered on the walk DB and the pick
      // row was blocked. Diana and Bartholomew join Strategy Squad: 7 members, Alice sees
      // four chips and "+2". Why this group: Weekend Warriors must keep MORE than its 3
      // seeded prompt responders (consensus closes at respondedCount >= totalActive, and
      // CI e2e walks its create-event surface); No Games Yet must stay game-less; Dice
      // Dynasty must stay without Alice (she is its guest). KNOWN CONSEQUENCE, not a
      // regression: create-event pre-fills every active member as a participant, so
      // Strategy Squad's Suggestions slot now runs at playerCount 7, above every owned
      // game's max_players (Catan 4, Azul 4, Ticket to Ride 5, Wingspan 5) — the slot
      // shows the SAME empty hint as No Games Yet, and the "has games" contrast for walk
      // row W152 is Weekend Warriors (4 players, all four owned games qualify). Giving a
      // squad member a 7-player game would change Weekend Warriors (Alice, Bob, Charlie,
      // Diana are in both) or un-empty No Games Yet (Eve, Frank, Bartholomew), so no
      // UserGame row is added. Diana's Tue/Thu availability patterns also join the squad
      // heatmap (availabilityService reads every member's recurring patterns); no test or
      // walk row asserts on it. Pinned by tests/scripts/seedSampleData.test.js
      // ("Strategy Squad has 7 active members").
      { user: users[3], group: groups[1], role: 'member' },
      { user: users[6], group: groups[1], role: 'member' },
      // Dice Dynasty: Charlie (owner), Eve, Frank
      { user: users[2], group: groups[3], role: 'owner' },
      { user: users[4], group: groups[3], role: 'member' },
      { user: users[5], group: groups[3], role: 'member' },
      // No Games Yet: Frank (owner), Eve, Bartholomew
      { user: users[5], group: groups[4], role: 'owner' },
      { user: users[4], group: groups[4], role: 'member' },
      { user: users[6], group: groups[4], role: 'member' },
      // Retired Raiders (quick 261103-glx): Alice (owner), Bob, Eve. These three
      // rows are stamped by the soft delete at the end of the seed, which is what
      // lets any of them restore the group from the printed link.
      { user: users[0], group: groups[5], role: 'owner' },
      { user: users[1], group: groups[5], role: 'member' },
      { user: users[4], group: groups[5], role: 'member' },
      // Photo Club (quick 261110-ugi): Eve (owner), Alice; see walk-states sub-block (e) U3.
      { user: users[4], group: groups[6], role: 'owner' }, // 88.9-R2 fixture — Photo Club (N16)
      { user: users[0], group: groups[6], role: 'member' }, // 88.9-R2 fixture — Photo Club (N16)
      // Amber Aces (quick 261115-seed-r3): Diana (owner), Alice, Charlie; see walk-states sub-block (f) R6.
      { user: users[3], group: groups[7], role: 'owner' }, // 88.9-R3 fixture — Amber Aces (P64-1)
      { user: users[0], group: groups[7], role: 'member' }, // 88.9-R3 fixture — Amber Aces (P64-1)
      { user: users[2], group: groups[7], role: 'member' }, // 88.9-R3 fixture — Amber Aces (P64-1)
    ];

    for (const { user, group, role } of userGroups) {
      // Phase 87.1 (BINT-02, Plan 09 cutover): UserGroup is now keyed on user_uuid
      // (= Users.id UUID); the old Auth0-string user_id column was removed from the
      // model. The FE e2e CI job sync()-builds its DB from these models (no migrations),
      // so this MUST key user_uuid or the seed crashes on a nonexistent column.
      await UserGroup.findOrCreate({
        where: { user_uuid: user.id, group_id: group.id },
        defaults: { role }
      });
    }
    console.log(`✅ Created ${userGroups.length} user-group relationships\n`);

    // Create Games
    console.log('🎲 Creating games...');
    const games = [];
    for (const gameData of sampleGames) {
      const [game, created] = await Game.findOrCreate({
        where: gameData.bgg_id ? { bgg_id: gameData.bgg_id } : { name: gameData.name, is_custom: true },
        defaults: gameData
      });
      games.push(game);
      if (created) console.log(`   ✓ Created game: ${game.name}`);
    }
    console.log(`✅ Created ${games.length} games\n`);

    // Create Events (game sessions)
    console.log('📅 Creating events...');
    const events = [];
    const now = new Date();
    
    // Weekend Warriors events
    const weekendGroup = groups[0];
    const weekendUsers = [users[0], users[1], users[2], users[3]];
    
    // Event 1: Catan - 2 weeks ago
    const event1 = await Event.create({
      group_id: weekendGroup.id,
      game_id: games[0].id, // Catan
      start_date: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
      duration_minutes: 75,
      winner_id: users[0].id, // Alice won
      picked_by_id: users[1].id, // Bob picked the game
      is_group_win: false,
      comments: 'Great game! Alice dominated with longest road.',
      status: 'completed'
    });
    events.push(event1);

    // Event 1 participations
    await EventParticipation.create({ event_id: event1.id, user_id: users[0].id, score: 10, placement: 1, is_new_player: false });
    await EventParticipation.create({ event_id: event1.id, user_id: users[1].id, score: 7, placement: 2, is_new_player: false });
    await EventParticipation.create({ event_id: event1.id, user_id: users[2].id, score: 5, placement: 3, is_new_player: false });
    await EventParticipation.create({ event_id: event1.id, user_id: users[3].id, score: 4, placement: 4, is_new_player: true });

    // Event 2: Ticket to Ride - 1 week ago
    const event2 = await Event.create({
      group_id: weekendGroup.id,
      game_id: games[1].id, // Ticket to Ride
      start_date: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      duration_minutes: 60,
      winner_id: users[2].id, // Charlie won
      picked_by_id: users[0].id, // Alice picked
      is_group_win: false,
      comments: 'Charlie completed the longest route!',
      status: 'completed'
    });
    events.push(event2);

    await EventParticipation.create({ event_id: event2.id, user_id: users[0].id, score: 78, placement: 2, is_new_player: false });
    await EventParticipation.create({ event_id: event2.id, user_id: users[1].id, score: 65, placement: 3, is_new_player: false });
    await EventParticipation.create({ event_id: event2.id, user_id: users[2].id, score: 95, placement: 1, is_new_player: false });
    await EventParticipation.create({ event_id: event2.id, user_id: users[3].id, score: 52, placement: 4, is_new_player: false });

    // Event 3: Wingspan - 3 days ago
    const event3 = await Event.create({
      group_id: weekendGroup.id,
      game_id: games[2].id, // Wingspan
      start_date: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      duration_minutes: 80,
      winner_id: users[3].id, // Diana won
      picked_by_id: users[2].id, // Charlie picked
      is_group_win: false,
      comments: 'Diana had an amazing bird engine!',
      status: 'completed'
    });
    events.push(event3);

    await EventParticipation.create({ event_id: event3.id, user_id: users[0].id, score: 42, placement: 3, is_new_player: false });
    await EventParticipation.create({ event_id: event3.id, user_id: users[1].id, score: 38, placement: 4, is_new_player: false });
    await EventParticipation.create({ event_id: event3.id, user_id: users[2].id, score: 48, placement: 2, is_new_player: false });
    await EventParticipation.create({ event_id: event3.id, user_id: users[3].id, score: 55, placement: 1, is_new_player: false });

    // Strategy Squad events
    const strategyGroup = groups[1];
    const strategyUsers = [users[1], users[2], users[4], users[5]];

    // Event 4: Gloomhaven - 10 days ago
    const event4 = await Event.create({
      group_id: strategyGroup.id,
      game_id: games[5].id, // Gloomhaven
      start_date: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000),
      duration_minutes: 150,
      winner_id: null, // Cooperative game
      picked_by_id: users[1].id, // Bob picked
      is_group_win: true,
      comments: 'We completed the scenario! Great teamwork.',
      status: 'completed'
    });
    events.push(event4);

    await EventParticipation.create({ event_id: event4.id, user_id: users[1].id, score: null, placement: null, is_new_player: false, faction: 'Brute' });
    await EventParticipation.create({ event_id: event4.id, user_id: users[2].id, score: null, placement: null, is_new_player: false, faction: 'Spellweaver' });
    await EventParticipation.create({ event_id: event4.id, user_id: users[4].id, score: null, placement: null, is_new_player: true, faction: 'Scoundrel' });
    await EventParticipation.create({ event_id: event4.id, user_id: users[5].id, score: null, placement: null, is_new_player: false, faction: 'Tinkerer' });

    // Event 5: Azul - 5 days ago
    const event5 = await Event.create({
      group_id: strategyGroup.id,
      game_id: games[3].id, // Azul
      start_date: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
      duration_minutes: 40,
      winner_id: users[4].id, // Eve won
      picked_by_id: users[5].id, // Frank picked
      is_group_win: false,
      comments: 'Eve had perfect tile placement strategy.',
      status: 'completed'
    });
    events.push(event5);

    await EventParticipation.create({ event_id: event5.id, user_id: users[1].id, score: 45, placement: 3, is_new_player: false });
    await EventParticipation.create({ event_id: event5.id, user_id: users[2].id, score: 52, placement: 2, is_new_player: false });
    await EventParticipation.create({ event_id: event5.id, user_id: users[4].id, score: 68, placement: 1, is_new_player: false });
    await EventParticipation.create({ event_id: event5.id, user_id: users[5].id, score: 38, placement: 4, is_new_player: false });

    // Casual Gamers events
    const casualGroup = groups[2];
    const casualUsers = [users[3], users[4], users[5]];

    // Event 6: Codenames - 2 days ago
    const event6 = await Event.create({
      group_id: casualGroup.id,
      game_id: games[4].id, // Codenames
      start_date: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      duration_minutes: 20,
      winner_id: null, // Team game
      picked_by_id: users[3].id, // Diana picked
      is_group_win: true,
      comments: 'Red team won! Great word associations.',
      status: 'completed'
    });
    events.push(event6);

    await EventParticipation.create({ event_id: event6.id, user_id: users[3].id, score: null, placement: null, is_new_player: false });
    await EventParticipation.create({ event_id: event6.id, user_id: users[4].id, score: null, placement: null, is_new_player: false });
    await EventParticipation.create({ event_id: event6.id, user_id: users[5].id, score: null, placement: null, is_new_player: false });

    // Event 7: Custom Card Game - yesterday
    const event7 = await Event.create({
      group_id: casualGroup.id,
      game_id: games[6].id, // Custom Card Game
      start_date: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      duration_minutes: 35,
      winner_id: users[5].id, // Frank won
      picked_by_id: users[4].id, // Eve picked
      is_group_win: false,
      comments: 'First time playing our custom game. Needs some rule tweaks.',
      status: 'completed'
    });
    events.push(event7);

    await EventParticipation.create({ event_id: event7.id, user_id: users[3].id, score: 15, placement: 3, is_new_player: true });
    await EventParticipation.create({ event_id: event7.id, user_id: users[4].id, score: 22, placement: 2, is_new_player: true });
    await EventParticipation.create({ event_id: event7.id, user_id: users[5].id, score: 28, placement: 1, is_new_player: true });

    // ────────────────────────────────────────────────────────────────────────
    // Phase 88-34 Task 5 (WI-B4) — FUTURE events.
    //
    // Every one of the seven events above is in the PAST with status
    // 'completed', so a fresh seed produced a database in which Upcoming Events
    // was permanently empty, no RSVP/ballot surface was reachable, and the walk's
    // Test-2 gates could only be walked after hand-inserting rows. Two future
    // events fix that.
    //
    // status is set EXPLICITLY here even though Task 1 made 'scheduled' both the
    // model default and what the create route derives — a seed should state the
    // state it intends rather than inherit it, and this row is written straight
    // through the model, bypassing the route's derivation entirely.
    // ────────────────────────────────────────────────────────────────────────
    console.log('📅 Creating FUTURE events (88-34 WI-B4)...');

    // ~3 days out, fully populated: participants + a game the group has played,
    // so it exercises Upcoming Events, RSVP and the group/game detail surfaces.
    const futureEvent1 = await Event.create({
      group_id: weekendGroup.id,
      game_id: games[0].id, // Catan
      start_date: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
      duration_minutes: 90,
      is_group_win: false,
      comments: 'Game night at Alice\'s — bring snacks!',
      status: 'scheduled',
    });
    events.push(futureEvent1);
    for (const u of weekendUsers) {
      await EventParticipation.create({ event_id: futureEvent1.id, user_id: u.id });
    }

    // ~10 days out, sparse: an upcoming event with no participants yet, which is
    // the state most real upcoming events are actually in.
    const futureEvent2 = await Event.create({
      group_id: strategyGroup.id,
      game_id: games[3].id,
      start_date: new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000),
      duration_minutes: 120,
      is_group_win: false,
      comments: 'Tentative — checking availability.',
      status: 'scheduled',
    });
    events.push(futureEvent2);

    console.log(`   ✓ Created 2 future events (status 'scheduled')`);

    // ────────────────────────────────────────────────────────────────────────
    // Phase 88.9 round 1b — the states the 88.9 lane-C look walk had to stage
    // BY HAND on 2026-10-27. Owner rule (2026-10-27): a walk row the seed could
    // resolve is resolved IN the seed, never by a scratch insert — hand-staged
    // state dies at the next reseed, exactly as the 88-34 block above records.
    // Each block names the walk rows it serves (ids from deferred/phase-88.9.md).
    // ────────────────────────────────────────────────────────────────────────
    console.log('🚶 Seeding the 88.9 walk states (round 1b)...');

    // (a) An OPEN ballot on the populated future event (#47: the Game Vote under
    //     the RSVP card), two options, deadline a day before the event. game_id
    //     stays set — the walk rendered exactly this shape. routes/ballot.js
    //     auto-closes an open ballot on read once the deadline passes, so the
    //     ballot is open for ~2 days after seeding: reseed to walk it later.
    await futureEvent1.update({
      ballot_status: 'open',
      rsvp_deadline: new Date(futureEvent1.start_date.getTime() - 24 * 60 * 60 * 1000),
    });
    const ballotOptions = [
      { game: games[0], order: 0 }, // Catan
      { game: games[2], order: 1 }, // Wingspan
    ];
    for (const { game, order } of ballotOptions) {
      await EventBallotOption.create({
        event_id: futureEvent1.id,
        game_id: game.id,
        game_name: game.name,
        display_order: order,
        created_by_uuid: users[0].id,
      });
    }

    // (b) GUESTS. ParticipantRow's GUEST chip (#33) needs a guest on an event
    //     Alice can open: Eve, not a Weekend Warriors member, joins futureEvent1
    //     as one. UpcomingEventsCard's Guest pill (#76) paints when the VIEWER's
    //     own participation row is is_guest=true, and GET /events/user/:id lists
    //     every event the user participates in even outside their groups
    //     (routes/events.js, the participatingEventIds OR-clause) — so Alice joins
    //     Dice Dynasty's night as a guest. Dice Dynasty exists for this.
    await EventParticipation.create({ event_id: futureEvent1.id, user_id: users[4].id, is_guest: true });
    const diceGroup = groups[3];
    const guestEvent = await Event.create({
      group_id: diceGroup.id,
      game_id: games[4].id, // Codenames
      start_date: new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000),
      duration_minutes: 90,
      is_group_win: false,
      comments: 'Codenames at Charlie\'s — Alice is coming as a guest.',
      status: 'scheduled',
    });
    events.push(guestEvent);
    await EventParticipation.create({ event_id: guestEvent.id, user_id: users[2].id });
    await EventParticipation.create({ event_id: guestEvent.id, user_id: users[4].id });
    await EventParticipation.create({ event_id: guestEvent.id, user_id: users[0].id, is_guest: true });

    // (c) Two prompt schedules on Weekend Warriors, one active and one paused, so
    //     ScheduleList shows both chips (#89) and its emphasis spans (#91). The
    //     object shape is the one POST /:group_id/prompt-settings/schedules writes
    //     (routes/groupPromptSettings.js, `const newSchedule = {`): schedules live
    //     INSIDE template_config.schedules, one settings row per group. A paused
    //     schedule is is_active=false with NO deleted_at (the GET keeps it; the
    //     toggle route flips it back). The seed writes the ROW only: a server
    //     already running does not pick the schedule up (BullMQ registration
    //     happens in the create / edit / toggle routes and in the boot sync,
    //     which runs only with NODE_ENV=production or ENABLE_WORKERS=true), so
    //     nothing fires until a server restarted with workers enabled — or a
    //     schedule edit / toggle through the routes on such a server — reaches
    //     Thursday 19:00 Pacific.
    //     The FE e2e fixture script DELETES this row for its own group
    //     (scripts/e2e-fixtures.js), because padding-budget.spec.ts anchors on
    //     ScheduleList's empty state.
    const stamp = new Date().toISOString();
    const weekendSchedules = [
      {
        id: crypto.randomUUID(),
        schedule_day_of_week: 4,
        schedule_time: '19:00',
        schedule_timezone: 'America/Los_Angeles',
        game_id: null,
        template_name: 'Thursday check-in',
        default_deadline_hours: 48,
        default_token_expiry_hours: 168,
        min_participants: 3,
        selected_member_ids: [],
        is_active: true,
        created_at: stamp,
        updated_at: stamp,
        created_by_user_id: users[0].id,
      },
      {
        id: crypto.randomUUID(),
        schedule_day_of_week: 0,
        schedule_time: '15:00',
        schedule_timezone: 'America/Los_Angeles',
        game_id: games[2].id, // Wingspan
        template_name: 'Sunday afternoon',
        default_deadline_hours: 72,
        default_token_expiry_hours: 168,
        min_participants: 2,
        selected_member_ids: [],
        is_active: false,
        created_at: stamp,
        updated_at: stamp,
        created_by_user_id: users[0].id,
      },
    ];
    await GroupPromptSettings.create({
      group_id: weekendGroup.id,
      schedule_timezone: 'America/Los_Angeles',
      template_config: { schedules: weekendSchedules },
      created_by_user_id: users[0].id,
    });

    // (d) A group with a stored colour AND a broken header image (#207, W48) and a
    //     game whose BGG images are dead (the SafeImage fallback row): the states
    //     the walk measures. `.invalid` is the RFC 2606 reserved TLD, so the
    //     browser fails each fetch fast instead of hanging on a real host.
    // AMENDED quick 261115-seed-r3 (plan 88.9-60 hand-off b): since 88.9-60 a header picture
    // that fails to load shows the group's NO-PICTURE look (here the blue tint), not a separate
    // image-failure look. The fixture is unchanged: still the group whose picture never loads.
    await casualGroup.update({ // 88.9-R2 fixture — O-02 / #207, a picture that fails to load (N16; seeded since round 1b)
      color_preset: 'blue',
      background_image_url: 'https://images.example.invalid/casual-gamers-header.jpg',
    });
    await games[3].update({ // Azul
      image_url: 'https://images.example.invalid/azul.jpg',
      thumbnail_url: 'https://images.example.invalid/azul-thumb.jpg',
    });

    // (e) Phase 88.9 round 2 (quick 261110-ugi): the 88.9-51 owner-glance fixtures.
    //     The W57 / R2-03 status nights below serve N11 (the Calendar sheet's Later
    //     rows at 375) and N12 (the day modal at 1280); after them come Strategy
    //     Squad's colour (N12, N16b), Photo Club (N16) and the cancelled night that
    //     started earlier today (N40).
    // DECISION quick-261110-ugi U1: the two status nights go on Strategy Squad, OVER
    // Weekend Warriors (the shared CI journey group, kept unmutated by e2e-fixtures.js
    // "DECISION Phase 88.3 (OQ-1)") and OVER Casual Gamers (its valid-protocol broken
    // header image makes every one of its rows an image row and would mix the O02d1 arm
    // into the status-tag glance). Both nights sit on ONE local calendar day at fixed
    // local hours, OVER the now-plus-N-days offsets the other future events use:
    // EventCalendar's handleDayClick opens the day modal only for two or more events,
    // and two now-relative offsets can straddle local midnight. This relies on the same
    // "seed machine shares the walk browser's TZ" assumption the heatmap block records.
    // The game is Gloomhaven, OVER Azul (dead images, so a broken picture would appear in
    // the rows) and OVER a game the squad has not played (routes/lists.js would add it to
    // the group's games list with play_count 0). No participations, so no per-user
    // history surface moves. No route writes either status on a future night today (the
    // create route derives 'scheduled' for a future start), so both rows are written
    // straight through the model, like every seeded row. The future 'completed' night
    // deliberately reproduces the state that migration
    // 20260820000002-backfill-future-completed-events.js calls bug M4 and re-stamps
    // 'scheduled' (the FE W57 tag renders it); never run that repair on a walk DB that
    // needs this row, reseed instead. Changing the group, the day or the game is a
    // decision, not a cleanup.
    // AMENDED quick 261115-seed-r3 (plan 88.9-61 hand-off a, "drop it or keep it as a no-tag
    // row"): KEPT. Since 88.9-61 only a cancelled row carries a status tag, so the completed
    // night shows none; it stays because it is the second row that opens the day modal for
    // N12 (two or more events), OVER dropping it and leaving the cancelled night alone on
    // its day.
    const statusDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 12);
    const statusDayAt = (hours, minutes) => new Date(
      statusDay.getFullYear(), statusDay.getMonth(), statusDay.getDate(), hours, minutes, 0, 0,
    );
    const cancelledFutureNight = await Event.create({ // 88.9-R2 fixture — CANCELLED future night (W57 / R2-03; N11, N12)
      group_id: strategyGroup.id,
      game_id: games[5].id, // Gloomhaven
      start_date: statusDayAt(18, 0),
      duration_minutes: 120,
      is_group_win: false,
      comments: 'Called off: not enough players this week.',
      status: 'cancelled',
    });
    events.push(cancelledFutureNight);
    const completedFutureNight = await Event.create({ // 88.9-R2 fixture — COMPLETED future night, same local day (W57 / R2-03; N11, N12)
      group_id: strategyGroup.id,
      game_id: games[5].id, // Gloomhaven
      start_date: statusDayAt(20, 30),
      duration_minutes: 90,
      is_group_win: false,
      comments: 'Short scenario, already marked done.',
      status: 'completed',
    });
    events.push(completedFutureNight);

    // Strategy Squad's colour (A + B; N12 tint, N16b).
    // DECISION quick-261110-ugi U2: Strategy Squad is the coloured, image-less group,
    // OVER Weekend Warriors (e2e-fixtures.js "DECISION Phase 88.3 (OQ-1)" keeps the shared
    // CI journey group unmutated). The preset is 'green' because N16b's wording expects
    // the preset green and it is in the validator's preset list (GROUP_COLOUR_PRESET_IDS);
    // only color_preset is written, the Casual Gamers precedent above. Recorded
    // consequence: Strategy Squad is the only seeded group giving Alice more than four
    // other members, so on the walk DB the +N chip now renders on the tinted arm. The
    // tinted arm adds a hairline; the +N fill pair is unchanged (MemberChipStack
    // OVERFLOW_PAIR). Its past rows, its started-today cancelled night and both future
    // status nights all carry the green. Changing the group or the preset is a decision,
    // not a cleanup.
    await strategyGroup.update({ color_preset: 'green' }); // 88.9-R2 fixture — coloured, image-less group (N12 tint, N16b)

    // Photo Club, the photo card with NO stored colour (C; N16).
    // DECISION quick-261110-ugi U3: a NEW two-member group, OVER (1) Weekend Warriors
    // (OQ-1, unmutated); (2) adding Alice to Dice Dynasty (she must stay its guest) or to
    // No Games Yet (it must stay game-less: suggestionService pools every member's games,
    // and Alice owns three); (3) stripping Strategy Squad's or Casual Gamers' colour (each
    // serves another glance row); (4) un-deleting Retired Raiders (the restore fixture).
    // The image is the FE's own public asset /seed/photo-club-table.jpg built from
    // FRONTEND_URL, OVER a .invalid host (a second failure-arm card, when N16 needs a
    // picture that renders) and OVER a third-party photo host (every page load would reach
    // an outside site). AMENDED quick-261110-ugi R1 (owner, 2026-11-11): a busy game-table
    // picture with a bright corner and a dark corner, OVER the app's /bgg-logo.png this
    // line first used — a 368x108 logo on a transparent ground cannot show what N16 asks
    // the owner to judge (a white outlined title over an undimmed photo). The picture is
    // generated, not a photograph; swapping the file for a real photo needs no seed
    // change. If the FE ever drops the asset, or FRONTEND_URL points somewhere that does
    // not serve it, the card degrades to the image-failure arm. The
    // URL is absolute because the FE allow-list rejects relative refs. background_color
    // stays at the model default, which the FE treats as unset: the shape of every group
    // nobody ever coloured. Eve is owner and Alice a plain member, so no owner affordance
    // joins her card. One past Ticket to Ride night, so the "Last Game:" row shows a game
    // name (N16's question is that row's ink). Changing the group, the image or the
    // members is a decision, not a cleanup.
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const photoClub = groups[6];
    await photoClub.update({ background_image_url: `${frontendUrl}/seed/photo-club-table.jpg` }); // 88.9-R2 fixture — photo card with NO stored colour (N16)
    const photoClubNight = await Event.create({ // 88.9-R2 fixture — Photo Club's Last Game night (N16)
      group_id: photoClub.id,
      game_id: games[1].id, // Ticket to Ride
      start_date: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000),
      duration_minutes: 60,
      is_group_win: false,
      comments: 'First club night: a quick round before the slideshow.',
      status: 'completed',
    });
    events.push(photoClubNight);

    // The cancelled night that started earlier today (D; N40).
    // DECISION quick-261110-ugi U4: the start is the LATER of local midnight of the seed's
    // day and the seed time minus 2 hours. REJECTED: a fixed evening hour today, because a
    // morning seed puts it in the future, where it lands in Later WITH a tag (the opposite
    // of N40). REJECTED: an unclamped seed-time-minus-2-hours, because before 02:00 it
    // falls on yesterday and reaches Past by the date split, skipping the started-today
    // routing N40 checks. The rule needs a reseed on the glance's own local day.
    const seedDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startedTodayAt = new Date(Math.max(seedDayStart.getTime(), now.getTime() - 2 * 60 * 60 * 1000));
    const cancelledTodayNight = await Event.create({ // 88.9-R2 fixture — cancelled after it started today (N40)
      group_id: strategyGroup.id,
      game_id: games[5].id, // Gloomhaven
      start_date: startedTodayAt,
      duration_minutes: 150,
      is_group_win: false,
      comments: 'Called off mid-game: the host had to leave.',
      status: 'cancelled',
    });
    events.push(cancelledTodayNight);

    // (f) Phase 88.9 after-build capture (quick 261115-seed-r3): the states capture rows
    //     P57-1 to P69-6 need that no earlier block produced (the row table is in the parent
    //     repo's 88.9-69-SUMMARY.md, "After-build pictures owed to the owner"). Alice's SMS
    //     entitlement (R1) sits with the users above; the rest is here.
    const DAY_MS = 24 * 60 * 60 * 1000;

    // The Saturday with three nights (P62-3: the "+N more" label; a day cell renders two tiles).
    // DECISION quick-261115-seed-r3 R2: three Strategy Squad Gloomhaven nights at fixed local
    // hours on ONE Saturday of the seed's local month (the month the calendar opens on).
    // Saturday, OVER any weekday: it is the grid's last column, where the label runs past the
    // card at 200% text (plan 88.9-62's finding). Strategy Squad, OVER Weekend Warriors (the
    // shared CI journey group stays unmutated, e2e-fixtures.js "DECISION Phase 88.3 (OQ-1)")
    // and OVER Photo Club or any other uncoloured group: FE e2e's month-tile spec measures the
    // plain tile on "a scheduled night of an uncoloured group the viewer is not a guest on", so
    // a new night of that kind changes what CI measures; a green group's nights never qualify.
    // WHICH Saturday: the nearest one still to come, else the nearest one behind, skipping
    // days other fixtures need. Never (hard): the seed day (N40's started-today night), the
    // day 3 days out (the Catan night and CI's own fixture night: their two tiles are the
    // ones that spec reads) and the day 12 days out (the two status nights: U1 above and its
    // pin want exactly two rows there). Avoided when another Saturday exists (soft): the days
    // of the other single nights (-11 and -4 Photo Club, +6 Dice Dynasty, +8 Photo Club, +10
    // Strategy Squad), so no fixture tile is pushed off its cell; a month whose Saturdays are
    // all soft still gets its trio. A month always has a Saturday outside the hard set. Ahead
    // of today the three are 'scheduled'; behind it, 'completed'. Gloomhaven, as U1 chose it.
    // Tidying this to "now + N days" breaks the Saturday on six days of every seven.
    const seedDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const HARD_DAYS = [0, 3, 12];
    const SOFT_DAYS = [-11, -4, 6, 8, 10];
    const saturdays = [];
    for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth++) {
      const day = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
      if (day.getMonth() !== now.getMonth()) break;
      if (day.getDay() !== 6) continue;
      // Rounded: a 23 or 25 hour DST day still counts as one day.
      const offset = Math.round((day.getTime() - seedDay.getTime()) / DAY_MS);
      if (!HARD_DAYS.includes(offset)) saturdays.push({ day, offset });
    }
    saturdays.sort((a, b) => (
      (Number(SOFT_DAYS.includes(a.offset)) - Number(SOFT_DAYS.includes(b.offset)))
      || (Number(a.offset < 0) - Number(b.offset < 0))
      || (Math.abs(a.offset) - Math.abs(b.offset))
    ));
    const trioDay = saturdays[0].day;
    const trioAhead = trioDay.getTime() > now.getTime();
    const trioNights = [];
    for (const [hours, comments] of [
      [13, 'Afternoon scenario: the early table.'],
      [16, 'Second table: Alice is dropping in as a guest.'],
      [19, 'Evening scenario: the late table.'],
    ]) {
      const trioNight = await Event.create({ // 88.9-R3 fixture — one of three nights on one Saturday (P62-3)
        group_id: strategyGroup.id,
        game_id: games[5].id, // Gloomhaven
        start_date: new Date(trioDay.getFullYear(), trioDay.getMonth(), trioDay.getDate(), hours, 0, 0, 0),
        duration_minutes: 150,
        is_group_win: false,
        comments,
        status: trioAhead ? 'scheduled' : 'completed',
      });
      events.push(trioNight);
      trioNights.push(trioNight);
    }

    // Guest nights on a tinted row and on a picture row (P63-2 / X27).
    // DECISION quick-261115-seed-r3 R3: Alice's own participation carries is_guest on the
    // middle Saturday night (Strategy Squad: tinted) and on a new Photo Club night 8 days out
    // (picture), both in groups she BELONGS to. That is a real state: joining a night by a
    // game-only link writes is_guest (routes/events.js, the game-token join) and nothing
    // clears it when the person later joins the group. Chosen OVER a new picture group
    // without Alice: a non-member cannot open the group page, and the guest row is owed on
    // the group-page list as well as on Home; and no membership the comments above protect
    // changes (Dice Dynasty keeps no Alice and stays her plain guest night). The Photo Club
    // night is 'scheduled' in an uncoloured group, but as a guest night it is never the plain
    // tile FE e2e measures (see R2). Frank and Eve are there as ordinary participants, so
    // neither night is guest-only. Ticket to Ride, the club's one played game, so its games
    // list does not grow. If the Saturday falls behind the seed day, the Gloomhaven guest row
    // is a played night in Frank's and Alice's history (no scores).
    await EventParticipation.create({ event_id: trioNights[1].id, user_id: users[5].id }); // Frank
    await EventParticipation.create({ event_id: trioNights[1].id, user_id: users[0].id, is_guest: true }); // 88.9-R3 fixture — Alice a guest on a tinted row (P63-2)
    const photoClubGuestNight = await Event.create({ // 88.9-R3 fixture — Alice a guest on a picture row (P63-2)
      group_id: photoClub.id,
      game_id: games[1].id, // Ticket to Ride
      start_date: new Date(now.getTime() + 8 * DAY_MS),
      duration_minutes: 60,
      is_group_win: false,
      comments: 'Club night: Alice came in on the game link before she joined.',
      status: 'scheduled',
    });
    events.push(photoClubGuestNight);
    await EventParticipation.create({ event_id: photoClubGuestNight.id, user_id: users[4].id }); // Eve
    await EventParticipation.create({ event_id: photoClubGuestNight.id, user_id: users[0].id, is_guest: true });

    // A picture row with RSVP counts, and the scores 57.50 and 57.00 (P60-3 chip; P65-1 / X50).
    // DECISION quick-261115-seed-r3 R4: an OLDER past Photo Club night (11 days back), OVER a
    // future one (a scheduled night of an uncoloured group Alice is not a guest on is exactly
    // the plain tile FE e2e measures, see R2) and OVER putting the answers on the Last Game
    // night above (that row is the "No RSVPs yet" frame, and N16 judged it as it is). Older
    // than that night, so "Last Game:" still names it. The list row prints its RSVP count at
    // every age, so a past row shows the chip. The club has two members and the three counts
    // need three people, so Frank, Diana and Bob are there as game-link guests (the RSVP route
    // accepts a participant who is not a member); Alice is not on the night at all, so none of
    // her history, stats or RSVP buttons move. Scores are DECIMAL(10,2): 57.5 and 57 are
    // stored and sent as "57.50" and "57.00", the two strings X50's formatter was built for.
    const photoClubRsvpNight = await Event.create({ // 88.9-R3 fixture — picture row with going / maybe / can't and scores 57.50, 57.00 (P60-3, P65-1)
      group_id: photoClub.id,
      game_id: games[1].id, // Ticket to Ride
      start_date: new Date(now.getTime() - 11 * DAY_MS),
      duration_minutes: 75,
      winner_id: users[4].id, // Eve won
      picked_by_id: users[4].id,
      is_group_win: false,
      comments: 'Half a point in it: Eve edged Frank on the last route.',
      status: 'completed',
    });
    events.push(photoClubRsvpNight);
    const rsvpNightRows = [
      { user: users[4], rsvp: 'yes', score: 57.5, placement: 1, is_guest: false }, // Eve
      { user: users[5], rsvp: 'yes', score: 57, placement: 2, is_guest: true }, // Frank
      { user: users[3], rsvp: 'maybe', score: 41, placement: 3, is_guest: true }, // Diana
      { user: users[1], rsvp: 'no', score: null, placement: null, is_guest: true }, // Bob
    ];
    for (const { user, rsvp, score, placement, is_guest } of rsvpNightRows) {
      await EventParticipation.create({ event_id: photoClubRsvpNight.id, user_id: user.id, score, placement, is_guest });
      await EventRsvp.create({ event_id: photoClubRsvpNight.id, user_uuid: user.id, status: rsvp });
    }

    // A night in the previous calendar year (P61-1: a Past row that prints its year).
    // DECISION quick-261115-seed-r3 R5: one completed Casual Gamers Codenames night on 20
    // December of last year at 19:00 local, a FIXED date OVER "now minus N days" (which is in
    // last year only for part of the year). Casual Gamers, because Alice belongs to it, it is
    // coloured (never the plain tile, see R2) and Codenames is already in its history. No
    // participants, so no per-user history moves.
    const lastYearNight = await Event.create({ // 88.9-R3 fixture — a night dated last year (P61-1)
      group_id: casualGroup.id,
      game_id: games[4].id, // Codenames
      start_date: new Date(now.getFullYear() - 1, 11, 20, 19, 0, 0, 0),
      duration_minutes: 30,
      is_group_win: true,
      comments: 'Holiday party round.',
      status: 'completed',
    });
    events.push(lastYearNight);

    // Six participants on the Catan night (P63-1 and P65-3: the strip shows five chips, then
    // "See all (N)"). Frank joins as a second guest beside Eve (sub-block (b)); he is not a
    // Weekend Warriors member, so he stays tickable in its invite panel (quick 261111-frd).
    await EventParticipation.create({ event_id: futureEvent1.id, user_id: users[5].id, is_guest: true }); // 88.9-R3 fixture — sixth participant, second guest (P63-1, P65-3)

    // Amber Aces (P64-1: Manage Members on an amber header).
    // DECISION quick-261115-seed-r3 R6: a NEW group storing the amber preset and no image,
    // with Alice as a PLAIN member, OVER recolouring a seeded group (each colour above serves
    // another row) and OVER making Alice its owner or admin: Weekend Warriors must stay the one
    // live group she can invite to (quick 261111-frd, N45 / N54). The group and its three
    // memberships are created with the other groups above; it has no event, so no calendar or
    // history moves. NOT seeded on purpose: an owner or admin role for Alice on a tinted or a
    // picture group (the gear on those cards and headers, P59-3 / P69-5), for the same
    // N45 / N54 reason. That is a decision for whoever owns the capture, not a seed gap to
    // fill quietly.
    const amberGroup = groups[7];
    console.log('   ✓ Walk states: open ballot (2 options), 2 guests (Eve at Catan, Alice at Dice Dynasty), 2 schedules (1 active, 1 paused), Casual Gamers blue + broken image, Azul dead images, Strategy Squad green + 3 status nights (2 future on one local day, 1 cancelled earlier today), Photo Club image + no colour');
    console.log(`   ✓ Capture states (quick 261115-seed-r3): 3 Strategy Squad nights on Saturday ${trioDay.toDateString()} (${trioAhead ? 'scheduled' : 'completed'}), Alice a guest on its 16:00 night and on a Photo Club night 8 days out, a Photo Club night 11 days back with 2 going / 1 maybe / 1 can't and scores 57.50 / 57.00, a Casual Gamers night on 20 December last year, Frank a second guest at Catan (6 participants), ${amberGroup.name} amber`);
    console.log(`✅ Created ${events.length} events with participations\n`);

    // Create Game Reviews
    console.log('⭐ Creating game reviews...');
    const reviews = [
      // Weekend Warriors reviews
      { user: users[0], group: weekendGroup, game: games[0], rating: 4.5, review_text: 'One of my favorites! Always a good time.', is_recommended: true },
      { user: users[1], group: weekendGroup, game: games[0], rating: 4, review_text: 'Classic strategy game. Great for groups.', is_recommended: true },
      { user: users[2], group: weekendGroup, game: games[1], rating: 5, review_text: 'Perfect gateway game. Easy to teach!', is_recommended: true },
      { user: users[3], group: weekendGroup, game: games[2], rating: 4.5, review_text: 'Beautiful artwork and engaging gameplay.', is_recommended: true },
      
      // Strategy Squad reviews
      { user: users[1], group: strategyGroup, game: games[5], rating: 5, review_text: 'Epic campaign game. Hours of fun!', is_recommended: true },
      { user: users[2], group: strategyGroup, game: games[5], rating: 4.5, review_text: 'Complex but rewarding. Love the legacy elements.', is_recommended: true },
      { user: users[4], group: strategyGroup, game: games[3], rating: 4, review_text: 'Quick and tactical. Great filler game.', is_recommended: true },
      { user: users[5], group: strategyGroup, game: games[3], rating: 3.5, review_text: 'Nice abstract game, but can be a bit dry.', is_recommended: false },
      
      // Casual Gamers reviews
      { user: users[3], group: casualGroup, game: games[4], rating: 4.5, review_text: 'Perfect party game! Always gets laughs.', is_recommended: true },
      { user: users[4], group: casualGroup, game: games[4], rating: 4, review_text: 'Great for non-gamers. Easy to learn.', is_recommended: true },
      { user: users[5], group: casualGroup, game: games[6], rating: 3, review_text: 'Needs more playtesting. Some rules unclear.', is_recommended: false },
    ];

    for (const { user, group, game, rating, review_text, is_recommended } of reviews) {
      await GameReview.findOrCreate({
        where: { user_id: user.id, group_id: group.id, game_id: game.id },
        defaults: { rating, review_text, is_recommended }
      });
    }
    console.log(`✅ Created ${reviews.length} game reviews\n`);

    // ────────────────────────────────────────────────────────────────────────
    // Phase 87.8 Plan 02 Task 1 — SPEC R8 availability check-in (DEC-4):
    // `npm run seed` ALONE produces Weekend Warriors' populated heatmap — no
    // secret, no chained script. CI-only token minting stays in e2e-fixtures.js.
    // ────────────────────────────────────────────────────────────────────────
    console.log('🗓️  Seeding availability check-in (R8 heatmap)...');

    // Week derivation — BOTH live heatmap read paths must reach this prompt:
    //  - services/availabilityService.js getGroupHeatmap (the EventHeatmapBackground
    //    surface) looks the prompt up by { group_id, status: 'active',
    //    week_identifier: <ISO week> }, deriving the ISO week from the caller's
    //    weekStart param (availabilityService.js:674-680, UTC Thursday algorithm).
    //  - The caller is the frontend: createEvent.js:326-334 derives "today" from the
    //    user's effective TZ (LOCAL wall clock), snaps to Monday (weekStartsOn: 1),
    //    and sends that yyyy-MM-dd Monday as weekStart.
    // So the seeded week_identifier must be the ISO week of LOCAL-today's Monday —
    // the week the browser will actually request at walkthrough time — NOT the ISO
    // week of an independently-derived UTC "today". The two diverge in evening
    // hours west of UTC at week boundaries (Sunday evening local is already Monday
    // UTC, which would seed NEXT week and leave the walkthrough's request empty).
    // We reproduce the FE's local-Monday first, then apply the backend's own
    // ISO-week algorithm to that Monday. Assumption: the machine running the seed
    // shares its TZ with the walkthrough browser (both the owner's machine).
    const localNow = new Date();
    const localNoon = new Date(Date.UTC(localNow.getFullYear(), localNow.getMonth(), localNow.getDate(), 12, 0, 0));
    const localDow = localNoon.getUTCDay() || 7; // 1=Mon .. 7=Sun (weekStartsOn: 1 semantics)
    const weekMonday = new Date(localNoon);
    weekMonday.setUTCDate(weekMonday.getUTCDate() - (localDow - 1));
    const weekStartStr = weekMonday.toISOString().slice(0, 10); // the string the FE would send
    // Backend ISO-week derivation, reproduced from services/availabilityService.js:674-680:
    const weekDate = new Date(weekStartStr + 'T00:00:00Z');
    const thursday = new Date(weekDate);
    thursday.setUTCDate(thursday.getUTCDate() + (4 - (thursday.getUTCDay() || 7)));
    const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
    const isoWeek = `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;

    const availabilityPrompt = await AvailabilityPrompt.create({
      group_id: weekendGroup.id,
      prompt_date: now,
      deadline: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      status: 'active',
      week_identifier: isoWeek,
      // created_by_user_id stays null (auto-style prompt) — satisfies the
      // availability_prompts_auto_group_week_unique partial index; the wipe block
      // above guarantees at most one such row per seed run.
    });

    // 30-minute sub-slots, because BOTH read paths AND consecutive halves
    // (HH:00 + HH:30) into one visible hour — a response stored as a single
    // multi-hour block would aggregate but never RENDER (routes/availabilityPrompt.js
    // hour bucketing needs both halves; availabilityService.js requires both the
    // date_HH:00 and date_HH:30 keys per hour).
    const slotAt = (dayOffset, hourUtc, halfHour, preference) => {
      const start = new Date(weekDate);
      start.setUTCDate(start.getUTCDate() + dayOffset);
      start.setUTCHours(hourUtc, halfHour ? 30 : 0, 0, 0);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      return { start: start.toISOString(), end: end.toISOString(), preference };
    };
    const hourSlots = (dayOffset, hourUtc, preference) => [
      slotAt(dayOffset, hourUtc, false, preference),
      slotAt(dayOffset, hourUtc, true, preference),
    ];

    // Three DELIBERATELY DIFFERENT patterns for visible heatmap contrast, with
    // shared exact {start, end} pairs layered in ON PURPOSE:
    // heatmapService.aggregateResponses keys suggestions on EXACT {start, end}
    // matches (round-3 finding ML#25), so merely-different patterns can legally
    // overlap nowhere. Overlap is guaranteed BY CONSTRUCTION here, not by chance:
    // Bob and Charlie share the full Friday 18:00-19:00 UTC hour (both 30-min
    // pairs), and Bob and Diana share Saturday 18:00-19:00 UTC.
    // Day offsets are from the week's Monday (4 = Friday, 5 = Saturday); UTC hours
    // 17-21 sit inside the heatmap's local 10:00-23:00 grid for both UTC and
    // US-Eastern viewers.
    const bobSlots = [ // broad, mostly preferred
      ...hourSlots(4, 17, 'preferred'),
      ...hourSlots(4, 18, 'preferred'), // ← shared exact pairs with Charlie
      ...hourSlots(4, 19, 'preferred'),
      ...hourSlots(4, 20, 'if-need-be'),
      ...hourSlots(5, 18, 'preferred'), // ← shared exact pairs with Diana
      ...hourSlots(5, 19, 'preferred'),
    ];
    const charlieSlots = [ // narrower, mixed preferences
      ...hourSlots(4, 18, 'preferred'), // ← shared exact pairs with Bob
      ...hourSlots(4, 19, 'if-need-be'),
    ];
    const dianaSlots = [ // available one hour only
      ...hourSlots(5, 18, 'if-need-be'), // ← shared exact pairs with Bob
    ];

    // DECISION Phase 87.8 (R8/DEC-4): responses for Bob, Charlie and Diana ONLY —
    // Alice's response is deliberately WITHHELD, chosen OVER seeding all four
    // members. promptLifecycleService.checkConsensusAndClose closes a prompt once
    // respondedCount >= totalActive (it returns not-closed while respondedCount <
    // totalActive), and Weekend Warriors has 4 active members — seeding 3 of 4 keeps
    // the prompt 'active' by construction (any roster LARGER than the 3 responders does),
    // so a real member can still respond during a walkthrough without the seed
    // having pre-tripped consensus auto-close. Adding Alice here is a decision,
    // not a completeness fix.
    const responseRows = [
      { user: users[1], time_slots: bobSlots },     // Bob
      { user: users[2], time_slots: charlieSlots }, // Charlie
      { user: users[3], time_slots: dianaSlots },   // Diana
    ];
    for (const { user, time_slots } of responseRows) {
      await AvailabilityResponse.create({
        prompt_id: availabilityPrompt.id,
        // user_uuid MUST come from the User instance's .id (Users.id UUID) — never
        // .user_id, which is the Auth0 sub string (Phase 87.5 UUID re-key).
        user_uuid: user.id,
        time_slots,
        user_timezone: 'America/New_York',
        submitted_at: now, // NULL would exclude the row from every responded/consensus query
      });
    }
    console.log(`   ✓ Created 1 active check-in (${isoWeek}) with 3 responses (Bob, Charlie, Diana)`);

    // This single call is what makes the seed reachable by the per-prompt heatmap
    // route (routes/availabilityPrompt.js GET /prompts/:promptId/heatmap reads
    // AvailabilitySuggestion rows, never raw responses). The ISO-week
    // week_identifier above is what makes the prompt independently reachable by
    // availabilityService.getGroupHeatmap. Both paths are needed — different
    // frontend surfaces read them and neither substitutes for the other.
    const aggregation = await heatmapService.aggregateResponses(availabilityPrompt.id);
    console.log(`   ✓ aggregateResponses: ${aggregation.suggestionCount} suggestion rows (${aggregation.message})`);

    // Consensus sanity line — same query shape as promptLifecycleService.checkConsensusAndClose (the totalActive / respondedCount counts)
    // uses — so a human running `npm run seed` sees at a glance that consensus
    // was NOT tripped.
    const totalActive = await UserGroup.count({
      where: { group_id: weekendGroup.id, status: 'active' },
    });
    const respondedCount = await AvailabilityResponse.count({
      where: { prompt_id: availabilityPrompt.id, submitted_at: { [Op.ne]: null } },
    });
    console.log(`   ✓ Consensus check: respondedCount ${respondedCount} / totalActive ${totalActive} — prompt stays '${availabilityPrompt.status}' (Alice deliberately withheld)\n`);

    // ────────────────────────────────────────────────────────────────────────
    // Phase 88-34 Task 5 (WI-B4) — the four models the walk had to hand-seed.
    //
    // These blocks codify the shapes the Phase 88 UAT walk built BY HAND on
    // 2026-08-10. Hand-seeded state is destroyed by the next reseed, which is
    // why the walk DB became hand-curated and un-reseedable — this section is
    // what makes a fresh `npm run seed` walkable end-to-end instead.
    // ────────────────────────────────────────────────────────────────────────

    // --- Friendships: four accepted, one pending ----------------------------
    // Both states are needed: accepted drives the friend list + the
    // invite-by-friend path, pending drives the incoming-request surface AND
    // the friend-pill staleness the walk flagged.
    console.log('🤝 Seeding friendships (88-34 WI-B4)...');
    await Friendship.create({
      requester_uuid: users[0].id, // Alice
      addressee_uuid: users[3].id, // Diana
      status: 'accepted',
    });
    await Friendship.create({
      requester_uuid: users[2].id, // Charlie
      addressee_uuid: users[0].id, // -> Alice (INCOMING pending request for Alice)
      status: 'pending',
    });
    // DECISION quick-261111-frd (88.9-51 glance rows N45 / N54): three MORE accepted
    // friends — Eve, Frank and Bartholomew — chosen because none of them is a Weekend
    // Warriors member (the one live group Alice owns, so the one she can invite to), OVER
    // (a) befriending Bob or Charlie, who are members there and would render as disabled
    // checkboxes like Diana, and (b) staging friends per walk with a scratch insert, which
    // the next reseed destroys (README-seed.md: the seed is the fixture layer). N45 ticks two
    // friends and then a third while the first send is held, so three is the floor. Bob keeps
    // NO friendship row on purpose: he is the Weekend Warriors member whose name popover
    // offers a live "Add friend". Tidying these away re-blocks both glance rows.
    for (const friend of [users[4], users[5], users[6]]) { // 88.9-R2 fixture — Eve, Frank, Bartholomew: invitable accepted friends (N45, N54)
      await Friendship.create({
        requester_uuid: users[0].id, // Alice
        addressee_uuid: friend.id,
        status: 'accepted',
      });
    }
    console.log('   ✓ 5 friendships (Alice<->Diana, Eve, Frank, Bartholomew accepted; Charlie->Alice pending)\n');

    // --- Game collections ---------------------------------------------------
    // UserGame is the "my collection" surface and the BringGamePicker source.
    // Two users so the picker has something to show for more than one member.
    console.log('🎒 Seeding game collections (88-34 WI-B4)...');
    const collectionRows = [
      { user: users[0], game: games[0] }, // Alice: Catan
      { user: users[0], game: games[1] },
      { user: users[0], game: games[2] },
      { user: users[1], game: games[3] }, // Bob
    ];
    for (const { user, game } of collectionRows) {
      await UserGame.findOrCreate({
        where: { user_id: user.id, game_id: game.id },
        defaults: {},
      });
    }
    console.log(`   ✓ ${collectionRows.length} collection games (Alice x3, Bob x1)\n`);

    // --- Recurring availability patterns ------------------------------------
    // These feed the saved-availability PREFILL endpoint, which is what makes
    // the check-in grid pre-paintable from a fresh seed.
    //
    // WHY A FULL WEEK OF EVENING PATTERNS FOR ONE USER (88-34 Task 3 / M6): the
    // check-in window is a ROLLING seven days anchored on the prompt date, so
    // which weekday lands on the window's LAST local day depends on the day the
    // seed is run. The M6 bug specifically dropped the last local day's evening
    // (>= 17:00 local) from the prefill response. Seeding an evening pattern on
    // EVERY weekday for Alice guarantees the last local day always has one,
    // whatever day the seed runs — so the Task-3 fix is exercised by every seed,
    // not just by seeds that happen to run on the right weekday. Do not "tidy"
    // this down to a single day; the coverage is the point.
    //
    // The timezone is deliberately a NEGATIVE-offset zone (America/Los_Angeles):
    // that is the sign that produces the M6 clip (local 17:00 PDT is already the
    // next UTC day), so a positive-offset zone would not exercise it.
    console.log('🗓️  Seeding recurring availability patterns (88-34 WI-B4)...');
    const AVAIL_TZ = 'America/Los_Angeles';
    const patternStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    const availabilityRows = [];
    // Alice — evenings all week (the Task-3 / M6 exerciser).
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      availabilityRows.push({
        user: users[0],
        pattern_data: { dayOfWeek, startTime: '17:00', endTime: '22:00', timezone: AVAIL_TZ },
      });
    }
    // Bob — weekday afternoons.
    for (const dayOfWeek of [1, 2, 3, 4, 5]) {
      availabilityRows.push({
        user: users[1],
        pattern_data: { dayOfWeek, startTime: '13:00', endTime: '17:00', timezone: AVAIL_TZ },
      });
    }
    // Charlie — weekend daytime.
    for (const dayOfWeek of [0, 6]) {
      availabilityRows.push({
        user: users[2],
        pattern_data: { dayOfWeek, startTime: '10:00', endTime: '15:00', timezone: AVAIL_TZ },
      });
    }
    // Diana — two evenings, so a third user shows on the heatmap.
    for (const dayOfWeek of [2, 4]) {
      availabilityRows.push({
        user: users[3],
        pattern_data: { dayOfWeek, startTime: '19:00', endTime: '23:00', timezone: AVAIL_TZ },
      });
    }

    for (const { user, pattern_data } of availabilityRows) {
      await UserAvailability.create({
        // Phase 87.5 UUID re-key: user_uuid is Users.id, NOT the Auth0 sub.
        user_uuid: user.id,
        type: 'recurring_pattern',
        pattern_data,
        start_date: patternStart,
        end_date: null,
        is_available: null,
        timezone: AVAIL_TZ,
      });
    }
    console.log(`   ✓ ${availabilityRows.length} recurring patterns (Alice 7 evenings, Bob 5, Charlie 2, Diana 2)\n`);

    // --- One pending group invite -------------------------------------------
    // Exercises the invite-pending surface AND the two 409 paths Task 4 added
    // machine-readable codes to (re-inviting this email now returns
    // invite_pending; inviting an existing member returns already_member).
    //
    // SECURITY — the token is generated AT RUNTIME, never committed. This
    // repository is PUBLIC, and a GroupInvite token IS the credential that joins
    // a group: a hard-coded literal here would be a permanently-published,
    // predictable join credential for every database this seed has ever touched.
    // Do not replace this with a fixed string "so tests can find it" — query the
    // row for its token instead.
    console.log('✉️  Seeding a pending group invite (88-34 WI-B4)...');
    const pendingInvite = await GroupInvite.create({
      group_id: weekendGroup.id,
      invited_email: 'pending-invitee@example.com',
      invited_by_uuid: users[0].id, // Alice, the Weekend Warriors owner
      token: crypto.randomBytes(32).toString('hex'), // runtime-generated, never a literal
      status: 'pending',
    });
    console.log(`   ✓ 1 pending invite to ${pendingInvite.invited_email} (token generated at runtime)\n`);

    // ────────────────────────────────────────────────────────────────────────
    // Token fixtures (Phase 88.9 round 2, quick 261103-glx). The two token states
    // the 88.9 round-1 walk could not reach from a fresh seed: Alice's open RSVP
    // links and a group-restore link for a soft-deleted group. Owner rule
    // (2026-10-27): a blocked walk row is a seed change, never a scratch insert.
    // ────────────────────────────────────────────────────────────────────────
    console.log('🔗 Seeding the walk token fixtures (quick 261103-glx)...');
    // frontendUrl is defined once, in walk-states sub-block (e) above (Photo Club's image).

    // --- Alice's RSVP links on the Weekend Warriors Catan night ---------------
    // DECISION quick-261103-glx G5: a MISSING secret skips the mint with a notice,
    // chosen to keep DEC-4's property ("`npm run seed` ALONE produces Weekend
    // Warriors' populated heatmap — no secret, no chained script. CI-only token
    // minting stays in e2e-fixtures.js."). A FAILED mint fails the seed, chosen
    // OVER the routes' best-effort .catch: a seed that "succeeds" without the link
    // reproduces the `not reached` UAT state silently, and nothing downstream would
    // notice. mintRsvpBatch throws on failure (no catch, so none here either); the
    // falsy check guards its docstring's "null on failure" promise in case the code
    // is ever changed to match it. The secret is never printed, in whole or part.
    const rsvpUrls = [];
    if (!process.env.MAGIC_TOKEN_SECRET) {
      // Unset OR empty — createHmac throws on an undefined key.
      console.log('   ⚠️  RSVP links NOT minted: MAGIC_TOKEN_SECRET is not set — the secret signs the link; set it in the backend env (the value the server uses) to get one.');
    } else {
      const rsvpBatchId = await rsvpLinks.mintRsvpBatch(futureEvent1.id, users[0].user_id);
      if (!rsvpBatchId) {
        throw new Error('Seeding the RSVP fixture failed: mintRsvpBatch returned no batch id');
      }
      for (const status of ['yes', 'maybe', 'no']) {
        rsvpUrls.push({ status, url: rsvpLinks.generateRsvpUrl(frontendUrl, futureEvent1.id, users[0].user_id, status) });
      }
      console.log(`   ✓ 3 RSVP links minted for Alice (yes / maybe / no, Weekend Warriors Catan night)`);
    }

    // --- Retired Raiders: one past event, then the soft delete ---------------
    // The event is NOT pushed into `events` — the live-event count stays as is;
    // this one is hidden with its group.
    const retiredGroup = groups[5];
    const retiredEvent = await Event.create({
      group_id: retiredGroup.id,
      game_id: games[1].id, // Ticket to Ride
      start_date: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
      duration_minutes: 70,
      winner_id: users[0].id, // Alice won
      picked_by_id: users[1].id, // Bob picked
      is_group_win: false,
      comments: 'Last game night before the group retired.',
      status: 'completed',
    });
    await EventParticipation.create({ event_id: retiredEvent.id, user_id: users[0].id, score: 112, placement: 1, is_new_player: false });
    await EventParticipation.create({ event_id: retiredEvent.id, user_id: users[1].id, score: 98, placement: 2, is_new_player: false });
    await EventParticipation.create({ event_id: retiredEvent.id, user_id: users[4].id, score: 87, placement: 3, is_new_player: false });

    // DECISION quick-261103-glx G3: Retired Raiders is soft-deleted through
    // softDeleteGroup — the service the DELETE route calls — chosen OVER inserting
    // pre-stamped rows or a hand-written destroy, because the service is the one
    // place that writes the single deletedAt stamp, purge_after and the random
    // 32-byte restore nonce together (a copy here would drift silently, and a
    // destroy on the group trips the F-02 CI gate). The nonce is random, never
    // derived from MAGIC_TOKEN_SECRET (same rule as the e2e fixture's DECISION
    // Phase 87.8 R7). `recipients` is ignored: the service sends no email — the
    // route does the fanout — so nothing is mailed from here.
    const { nonce: restoreNonce } = await softDeleteGroup(retiredGroup.id, { excludeUserUuid: users[0].id });
    // Same link shape and FRONTEND_URL fallback as the DELETE route's emailed link.
    const restoreUrl = `${frontendUrl}/restore/group/${restoreNonce}`;
    console.log(`   ✓ Retired Raiders soft-deleted (3 memberships + 1 past event hidden), 1 group-restore token minted\n`);

    console.log('🎉 Database seeding completed successfully!\n');
    console.log('📊 Summary:');
    console.log(`   - ${users.length} users`);
    console.log(`   - ${groups.length} groups (1 of them soft-deleted: Retired Raiders, restorable for 30 days)`);
    console.log(`   - ${userGroups.length} user-group memberships (3 hidden with Retired Raiders)`);
    console.log(`   - ${games.length} games`);
    console.log(`   - ${events.length} events (${events.filter((e) => e.start_date.getTime() <= now.getTime()).length} already started, ${events.filter((e) => e.start_date.getTime() > now.getTime()).length} still to come), plus 1 past event hidden with Retired Raiders`);
    console.log(`   - ${reviews.length} reviews`);
    // Phase 88-34 Task 5 (WI-B4): report the new sections too, so a human
    // running the seed can see at a glance that the Test-2 gates are walkable.
    console.log(`   - 5 friendships (4 accepted, 1 pending)`);
    console.log(`   - ${collectionRows.length} collection games`);
    console.log(`   - ${availabilityRows.length} recurring availability patterns`);
    console.log(`   - 1 pending group invite`);
    // Phase 88.9 round 1b: the walk states, so a reader sees they are seeded.
    console.log(`   - 1 open ballot (2 options), 8 guest participations (3 of them Alice's own), 2 prompt schedules, 1 coloured group with a broken image, 1 game with dead images, Strategy Squad green, 3 status nights, 1 no-colour photo group (Photo Club)`);
    console.log(`   - capture states: 3 nights on one Saturday, 4 RSVP answers on one Photo Club night, 1 night dated last year, 1 amber group, Alice's SMS entitlement + verified fictional phone`);
    if (rsvpUrls.length) {
      console.log(`   - 3 RSVP links for Alice (yes / maybe / no, Weekend Warriors Catan night)`);
    } else {
      console.log(`   - RSVP links not minted (MAGIC_TOKEN_SECRET is not set)`);
    }
    console.log(`   - 1 group-restore link (Retired Raiders)`);

    // DECISION quick-261103-glx G6: the walk links are printed only when CI is
    // unset — chosen OVER printing everywhere, because both CI jobs that run this
    // seed (BE ci.yml and the FE e2e job) write to PUBLIC Actions logs, and a
    // token in a public log is a published credential (T-82-11). Locally the owner
    // needs the links to paste into a browser. Read at call time, not at load.
    const linksVisible = !process.env.CI;
    if (linksVisible) {
      console.log('\n🔗 Walk links (paste into a browser):');
      for (const { status, url } of rsvpUrls) {
        console.log(`   - Alice RSVP ${status} (Weekend Warriors Catan night): ${url}`);
      }
      if (rsvpUrls.length) {
        console.log('     The RSVP links are single-use: opening one answers the RSVP and revokes the other two. Reseed for fresh ones.');
        console.log('     They work only until the Catan night starts, about 3 days after this seed (after that the respond route answers 410 for a past event) — reseed close to the walk.');
        // Review finding 1 (quick 261103-glx): when Alice was seeded on the fallback
        // sub, the links are signed over it, and the repoint needed to sign in as
        // Alice breaks them.
        // DECISION quick-261103-glx WR-02: the notice compares the sub Alice was
        // actually seeded on (users[0], from sampleUsers, fixed when this module
        // loaded) with ALICE_PLACEHOLDER_SUB, chosen OVER re-reading AUTH0_ALICE_SUB
        // here: the env var read now can differ from the one sampleUsers captured at
        // load, and the notice states a fact about the links, not about the env.
        if (users[0].user_id === ALICE_PLACEHOLDER_SUB) {
          console.log("   ⚠️  RSVP links are signed over Alice's placeholder sub; a later repoint of Alice breaks them — set AUTH0_ALICE_SUB and reseed.");
        }
      }
      console.log(`   - Restore Retired Raiders: ${restoreUrl}`);
    } else {
      console.log('\n🔗 Walk links minted but not printed — CI is set, and a public Actions log never carries a token (T-82-11).');
    }
    console.log('\n✨ Your database is now populated with sample data!');

  } catch (error) {
    console.error('❌ Error seeding database:', seedErrorForLog(error));
    throw error;
  } finally {
    if (closeConnection) {
      await sequelize.close();
    }
  }
}

// Run the seed script
if (require.main === module) {
  seedDatabase()
    .then(() => {
      console.log('\n✅ Seeding complete!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Seeding failed:', seedErrorForLog(error));
      process.exit(1);
    });
}

module.exports = { seedDatabase, ALICE_PLACEHOLDER_SUB };

