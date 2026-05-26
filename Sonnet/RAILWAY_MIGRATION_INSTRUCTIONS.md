# Railway Database Migration Instructions

> **Parked CI idea — not yet wired up:** [`docs/migrations-check.ci.yml.disabled`](docs/migrations-check.ci.yml.disabled) is a GitHub Actions workflow that smoke-tests migrations on PRs (fresh Postgres → apply all migrations from scratch → re-run for idempotency). It was written in phase 74-03 but never ran (it lived in the remote-less umbrella repo). If you're doing migration work and want an automated safety net, see that file's header for the ~6-step "to activate" checklist. Otherwise leave it parked.

## Migrating UserGroup.user_id from UUID to STRING

This migration changes the `UserGroups.user_id` column from UUID to VARCHAR(255) to support Auth0 user IDs (which are strings like `google-oauth2|107459289778553956693`).

## Option 1: Using pgAdmin 4 (Recommended - Easiest GUI)

pgAdmin 4 is a great PostgreSQL administration tool that makes running SQL migrations simple:

1. **Install pgAdmin 4** (if not already installed):
   - Download from: https://www.pgadmin.org/download/
   - Or on macOS: `brew install --cask pgadmin4`
   - Or on Windows: Download installer from website

2. **Get Connection Details from Railway**:
   - Go to Railway Dashboard: https://railway.app
   - Select your PostgreSQL database service
   - Click on **"Connect"** tab (or "Variables" tab)
   - Look for **"Public Networking"** section or connection string
   - You need the **actual values**, not the variable names:
     - **Hostname**: Will look like `containers-us-west-xxx.railway.app` or `monorail.proxy.rlwy.net` (NOT "PGHOST")
     - **Port**: Usually `5432` or a 5-digit number (NOT "PGPORT")
     - **Database**: Usually `railway` (NOT "PGDATABASE")
     - **Username**: Usually `postgres` (NOT "PGUSER")
     - **Password**: The actual password string (NOT "PGPASSWORD")
   
   **Important**: The connection string looks like `gondola.proxy.rlwy.net:12889/railway` or `postgresql://postgres:password@gondola.proxy.rlwy.net:12889/railway`
   - Hostname: `gondola.proxy.rlwy.net` (the part before the `:` or after `@`)
   - Port: `12889` (the number after the `:`)
   - Database: `railway` (the part after the last `/`)
   - Username/Password: Usually `postgres` / (check Railway Variables tab for `PGUSER` and `PGPASSWORD` values)

3. **Connect to Database in pgAdmin 4**:
   - Open pgAdmin 4
   - Right-click on "Servers" → "Create" → "Server"
   - **General tab**: Name it "Railway Production" (or any name)
   - **Connection tab**: Enter the ACTUAL VALUES (not variable names):
     - **Host name/address**: The actual hostname (e.g., `containers-us-west-xxx.railway.app`)
     - **Port**: The actual port number (e.g., `5432` or `12345`)
     - **Maintenance database**: The actual database name (usually `railway`)
     - **Username**: The actual username (usually `postgres`)
     - **Password**: The actual password string (check "Save password" if you want)
   - **SSL tab**: Select "Require" mode
   - Click "Save"

4. **Run the Migration SQL**:
   - Expand your new server connection
   - Expand "Databases" → `railway` → "Schemas" → "public"
   - Click on "Query Tool" icon (or right-click database → "Query Tool")
   - Paste the SQL from "Quick SQL Migration" section below
   - Click the "Execute" button (▶) or press F5
   - Verify success messages appear

5. **Verify the Migration**:
   - Run this query to verify:
   ```sql
   SELECT data_type, character_maximum_length
   FROM information_schema.columns
   WHERE table_name = 'UserGroups' AND column_name = 'user_id';
   ```
   - Should return: `character varying` with `255` max length

## Option 2: Using Railway Web Interface

The Railway CLI's `railway run` uses internal hostnames that don't work from your local machine. Using the web interface is easier:

1. **Go to Railway Dashboard**: https://railway.app
2. **Select your backend project**
3. **Go to your PostgreSQL database service**
4. **Click on "Query" or "Data" tab** (some Railway plans have this)
5. **Run the SQL commands below** (see "Quick SQL Migration" section)

