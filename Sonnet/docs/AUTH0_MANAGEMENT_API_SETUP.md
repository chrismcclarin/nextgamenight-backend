# Auth0 Management API Setup

This guide explains how to set up Auth0 Management API to enable proper user lookup and email extraction for email/password authentication users.

## Why This Is Needed

When users sign up with email/password (instead of Google OAuth), their email address may not always be included in the access token. The Auth0 Management API allows us to:

1. Look up users by email when adding them to groups
2. Fetch complete user profiles including email and name
3. Automatically correct user information (email/username) in our database

## IMPORTANT: `AUTH0_TENANT_DOMAIN` vs `AUTH0_DOMAIN` (added Phase 88.8)

**If Management API calls are returning 403, this section is almost certainly why.**

Auth0 gives a tenant **two** domains:

| Variable | Holds | Used for |
| --- | --- | --- |
| `AUTH0_DOMAIN` | the **custom login domain**, e.g. `auth.nextgamenight.app` | validating login tokens — the JWT `issuer` and the JWKS key-set URL |
| `AUTH0_TENANT_DOMAIN` | the **canonical tenant domain**, always ending `.auth0.com` | the Management API audience and every Management API request URL |

Auth0 requires the Management API **audience** to be the canonical tenant domain, *even
when your users log in through a custom domain*. Before Phase 88.8 this backend built the
Management audience from `AUTH0_DOMAIN`, which holds the custom domain — producing
`https://auth.nextgamenight.app/api/v2/`, an API identifier that does not exist. Every
Management token exchange 403'd from 2026-04 onward, so first-time sign-ins fell back to
inventing a synthetic `<sub>@auth0.local` email address instead of storing the real one.

### Where to find the canonical value

Auth0 Dashboard -> the **tenant dropdown** at the top left (it is shown next to the tenant
name), or **Settings -> General**. It ends in `.auth0.com` (e.g. `something.us.auth0.com`).
It is **not** the custom login domain.

### Setting it

Add `AUTH0_TENANT_DOMAIN` to the backend environment (Railway -> backend service ->
Variables, and your local `.env` if you run Management calls locally).

**Do not change `AUTH0_DOMAIN`.** It must keep the custom domain, because that is what
validates login tokens. Moving the issuer or the JWKS URL onto the tenant domain would
reject every real login — that would be a bug, not a cleanup.

If `AUTH0_TENANT_DOMAIN` is unset, the code falls back to `AUTH0_DOMAIN`, which reproduces
the old (broken-with-a-custom-domain) URLs exactly. That fallback is deliberate: it means
the code and the variable can be rolled out in either order without a broken window. In
production the fallback logs a warning and raises one Sentry event so it cannot stay silent.

## Step 1: Create a Machine-to-Machine Application in Auth0

1. Go to [Auth0 Dashboard](https://manage.auth0.com)
2. Navigate to **Applications** → **Applications**
3. Click **+ Create Application**
4. Select **Machine to Machine Applications**
5. Name it something like "Backend Management API" or "PeriodicTableTop Backend"
6. Click **Create**

## Step 2: Authorize the Application for Management API

1. After creating the application, you'll be prompted to authorize it for an API
2. Select **Auth0 Management API** from the dropdown
3. Click **Authorize**
4. In the **Permissions** section, select the following scopes:
   - `read:users` - Required to read user information
   - `read:user_idp_tokens` - Optional, for advanced use cases
5. Click **Authorize**

## Step 3: Get the Credentials

1. Stay on the application's settings page
2. Note down:
   - **Client ID** (this is your `AUTH0_MANAGEMENT_CLIENT_ID`)
   - **Client Secret** (this is your `AUTH0_MANAGEMENT_CLIENT_SECRET` - click "Show" to reveal it)

## Step 4: Add Environment Variables

### Local Development (.env file)

Add these to your backend `.env` file:

```env
AUTH0_DOMAIN=auth.your-custom-domain.example        # custom login domain — JWT issuer / JWKS
AUTH0_TENANT_DOMAIN=your-tenant.us.auth0.com        # canonical tenant domain — Management API
AUTH0_MANAGEMENT_CLIENT_ID=your-management-client-id
AUTH0_MANAGEMENT_CLIENT_SECRET=your-management-client-secret
```

**Note:** You should already have `AUTH0_DOMAIN` set. You need to add the Management API
credentials **and** `AUTH0_TENANT_DOMAIN` — see the section at the top of this document for
why the two domains are different and must not be swapped.

### Railway (Production)

1. Go to your Railway project dashboard
2. Select your backend service
3. Go to **Variables** tab
4. Add these variables:
   - `AUTH0_MANAGEMENT_CLIENT_ID` = (your Client ID from Step 3)
   - `AUTH0_MANAGEMENT_CLIENT_SECRET` = (your Client Secret from Step 3)

## Step 5: Verify Setup

After adding the environment variables, restart your backend server. The system will:

1. Automatically use Management API to fetch user details when email is missing from token
2. Allow searching for users by email even if they haven't logged in yet
3. Auto-correct user information when they log in

## Troubleshooting

### "Auth0 Management API credentials not configured"

- Make sure `AUTH0_MANAGEMENT_CLIENT_ID`, `AUTH0_MANAGEMENT_CLIENT_SECRET`, and `AUTH0_DOMAIN` are all set in your environment variables
- Restart your backend server after adding the variables

### "Failed to get Auth0 Management API token"

- **First: check `AUTH0_TENANT_DOMAIN` is set to the canonical `*.auth0.com` domain.** A 403
  here with a custom login domain in `AUTH0_DOMAIN` is the Phase 88.8 root cause described at
  the top of this document, not a credential problem. Since Phase 88.8 every one of these
  failures also raises a Sentry event tagged `service: auth0-management` with an `op` tag
  naming the call that failed (`token`, `getUserById`, `searchUsersByEmail`, `deleteUser`).
- Verify the Client ID and Client Secret are correct
- Check that the application is authorized for "Auth0 Management API"
- Ensure the application type is "Machine to Machine" (not "Native" or "Regular Web Application")

### Users still showing "User" as username or "@auth0.local" email

- The system will try to fix this automatically when users log in
- You can also manually refresh user info by calling `POST /api/users/:user_id/refresh` (requires authentication)
- Make sure the Management API has `read:users` permission

### Search by email still returns 404

- The search endpoint will work even without Management API (searches database only)
- With Management API, it will also search Auth0 and auto-create users found there
- Make sure Management API credentials are set correctly

## Security Notes

- The Management API credentials are sensitive - never commit them to git
- The Management API has access to all users in your Auth0 tenant
- Only grant the minimum permissions needed (`read:users` is sufficient for this use case)
- Consider using environment variable encryption on Railway for production

## Fallback Behavior

If the Management API is not configured, the system will still work but with limitations:

- User search will only find users already in the database
- Auto-creation will use fallback email/username if not in token
- Email/password users may need to manually update their profile after first login

The Management API setup is **recommended but optional** - the application will function without it, just with reduced functionality.
