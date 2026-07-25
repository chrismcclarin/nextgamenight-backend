#!/usr/bin/env node

/**
 * MongoDB → PostgreSQL Migration Script
 *
 * Migrates board game play records from the old MongoDB backend (gamecalenderbackend)
 * to the new PostgreSQL backend (periodictabletopbackend_v2).
 *
 * MongoDB collections:
 *   - bgs: Board game play records with player data
 *   - users: User records (username, email, user_id)
 *   - groups: Group records (Name, Userlist, group_id)
 *
 * PostgreSQL targets:
 *   - Games: Game catalog (find or create by name)
 *   - Events: Play session records
 *   - EventParticipation: Player participation with scores
 *
 * Usage:
 *   1. Fill in the CONFIG section below
 *   2. Run with --preview to see what will be migrated:
 *        node scripts/migrate-mongodb-to-postgres.js --preview
 *   3. Run with --dry-run to simulate without writing:
 *        node scripts/migrate-mongodb-to-postgres.js --dry-run
 *   4. Run for real:
 *        node scripts/migrate-mongodb-to-postgres.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Sequelize, DataTypes, Op } = require('sequelize');

// ============================================================
// PostgreSQL connection — uses CONFIG.POSTGRES_URL directly
// instead of the default config/database.js (which targets localhost)
// ============================================================

function createSequelize(url) {
  return new Sequelize(url, {
    dialect: 'postgresql',
    logging: false,
    dialectOptions: {
      ssl: { require: true, rejectUnauthorized: false },
      connectTimeout: 30000,
    },
    pool: { max: 5, min: 0, acquire: 60000, idle: 10000 },
  });
}

// Define models inline so they use our custom connection, not the default one
function defineModels(sequelize) {
  const User = sequelize.define('User', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    username: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false },
    user_id: { type: DataTypes.STRING, allowNull: false },
  }, { timestamps: true });

  const Group = sequelize.define('Group', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    group_id: { type: DataTypes.STRING },
  }, { timestamps: true });

  const Game = sequelize.define('Game', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    bgg_id: { type: DataTypes.INTEGER, allowNull: true, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    year_published: { type: DataTypes.INTEGER, allowNull: true },
    min_players: { type: DataTypes.INTEGER, allowNull: true },
    max_players: { type: DataTypes.INTEGER, allowNull: true },
    playing_time: { type: DataTypes.INTEGER, allowNull: true },
    weight: { type: DataTypes.DECIMAL(4, 2), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    image_url: { type: DataTypes.STRING, allowNull: true },
    thumbnail_url: { type: DataTypes.STRING, allowNull: true },
    is_custom: { type: DataTypes.BOOLEAN, defaultValue: false },
    theme: { type: DataTypes.STRING, allowNull: true },
    url: { type: DataTypes.STRING, allowNull: true },
  }, { timestamps: true });

  const Event = sequelize.define('Event', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    group_id: { type: DataTypes.UUID, allowNull: false },
    game_id: { type: DataTypes.UUID, allowNull: true },
    start_date: { type: DataTypes.DATE, allowNull: false },
    duration_minutes: { type: DataTypes.INTEGER, allowNull: true },
    winner_id: { type: DataTypes.UUID, allowNull: true },
    picked_by_id: { type: DataTypes.UUID, allowNull: true },
    winner_name: { type: DataTypes.STRING, allowNull: true },
    picked_by_name: { type: DataTypes.STRING, allowNull: true },
    custom_participants: { type: DataTypes.JSONB, allowNull: true, defaultValue: [] },
    is_group_win: { type: DataTypes.BOOLEAN, defaultValue: false },
    comments: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM('scheduled', 'in_progress', 'completed', 'cancelled'), defaultValue: 'completed' },
    rsvp_deadline: { type: DataTypes.DATE, allowNull: true },
    ballot_status: { type: DataTypes.ENUM('open', 'closed'), allowNull: true, defaultValue: null },
  }, { timestamps: true });

  const EventParticipation = sequelize.define('EventParticipation', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    event_id: { type: DataTypes.UUID, allowNull: false },
    user_id: { type: DataTypes.UUID, allowNull: false },
    score: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    faction: { type: DataTypes.STRING, allowNull: true },
    is_new_player: { type: DataTypes.BOOLEAN, defaultValue: false },
    placement: { type: DataTypes.INTEGER, allowNull: true },
  }, { timestamps: true });

  return { User, Group, Game, Event, EventParticipation };
}

// ============================================================
// CONFIG — Fill these in before running
// ============================================================

const CONFIG = {
  // MongoDB Atlas connection string
  MONGO_URI: process.env.MONGO_URI || 'mongodb+srv://admin:860148286@cluster0.extay.mongodb.net/Boardgamelist?retryWrites=true&w=majority',

  // Production Railway PostgreSQL connection (public proxy)
  // Set via MIGRATION_DATABASE_URL env var or defaults to Railway public proxy
  POSTGRES_URL: process.env.MIGRATION_DATABASE_URL || 'postgresql://postgres:jxcXfPLplNMVsfbykletCpXIYolIhwEJ@gondola.proxy.rlwy.net:12889/railway',

  // The PostgreSQL Group UUID to associate imported events with
  TARGET_GROUP_ID: '9c408dd8-2fa2-49a0-999d-01f74cef1b2c',

  // Player name mapping: MongoDB player name → PostgreSQL User UUID
  // Players NOT in this mapping will be added as custom_participants on the Event.
  PLAYER_MAPPING: {
    'Chris': '3d9473c0-5fb1-4735-a8ae-a3bca3500db4',
    'Eavan': '945f6f27-88c6-4f06-a4ef-ebd208c3d998',
    'Evan': '945f6f27-88c6-4f06-a4ef-ebd208c3d998',  // same person as Eavan, misspelled
    'Kevin': '8faba948-c69f-4efc-9dc0-0f11748d6ac0',
    'Eric': 'b18e0c06-ee82-4f23-b5ba-5c13a9eef7cd',
    // Andy, Becca, Justin → custom_participants (no PostgreSQL accounts / not in group)
  },

  // Game name corrections: MongoDB name → corrected name
  // Fixes misspellings and merges alternate names into canonical versions
  NAME_CORRECTIONS: {
    '6 Mimmit': '6 Nimmt',                              // misspelling
    'Cant Stop': "Can't Stop",                           // missing apostrophe
    'Teotihucan': 'Teotihuacan',                         // missing 'a'
    "The King's Dilema": "The King's Dilemma",           // missing 'm'
    'Quacks of Quedlinberg': 'The Quacks of Quedlinburg', // misspelling + missing 'The'
    'Diskworld: Ankh-Morpork': 'Discworld: Ankh-Morpork', // Disk vs Disc
    'Dead of Winter': 'Dead of Winter: A Crossroads Game', // merge with PG full title
    "Tzolk'in": "Tzolk'in: The Mayan Calendar",          // merge with PG full title
    'Hansa Teutonica': 'Hansa Teutonica: Big Box',        // same game, Big Box is reprint
  },

  // Game names to skip entirely
  SKIP_GAMES: ['test'],
};

// ============================================================
// MongoDB Schema (mirrors old backend)
// ============================================================

const BGSchema = new mongoose.Schema({
  Name: String,
  Players: [{
    Player: String,
    Winner: Boolean,
    New: Boolean,
    Score: Number,
    Faction: String,
    Picked: Boolean,
  }],
  Groupwin: Boolean,
  GameComments: String,
  url: String,
  theme: String,
  startDate: Date,
  Length: Number,
}, { timestamps: true, collection: 'bgs' });

const MongoUser = mongoose.model('bgs_migration_users', new mongoose.Schema({
  username: String,
  email: String,
  user_id: String,
}, { timestamps: true, collection: 'users' }));

const MongoGroup = mongoose.model('bgs_migration_groups', new mongoose.Schema({
  Name: String,
  Userlist: Array,
  group_id: String,
}, { timestamps: true, collection: 'groups' }));

const BG = mongoose.model('bgs_migration_bgs', BGSchema);

// ============================================================
// Main Script
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const isPreview = args.includes('--preview');
  const isDryRun = args.includes('--dry-run');

  // Validate config (unless preview mode)
  if (!isPreview) {
    if (CONFIG.MONGO_URI === 'YOUR_MONGODB_ATLAS_CONNECTION_STRING_HERE') {
      console.error('ERROR: Set CONFIG.MONGO_URI to your MongoDB Atlas connection string.');
      process.exit(1);
    }
    if (CONFIG.TARGET_GROUP_ID === 'YOUR_GROUP_UUID_HERE') {
      console.error('ERROR: Set CONFIG.TARGET_GROUP_ID to your PostgreSQL group UUID.');
      process.exit(1);
    }
    if (Object.keys(CONFIG.PLAYER_MAPPING).length === 0) {
      console.warn('WARNING: PLAYER_MAPPING is empty. All players will be added as custom_participants.');
      console.warn('Run with --preview first to see player names and PostgreSQL users.\n');
    }
  } else {
    if (CONFIG.MONGO_URI === 'YOUR_MONGODB_ATLAS_CONNECTION_STRING_HERE') {
      console.error('ERROR: Set CONFIG.MONGO_URI to your MongoDB Atlas connection string (needed even for preview).');
      process.exit(1);
    }
  }

  // Connect to MongoDB
  console.log('Connecting to MongoDB Atlas...');
  await mongoose.connect(CONFIG.MONGO_URI);
  console.log('Connected to MongoDB.\n');

  if (isPreview) {
    await runPreview();
  } else {
    await runMigration(isDryRun);
  }

  await mongoose.disconnect();
  console.log('\nMongoDB disconnected.');
}

// ============================================================
// Preview Mode — Shows data from both databases for mapping
// ============================================================

async function runPreview() {
  // Connect to PostgreSQL via CONFIG.POSTGRES_URL
  const sequelize = createSequelize(CONFIG.POSTGRES_URL);
  const { User, Group, Game } = defineModels(sequelize);

  console.log('=== PREVIEW MODE ===\n');

  // --- MongoDB Data ---
  const bgRecords = await BG.find({}).sort({ startDate: 1 });
  const mongoUsers = await MongoUser.find({});
  const mongoGroups = await MongoGroup.find({});

  console.log(`--- MongoDB Data ---`);
  console.log(`Total board game records (bgs): ${bgRecords.length}`);
  console.log(`Total users: ${mongoUsers.length}`);
  console.log(`Total groups: ${mongoGroups.length}\n`);

  // Extract unique player names
  const playerNames = new Set();
  for (const bg of bgRecords) {
    for (const player of bg.Players || []) {
      if (player.Player && player.Player.trim()) {
        playerNames.add(player.Player.trim());
      }
    }
  }

  console.log(`Unique player names found in game records:`);
  for (const name of [...playerNames].sort()) {
    console.log(`  - "${name}"`);
  }

  // Show MongoDB users
  console.log(`\nMongoDB users:`);
  for (const u of mongoUsers) {
    console.log(`  - username: "${u.username}", email: "${u.email}", user_id: "${u.user_id}"`);
  }

  // Show MongoDB groups
  console.log(`\nMongoDB groups:`);
  for (const g of mongoGroups) {
    console.log(`  - Name: "${g.Name}", group_id: "${g.group_id}", members: ${JSON.stringify(g.Userlist)}`);
  }

  // Show unique game names
  const gameNames = new Set();
  for (const bg of bgRecords) {
    if (bg.Name && bg.Name.trim()) {
      gameNames.add(bg.Name.trim());
    }
  }
  console.log(`\nUnique game names (${gameNames.size} total):`);
  for (const name of [...gameNames].sort()) {
    const count = bgRecords.filter(bg => bg.Name && bg.Name.trim() === name).length;
    console.log(`  - "${name}" (${count} play${count !== 1 ? 's' : ''})`);
  }

  // Show date range
  const dates = bgRecords.filter(bg => bg.startDate).map(bg => bg.startDate);
  if (dates.length > 0) {
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    console.log(`\nDate range: ${minDate.toISOString().split('T')[0]} → ${maxDate.toISOString().split('T')[0]}`);
  }

  // --- PostgreSQL Data ---
  console.log(`\n--- PostgreSQL Data ---`);

  try {
    await sequelize.authenticate();

    const pgUsers = await User.findAll({ attributes: ['id', 'username', 'email', 'user_id'] });
    console.log(`\nPostgreSQL users (${pgUsers.length} total):`);
    for (const u of pgUsers) {
      console.log(`  - UUID: "${u.id}", username: "${u.username}", email: "${u.email}"`);
    }

    const pgGroups = await Group.findAll({ attributes: ['id', 'name', 'group_id'] });
    console.log(`\nPostgreSQL groups (${pgGroups.length} total):`);
    for (const g of pgGroups) {
      console.log(`  - UUID: "${g.id}", name: "${g.name}", group_id: "${g.group_id}"`);
    }

    // Check for existing games that match
    const existingGames = await Game.findAll({ attributes: ['id', 'name', 'bgg_id'] });
    const matchedGames = [];
    const unmatchedGames = [];
    for (const gameName of gameNames) {
      const match = existingGames.find(g => g.name.toLowerCase() === gameName.toLowerCase());
      if (match) {
        matchedGames.push({ mongoName: gameName, pgName: match.name, pgId: match.id });
      } else {
        unmatchedGames.push(gameName);
      }
    }

    if (matchedGames.length > 0) {
      console.log(`\nGames that already exist in PostgreSQL (${matchedGames.length}):`);
      for (const g of matchedGames) {
        console.log(`  ✓ "${g.mongoName}" → ${g.pgId}`);
      }
    }
    if (unmatchedGames.length > 0) {
      console.log(`\nGames that will be CREATED as custom games (${unmatchedGames.length}):`);
      for (const name of unmatchedGames) {
        console.log(`  + "${name}"`);
      }
    }

    await sequelize.close();
  } catch (err) {
    console.log(`\nCould not connect to PostgreSQL: ${err.message}`);
    console.log('Make sure your .env file has the correct DATABASE_URL or DB_* variables.');
  }

  // --- Generate mapping template ---
  console.log(`\n\n=== COPY THIS INTO CONFIG.PLAYER_MAPPING ===\n`);
  console.log(`PLAYER_MAPPING: {`);
  for (const name of [...playerNames].sort()) {
    console.log(`  '${name}': '',  // ← paste PostgreSQL User UUID here`);
  }
  console.log(`},`);
  console.log(`\n=== END TEMPLATE ===`);
}

// ============================================================
// Migration Mode — Reads MongoDB, writes to PostgreSQL
// ============================================================

async function runMigration(isDryRun) {
  // Connect to PostgreSQL via CONFIG.POSTGRES_URL
  const sequelize = createSequelize(CONFIG.POSTGRES_URL);
  const { User, Group, Game, Event, EventParticipation } = defineModels(sequelize);

  console.log(`=== ${isDryRun ? 'DRY RUN' : 'MIGRATION'} MODE ===\n`);

  // Verify PostgreSQL connection
  await sequelize.authenticate();
  console.log('Connected to production PostgreSQL.\n');
  const targetGroup = await Group.findByPk(CONFIG.TARGET_GROUP_ID);
  if (!targetGroup) {
    console.error(`ERROR: Group with ID "${CONFIG.TARGET_GROUP_ID}" not found in PostgreSQL.`);
    process.exit(1);
  }
  console.log(`Target group: "${targetGroup.name}" (${targetGroup.id})\n`);

  // Build a reverse lookup: UUID → User record (for winner_id / picked_by_id)
  const usersByUuid = {};
  const pgUsers = await User.findAll();
  for (const u of pgUsers) {
    usersByUuid[u.id] = u;
  }

  // Fetch all MongoDB board game records
  const bgRecords = await BG.find({}).sort({ startDate: 1 });
  console.log(`Found ${bgRecords.length} board game records in MongoDB.\n`);

  if (bgRecords.length === 0) {
    console.log('Nothing to migrate.');
    return;
  }

  // Pre-load existing PostgreSQL games for matching
  const existingGames = await Game.findAll();
  const gameCache = {}; // lowercase name → Game instance
  for (const g of existingGames) {
    gameCache[g.name.toLowerCase()] = g;
  }

  // Stats
  const stats = {
    eventsCreated: 0,
    gamesCreated: 0,
    gamesMatched: 0,
    participationsCreated: 0,
    customParticipantsAdded: 0,
    skipped: 0,
    errors: [],
  };

  // Process each record in a transaction
  const transaction = isDryRun ? null : await sequelize.transaction();

  try {
    for (let i = 0; i < bgRecords.length; i++) {
      const bg = bgRecords[i];
      const prefix = `[${i + 1}/${bgRecords.length}]`;

      try {
        // --- Find or create Game ---
        let gameName = (bg.Name || '').trim();
        if (!gameName) {
          console.log(`${prefix} SKIP: No game name`);
          stats.skipped++;
          continue;
        }

        // Skip test/junk records
        if (CONFIG.SKIP_GAMES.includes(gameName.toLowerCase()) || CONFIG.SKIP_GAMES.includes(gameName)) {
          console.log(`${prefix} SKIP: "${gameName}" (in skip list)`);
          stats.skipped++;
          continue;
        }

        // Apply name corrections (misspellings, merges)
        if (CONFIG.NAME_CORRECTIONS[gameName]) {
          const corrected = CONFIG.NAME_CORRECTIONS[gameName];
          console.log(`${prefix} Name corrected: "${gameName}" → "${corrected}"`);
          gameName = corrected;
        }

        let game = gameCache[gameName.toLowerCase()];
        if (!game) {
          // Create as a custom game
          if (!isDryRun) {
            game = await Game.create({
              name: gameName,
              is_custom: true,
              theme: bg.theme || null,
              url: bg.url || null,
            }, { transaction });
          } else {
            game = { id: `(new-${gameName})`, name: gameName };
          }
          gameCache[gameName.toLowerCase()] = game;
          stats.gamesCreated++;
          console.log(`${prefix} Created game: "${gameName}"`);
        } else {
          stats.gamesMatched++;
        }

        // --- Determine winner and picker from Players array ---
        let winnerId = null;
        let winnerName = null;
        let pickedById = null;
        let pickedByName = null;
        const participations = [];
        const customParticipants = [];

        const players = (bg.Players || []).filter(p => p.Player && p.Player.trim());

        for (const player of players) {
          const playerName = player.Player.trim();
          const pgUserUuid = CONFIG.PLAYER_MAPPING[playerName];

          if (pgUserUuid && usersByUuid[pgUserUuid]) {
            // Mapped user → EventParticipation
            participations.push({
              userUuid: pgUserUuid,
              score: player.Score != null ? player.Score : null,
              faction: player.Faction || null,
              is_new_player: player.New || false,
            });

            if (player.Winner) {
              winnerId = pgUserUuid;
            }
            if (player.Picked) {
              pickedById = pgUserUuid;
            }
          } else {
            // Unmapped player → custom_participant
            customParticipants.push({
              username: playerName,
              score: player.Score != null ? player.Score : null,
              faction: player.Faction || null,
              is_new_player: player.New || false,
            });

            if (player.Winner) {
              winnerName = playerName;
            }
            if (player.Picked) {
              pickedByName = playerName;
            }
          }
        }

        // --- Create Event ---
        const eventData = {
          group_id: CONFIG.TARGET_GROUP_ID,
          game_id: isDryRun ? null : game.id,
          start_date: bg.startDate || bg.createdAt || new Date(),
          duration_minutes: bg.Length || null,
          winner_id: winnerId,
          picked_by_id: pickedById,
          winner_name: winnerName,
          picked_by_name: pickedByName,
          custom_participants: customParticipants.length > 0 ? customParticipants : [],
          is_group_win: bg.Groupwin || false,
          comments: bg.GameComments || null,
          status: 'completed',
        };

        let event;
        if (!isDryRun) {
          event = await Event.create(eventData, { transaction });
        } else {
          event = { id: `(dry-run-${i})` };
        }
        stats.eventsCreated++;

        // --- Create EventParticipation records ---
        for (const p of participations) {
          if (!isDryRun) {
            await EventParticipation.create({
              event_id: event.id,
              user_id: p.userUuid,
              score: p.score,
              faction: p.faction,
              is_new_player: p.is_new_player,
            }, { transaction });
          }
          stats.participationsCreated++;
        }
        stats.customParticipantsAdded += customParticipants.length;

        const dateStr = bg.startDate ? bg.startDate.toISOString().split('T')[0] : 'no-date';
        const playerCount = players.length;
        console.log(`${prefix} ${gameName} (${dateStr}) — ${participations.length} linked, ${customParticipants.length} custom participants`);

      } catch (err) {
        console.error(`${prefix} ERROR processing "${bg.Name}": ${err.message}`);
        stats.errors.push({ name: bg.Name, error: err.message });
      }
    }

    // Commit transaction
    if (!isDryRun && transaction) {
      await transaction.commit();
      console.log('\nTransaction committed successfully.');
    }

  } catch (err) {
    if (!isDryRun && transaction) {
      await transaction.rollback();
      console.error('\nTransaction rolled back due to error:', err.message);
    }
    throw err;
  }

  // --- Summary ---
  console.log(`\n=== ${isDryRun ? 'DRY RUN' : 'MIGRATION'} SUMMARY ===`);
  console.log(`Events created:              ${stats.eventsCreated}`);
  console.log(`Games created (custom):      ${stats.gamesCreated}`);
  console.log(`Games matched (existing):    ${stats.gamesMatched}`);
  console.log(`EventParticipation records:  ${stats.participationsCreated}`);
  console.log(`Custom participants added:   ${stats.customParticipantsAdded}`);
  console.log(`Skipped (no game name):      ${stats.skipped}`);
  console.log(`Errors:                      ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of stats.errors) {
      console.log(`  - "${e.name}": ${e.error}`);
    }
  }

  if (isDryRun) {
    console.log(`\nThis was a DRY RUN. No data was written to PostgreSQL.`);
    console.log(`Run without --dry-run to perform the actual migration.`);
  }

  await sequelize.close();
}

// ============================================================
// Run
// ============================================================

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
