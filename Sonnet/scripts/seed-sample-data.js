// scripts/seed-sample-data.js
const { Op } = require('sequelize');
const {
  User, Group, UserGroup, Game, Event, EventParticipation, GameReview,
  AvailabilityPrompt, AvailabilityResponse, AvailabilitySuggestion, sequelize,
} = require('../models');
const heatmapService = require('../services/heatmapService');
const { assertNotProductionDb } = require('./lib/assert-not-production-db');

// Sample data arrays
// NOTE: user_id should match your Auth0 'sub' claim value
// To get your Auth0 sub: Log in to the app and check browser console
// Or check Auth0 Dashboard > Users > [User] > User ID field
// You can also set these via environment variables:
//   AUTH0_ALICE_SUB, AUTH0_BOB_SUB, etc.
const sampleUsers = [
  { 
    user_id: process.env.AUTH0_ALICE_SUB || 'auth0|6959f749afc6f7d1e7fb1635', 
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
];

const sampleGroups = [
  { group_id: 'weekend-warriors', name: 'Weekend Warriors' },
  { group_id: 'strategy-squad', name: 'Strategy Squad' },
  { group_id: 'casual-gamers', name: 'Casual Gamers' },
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

async function seedDatabase() {
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

    // Sync database
    await sequelize.sync({ alter: true });
    console.log('✅ Database synced\n');

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
    await AvailabilitySuggestion.destroy({ where: {} });
    await AvailabilityResponse.destroy({ where: {} });
    await AvailabilityPrompt.destroy({ where: {} });
    await GameReview.destroy({ where: {} });
    await EventParticipation.destroy({ where: {} });
    await Event.destroy({ where: {}, force: true });
    await UserGroup.destroy({ where: {}, force: true });
    await Game.destroy({ where: {} });
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
      
      // Strategy Squad: Frank (owner), Bob, Charlie (admin), Eve
      { user: users[5], group: groups[1], role: 'owner' },
      { user: users[1], group: groups[1], role: 'member' },
      { user: users[2], group: groups[1], role: 'admin' },
      { user: users[4], group: groups[1], role: 'member' },
      
      // Casual Gamers: Diana (owner), Eve, Frank
      { user: users[3], group: groups[2], role: 'owner' },
      { user: users[4], group: groups[2], role: 'member' },
      { user: users[5], group: groups[2], role: 'member' },
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
    // members. promptLifecycleService.checkConsensusAndClose closes a prompt the
    // instant respondedCount === totalActive, and Weekend Warriors has exactly 4
    // active members — seeding 3 of 4 keeps the prompt 'active' by construction,
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

    // Consensus sanity line — same query shape promptLifecycleService.js:56-70
    // uses — so a human running `npm run seed` sees at a glance that consensus
    // was NOT tripped.
    const totalActive = await UserGroup.count({
      where: { group_id: weekendGroup.id, status: 'active' },
    });
    const respondedCount = await AvailabilityResponse.count({
      where: { prompt_id: availabilityPrompt.id, submitted_at: { [Op.ne]: null } },
    });
    console.log(`   ✓ Consensus check: respondedCount ${respondedCount} / totalActive ${totalActive} — prompt stays '${availabilityPrompt.status}' (Alice deliberately withheld)\n`);

    console.log('🎉 Database seeding completed successfully!\n');
    console.log('📊 Summary:');
    console.log(`   - ${users.length} users`);
    console.log(`   - ${groups.length} groups`);
    console.log(`   - ${userGroups.length} user-group memberships`);
    console.log(`   - ${games.length} games`);
    console.log(`   - ${events.length} events`);
    console.log(`   - ${reviews.length} reviews`);
    console.log('\n✨ Your database is now populated with sample data!');

  } catch (error) {
    console.error('❌ Error seeding database:', error);
    throw error;
  } finally {
    await sequelize.close();
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
      console.error('\n❌ Seeding failed:', error);
      process.exit(1);
    });
}

module.exports = { seedDatabase };

