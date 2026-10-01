// services/bggService.js
const axios = require('axios');
const xml2js = require('xml2js');
const { BGG_USER_AGENT } = require('./bggHttpIdentity');


class BGGService {
  constructor() {
    this.baseURL = 'https://boardgamegeek.com/xmlapi2';
    this.parser = new xml2js.Parser();
    this.lastRequestTime = 0;
    this.minRequestInterval = 2000; // Minimum 2 seconds between requests
    // Get BGG Application Token from environment variable (if registered)
    // See BGG_API_COMPLIANCE.md for registration instructions
    this.applicationToken = process.env.BGG_APPLICATION_TOKEN || null;
  }

  /**
   * Get headers for BGG API requests
   * Includes Authorization header if token is available
   */
  getHeaders() {
    const headers = {
      'User-Agent': BGG_USER_AGENT,
      'Accept': 'application/xml, text/xml, */*',
      'Accept-Language': 'en-US,en;q=0.9'
    };

    // Add Authorization header if token is available
    // Format: "Bearer <token>" (no colon after Bearer!)
    if (this.applicationToken) {
      headers['Authorization'] = `Bearer ${this.applicationToken}`;
    }

    return headers;
  }


  async getGameById(bggId, type = null) {
    try {
      // BGG thing API can handle both boardgame and boardgameexpansion
      // If type is specified, use it; otherwise default to boardgame
      // If it fails, we'll try the other type as fallback
      const gameType = type === 'boardgameexpansion' ? 'boardgameexpansion' : 'boardgame';
      
      let response;
      let parsedResult;
      
      try {
        response = await axios.get(`${this.baseURL}/thing`, {
          params: {
            id: bggId,
            type: gameType,
            stats: 1
          },
          headers: this.getHeaders(),
          timeout: 15000,
          maxRedirects: 5
        });

        parsedResult = await this.parser.parseStringPromise(response.data);

        // Check if we got valid data
        if (!parsedResult.items || !parsedResult.items.item || parsedResult.items.item.length === 0) {
          // No items found with this type, try the other type if we tried boardgame first
          if (gameType === 'boardgame') {
            response = await axios.get(`${this.baseURL}/thing`, {
              params: {
                id: bggId,
                type: 'boardgameexpansion',
                stats: 1
              },
              headers: this.getHeaders(),
              timeout: 15000,
              maxRedirects: 5
            });
            parsedResult = await this.parser.parseStringPromise(response.data);
          }
        }
      } catch (firstError) {
        // If first attempt fails and we tried boardgame, try boardgameexpansion as fallback
        if (gameType === 'boardgame') {
          try {
            response = await axios.get(`${this.baseURL}/thing`, {
              params: {
                id: bggId,
                type: 'boardgameexpansion',
                stats: 1
              },
              headers: this.getHeaders(),
              timeout: 15000,
              maxRedirects: 5
            });
            parsedResult = await this.parser.parseStringPromise(response.data);
          } catch (secondError) {
            throw firstError; // Throw the original error
          }
        } else {
          throw firstError;
        }
      }

      // Use the parsed result we already have
      if (!parsedResult || !parsedResult.items || !parsedResult.items.item || parsedResult.items.item.length === 0) {
        throw new Error(`No game data found for BGG ID ${bggId}`);
      }
      
      const item = Array.isArray(parsedResult.items.item) ? parsedResult.items.item[0] : parsedResult.items.item;

      // Extract weight (complexity) from BGG statistics
      // Path: item.statistics[0].ratings[0].averageweight[0].$.value
      let weight = null;
      try {
        const rawWeight = item?.statistics?.[0]?.ratings?.[0]?.averageweight?.[0]?.$?.value;
        if (rawWeight) {
          const parsed = parseFloat(rawWeight);
          if (!isNaN(parsed) && parsed > 0) {
            weight = parsed;
          }
        }
      } catch (e) {
        // Weight extraction failed -- not critical, continue without it
      }

      return {
        name: this.extractValue(item.name),
        year_published: parseInt(this.extractValue(item.yearpublished)) || null,
        min_players: parseInt(this.extractValue(item.minplayers)) || null,
        max_players: parseInt(this.extractValue(item.maxplayers)) || null,
        playing_time: parseInt(this.extractValue(item.playingtime)) || null,
        description: this.extractValue(item.description) || null,
        image_url: this.extractValue(item.image) || null,
        thumbnail_url: this.extractValue(item.thumbnail) || null,
        weight,
      };
    } catch (error) {
      throw new Error(`Failed to fetch game from BGG: ${error.message}`);
    }
  }


