# Sample Data Seeding Script

This script populates your database with realistic sample data for testing and development.

## What Gets Created

### Users (7)
- Alice, Bob, Charlie, Diana, Eve, Frank
- Bartholomew Featherstonehaugh-Cholmondeley — owns no games; the long name wraps a 375px profile title (Phase 88.9 walk, rows W152 / #29)

### Groups (6)
- **Weekend Warriors** - 4 members (Alice owner, Bob, Charlie, Diana); two prompt schedules (Thursday check-in active, Sunday afternoon paused)
- **Strategy Squad** - 7 members (Frank owner, Bob, Charlie, Eve, Alice, Diana, Bartholomew); the one group where Alice sees more than 4 other members, so her home card shows four chips and a "+2" overflow chip (Phase 88.9 round 2, pick row D2 / #77). Consequence: create-event pre-fills all 7 as participants and no owned game allows 7 players, so its Suggestions slot shows the empty hint — Weekend Warriors (4 players) is the group whose slot shows suggestions
- **Casual Gamers** - 4 members (Diana owner, Eve, Frank, Alice); colour preset `blue` with a BROKEN header image URL (the fallback the 88.9 walk measures)
- **Dice Dynasty** - 3 members (Charlie owner, Eve, Frank); Alice is NOT a member and attends its event as a guest
- **No Games Yet** - 3 members (Frank owner, Eve, Bartholomew); nobody in it owns a game, so create-event's Suggestions slot shows its empty hint
- **Retired Raiders** - 3 members (Alice owner, Bob, Eve) and 1 past event; SOFT-DELETED at the end of the seed through the same service the delete button uses, so it is hidden everywhere and restorable for 30 days from the seed run (the restore link below)

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

### Events (7 past game sessions + 3 upcoming, plus 1 past event hidden inside Retired Raiders)
- Weekend Warriors: 3 past events (Catan, Ticket to Ride, Wingspan); 1 upcoming (Catan, ~3 days out) with an OPEN ballot (Catan / Wingspan) and Eve joined as a guest
- Strategy Squad: 2 past events (Gloomhaven, Azul); 1 upcoming (~10 days out, no participants yet)
- Casual Gamers: 2 past events (Codenames, Custom Card Game)
- Dice Dynasty: 1 upcoming (Codenames, ~6 days out) with Alice joined as a guest
- Retired Raiders: 1 past event (Ticket to Ride, ~20 days ago, Alice won) — hidden with its group until someone restores it
- Azul's image URLs are deliberately dead (the SafeImage fallback)

### Game Reviews (11)
- Reviews from various users across different groups

### Links the seed prints
At the end of its output the seed prints two kinds of walk link (Phase 88.9 round 2, quick 261103-glx):

- **Alice's RSVP links** — three single-use links (yes / maybe / no) for Alice on the Weekend Warriors Catan night. Opening one answers the RSVP and revokes the other two; reseed for fresh ones. They are usable only until the Catan night starts, about 3 days after the seed (the respond route answers 410 for a past event), not for the 30-day token expiry — reseed close to the walk. The RSVP link needs MAGIC_TOKEN_SECRET in the backend env — the same value the backend server uses, or the server rejects the link — and is skipped with a notice when it is unset (the rest of the seed still runs). The links are signed over Alice's Auth0 sub as seeded, so seed with `AUTH0_ALICE_SUB` set and never repoint Alice's `user_id` afterwards — reseed instead.
- **The Retired Raiders restore link** — the preview page opens signed out; finishing the restore needs sign-in as Alice (or Bob or Eve).

For both: the links are built from `FRONTEND_URL` (falls back to `http://localhost:3000`), are never printed when `CI` is set (one "Walk links minted but not printed" line instead — Actions logs are public), and are replaced by every reseed (the seed deletes the old `rsvp` and `group_restore` tokens explicitly, and its `User.destroy` takes every user-owned token of every kind with the users — the `ON DELETE CASCADE` on `single_use_tokens.user_id` in `models/index.js` and, in prod, migration `20260730000003-reconcile-single-use-tokens-user-fk.js` — so only tokens with no user survive a reseed, and no live token kind is user-less except `group_restore`; the explicit clear is what removes the restore token, and covers any database not yet migrated past that migration).

## The seed is the fixture layer (owner rule, 2026-10-27)

When a walk, UAT or capture row is blocked because the seeded data has no instance of the state it needs (a guest-joined event, a recurring schedule, an open ballot, a game-less group, an open RSVP link), the fix is a change to `seed-sample-data.js` so that a fresh `npm run seed` produces that state. Never a one-off scratch insert that the next reseed destroys, and never an escalation of the row to the owner. Owner, 2026-10-27: "We created the seed, if we come up against a thing that the seed could resolve, lets modify the seed to resolve that issue."

How: a blocked row becomes a backend branch and PR with a review record, then the owner's go on the merge (backend `main` deploys production, even though the seed never runs there), then a reseed of the local walk database and a re-capture. A walk's scratch fixtures get folded into the seed rather than carried as scripts.

Exceptions — the row stays escalated, with the reason written beside it:
- The state needs a walk user other than Alice (a member who owns no games, for example: Alice keeps her games for every other row). The seed adds that user; the capture signs in as them instead.
- Device-only checks the seed cannot reach (iPhone VoiceOver).
- A state that needs a secret the seed does not have (the RSVP links are skipped with a notice when `MAGIC_TOKEN_SECRET` is unset).

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

