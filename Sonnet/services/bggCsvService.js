// services/bggCsvService.js
// Service for managing BGG CSV dump and local game search
// This replaces frequent API calls with local database searches

const fs = require('fs').promises;
const path = require('path');
const csv = require('csv-parser');
const { Game } = require('../models');
const { Op } = require('sequelize');
const { BGG_USER_AGENT } = require('./bggHttpIdentity');

class BGGCSVService {
  constructor() {
    // __dirname is services/, so ../data/ is Sonnet/data/
    this.csvPath = path.join(__dirname, '../data/bgg-games.csv');
    this.lastUpdateCheck = null;
    this.updateInterval = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
  }

  /**
   * Download the BGG CSV dump
   * Requires: BGG Application Token (if registered) or logged-in session
   * CSV is available at: https://boardgamegeek.com/xmlapi2/geeklist/161936 (or direct download link)
   * 
   * According to BGG docs:
   * - If you have an approved application, you can download the CSV directly
   * - CSV download requires application token in Authorization header
   * - CSV is updated periodically by BGG
   */
  async downloadCSV() {
    try {
      const axios = require('axios');
      const applicationToken = process.env.BGG_APPLICATION_TOKEN;
      
      const headers = {
        'User-Agent': BGG_USER_AGENT,
        'Accept': 'text/csv, application/csv, */*',
      };

      if (applicationToken) {
        headers['Authorization'] = `Bearer ${applicationToken}`;
      }

      // BGG CSV download endpoint (check BGG_XML_API2 page for exact URL)
      // This is a placeholder - you'll need to get the actual CSV download URL from BGG
      const csvUrl = process.env.BGG_CSV_DOWNLOAD_URL || 
        'https://boardgamegeek.com/xmlapi2/geeklist/161936?csv=1';

      console.log('Downloading BGG CSV dump...');
      const response = await axios.get(csvUrl, {
        headers,
        responseType: 'stream',
        timeout: 300000, // 5 minute timeout for large file
      });

      // Ensure data directory exists
      const dataDir = path.dirname(this.csvPath);
      await fs.mkdir(dataDir, { recursive: true });

      // Write to file
      const writer = require('fs').createWriteStream(this.csvPath);
      response.data.pipe(writer);

      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          console.log('BGG CSV downloaded successfully');
          this.lastUpdateCheck = Date.now();
          resolve();
        });
        writer.on('error', reject);
      });
    } catch (error) {
      console.error('Error downloading BGG CSV:', error);
      throw new Error(`Failed to download BGG CSV: ${error.message}`);
    }
  }

  /**
   * Import CSV data into local database
   * This creates/updates Game records from the CSV
   */
  async importCSVToDatabase() {
    try {
      console.log('Importing BGG CSV to database...');
      
      // Check if CSV file exists
      try {
        await fs.access(this.csvPath);
      } catch {
        throw new Error('BGG CSV file not found. Please download it first.');
      }

      const games = [];
      let rowCount = 0;

      // Read and parse CSV - collect in batches, then process after stream ends
      return new Promise((resolve, reject) => {
        const allBatches = [];
        let currentBatch = [];
        let streamRowCount = 0;
        
        require('fs').createReadStream(this.csvPath)
          .pipe(csv())
          .on('data', (row) => {
            streamRowCount++;
            rowCount = streamRowCount;
            
            // Map CSV columns to Game model fields
            const gameData = {
              bgg_id: parseInt(row.id) || null,
              name: row.name ? row.name.replace(/^"|"$/g, '') : null,
              year_published: parseInt(row.yearpublished) || null,
              min_players: null,
              max_players: null,
              playing_time: null,
              is_custom: false,
            };

            if (gameData.bgg_id && gameData.name) {
              currentBatch.push(gameData);
              
              // When batch reaches 1000, save it and start new batch
              if (currentBatch.length >= 1000) {
                allBatches.push(currentBatch);
                currentBatch = [];
                console.log(`  Parsed ${streamRowCount} rows, collected ${allBatches.length * 1000} games...`);
              }
            }
          })
          .on('end', async () => {
            try {
              // Add final batch if it has games
              if (currentBatch.length > 0) {
                allBatches.push(currentBatch);
              }
              
              console.log(`Finished parsing CSV. Total batches: ${allBatches.length}, Total games: ${allBatches.reduce((sum, b) => sum + b.length, 0)} from ${streamRowCount} rows`);
              console.log('Starting database import...');
              
              let processedCount = 0;
              const totalGames = allBatches.reduce((sum, b) => sum + b.length, 0);
              
              // Process all batches
              for (let i = 0; i < allBatches.length; i++) {
                const batch = allBatches[i];
                await this.batchUpsertGames(batch);
                processedCount += batch.length;
                console.log(`  Imported ${processedCount} / ${totalGames} games (${Math.round(processedCount/totalGames*100)}%)...`);
              }
              
              console.log(`✅ Imported ${processedCount} games from ${streamRowCount} rows in BGG CSV`);
              resolve(processedCount);
            } catch (error) {
              console.error('Error in end handler:', error);
              reject(error);
            }
          })
          .on('error', (error) => {
            console.error('Stream error:', error);
            reject(error);
          });
      });
    } catch (error) {
      console.error('Error importing CSV to database:', error);
      throw new Error(`Failed to import CSV: ${error.message}`);
    }
  }

  /**
   * Batch upsert games (insert or update)
   */
  async batchUpsertGames(games) {
    let successCount = 0;
    let errorCount = 0;
    
    for (const gameData of games) {
      try {
        // Only upsert if we have required fields
        if (!gameData.bgg_id || !gameData.name) {
          errorCount++;
          continue;
        }
        
        await Game.upsert(gameData, {
          conflictFields: ['bgg_id'],
          updateOnDuplicate: ['name', 'year_published', 'min_players', 'max_players', 'playing_time'],
        });
        successCount++;
      } catch (error) {
        errorCount++;
        // Only log first few errors to avoid spam
        if (errorCount <= 5) {
          console.warn(`Failed to upsert game ${gameData.bgg_id} (${gameData.name}):`, error.message);
        }
      }
    }
    
    if (errorCount > 0 && errorCount <= 5) {
      console.log(`  Upserted ${successCount} games, ${errorCount} errors`);
    } else if (errorCount > 5) {
      console.log(`  Upserted ${successCount} games, ${errorCount} errors (showing first 5)`);
    }
  }

  /**
   * Search games in local database
   * This is much faster than API calls and avoids rate limiting
   */
  async searchGames(query, limit = 50) {
    try {
      if (!query || query.trim().length < 2) {
        return [];
      }

      const searchTerm = query.trim();
      
      const games = await Game.findAll({
        where: {
          name: {
            [Op.iLike]: `%${searchTerm}%`, // Case-insensitive search
          },
          is_custom: false, // Only BGG games
        },
        limit,
        order: [
          // Prioritize exact matches and popular games
          // Use Sequelize.fn to safely escape the search term
          [Game.sequelize.literal(`CASE WHEN name ILIKE ${Game.sequelize.escape(searchTerm + '%')} THEN 1 ELSE 2 END`), 'ASC'],
          ['year_published', 'DESC'], // Newer games first
        ],
        attributes: ['id', 'bgg_id', 'name', 'year_published', 'min_players', 'max_players', 'playing_time', 'image_url'],
      });

      return games.map(game => ({
        bgg_id: game.bgg_id,
        name: game.name,
        year_published: game.year_published,
        // Include database ID for quick import
        db_id: game.id,
      }));
    } catch (error) {
      console.error('Error searching games in database:', error);
      throw new Error(`Failed to search games: ${error.message}`);
    }
  }

  /**
   * Check if CSV needs to be updated
   */
  shouldUpdateCSV() {
    if (!this.lastUpdateCheck) {
      return true; // Never updated
    }
    return (Date.now() - this.lastUpdateCheck) > this.updateInterval;
  }

  /**
   * Initialize: Download and import CSV if needed
   */
  async initialize() {
    try {
      // Check if we need to update
      if (this.shouldUpdateCSV()) {
        console.log('BGG CSV update needed. Downloading...');
        await this.downloadCSV();
        await this.importCSVToDatabase();
      } else {
        console.log('BGG CSV is up to date');
      }
    } catch (error) {
      console.error('Error initializing BGG CSV service:', error);
      // Don't throw - allow app to continue with existing data
      console.warn('Continuing with existing game data...');
    }
  }
}

module.exports = new BGGCSVService();

