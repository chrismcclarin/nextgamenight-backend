# Sample Data Seeding Script

This script populates your database with realistic sample data for testing and development.

## What Gets Created

### Users (7)
- Alice, Bob, Charlie, Diana, Eve, Frank
- Bartholomew Featherstonehaugh-Cholmondeley — owns no games; the long name wraps a 375px profile title (Phase 88.9 walk, rows W152 / #29)

**Addresses and the one SMS user (quick 261119-nv0).** The user table lives in `scripts/lib/seed-users.js`. Each user has a tag: `alice`, `bob`, `charlie`, `diana`, `eve`, `frank`, `bartholomew`; the pending invite uses `pending-invitee`.
- With `SEED_EMAIL_BASE` unset (local development, CI), every address is the tag at `example.com`, a reserved domain that delivers nowhere. This is what the seed has always written.
- With `SEED_EMAIL_BASE` set to one plain address (staging), every address becomes a plus-address of it: the part before the `@`, then `+`, then the tag, then the same domain. All seeded mail then lands in that one mailbox. The base itself must have no `+` in it.
- `SEED_SMS_USER`, when set to one tag, gives that one user `sms_enabled` and leaves the other six without it. Unset means nobody has it. A value that is not a tag stops the seed before it connects. The seed never writes a phone number: add and verify the phone in the app, and do it again after each reseed.
- The seed's output names users by username and never prints an address.

### Groups (7)
- **Weekend Warriors** - 4 members (Alice owner, Bob, Charlie, Diana); two prompt schedules (Thursday check-in active, Sunday afternoon paused)
- **Strategy Squad** - 7 members (Frank owner, Bob, Charlie, Eve, Alice, Diana, Bartholomew); the one group where Alice sees more than 4 other members, so her home card shows four chips and a "+2" overflow chip (Phase 88.9 round 2, pick row D2 / #77). Consequence: create-event pre-fills all 7 as participants and no owned game allows 7 players, so its Suggestions slot shows the empty hint — Weekend Warriors (4 players) is the group whose slot shows suggestions. It stores the colour preset `green` and has no header image (88.9-R2 fixture, quick 261110-ugi): it is the coloured, image-less group Alice belongs to (N16b, and the tint on N12's day-modal rows), so its +N chip now sits on a green card. It also holds three status nights (see Events)
- **Casual Gamers** - 4 members (Diana owner, Eve, Frank, Alice); colour preset `blue` with a BROKEN header image URL (the fallback the 88.9 walk measures) (88.9-R2 fixture: O-02 / #207, the O02d1 image-failure arm, N16; the host is on the RFC 2606 `.invalid` TLD so the fetch fails fast without reaching a real site)
- **Dice Dynasty** - 3 members (Charlie owner, Eve, Frank); Alice is NOT a member and attends its event as a guest
- **No Games Yet** - 3 members (Frank owner, Eve, Bartholomew); nobody in it owns a game, so create-event's Suggestions slot shows its empty hint
- **Retired Raiders** - 3 members (Alice owner, Bob, Eve) and 1 past event; SOFT-DELETED at the end of the seed through the same service the delete button uses, so it is hidden everywhere and restorable for 30 days from the seed run (the restore link below)
- **Photo Club** - 2 members (Eve owner, Alice); NO stored colour, and a header image that loads: the FE's own `/seed/photo-club-table.jpg` at `FRONTEND_URL` (a busy generated game-table picture with a bright and a dark corner, so the title is judged over a real picture, not a logo); 1 past Ticket to Ride night, so its "Last Game:" row shows a game name. It is the photo card with no stored colour (88.9-R2 fixture, quick 261110-ugi; N16)

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

### Events (8 past game sessions + 1 cancelled earlier on the seed day + 5 upcoming, plus 1 past event hidden inside Retired Raiders)
- Weekend Warriors: 3 past events (Catan, Ticket to Ride, Wingspan); 1 upcoming (Catan, ~3 days out) with an OPEN ballot (Catan / Wingspan) and Eve joined as a guest
- Strategy Squad: 2 past events (Gloomhaven, Azul); 1 upcoming (~10 days out, no participants yet); plus three status nights, all Gloomhaven with no participants (88.9-R2 fixtures, quick 261110-ugi):
  - a CANCELLED night (18:00) and a COMPLETED night (20:30) on one local day 12 days after the seed (W57 / R2-03; N11 Later rows, N12 day modal). Tapping that day opens the day modal with both tagged rows
  - a cancelled night that started earlier on the seed day (N40). It sits under Past, untagged
- Casual Gamers: 2 past events (Codenames, Custom Card Game)
- Dice Dynasty: 1 upcoming (Codenames, ~6 days out) with Alice joined as a guest
- Photo Club: 1 past event (Ticket to Ride, ~4 days ago, completed), its "Last Game:" (N16)
- Retired Raiders: 1 past event (Ticket to Ride, ~20 days ago, Alice won) — hidden with its group until someone restores it
- Azul's image URLs are deliberately dead (the SafeImage fallback)
- Reseed timing for the 88.9 round-2 glance: the N40 night needs a reseed on the glance's own local day (it is "earlier today" only on the seed day), and the two status nights stay in Later for 12 days after the seed

### Game Reviews (11)
- Reviews from various users across different groups

### Friendships (5)
- Alice has four accepted friends: Diana (already a Weekend Warriors member, so her invite checkbox there is disabled) and Eve, Frank and Bartholomew (not members of Weekend Warriors, the one live group Alice owns (Retired Raiders, her other, is soft-deleted by the seed), so all three can be ticked in its invite panel and on the Friends page's Invite to Group; 88.9-R2 fixtures, quick 261111-frd, glance rows N45 / N54).
- Charlie has sent Alice a request that is still pending (the incoming-request surface).
- Bob has no friendship row with Alice on purpose: his name popover is the one that offers "Add friend".

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

## Where the seed may run (the guard)

The seed changes the schema and deletes every row in the database it is pointed at. Before it does anything it asks a guard (`scripts/lib/assert-not-production-db.js`), and it prints which database it resolved (host, port and database name, never a username or password) and what the guard found.

**On your machine and in CI (`NODE_ENV` is not `production`).** The database host must be `localhost`, `127.0.0.1` or `::1`. Any other host is refused unless `ALLOW_DESTRUCTIVE_SEED=1` is set on purpose for a database that is safe to wipe.

**With `NODE_ENV=production`** the seed is refused, with one exception: the staging environment on Railway, which runs in production mode so that it behaves like the live site (owner ruling G1, 2026-11-19). The exception opens only when all four locks hold:

1. `RAILWAY_ENVIRONMENT_NAME` is exactly `staging` (Railway sets this itself).
2. `ALLOW_STAGING_SEED` is exactly `1`.
3. The database host can be read and, when `PROD_DB_HOST_DENY` is set, does not contain it.
4. The Users table holds nobody except the seed's own users and plus-addresses of `SEED_EMAIL_BASE`.

Things to know about the locks:
- **Lock 4 is the one that protects production.** Production holds real people, so production always fails it, and it does not depend on any variable being set correctly. It is a read (one `SELECT`) and it runs before the first change.
- **Lock 3 is weak, and known to be.** Inside Railway the staging and production database hosts very likely have the same name, so lock 3 cannot tell them apart. It only catches a staging variable that points at the host written in `PROD_DB_HOST_DENY`.
- **`ALLOW_STAGING_SEED` belongs on the staging service only. Never set it on production.** `ALLOW_DESTRUCTIVE_SEED` does nothing in production mode.
- **In production mode the seed does not change the schema.** Staging's tables are built by its migrations, the same way production's are, so the seed skips its schema sync there and prints a line saying so. It still empties and refills the tables. On your machine and in CI the seed keeps syncing the schema from the models.
- A refusal names the lock that failed and what would make it pass. It names variables and never repeats what they hold; a lock 4 refusal gives a count of users, never an address.
- The fixture script (`scripts/e2e-fixtures.js`) has no staging exception: it never runs in production mode.

Setting staging up, and seeding it, is written out step by step in [`docs/staging-environment.md`](../docs/staging-environment.md).

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
2. Modify the arrays at the top (sampleGroups, sampleGames); the users are in `scripts/lib/seed-users.js`
3. Adjust the events, participations, and reviews as needed

## Data Relationships

- Users belong to Groups (via UserGroup)
- Events belong to Groups and reference Games
- EventParticipations link Users to Events
- GameReviews are created by Users for Games within Groups

