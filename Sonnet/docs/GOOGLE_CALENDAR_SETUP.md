# Google Calendar Integration Setup

This document explains how to set up Google Calendar integration for the board game event tracking application.

## Overview

When a new game event is created in the **future**, the system can automatically add it to Google Calendar and send invitation emails to all group members.

### Important: Gmail vs Non-Gmail Users

- **Users with Google Calendar connected** (Gmail or any Google account):
  - Events are automatically added to their Google Calendar
  - Requires OAuth 2.0 authorization (connecting Google Calendar in profile)
  
- **Users without Google Calendar connected** (any email, including non-Gmail):
  - Receive invitation emails (sent by Google Calendar API)
  - Can manually add the event to their calendar from the invitation email
  - **No Google account required** to receive invitations

**Key Point**: Only ONE group member needs to have Google Calendar connected. When they create an event, Google Calendar sends invitation emails to ALL group members (regardless of email domain). Everyone receives the invitation, but only users with Google Calendar connected get the event automatically added to their calendar.

## Prerequisites

1. **Google Cloud Console Project**
   - Create a project at https://console.cloud.google.com
   - Enable the Google Calendar API
   - Create OAuth 2.0 credentials

2. **Configure OAuth Consent Screen** (IMPORTANT - Prevents "App is blocked" error)
   - Go to **APIs & Services → OAuth consent screen**
   - **User Type**: Choose "External"
   - **App name**: Your app name (e.g., "Periodic Tabletop")
   - **User support email**: Your email
   - **Developer contact**: Your email
   - **Scopes**: Add these scopes:
     - `https://www.googleapis.com/auth/calendar`
     - `https://www.googleapis.com/auth/calendar.events`
   - **Test Users**: Add your email address (and any other test users)
     - This is REQUIRED if your app is in "Testing" mode
     - Without this, you'll get "This app is blocked" error
   - Click **SAVE AND CONTINUE** through all steps

3. **Environment Variables**
   Add these to your `.env` file:
   ```
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-client-secret
   GOOGLE_REDIRECT_URI=http://localhost:4000/api/auth/google/callback
   ```
   
   **Important**: 
   - Make sure the redirect URI in your Google Cloud Console matches exactly: `http://localhost:4000/api/auth/google/callback`
   - Add your email as a test user in OAuth consent screen to avoid "app is blocked" error

## Implementation Approach

**Note**: Full Google Calendar integration requires:
1. OAuth 2.0 flow to authorize each user
2. Storing Google OAuth tokens in the database
3. Token refresh logic
4. User consent UI

### Recommended Approach

For a production implementation, you would need:

1. **User Authorization Flow**
   - Add "Connect Google Calendar" button to user profile
   - Redirect users to Google OAuth consent screen
   - Store access/refresh tokens in User model
   - Handle token refresh automatically

2. **Database Schema Updates**
   - Add fields to User model:
     - `google_calendar_token` (encrypted)
     - `google_calendar_refresh_token` (encrypted)
     - `google_calendar_enabled` (boolean)

3. **Calendar Event Creation**
   - When creating future events, check if user has Google Calendar enabled
   - Use stored tokens to create calendar events
   - Send invitations to all group members

### Alternative: Simplified Approach

For now, we can implement the infrastructure but note that:
- Each user must authorize Google Calendar access separately
- This requires frontend OAuth flow
- Tokens need to be stored securely

## Current Implementation

The `googleCalendarService.js` service is set up with:
- Calendar event creation logic
- Attendee invitation handling
- Future event detection

However, to use this service, you need to:
1. Set up Google OAuth 2.0
2. Implement user authorization flow
3. Store user tokens securely
4. Call the service when creating future events

## Next Steps

1. Set up Google Cloud Console project
2. Install `googleapis` package: `npm install googleapis`
3. Implement OAuth 2.0 authorization flow
4. Add token storage to User model
5. Integrate calendar creation into event creation endpoint

