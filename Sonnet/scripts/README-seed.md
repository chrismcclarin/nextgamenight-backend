# Sample Data Seeding Script

This script populates your database with realistic sample data for testing and development.

## What Gets Created

### Users (7)
- Alice, Bob, Charlie, Diana, Eve, Frank
- Bartholomew Featherstonehaugh-Cholmondeley — owns no games; the long name wraps a 375px profile title (Phase 88.9 walk, rows W152 / #29)

### Groups (5)
- **Weekend Warriors** - 4 members (Alice owner, Bob, Charlie, Diana); two prompt schedules (Thursday check-in active, Sunday afternoon paused)
- **Strategy Squad** - 5 members (Frank owner, Bob, Charlie, Eve, Alice)
- **Casual Gamers** - 4 members (Diana owner, Eve, Frank, Alice); colour preset `blue` with a BROKEN header image URL (the fallback the 88.9 walk measures)
- **Dice Dynasty** - 3 members (Charlie owner, Eve, Frank); Alice is NOT a member and attends its event as a guest
- **No Games Yet** - 3 members (Frank owner, Eve, Bartholomew); nobody in it owns a game, so create-event's Suggestions slot shows its empty hint

### Games (8)
- **BGG Games:**
  - Catan (1995)
  - Ticket to Ride (2004)
  - Wingspan (2019)
  - Azul (2017)
  - Codenames (2015)
  - Gloomhaven (2017)
- **Custom Games:**
  - Custom Card Game
  - House Rules Monopoly

### Events (7 past game sessions + 3 upcoming)
- Weekend Warriors: 3 past events (Catan, Ticket to Ride, Wingspan); 1 upcoming (Catan, ~3 days out) with an OPEN ballot (Catan / Wingspan) and Eve joined as a guest
- Strategy Squad: 2 past events (Gloomhaven, Azul); 1 upcoming (~10 days out, no participants yet)
- Casual Gamers: 2 past events (Codenames, Custom Card Game)
- Dice Dynasty: 1 upcoming (Codenames, ~6 days out) with Alice joined as a guest
- Azul's image URLs are deliberately dead (the SafeImage fallback)

### Game Reviews (11)
- Reviews from various users across different groups

## Usage

```bash
# Seed the database with sample data
npm run seed
```

**Note:** The script will:
1. Clear all existing data (optional - you can comment out the clearing section)
2. Create users, groups, games, events, participations, and reviews
3. Establish relationships between all entities

## Customization

To modify the sample data:
1. Edit `scripts/seed-sample-data.js`
2. Modify the arrays at the top (sampleUsers, sampleGroups, sampleGames)
3. Adjust the events, participations, and reviews as needed

## Data Relationships

- Users belong to Groups (via UserGroup)
- Events belong to Groups and reference Games
- EventParticipations link Users to Events
- GameReviews are created by Users for Games within Groups