  async searchGames(query) {
    try {
      // Rate limiting: ensure minimum time between requests
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
      }
      
      // BGG API can be slow, so we'll add retry logic
      let lastError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          if (attempt > 0) {
            // Wait before retrying (exponential backoff)
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          }
          
          this.lastRequestTime = Date.now();
          
          const response = await axios.get(`${this.baseURL}/search`, {
            params: {
              query,
              type: 'boardgame'
            },
            headers: this.getHeaders(),
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: function (status) {
              return status >= 200 && status < 500; // Don't throw on 4xx
            }
          });

          if (response.status === 401 || response.status === 403) {
            throw new Error(`BGG API returned ${response.status}. This may be due to rate limiting. Please try again in a few moments.`);
          }

          if (response.status !== 200) {
            throw new Error(`BGG API returned status ${response.status}`);
          }

          const result = await this.parser.parseStringPromise(response.data);
          
          if (!result.items || !result.items.item) {
            return [];
          }

          const items = Array.isArray(result.items.item) ? result.items.item : [result.items.item];
          
          return items.map(item => ({
            bgg_id: parseInt(item.$.id),
            name: this.extractValue(item.name),
            year_published: parseInt(this.extractValue(item.yearpublished)) || null
          }));
        } catch (error) {
          lastError = error;
          if (error.response?.status === 401 || error.response?.status === 403) {
            // Don't retry on auth errors
            throw error;
          }
          // Continue to retry for other errors
        }
      }
      throw lastError;
    } catch (error) {
      // Log more details about the error
      console.error('BGG Search Error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        url: error.config?.url
      });
      
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error('BGG API access denied. This may be due to rate limiting. Please wait a moment and try again.');
      }
      if (error.code === 'ECONNABORTED') {
        throw new Error('BGG API request timed out. Please try again.');
      }
      throw new Error(`Failed to search BGG: ${error.message}`);
    }
  }


  /**
   * Get a user's BGG collection
   * BGG API returns 202 (Accepted) when processing the request, then 200 when ready
   * We need to poll until we get a 200 response
   * @param {string} bggUsername - BGG username
   * @param {string} subtype - Collection subtype: 'boardgame', 'boardgameexpansion', or null/undefined for all types (optional)
   * @returns {Promise<Array>} Array of collection items with subtype information
   */
  async getUserCollection(bggUsername, subtype = null) {
    try {
      // Rate limiting: ensure minimum time between requests
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.minRequestInterval) {
        await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
      }

      this.lastRequestTime = Date.now();

      const collectionUrl = `${this.baseURL}/collection`;
      const params = {
        username: bggUsername,
        own: 1, // Only get games they own
      };
      
      // Only include subtype parameter if specified (omit to get all types)
      // If subtype is not specified, BGG API returns all collection items (boardgames, expansions, etc.)
      if (subtype) {
        params.subtype = subtype;
      }

      // BGG API returns 202 when processing, 200 when ready
      // We need to poll until we get 200
      let response;
      let attempts = 0;
      const maxAttempts = 30; // Maximum 30 attempts (about 60 seconds)
      const pollInterval = 2000; // Poll every 2 seconds

      do {
        if (attempts > 0) {
          // Wait before polling again (except for first request)
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        }

        response = await axios.get(collectionUrl, {
          params,
          headers: this.getHeaders(),
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: function (status) {
            return status >= 200 && status < 500;
          }
        });

        attempts++;

        if (response.status === 401 || response.status === 403) {
          throw new Error(`BGG API returned ${response.status}. This may be due to rate limiting. Please try again in a few moments.`);
        }

        if (response.status === 202) {
          // Still processing, continue polling
          console.log(`BGG collection request is being processed (attempt ${attempts}/${maxAttempts})...`);
          continue;
        }

        if (response.status !== 200) {
          throw new Error(`BGG API returned status ${response.status}`);
        }

        // Got 200, break out of loop
        break;
      } while (attempts < maxAttempts);

      if (response.status !== 200) {
        throw new Error(`BGG API did not return collection data after ${attempts} attempts. The request may still be processing.`);
      }

      const result = await this.parser.parseStringPromise(response.data);
      
      // BGG API sometimes returns an error message in the XML
      if (result.errors && result.errors.error) {
        const errorMsg = Array.isArray(result.errors.error) 
          ? result.errors.error[0].$.message 
          : result.errors.error.$.message;
        throw new Error(`BGG API error: ${errorMsg}`);
      }
      
      if (!result.items || !result.items.item) {
        console.log('BGG collection response: No items found');
        return [];
      }

      const items = Array.isArray(result.items.item) ? result.items.item : [result.items.item];
      console.log(`BGG collection: Found ${items.length} items for user`);
      
      return items.map(item => {
        try {
          // Extract rating value - BGG collection XML structure
          let rating = null;
          if (item.stats && item.stats.rating && item.stats.rating.$ && item.stats.rating.$.value) {
            const ratingValue = item.stats.rating.$.value;
            if (ratingValue && ratingValue !== 'N/A' && ratingValue !== 'N/A') {
              rating = parseFloat(ratingValue);
              if (isNaN(rating)) rating = null;
            }
          }
          
          // Safely extract bgg_id
          const bgg_id = item.$ && item.$.objectid ? parseInt(item.$.objectid) : null;
          if (!bgg_id || isNaN(bgg_id)) {
            console.warn('Skipping item with invalid bgg_id:', item);
            return null;
          }
          
          // Determine subtype from item attributes or use provided subtype
          // BGG collection XML might include objecttype or subtype in the item attributes
          let itemSubtype = subtype;
          if (!itemSubtype && item.$ && item.$.subtype) {
            itemSubtype = item.$.subtype;
          } else if (!itemSubtype && item.$ && item.$.objecttype) {
            // Object type might indicate if it's an expansion
            itemSubtype = item.$.objecttype === 'boardgameexpansion' ? 'boardgameexpansion' : 'boardgame';
          }
          // Default to 'boardgame' if no subtype can be determined (will be handled by fallback in getGameById)
          
          return {
            bgg_id: bgg_id,
            name: this.extractValue(item.name) || 'Unknown Game',
            year_published: parseInt(this.extractValue(item.yearpublished)) || null,
            // Collection-specific data
            numplays: parseInt(this.extractValue(item.numplays)) || 0,
            rating: rating,
            subtype: itemSubtype || 'boardgame', // Include subtype so we know if it's an expansion
          };
        } catch (itemError) {
          console.error('Error parsing collection item:', itemError, 'Item:', item);
          return null;
        }
      }).filter(item => item !== null); // Remove any null items
    } catch (error) {
      console.error('BGG Collection Error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        message: error.message,
        url: error.config?.url
      });
      
      if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error('BGG API access denied. This may be due to rate limiting. Please wait a moment and try again.');
      }
      if (error.code === 'ECONNABORTED') {
        throw new Error('BGG API request timed out. Please try again.');
      }
      throw new Error(`Failed to fetch BGG collection: ${error.message}`);
    }
  }

  extractValue(element) {
    if (!element) return null;
    try {
      if (Array.isArray(element)) {
        if (element.length === 0) return null;
        const first = element[0];
        if (first && first.$ && first.$.value !== undefined) {
          return first.$.value;
        }
        if (first && first._ !== undefined) {
          return first._;
        }
        return first || null;
      }
      if (element.$ && element.$.value !== undefined) {
        return element.$.value;
      }
      if (element._ !== undefined) {
        return element._;
      }
      return element || null;
    } catch (error) {
      console.warn('Error extracting value from element:', error, element);
      return null;
    }
  }
}


module.exports = new BGGService();