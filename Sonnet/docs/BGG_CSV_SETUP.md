# BGG CSV Dump Setup Guide

## Overview

Instead of making API calls for every game search (which causes rate limiting), we use BGG's CSV dump of all games. This approach:

- ✅ **Eliminates rate limiting** - No API calls for searches
- ✅ **Much faster** - Local database queries vs network requests
- ✅ **More reliable** - No dependency on BGG API availability
- ✅ **Better user experience** - Instant search results
- ✅ **Recommended by BGG** - CSV dump is specifically for this use case

## How It Works

1. **Download CSV**: Periodically download the full BGG games CSV dump
2. **Import to Database**: Store all games in your local database
3. **Search Locally**: All searches query your local database
4. **API for Details**: Only use BGG API when importing a specific game's full details (images, descriptions, etc.)

## Setup Instructions

### Step 1: Install Required Package

```bash
cd periodictabletopbackend_v2/Sonnet
npm install csv-parser
```

### Step 2: Get BGG CSV Download URL

1. Log into BoardGameGeek.com
2. Go to the [BGG XML API2 page](https://boardgamegeek.com/wiki/page/BGG_XML_API2)
3. Find the CSV download link (usually something like `/xmlapi2/geeklist/161936?csv=1`)
4. Or check: https://boardgamegeek.com/xmlapi2/geeklist/161936 (while logged in)

**Note**: If you have an approved BGG application, you can use your Application Token to download the CSV programmatically.

### Step 3: Set Environment Variable

Add to your `.env` file:

```env
# BGG CSV Download URL (get from BGG website while logged in)
BGG_CSV_DOWNLOAD_URL=https://boardgamegeek.com/xmlapi2/geeklist/161936?csv=1

# Optional: BGG Application Token (if you have one)
BGG_APPLICATION_TOKEN=your-token-here
```

### Step 4: Initial CSV Download and Import

Run the setup script:

```bash
node scripts/setup-bgg-csv.js
```

This will:
1. Download the CSV file
2. Import all games into your database
3. Set up automatic periodic updates

### Step 5: Automatic Updates

The system will automatically check for CSV updates every 7 days. You can also manually trigger updates:

```bash
node scripts/update-bgg-csv.js
```

## CSV File Location

The CSV file is stored at:
```
periodictabletopbackend_v2/Sonnet/data/bgg-games.csv
```

This file is gitignored (don't commit it to version control).

## How Searches Work Now

1. **User searches for a game** → Queries local database (fast, no API call)
2. **User selects a game** → If game exists in DB, use it; otherwise import from BGG API
3. **Import game details** → Only when needed, fetches full details (images, description) from BGG API

## Benefits

### Before (API-only):
- ❌ Rate limited (401/403 errors)
- ❌ Slow (network requests)
- ❌ Unreliable (BGG API downtime)
- ❌ Poor user experience

### After (CSV + API hybrid):
- ✅ No rate limiting for searches
- ✅ Fast local database queries
- ✅ Reliable (works offline)
- ✅ Great user experience
- ✅ Only uses API when importing specific game details

## Maintenance

### Manual Update

If you want to update the game database manually:

```bash
node scripts/update-bgg-csv.js
```

### Automatic Updates

The system automatically checks for updates every 7 days. You can adjust this in `services/bggCsvService.js`:

```javascript
this.updateInterval = 7 * 24 * 60 * 60 * 1000; // Change to desired interval
```

## Troubleshooting

### CSV Download Fails

- Make sure you're logged into BGG in your browser
- Check that the CSV URL is correct
- If you have an Application Token, make sure it's set in `.env`

### Import Takes Too Long

- The CSV has ~200,000+ games, so initial import may take 10-30 minutes
- This is a one-time operation
- Updates are incremental and faster

### Search Returns No Results

- Make sure the CSV has been imported: Check your database for games with `is_custom = false`
- Try updating the CSV: `node scripts/update-bgg-csv.js`

## File Size

The BGG CSV dump is typically:
- **Size**: ~50-100 MB (compressed)
- **Games**: ~200,000+ board games
- **Update Frequency**: BGG updates it periodically (weekly/monthly)

## Next Steps

1. Install `csv-parser`: `npm install csv-parser`
2. Get CSV download URL from BGG
3. Run setup script: `node scripts/setup-bgg-csv.js`
4. Test search functionality


