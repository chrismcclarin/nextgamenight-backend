#!/usr/bin/env node

/**
 * Resolve Custom Games → BGG Games
 *
 * Step 1: Match custom game names against the local BGG CSV (172K games, instant)
 * Step 2: For matches, fetch full metadata from BGG API (2 sec each)
 *
 * Usage:
 *   --preview   Show matches without fetching metadata or writing
 *   --dry-run   Match + fetch metadata but don't write to database
 *   (no flags)  Match, fetch, and update the database
 */

require('dotenv').config();
const { Sequelize, DataTypes } = require('sequelize');
const fs = require('fs');
const csv = require('csv-parser');
const path = require('path');
const bgg = require('../services/bggService');

/**
 * Read a required env var, or exit loudly.
 *
 * SECURITY (2026-07-25): this used to be
 *   `process.env.MIGRATION_DATABASE_URL || '<hardcoded production URL with password>'`
 * That leaked a live Railway Postgres credential into a public repo when the file was
 * committed, and the credential had to be rotated. The fallback was ALSO a footgun in
 * its own right: running this script with no env set silently connected to PRODUCTION.
 * Never reintroduce a literal credential as a default — fail closed instead.
 */
function requiredEnv(name, hint) {
  const value = process.env[name];
  if (!value) {
    console.error(`\n[config] Missing required environment variable: ${name}`);
    if (hint) console.error(`         ${hint}`);
    console.error(`         Set it in Sonnet/.env or inline:  ${name}=... node scripts/resolve-custom-games.js\n`);
    process.exit(1);
  }
  return value;
}

const POSTGRES_URL = requiredEnv(
  'MIGRATION_DATABASE_URL',
  'The Postgres connection string this script should write to. Point it at a LOCAL database unless you deliberately intend to modify production.'
);
const CSV_PATH = path.join(__dirname, '../data/bgg-games.csv');

// Games to skip (not real BGG board games)
const SKIP_GAMES = ['test', 'Tractor', 'Go Fish!'];

// Manual overrides: wrong CSV matches + unmatched names (spelling/punctuation differences)
const MANUAL_OVERRIDES = {
  // Wrong CSV matches
  'heat': { bgg_id: 366013, name: 'Heat: Pedal to the Metal', year_published: 2022 },
  'expeditions: around the world': { bgg_id: 223, name: 'Expeditions: Around the World', year_published: 1996 },
  // Unmatched — naming differences from BGG CSV
  '6 nimmt': { bgg_id: 432, name: 'Take 5', year_published: 1994 },
  'arkham horror (3e)': { bgg_id: 257499, name: 'Arkham Horror (Third Edition)', year_published: 2018 },
  'burgle bros': { bgg_id: 172081, name: 'Burgle Bros.', year_published: 2015 },
  'castles of burgundy': { bgg_id: 84876, name: 'The Castles of Burgundy', year_published: 2011 },
  'clank!: a deck building adventure': { bgg_id: 201808, name: 'Clank!: A Deck-Building Adventure', year_published: 2016 },
  'dune: imperium- uprising': { bgg_id: 397598, name: 'Dune: Imperium – Uprising', year_published: 2023 },
  'epic spell wars of the battle wizards': { bgg_id: 112686, name: 'Epic Spell Wars of the Battle Wizards: Duel at Mt. Skullzfyre', year_published: 2012 },
  'five tribes': { bgg_id: 157354, name: 'Five Tribes: The Djinns of Naqala', year_published: 2014 },
  'fury of dracula': { bgg_id: 181279, name: 'Fury of Dracula (Third/Fourth Edition)', year_published: 2015 },
  'glen more ii : chronicles': { bgg_id: 265188, name: 'Glen More II: Chronicles', year_published: 2019 },
  'gugong': { bgg_id: 250458, name: 'Gùgōng', year_published: 2018 },
  'incan gold': { bgg_id: 15512, name: 'Diamant', year_published: 2005 },
  'isle of skye': { bgg_id: 176494, name: 'Isle of Skye: From Chieftain to King', year_published: 2015 },
  "let's go to japan": { bgg_id: 368173, name: "Let's Go! To Japan", year_published: 2024 },
  'london (2e)': { bgg_id: 236191, name: 'London (Second Edition)', year_published: 2017 },
  'mechs vs minions': { bgg_id: 209010, name: 'Mechs vs. Minions', year_published: 2016 },
  'merv': { bgg_id: 306040, name: 'Merv: The Heart of the Silk Road', year_published: 2020 },
  'orleans': { bgg_id: 164928, name: 'Orléans', year_published: 2014 },
  'pax pamir (2e)': { bgg_id: 256960, name: 'Pax Pamir: Second Edition', year_published: 2019 },
  'quest for el dorado': { bgg_id: 217372, name: 'The Quest for El Dorado', year_published: 2017 },
  'red dragon inn': { bgg_id: 24310, name: 'The Red Dragon Inn', year_published: 2007 },
  'search for planet x': { bgg_id: 279537, name: 'The Search for Planet X', year_published: 2020 },
  'smallworld': { bgg_id: 40692, name: 'Small World', year_published: 2009 },
  'teotihuacan': { bgg_id: 229853, name: 'Teotihuacan: City of Gods', year_published: 2018 },
  'the crew': { bgg_id: 284083, name: 'The Crew: The Quest for Planet Nine', year_published: 2019 },
  'the quacks of quedlinburg': { bgg_id: 244521, name: 'Quacks', year_published: 2018 },
  'twilight imperium fourth edition': { bgg_id: 233078, name: 'Twilight Imperium: Fourth Edition', year_published: 2017 },
  'white castle': { bgg_id: 371942, name: 'The White Castle', year_published: 2023 },
};