**OR use the migration script with a public connection string** (see Option 2)

## Option 3: Using Migration Script with Public Connection String

1. **Get Public Connection String from Railway**:
   - Go to Railway Dashboard → Your PostgreSQL service
   - Click "Connect" or "Variables"
   - Look for "Public Network" connection string (or create one if needed)
   - Copy the full connection string (looks like: `postgresql://user:pass@hostname.railway.app:port/railway`)

2. **Run the migration script locally**:
   ```bash
   cd periodictabletopbackend_v2/Sonnet
   DATABASE_URL="your-public-connection-string-here" node scripts/migrate-usergroup-user-id-production.js
   ```

   This will:
   - Connect to your Railway database using the public URL
   - Check the current column type
   - Change it from UUID to VARCHAR if needed
   - Migrate all existing data from UUID to Auth0 user_id strings
   - Verify the migration

## Quick SQL Migration (Use with pgAdmin 4 or Railway Web Interface)

Copy and run this SQL in pgAdmin 4's Query Tool, or Railway's web interface:

If Railway CLI gives you the internal hostname error, use the web interface instead:

1. **Go to Railway Dashboard**: https://railway.app
2. **Select your backend project**
3. **Go to your PostgreSQL database service**
4. **Click on "Connect"** to see connection options
5. **Look for "Query" or "Data" tab** - or use a database client
6. **Run these SQL commands**:

### Step 1: Check current state
```sql
SELECT data_type 
FROM information_schema.columns 
WHERE table_name = 'UserGroups' AND column_name = 'user_id';
```

### Step 2: Drop foreign key constraint (if exists)
```sql
ALTER TABLE "UserGroups" DROP CONSTRAINT IF EXISTS "UserGroups_user_id_fkey";
```

### Step 3: Change column type
```sql
ALTER TABLE "UserGroups" 
ALTER COLUMN "user_id" TYPE VARCHAR(255) USING "user_id"::text;
```

### Step 4: Migrate existing data
This automatically updates ALL UserGroup records that have UUID values to use the corresponding Auth0 user_id strings:

```sql
-- First, check which records need migration (optional - just to see what will be updated)
SELECT ug.id, ug.user_id as current_uuid, u.user_id as auth0_user_id, u.username
FROM "UserGroups" ug
LEFT JOIN "Users" u ON u.id::text = ug.user_id::text
WHERE ug.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
```

```sql
-- Now update ALL UserGroups that have UUID values to use Auth0 user_id strings
UPDATE "UserGroups" ug
SET user_id = u.user_id
FROM "Users" u
WHERE ug.user_id::text = u.id::text
AND ug.user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
```

This single command will automatically update all UserGroup records that have UUID values (like `2271fcc5-c12f-4119-9143-cc975b1e65ee`) to the corresponding Auth0 user_id strings (like `google-oauth2|107459289778553956693`) from the Users table.

## Option 4: Direct Database Connection (Command Line)

If you have direct database access:

1. **Get your database connection string** from Railway:
   - Go to your PostgreSQL service
   - Click "Connect" or "Variables"
   - Copy the `DATABASE_URL` or connection details

2. **Connect using psql or a database client**:
   ```bash
   psql $DATABASE_URL
   ```

3. **Run the SQL commands** from Option 2 above, or use the migration script:
   ```bash
   DATABASE_URL="your-railway-database-url" node scripts/migrate-usergroup-user-id-production.js
   ```

## Verification

After migration, verify it worked:

```sql
-- Check column type
SELECT data_type 
FROM information_schema.columns 
WHERE table_name = 'UserGroups' AND column_name = 'user_id';
-- Should return: character varying or varchar

-- Check data
SELECT 
  COUNT(*) as total,
  COUNT(CASE WHEN user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 1 END) as uuid_count,
  COUNT(CASE WHEN user_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN 1 END) as string_count
FROM "UserGroups";
```

The `uuid_count` should be 0 (or very low if there are orphaned records).

## Troubleshooting

- **"relation does not exist"**: Make sure you're connected to the correct database
- **"permission denied"**: Check that your database user has ALTER TABLE permissions
- **"foreign key constraint"**: The script should handle this, but if it fails, manually drop the constraint first
- **"connection refused"**: Verify your DATABASE_URL is correct and the database is accessible
