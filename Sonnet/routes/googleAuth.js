// routes/googleAuth.js
// Google OAuth 2.0 routes for Calendar integration
const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const { User, SingleUseToken, PendingAuth0Deletion } = require('../models');
const { sendError, AppError } = require('../utils/errors');
const { resolveAllowedFrontendUrl } = require('../config/allowedOrigins');
const { matchesSelf } = require('../middleware/objectAuth');
const router = express.Router();

// OAuth state nonce lifetime: the consent round-trip is short; 30 min is generous.
const OAUTH_STATE_TTL_MS = 30 * 60 * 1000;

// Initialize OAuth2 client
const getOAuth2Client = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  
  // Determine redirect URI - check env var, or construct from Railway domain, or use localhost default
  let redirectUri = process.env.GOOGLE_REDIRECT_URI;
  
  if (!redirectUri) {
    // Try to construct from Railway environment (Railway provides RAILWAY_PUBLIC_DOMAIN)
    if (process.env.RAILWAY_PUBLIC_DOMAIN) {
      redirectUri = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/auth/google/callback`;
    } else if (process.env.NODE_ENV === 'production') {
      // In production without explicit redirect URI and no Railway domain, throw error
      throw new Error('GOOGLE_REDIRECT_URI environment variable is required in production. Set it to your production backend URL (e.g., https://your-backend.railway.app/api/auth/google/callback)');
    } else {
      // Development: use localhost default
      redirectUri = 'http://localhost:4000/api/auth/google/callback';
    }
  }
  
  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID environment variable is not set');
  }
  
  if (!clientSecret) {
    throw new Error('GOOGLE_CLIENT_SECRET environment variable is not set');
  }
  
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
};

// Helper function to generate Google OAuth URL
const generateGoogleAuthUrl = async (user_id, email = null, username = null, frontendUrl = null) => {
  // SPEC Req 6 (Phase 87.2 tombstone guard, self-keyed): both callers pass the
  // verified token sub. A still-valid token surviving account deletion must not
  // re-provision the Users row via the OAuth-URL mint. Throw the registered
  // AppError so the routes' catch blocks map it to the pinned 410 envelope.
  if (await PendingAuth0Deletion.isTombstoned(user_id)) {
    throw new AppError('account_deleted');
  }

  // Create or find user (auto-create if doesn't exist)
  const [user, created] = await User.findOrCreate({
    where: { user_id },
    defaults: {
      user_id,
      email: email || null,
      username: username || email?.split('@')[0] || 'User',
    }
  });

  // Update user info if provided and user already existed
  if (!created && (email || username)) {
    const updateData = {};
    if (email) updateData.email = email;
    if (username) updateData.username = username;
    await user.update(updateData);
  }

  const oauth2Client = getOAuth2Client();

  // Generate authorization URL
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly'
  ];

  // D-04 / BSEC-03: server-stored crypto nonce instead of unsigned base64-JSON state.
  // The callback resolves user_id FROM the stored row (kills BE-001 login-CSRF) and
  // redirects to the allow-listed frontend_url stored alongside it (kills BE-024 open redirect).
  // Allow-list the requested frontend_url against the SAME allow-list CORS uses;
  // reject anything not on it by falling back to FRONTEND_URL (never reflect attacker input).
  const allowedFrontendUrl =
    resolveAllowedFrontendUrl(frontendUrl) ||
    resolveAllowedFrontendUrl(process.env.FRONTEND_URL) ||
    process.env.FRONTEND_URL ||
    'http://localhost:3000';

  const nonce = crypto.randomBytes(32).toString('base64url');
  await SingleUseToken.create({
    nonce,
    user_id,
    purpose: 'oauth_state',
    frontend_url: allowedFrontendUrl,
    status: 'active',
    expires_at: new Date(Date.now() + OAUTH_STATE_TTL_MS),
  });

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Required to get refresh token
    scope: scopes,
    prompt: 'consent', // Force consent screen to get refresh token
    state: nonce, // Opaque server-stored nonce — NOT client-controlled state
  });

  return authUrl;
};

// Get Google OAuth URL as JSON (for authenticated API calls)
router.get('/google/url', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get user info from token (preferred) or query params (fallback for backwards compatibility)
    const email = req.user?.email || req.query.email || null;
    const username = req.user?.name || req.user?.nickname || req.query.username || null;

    // Get frontend URL from request origin, query param, or environment variable
    // This ensures the callback redirects to the correct frontend URL
    const frontendUrl = req.query.frontend_url ||
                       (req.headers.origin ? req.headers.origin.replace(/\/$/, '') : null) ||
                       process.env.FRONTEND_URL ||
                       'http://localhost:3000';

    const authUrl = await generateGoogleAuthUrl(userId, email, username, frontendUrl);

    // Return URL as JSON
    res.json({ authUrl });
  } catch (error) {
    if (error instanceof AppError && error.code === 'account_deleted') {
      // Phase 87.2 tombstone refusal — pinned 410 envelope, never a raw 500.
      return sendError(res, 'account_deleted');
    }
    console.error('Error generating Google OAuth URL:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Step 1: Redirect user to Google OAuth consent screen (deprecated - use /url endpoint instead)
router.get('/google', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { email, username } = req.query; // Optional, for user creation

    const authUrl = await generateGoogleAuthUrl(userId, email, username);

    // Redirect to Google
    res.redirect(authUrl);
  } catch (error) {
    if (error instanceof AppError && error.code === 'account_deleted') {
      // Phase 87.2 tombstone refusal — pinned 410 envelope, never a raw 500.
      return sendError(res, 'account_deleted');
    }
    console.error('Error initiating Google OAuth:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Step 2: Handle OAuth callback from Google (PUBLIC - no auth required)
router.get('/google/callback', async (req, res) => {
  // D-04: the resolved nonce row is hoisted so BOTH the success path AND the
  // catch-block error redirect derive frontend_url from it — never from a
  // re-parse of req.query.state (the second open-redirect sink, now removed).
  let consumedToken = null;
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    if (!state) {
      return res.status(400).json({ error: 'State parameter is required' });
    }

    // D-04 / BSEC-03: atomically consume the server-stored single-use nonce.
    // Zero rows => forged / replayed / expired => 403. This resolves user_id
    // and frontend_url FROM the row (the client cannot influence either).
    consumedToken = await SingleUseToken.consumeByNonce(state);
    if (!consumedToken || consumedToken.purpose !== 'oauth_state') {
      console.error('OAuth callback rejected: invalid, expired, or already-used state nonce');
      const errUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      return res.redirect(`${errUrl}/userProfile/?google_calendar=error&message=${encodeURIComponent('Invalid or expired authorization request')}`);
    }

    const user_id = consumedToken.user_id;
    // frontend_url was allow-listed at mint time; trust the stored value.
    const frontendUrl = consumedToken.frontend_url || process.env.FRONTEND_URL || 'http://localhost:3000';

    // SPEC Req 6 (Phase 87.2 tombstone guard, self-keyed): the sub was resolved from
    // the nonce minted by the same (now-deleted) user. Refuse before the findOrCreate
    // below can re-materialize the Users row mid-OAuth-flow. Pinned refusal shape:
    // 410 account_deleted envelope.
    if (await PendingAuth0Deletion.isTombstoned(user_id)) {
      return sendError(res, 'account_deleted');
    }

    // Find or create user (should exist from step 1, but create if needed)
    const [user] = await User.findOrCreate({
      where: { user_id },
      defaults: {
        user_id,
        username: 'User',
        email: null,
      }
    });

    const oauth2Client = getOAuth2Client();

    // Exchange authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      console.error('No access token received from Google');
      throw new Error('Failed to get access token from Google');
    }

    // Store tokens in database
    // Note: Refresh token might be null if user already granted permission (Google reuses existing consent)
    const updateData = {
      google_calendar_token: tokens.access_token,
      google_calendar_enabled: true,
    };

    // Only update refresh token if we received one (if null, keep existing refresh token)
    if (tokens.refresh_token) {
      updateData.google_calendar_refresh_token = tokens.refresh_token;
    }

    await user.update(updateData);

    // Redirect to frontend success page using the allow-listed frontend URL from the row
    res.redirect(`${frontendUrl}/userProfile/?google_calendar=connected`);
  } catch (error) {
    console.error('Error handling Google OAuth callback:', error.message);
    // D-04: derive the error-redirect target from the RESOLVED row's allow-listed
    // frontend_url (or the env default) — NEVER from re-parsing req.query.state.
    // An attacker-supplied state cannot influence the error redirect.
    const frontendUrl =
      (consumedToken && consumedToken.frontend_url) ||
      process.env.FRONTEND_URL ||
      'http://localhost:3000';
    res.redirect(`${frontendUrl}/userProfile/?google_calendar=error&message=${encodeURIComponent(error.message)}`);
  }
});

// Disconnect Google Calendar
router.post('/google/disconnect', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Clear Google Calendar tokens
    await user.update({
      google_calendar_token: null,
      google_calendar_refresh_token: null,
      google_calendar_enabled: false,
    });

    res.json({ message: 'Google Calendar disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting Google Calendar:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get Google Calendar connection status
router.get('/google/status/:user_id', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify that the requested user_id matches the authenticated user
    if (!(await matchesSelf(req, req.params.user_id))) {
      return res.status(403).json({ error: 'Forbidden: Cannot access other users\' calendar status' });
    }

    // Find user (don't auto-create, just return status)
    const user = await User.findOne({
      where: { user_id: userId },
      attributes: ['google_calendar_enabled', 'google_calendar_token']
    });

    // If user doesn't exist, they're not connected
    if (!user) {
      return res.json({ connected: false });
    }

    // Check if calendar is enabled AND has a token (both required for "connected")
    const isConnected = !!(user.google_calendar_enabled && user.google_calendar_token);
    
    res.json({ 
      connected: isConnected
    });
  } catch (error) {
    console.error('Error getting Google Calendar status:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Refresh Google Calendar token
router.post('/google/refresh', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user || !user.google_calendar_refresh_token) {
      return res.status(404).json({ error: 'User not found or no refresh token available' });
    }

    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      refresh_token: user.google_calendar_refresh_token,
    });

    // Refresh the token
    const { credentials } = await oauth2Client.refreshAccessToken();
    
    // Update stored token
    await user.update({
      google_calendar_token: credentials.access_token,
      // Refresh token might be updated too
      google_calendar_refresh_token: credentials.refresh_token || user.google_calendar_refresh_token,
    });

    res.json({ message: 'Token refreshed successfully' });
  } catch (error) {
    console.error('Error refreshing Google Calendar token:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

