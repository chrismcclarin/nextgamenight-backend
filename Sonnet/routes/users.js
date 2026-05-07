// routes/users.js
const express = require('express');
const { User, Group, UserGroup, sequelize } = require('../models');
const router = express.Router();
const { validateUserSearch } = require('../middleware/validators');
const { writeOperationLimiter } = require('../middleware/rateLimiter');
const auth0Service = require('../services/auth0Service');
const smsService = require('../services/smsService');

// Search user by email
// Searches both our database and Auth0
router.get('/search/email/:email', validateUserSearch, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    
    // First, search in our database
    let user = await User.findOne({
      where: { email: email }
    });
    
    // If not found in database, try to find in Auth0 Management API
    // SECURITY: We ONLY create users if they exist in Auth0 (verified by Management API search)
    // We never create users "from thin air" - they must exist in Auth0 first
    if (!user) {
      try {
        const auth0Users = await auth0Service.searchUsersByEmail(email);
        
        // Only create user if found in Auth0
        if (auth0Users && auth0Users.length > 0) {
          // Found in Auth0, safe to create user in our database
          const auth0User = auth0Users[0]; // Use first match
          const userDetails = auth0Service.extractUserDetails(auth0User);
          
          // Create user in our database (they exist in Auth0, so this is safe)
          const [newUser, created] = await User.findOrCreate({
            where: { user_id: userDetails.user_id },
            defaults: {
              user_id: userDetails.user_id,
              email: userDetails.email,
              username: userDetails.username, // This includes the username they entered during signup
            }
          });
          
          // If user already existed but had wrong email, update it
          if (!created && newUser.email !== userDetails.email) {
            await newUser.update({
              email: userDetails.email,
              username: userDetails.username
            });
          }
          
          user = newUser;
        }
        // If not found in Auth0, user doesn't exist - return 404 (don't create from thin air)
      } catch (auth0Error) {
        // If Auth0 Management API is not configured, log and continue
        // This allows the endpoint to work even without Management API (but won't find users who haven't logged in yet)
        console.warn('Auth0 Management API lookup failed (this is optional):', auth0Error.message);
        // Continue to return 404 below (user not found)
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user by user_id (auto-creates if doesn't exist and user is authenticated)
// SECURITY: We only create users if:
// 1. They have a valid Auth0 token (verified by verifyAuth0Token middleware)
// 2. The token's user_id matches the requested user_id
// This ensures the user MUST exist in Auth0 before we create them in our database
router.get('/:user_id', async (req, res) => {
  try {
    let user = await User.findOne({
      where: { user_id: req.params.user_id },
      include: [{ model: Group }]
    });
    
    // Only auto-create if:
    // 1. User doesn't exist in our database
    // 2. Request has authenticated user info (valid Auth0 token)
    // 3. The authenticated user_id matches the requested user_id
    // SECURITY: The verifyAuth0Token middleware ensures they exist in Auth0 (token is signed by Auth0)
    // A valid Auth0 token can ONLY be issued by Auth0, which means the user MUST exist in Auth0
    // Therefore, we can safely create them in our database
    if (!user && req.user && req.user.user_id === req.params.user_id) {
      // Start with username from token (for email/password users, this is what they entered during signup)
      let userName = req.user.username || req.user.name || req.user.nickname || req.user.given_name || req.user.email?.split('@')[0] || 'User';
      let userEmail = req.user.email;
      
      // ALWAYS try to fetch from Auth0 Management API if we have credentials
      // This ensures we get the username they entered during signup (for email/password users)
      // Even if email is in token, username might not be, so we need Management API
      try {
        const auth0User = await auth0Service.getUserById(req.params.user_id);
        if (auth0User) {
          // User exists in Auth0 (verified), safe to use their details
          const userDetails = auth0Service.extractUserDetails(auth0User);
          
          // Always use email from Management API if available and valid
          if (userDetails.email && !userDetails.email.includes('@auth0.local') && !userDetails.email.includes('@auth0')) {
            userEmail = userDetails.email;
          }
          
          // Always use username from Management API if available and not generic
          // This is critical for email/password users who entered a username during signup
          if (userDetails.username && userDetails.username.trim().length > 0 && userDetails.username !== 'User') {
            userName = userDetails.username.trim();
          }
        }
      } catch (auth0Error) {
        // If Management API is not configured or fails, log and continue with token data
        // This allows the system to work without Management API (with reduced functionality)
        console.warn('Auth0 Management API lookup failed during user creation (this is optional):', auth0Error.message);
        if (process.env.NODE_ENV === 'development') {
          console.log('Falling back to token data. Make sure AUTH0_MANAGEMENT_CLIENT_ID and AUTH0_MANAGEMENT_CLIENT_SECRET are set for full functionality.');
        }
      }
      
      // Improve username extraction for email/password users
      if (!userEmail || userEmail.includes('@auth0.local') || userEmail.includes('@auth0')) {
        // Fallback: construct email from user_id if still missing
        userEmail = `${req.params.user_id.replace(/[|:]/g, '-')}@auth0.local`;
      }
      
      // If username is still generic, try to extract from email
      if (userName === 'User' && userEmail && !userEmail.includes('@auth0.local') && !userEmail.includes('@auth0')) {
        userName = userEmail.split('@')[0];
      }
      
      // Combine given_name and family_name if available
      if (req.user.given_name || req.user.family_name) {
        const fullName = [req.user.given_name, req.user.family_name].filter(Boolean).join(' ').trim();
        if (fullName) {
          userName = fullName;
        }
      }
      
      try {
        const [newUser, created] = await User.findOrCreate({
          where: { user_id: req.params.user_id },
          defaults: {
            user_id: req.params.user_id,
            email: userEmail,
            username: userName,
          }
        });
        
        // If user already existed but has wrong email/username, update them
        if (!created) {
          const needsUpdate = 
            (newUser.email !== userEmail && !newUser.email.includes('@auth0.local') && !newUser.email.includes('@auth0')) ||
            (newUser.username === 'User' && userName !== 'User');
          
          if (needsUpdate) {
            await newUser.update({
              email: userEmail,
              username: userName
            });
            console.log(`Updated user ${newUser.user_id} with email: ${userEmail}, username: ${userName}`);
          }
        } else {
          console.log(`Auto-created user: ${newUser.user_id} (${newUser.username}) with email: ${newUser.email}`);
        }
        
        user = newUser;
      } catch (error) {
        // If creation fails (e.g., email already exists), try to find the user
        console.error('Error auto-creating user:', error.message);
        user = await User.findOne({ where: { user_id: req.params.user_id } });
        if (!user) {
          throw error; // Re-throw if we still can't find/create the user
        }
      }
    }
    
    // If user exists but has incorrect email/username, try to fix it
    // This handles cases where users were created before we had proper email extraction
    if (user && req.user && req.user.user_id === req.params.user_id) {
      const hasIncorrectEmail = user.email && (user.email.includes('@auth0.local') || user.email.includes('@auth0'));
      const hasGenericUsername = user.username === 'User' || !user.username || user.username.trim().length === 0;
      
      if (hasIncorrectEmail || hasGenericUsername) {
        // ALWAYS try Auth0 Management API to get correct data
        // This is especially important for email/password users with username from signup
        try {
          const auth0User = await auth0Service.getUserById(req.params.user_id);
          if (auth0User) {
            const userDetails = auth0Service.extractUserDetails(auth0User);
            
            const updateData = {};
            
            // Update email if incorrect
            if (hasIncorrectEmail && userDetails.email && !userDetails.email.includes('@auth0.local') && !userDetails.email.includes('@auth0')) {
              updateData.email = userDetails.email;
            }
            
            // Update username if generic or missing
            if (hasGenericUsername && userDetails.username && userDetails.username.trim().length > 0 && userDetails.username !== 'User') {
              updateData.username = userDetails.username.trim();
            }
            
            if (Object.keys(updateData).length > 0) {
              await user.update(updateData);
              console.log(`Fixed user ${user.user_id} with Management API data:`, updateData);
              // Reload user to get updated data
              user = await User.findOne({
                where: { user_id: req.params.user_id },
                include: [{ model: Group }]
              });
            }
          }
        } catch (auth0Error) {
          // If Management API fails, log but don't break
          console.warn('Auth0 Management API lookup failed during user update:', auth0Error.message);
          if (process.env.NODE_ENV === 'development') {
            console.log('Make sure AUTH0_MANAGEMENT_CLIENT_ID and AUTH0_MANAGEMENT_CLIENT_SECRET are set.');
          }
        }
      }
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mark tutorial as completed (with version tracking)
router.put('/:user_id/tutorial', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' tutorial status' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Accept version from body, default to 2 (current tutorial version)
    const version = req.body.version != null ? parseInt(req.body.version, 10) : 2;
    await user.update({ tutorial_version: version });
    res.json({ tutorial_version: version });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reset tutorial for replay
router.delete('/:user_id/tutorial', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot reset other users\' tutorial status' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ tutorial_version: 0 });
    res.json({ tutorial_version: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create or update user
router.post('/', async (req, res) => {
  try {
    const { username, email, user_id } = req.body;
    
    const [user, created] = await User.findOrCreate({
      where: { user_id },
      defaults: { username, email, user_id }
    });
    
    if (!created) {
      await user.update({ username, email });
    }
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user's username
router.put('/:user_id/username', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Verify that the requested user_id matches the authenticated user
    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' usernames' });
    }
    
    const { username } = req.body;
    
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({ error: 'Username is required and must be a non-empty string' });
    }
    
    if (username.length > 50) {
      return res.status(400).json({ error: 'Username must be 50 characters or less' });
    }
    
    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    await user.update({ username: username.trim() });
    
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Refresh user info from Auth0 (updates email and username from Auth0)
router.post('/:user_id/refresh', async (req, res) => {
  try {
    // Use verified user_id from token
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Verify that the requested user_id matches the authenticated user
    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot refresh other users\' info' });
    }
    
    let user = await User.findOne({ where: { user_id: userId } });
    
    try {
      // Fetch latest info from Auth0 Management API
      const auth0User = await auth0Service.getUserById(userId);
      if (!auth0User) {
        return res.status(404).json({ error: 'User not found in Auth0' });
      }
      
      const userDetails = auth0Service.extractUserDetails(auth0User);
      
      if (!user) {
        // Create user if doesn't exist
        user = await User.create({
          user_id: userDetails.user_id,
          email: userDetails.email,
          username: userDetails.username,
        });
      } else {
        // Update existing user with correct info
        await user.update({
          email: userDetails.email,
          username: userDetails.username,
        });
      }
      
      res.json(user);
    } catch (auth0Error) {
      if (!user) {
        return res.status(404).json({ error: 'User not found and could not fetch from Auth0' });
      }
      // If Auth0 fails but user exists, return current user
      res.json(user);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update notification preferences
router.patch('/:user_id/notification-preferences', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' notification preferences' });
    }

    const { preferences } = req.body;
    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({ error: 'preferences object is required' });
    }

    // Validate shape: each key must have boolean email/sms values.
    // poll_created added in Plan 71-05 per D-POLL-CREATE-08 — symmetric with
    // PREF_KEYS in the phone-removal cascade below + DEFAULT_PREFERENCES in
    // notificationService.js. Without it the frontend matrix's "New polls"
    // toggle would 400 with "Unknown notification type: poll_created".
    const validTypes = ['event_created', 'reminder', 'event_updated', 'event_cancelled', 'poll_created'];
    for (const [type, channels] of Object.entries(preferences)) {
      if (!validTypes.includes(type)) {
        return res.status(400).json({ error: `Unknown notification type: ${type}` });
      }
      if (typeof channels !== 'object' || channels === null) {
        return res.status(400).json({ error: `Invalid channels for type: ${type}` });
      }
      if (channels.email !== undefined && typeof channels.email !== 'boolean') {
        return res.status(400).json({ error: `email must be a boolean for type: ${type}` });
      }
      if (channels.sms !== undefined && typeof channels.sms !== 'boolean') {
        return res.status(400).json({ error: `sms must be a boolean for type: ${type}` });
      }
    }

    // At least one channel must be enabled globally across all notification types
    const anyEnabled = validTypes.some(type => {
      const channels = preferences[type];
      if (!channels) return true; // missing type defaults to email=true
      return channels.email || channels.sms;
    });
    if (!anyEnabled) {
      return res.status(400).json({ error: 'At least one notification channel must be enabled' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ notification_preferences: preferences });

    // CTIA / carrier compliance: send one-time welcome SMS the first time a user
    // opts in to any SMS notification. Idempotent via sms_welcome_sent_at timestamp.
    // Failure is non-fatal -- preference save still succeeds.
    const anySmsEnabled = Object.values(preferences).some(
      (channels) => channels && channels.sms === true
    );
    const shouldSendWelcome = (
      anySmsEnabled &&
      !user.sms_welcome_sent_at &&
      user.sms_enabled &&
      user.phone &&
      user.phone_verified
    );
    if (shouldSendWelcome) {
      try {
        const result = await smsService.send({
          to: user.phone,
          type: 'sms_welcome',
          data: {},
        });
        if (result.success) {
          await user.update({ sms_welcome_sent_at: new Date() });
        } else {
          console.warn(`[users] Welcome SMS not sent for ${userId}: ${result.error}`);
        }
      } catch (error) {
        console.error(`[users] Welcome SMS error for ${userId}:`, error.message);
      }
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user's timezone
router.patch('/:user_id/timezone', writeOperationLimiter, async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' timezone' });
    }

    const { timezone } = req.body;

    if (!timezone || typeof timezone !== 'string' || timezone.trim().length === 0) {
      return res.status(400).json({ error: 'timezone is required and must be a non-empty string' });
    }

    // Validate IANA timezone string
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return res.status(400).json({ error: 'Invalid IANA timezone string' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await user.update({ timezone });
    res.json({ timezone: user.timezone });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save phone number and initiate Twilio Verify verification
router.post('/:user_id/phone', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' phone numbers' });
    }

    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Validate using libphonenumber-js
    const { validatePhone } = require('../utils/phoneValidation');
    const result = validatePhone(phone);
    if (!result.valid) {
      return res.status(400).json({ error: result.error });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Save phone and reset verification status
    await user.update({ phone: result.e164, phone_verified: false });

    // Initiate Twilio Verify
    const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!verifySid) {
      return res.status(500).json({ error: 'Phone verification service is not configured. TWILIO_VERIFY_SERVICE_SID is missing.' });
    }

    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.verify.v2.services(verifySid).verifications.create({
      to: result.e164,
      channel: 'sms',
    });

    res.json({ status: 'verification_sent' });
  } catch (error) {
    console.error('[users] Phone verification initiation failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Verify phone with SMS code from Twilio Verify
router.post('/:user_id/phone/verify', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot verify other users\' phone numbers' });
    }

    const { code } = req.body;
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be a string of exactly 6 digits' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.phone) {
      return res.status(400).json({ error: 'No phone number on file to verify' });
    }

    const verifySid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!verifySid) {
      return res.status(500).json({ error: 'Phone verification service is not configured. TWILIO_VERIFY_SERVICE_SID is missing.' });
    }

    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const check = await client.verify.v2.services(verifySid).verificationChecks.create({
      to: user.phone,
      code,
    });

    if (check.status === 'approved') {
      await user.update({ phone_verified: true });
      return res.json({ verified: true });
    }

    res.json({ verified: false, error: 'Invalid or expired code' });
  } catch (error) {
    console.error('[users] Phone verification check failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Remove phone number (D-PHONE-02 cascade): clear phone, phone_verified,
// sms_enabled, and all 4 notification_preferences[type].sms toggles in ONE
// atomic Sequelize transaction. If any field write fails, the user record is
// rolled back to its prior state — never half-cleared. Returns the updated
// user so the frontend can refresh local state without a second fetch.
router.delete('/:user_id/phone', async (req, res) => {
  try {
    const userId = req.user?.user_id;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (req.params.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden: Cannot update other users\' phone numbers' });
    }

    const user = await User.findOne({ where: { user_id: userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build cleared notification_preferences. Mirrors DEFAULT_PREFERENCES
    // shape from periodictabletop/src/app/userProfile/page.js (lines 29-34):
    // 5 keys (event_created, reminder, event_updated, event_cancelled, poll_created),
    // each with email + sms (and reminder.window_hours). Preserve existing email
    // values + reminder.window_hours; only flip every sms key to false.
    // poll_created added in Phase 71-04 per D-POLL-CREATE-08 — extends the Plan 70-01
    // defensive prefs cascade so phone removal also clears poll_created.sms.
    const existingPrefs = user.notification_preferences || {};
    const PREF_KEYS = ['event_created', 'reminder', 'event_updated', 'event_cancelled', 'poll_created'];
    const clearedPrefs = {};
    for (const key of PREF_KEYS) {
      const existing = existingPrefs[key] || {};
      const cleared = {
        email: existing.email !== undefined ? existing.email : true,
        sms: false,
      };
      if (key === 'reminder') {
        cleared.window_hours = existing.window_hours !== undefined ? existing.window_hours : 1;
      }
      clearedPrefs[key] = cleared;
    }

    // Atomic cascade. Wrap a single user.update() in sequelize.transaction so
    // future expansion (e.g. clearing sms_welcome_sent_at) stays atomic by
    // construction. Rollback on any failure prevents half-cleared state.
    await sequelize.transaction(async (t) => {
      await user.update(
        {
          phone: null,
          phone_verified: false,
          sms_enabled: false,
          notification_preferences: clearedPrefs,
        },
        { transaction: t }
      );
    });

    // Re-read to return the post-cascade state to the client.
    await user.reload();
    res.json(user);
  } catch (error) {
    console.error('[users] Phone removal cascade failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;