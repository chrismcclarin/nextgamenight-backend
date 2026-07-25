# Google OAuth "App is Blocked" Error - Troubleshooting Guide

If you see "This app is blocked" when trying to sign in with Google or connect Google Calendar, follow these steps:

## Quick Fix: Add Your Email as a Test User

If your OAuth app is in "Testing" mode (which it is by default), you need to add test users:

1. Go to https://console.cloud.google.com
2. Select your project
3. Navigate to **APIs & Services → OAuth consent screen**
4. Scroll down to **Test users** section
5. Click **+ ADD USERS**
6. Add your email address (the one you're trying to sign in with)
7. Click **SAVE**

## For "Sign in with Google" (Auth0)

If you're using the "Sign in with Google" button on the landing page, this uses **Auth0's Google connection**, not our backend OAuth.

### Option 1: Configure Auth0 Google Connection

1. Go to https://manage.auth0.com
2. Navigate to **Authentication → Social**
3. Click **Create Connection**
4. Select **Google**
5. Enter your Google OAuth credentials:
   - **Client ID**: From Google Cloud Console
   - **Client Secret**: From Google Cloud Console
6. **Authorized Callback URLs**: Should include your Auth0 callback URL
   - Format: `https://YOUR_AUTH0_DOMAIN/login/callback`
7. Click **SAVE**

### Option 2: Use Auth0's Built-in Google Connection

Auth0 provides a default Google connection that you can enable:
1. Go to **Authentication → Social**
2. Find **Google** in the list
3. Click to enable it
4. No credentials needed - Auth0 handles it

## For "Connect Google Calendar" (Backend OAuth)

If you're trying to connect Google Calendar from the profile page, this uses our backend OAuth.

### Fix OAuth Consent Screen

1. Go to https://console.cloud.google.com
2. Select your project
3. Navigate to **APIs & Services → OAuth consent screen**

#### Step 1: Configure OAuth Consent Screen
- **User Type**: Choose "External" (unless you have a Google Workspace)
- **App name**: Enter your app name (e.g., "Periodic Tabletop")
- **User support email**: Your email
- **Developer contact information**: Your email
- Click **SAVE AND CONTINUE**

#### Step 2: Scopes
- Click **ADD OR REMOVE SCOPES**
- Add these scopes:
  - `https://www.googleapis.com/auth/calendar`
  - `https://www.googleapis.com/auth/calendar.events`
- Click **UPDATE**
- Click **SAVE AND CONTINUE**

#### Step 3: Test Users (IMPORTANT!)
- Click **+ ADD USERS**
- Add your email address (the one you're trying to use)
- Add any other test user emails
- Click **SAVE AND CONTINUE**

#### Step 4: Summary
- Review and click **BACK TO DASHBOARD**

### Publishing Your App (Optional)

If you want anyone to use it without being a test user:
1. Go to **OAuth consent screen**
2. Click **PUBLISH APP**
3. Note: This may require app verification if you request sensitive scopes

## Common Issues

### Issue: "App is blocked" even after adding test user
**Solution**: 
- Make sure you're using the exact email address you added
- Clear browser cache and cookies
- Try in incognito mode
- Wait a few minutes for changes to propagate

### Issue: "Redirect URI mismatch"
**Solution**:
- Check that the redirect URI in Google Cloud Console matches exactly:
  - For Calendar: `http://localhost:4000/api/auth/google/callback`
  - For Auth0: Your Auth0 callback URL
- No trailing slashes, exact match required

### Issue: "Invalid client"
**Solution**:
- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your `.env` file
- Make sure they match what's in Google Cloud Console
- Restart your backend server after updating `.env`

## Testing

After making changes:
1. Restart your backend server
2. Clear browser cache
3. Try the connection again