/**
 * Load the BGG CSV into a name lookup map.
 * Returns: { lowercaseName: { bgg_id, name, year_published } }
 */
function loadCSV() {
  return new Promise((resolve, reject) => {
    const nameMap = {};      // lowercase name → entry (first match wins for dupes)
    const nameMapAll = {};   // lowercase name → array of all entries (for disambiguation)

    fs.createReadStream(CSV_PATH)
      .pipe(csv())
      .on('data', (row) => {
        const bgg_id = parseInt(row.id);
        const name = row.name ? row.name.replace(/^"|"$/g, '') : null;
        const year = parseInt(row.yearpublished) || null;

        if (bgg_id && name) {
          const key = name.toLowerCase();
          const entry = { bgg_id, name, year_published: year };

          if (!nameMapAll[key]) nameMapAll[key] = [];
          nameMapAll[key].push(entry);

          // Keep the highest-ranked (first in CSV) or most recent
          if (!nameMap[key]) {
            nameMap[key] = entry;
          }
        }
      })
      .on('end', () => resolve({ nameMap, nameMapAll }))
      .on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const isPreview = args.includes('--preview');
  const isDryRun = args.includes('--dry-run');

  // Step 1: Load CSV
  console.log('Loading BGG CSV...');
  const { nameMap, nameMapAll } = await loadCSV();
  console.log(`Loaded ${Object.keys(nameMap).length} unique game names from CSV.\n`);

  // Connect to production PostgreSQL
  const sequelize = new Sequelize(POSTGRES_URL, {
    dialect: 'postgresql',
    logging: false,
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
  });

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

  await sequelize.authenticate();
  console.log('Connected to production PostgreSQL.\n');

  const customGames = await Game.findAll({ where: { is_custom: true }, order: [['name', 'ASC']] });
  console.log(`Found ${customGames.length} custom games.\n`);

  // Step 2: Match against CSV
  const matched = [];
  const notFound = [];
  const skipped = [];

  for (const game of customGames) {
    if (SKIP_GAMES.includes(game.name)) {
      skipped.push(game);
      continue;
    }

    const key = game.name.toLowerCase();

    // Check manual overrides first, then CSV
    const csvMatch = MANUAL_OVERRIDES[key] || nameMap[key];

    if (csvMatch) {
      matched.push({ game, csvMatch });
    } else {
      notFound.push(game);
    }
  }

  console.log(`=== CSV MATCHING RESULTS ===`);
  console.log(`Matched:    ${matched.length}`);
  console.log(`Not found:  ${notFound.length}`);
  console.log(`Skipped:    ${skipped.length}\n`);

  if (notFound.length > 0) {
    console.log('Games NOT found in BGG CSV (will remain custom):');
    for (const g of notFound) {
      console.log(`  - "${g.name}"`);
    }
    console.log();
  }

  if (isPreview) {
    console.log('=== MATCHED GAMES (would be resolved) ===\n');
    for (const { game, csvMatch } of matched) {
      console.log(`  "${game.name}" → bgg_id: ${csvMatch.bgg_id} (${csvMatch.name}, ${csvMatch.year_published || '?'})`);
    }
    await sequelize.close();
    return;
  }

  // Step 3: Update database with CSV data (no API calls)
  const stats = { resolved: 0, conflicts: 0, errors: 0 };

  for (let i = 0; i < matched.length; i++) {
    const { game, csvMatch } = matched[i];
    const prefix = `[${i + 1}/${matched.length}]`;

    try {
      // Check for bgg_id conflicts
      const existing = await Game.findOne({ where: { bgg_id: csvMatch.bgg_id } });
      if (existing && existing.id !== game.id) {
        console.log(`${prefix} CONFLICT: bgg_id ${csvMatch.bgg_id} already used by "${existing.name}" — skipping "${game.name}"`);
        stats.conflicts++;
        continue;
      }

      if (!isDryRun) {
        await game.update({
          bgg_id: csvMatch.bgg_id,
          year_published: csvMatch.year_published,
          is_custom: false,
          url: `https://boardgamegeek.com/boardgame/${csvMatch.bgg_id}`,
        });
      }

      console.log(`${prefix} RESOLVED: "${game.name}" → bgg_id: ${csvMatch.bgg_id} (${csvMatch.name}, ${csvMatch.year_published || '?'})`);
      stats.resolved++;

    } catch (err) {
      console.error(`${prefix} ERROR: "${game.name}" — ${err.message}`);
      stats.errors++;
    }
  }

  console.log(`\n=== ${isDryRun ? 'DRY RUN' : 'RESOLUTION'} SUMMARY ===`);
  console.log(`Resolved:    ${stats.resolved}`);
  console.log(`Conflicts:   ${stats.conflicts}`);
  console.log(`Errors:      ${stats.errors}`);
  console.log(`Not in CSV:  ${notFound.length} (remain custom)`);
  console.log(`Skipped:     ${skipped.length}`);

  if (isDryRun) {
    console.log(`\nThis was a DRY RUN. No data was written.`);
  }

  await sequelize.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
