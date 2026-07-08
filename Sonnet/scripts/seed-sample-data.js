// scripts/seed-sample-data.js
const { User, Group, UserGroup, Game, Event, EventParticipation, GameReview, sequelize } = require('../models');

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
    await GameReview.destroy({ where: {} });
    await EventParticipation.destroy({ where: {} });
    await Event.destroy({ where: {} });
    await UserGroup.destroy({ where: {} });
    await Game.destroy({ where: {} });
    await Group.destroy({ where: {} });
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

