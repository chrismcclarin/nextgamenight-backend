// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { sequelize } = require('./models');
const { buildAllowedOrigins } = require('./config/allowedOrigins');

// Global error handlers to prevent crashes from unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process - log the error and continue
  // In production, you might want to send this to an error tracking service
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // For uncaught exceptions, we should exit gracefully
  // But log it first so we can see what happened
  process.exit(1);
});

// Initialize Sentry error tracking (if DSN is provided)
let Sentry = null;
if (process.env.SENTRY_DSN) {
  try {
    Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0, // 10% in prod, 100% in dev
    });
    console.log('Sentry error tracking initialized.');
  } catch (error) {
    console.warn('Sentry initialization failed:', error.message);
  }
}

// Import middleware
const { verifyAuth0Token, optionalAuth } = require('./middleware/auth0');
const { apiLimiter, authLimiter, feedbackLimiter, writeOperationLimiter } = require('./middleware/rateLimiter');
const requestLogger = require('./middleware/requestLogger');

// Import routes
const userRoutes = require('./routes/users');
const groupRoutes = require('./routes/groups');
const eventRoutes = require('./routes/events');
const gameRoutes = require('./routes/games');
const listRoutes = require('./routes/lists');
const gameReviewRoutes = require('./routes/gameReviews');
const userGameRoutes = require('./routes/userGames');
const feedbackRoutes = require('./routes/feedback');
const googleAuthRoutes = require('./routes/googleAuth');
const availabilityRoutes = require('./routes/availability');
const webhooksRoutes = require('./routes/webhooks');
const magicAuthRoutes = require('./routes/magicAuth');
const groupPromptSettingsRoutes = require('./routes/groupPromptSettings');
const availabilityResponseRoutes = require('./routes/availabilityResponse');
const availabilityPrefillRoutes = require('./routes/availabilityPrefill');
const availabilitySuggestionRoutes = require('./routes/availabilitySuggestion');
const availabilityPromptRoutes = require('./routes/availabilityPrompt');
const adminMetricsRoutes = require('./routes/adminMetrics');
const tokenRoutes = require('./routes/tokens');
const inviteRoutes = require('./routes/invites');
const friendshipRoutes = require('./routes/friendships');
const rsvpRoutes = require('./routes/rsvp');
const eventBringRoutes = require('./routes/eventBrings');
const ballotRoutes = require('./routes/ballot');
const suggestionRoutes = require('./routes/suggestions');

// Scheduler for deadline-based auto-scheduling
const { deadlineJob } = require('./schedulers/deadlineScheduler');
// Scheduler for auto-promoting pending members after 24h
const { autoPromotionJob } = require('./schedulers/autoPromotionScheduler');
// Scheduler for SMS reminders before upcoming events
const { reminderJob } = require('./schedulers/reminderScheduler');

const app = express();
const PORT = process.env.PORT || 4000;

// Trust proxy - required for Railway and other platforms that use reverse proxies
// Set to 1 to trust only the first proxy (Railway's reverse proxy)
// This is more secure than 'true' which trusts all proxies
app.set('trust proxy', 1);

// HTTPS Enforcement (for production)
// Note: Heroku handles HTTPS at the load balancer, but this adds extra protection
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    // Check if request is secure (Heroku sets x-forwarded-proto)
    const isSecure = req.secure || 
                     req.headers['x-forwarded-proto'] === 'https' ||
                     req.headers['x-forwarded-ssl'] === 'on';
    
    if (!isSecure && req.method === 'GET') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Sentry request handler (must be before other middleware)
if (Sentry) {
  app.use(Sentry.Handlers.requestHandler());
}

// Security Middleware
// 1. Helmet - Set security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding if needed
}));

// 2. CORS configuration - allow frontend domains
// Support both localhost (development) and production domains.
// The allow-list is built in config/allowedOrigins.js so the OAuth redirect
// allow-list (routes/googleAuth.js, D-04) reuses the SAME source — no drift.
const allowedOrigins = buildAllowedOrigins();

// Log allowed origins on startup (helpful for debugging)
console.log('CORS allowed origins:', allowedOrigins.length > 0 ? allowedOrigins.join(', ') : 'None configured');
if (allowedOrigins.length === 0 && process.env.NODE_ENV === 'production') {
  console.warn('WARNING: No CORS origins configured! Set FRONTEND_URL or ALLOWED_ORIGINS environment variable.');
}

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin in development
    if (!origin && process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (origin && allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    
    // In production, allow requests with no origin ONLY for server-to-server requests
    // These come from Next.js API routes which authenticate via Authorization header
    // NOTE: We validate Authorization header in separate middleware after CORS
    // CORS is primarily a browser security feature; server-to-server requests rely on auth
    if (!origin && process.env.NODE_ENV === 'production') {
      // Allow through CORS - auth middleware will enforce authentication on protected routes
      return callback(null, true);
    }
    
    // Block unallowed origins in production
    if (process.env.NODE_ENV === 'production') {
      console.warn(`CORS: Blocked request from origin: ${origin || 'undefined'}`);
      console.warn(`Allowed origins: ${allowedOrigins.join(', ')}`);
      callback(new Error('Not allowed by CORS'));
    } else {
      // In development, allow any origin
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
}));

// Security validation: Require Authorization header for no-origin requests to protected routes
// This ensures server-to-server requests are authenticated
app.use((req, res, next) => {
  const hasOrigin = req.headers.origin;
  const hasAuth = !!req.headers.authorization;
  
  // Define protected routes (routes that require authentication)
  const protectedRoutes = [
    '/api/auth/google/url', // Google auth URL generation (requires auth)
    '/api/auth/google/disconnect', // Google disconnect (requires auth)
    '/api/auth/google/refresh', // Token refresh (requires auth)
    '/api/users',
    '/api/groups',
    '/api/events',
    '/api/availability',
    '/api/lists',
    '/api/game-reviews',
    '/api/user-games',
    '/api/invites',
    '/api/friendships',
  ];
  
  // Exclude public routes that don't require auth
  const publicRoutes = [
    '/api/auth/google/callback', // Google OAuth callback (public - Google redirects to it)
    '/api/games', // Game search is public
    '/api/feedback', // Feedback is public (or optional auth)
    '/health', // Health check is public
    '/api/groups/invite-preview', // QR code group invite preview (public)
    '/api/events/invite-preview', // QR code game invite preview (public)
  ];
  
  const isProtectedRoute = protectedRoutes.some(route => req.path.startsWith(route));
  const isPublicRoute = publicRoutes.some(route => req.path === route || req.path.startsWith(route));
  
  // In production, block no-origin requests to protected routes without Authorization header
  // This prevents unauthorized server-to-server requests
  // Public routes (like Google callback) are exempt from this check
  if (!hasOrigin && process.env.NODE_ENV === 'production' && isProtectedRoute && !isPublicRoute && !hasAuth) {
    console.warn(`SECURITY: Blocked no-origin request without Authorization to protected route: ${req.method} ${req.path} from IP: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: Server-to-server requests require authentication' });
  }
  
  // Log no-origin requests with auth for monitoring (these are legitimate server-to-server)
  if (!hasOrigin && hasAuth && process.env.NODE_ENV === 'production') {
    console.log(`Server-to-server authenticated request: ${req.method} ${req.path}`);
  }
  
  next();
});

// 3. Request body parsing with size limit
app.use(express.json({ limit: '10mb', verify: (req, _res, buf) => { req.rawBody = buf; } })); // Limit request body size

// URL-encoded body parsing scoped to Twilio webhook routes only
// Twilio sends inbound SMS data as application/x-www-form-urlencoded
app.use('/api/webhooks/twilio', express.urlencoded({ extended: false }));

// 4. Request logging for security auditing
app.use(requestLogger);

// 5. Rate limiting - Apply general API rate limiter to all routes
app.use('/api/', apiLimiter);

// Routes
// Public routes (no auth required)
app.use('/api/games', gameRoutes); // Game search is public
app.use('/api/feedback', feedbackLimiter, optionalAuth, feedbackRoutes); // Feedback with strict rate limiting
app.use('/api/webhooks', webhooksRoutes); // External service webhooks (Resend, etc.)
app.use('/api/magic-auth', magicAuthRoutes); // Magic link validation (no Auth0 required)
app.use('/api/availability-responses', availabilityResponseRoutes); // Availability form submission (magic token auth)
app.use('/api/availability-prefill', availabilityPrefillRoutes); // Check-in pre-fill (GCal / saved availability — magic token auth)
// Public invite info endpoint handled by conditional auth below
app.use('/api/rsvp', writeOperationLimiter, rsvpRoutes); // RSVP: GET /respond is public; POST/GET/DELETE have per-route auth
app.use('/api/event-brings', writeOperationLimiter, eventBringRoutes); // Event brings: per-route auth inside

// Protected routes (require Auth0 token)
// Apply write operation rate limiting only to POST/PUT/DELETE requests
// GET requests will use the general apiLimiter
app.use('/api/users', verifyAuth0Token, userRoutes);
// Groups: public QR invite preview, auth for everything else
const conditionalGroupAuth = (req, res, next) => {
  if (req.method === 'GET' && req.path.match(/^\/invite-preview\//)) return next();
  return verifyAuth0Token(req, res, next);
};
app.use('/api/groups', writeOperationLimiter, conditionalGroupAuth, groupRoutes);
app.use('/api/groups', writeOperationLimiter, verifyAuth0Token, groupPromptSettingsRoutes);
// Events: public QR invite preview, auth for everything else
const conditionalEventAuth = (req, res, next) => {
  if (req.method === 'GET' && req.path.match(/^\/invite-preview\//)) return next();
  return verifyAuth0Token(req, res, next);
};
app.use('/api/events', writeOperationLimiter, conditionalEventAuth, eventRoutes);
app.use('/api/lists', verifyAuth0Token, listRoutes);
app.use('/api/game-reviews', writeOperationLimiter, verifyAuth0Token, gameReviewRoutes);
app.use('/api/user-games', writeOperationLimiter, verifyAuth0Token, userGameRoutes);
// Google Auth routes - callback is public (Google redirects to it), others require auth
// Conditional middleware: skip auth for callback route
const conditionalAuth = (req, res, next) => {
  // Skip auth for callback route (Google redirects to it without auth header)
  // req.path will be '/google/callback' when router is mounted at '/api/auth'
  if (req.path === '/google/callback' || req.originalUrl.includes('/google/callback')) {
    return next();
  }
  // Apply auth for all other routes
  return verifyAuth0Token(req, res, next);
};
app.use('/api/auth', authLimiter, conditionalAuth, googleAuthRoutes);
app.use('/api/availability', writeOperationLimiter, verifyAuth0Token, availabilityRoutes);
// Availability suggestion routes (protected by Auth0 in the route handlers)
app.use('/api', writeOperationLimiter, availabilitySuggestionRoutes);
// Availability prompt routes (respondent list, reminders)
app.use('/api', writeOperationLimiter, availabilityPromptRoutes);
// Admin metrics dashboard (protected by Auth0 token)
app.use('/api', adminMetricsRoutes);
// Token analytics (requires Auth0 token)
app.use('/api/tokens', verifyAuth0Token, tokenRoutes);
// Group invites: GET /info/:token is public, all other endpoints require auth
const conditionalInviteAuth = (req, res, next) => {
  if (req.method === 'GET' && req.path.match(/^\/info\//)) return next();
  return verifyAuth0Token(req, res, next);
};
app.use('/api/invites', writeOperationLimiter, conditionalInviteAuth, inviteRoutes);
// Friendships (social graph: friend requests, accept, decline, remove)
app.use('/api/friendships', writeOperationLimiter, verifyAuth0Token, friendshipRoutes);
// Ballot routes (game voting: ballot CRUD, vote toggle, auto-close)
app.use('/api/ballot', writeOperationLimiter, verifyAuth0Token, ballotRoutes);
// Suggestion routes (smart game suggestions based on group collections)
app.use('/api/suggestions', verifyAuth0Token, suggestionRoutes);
// RSVP routes moved to public section above (per-route auth inside rsvp.js)

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Sentry error handler (must be after all routes, before error handler)
if (Sentry) {
  app.use(Sentry.Handlers.errorHandler());
}

// Global error handler (catch-all for unhandled errors)
app.use((err, req, res, next) => {
  // Log error to Sentry if available
  if (Sentry) {
    Sentry.captureException(err);
  }
  
  // Don't expose error details in production
  const message = process.env.NODE_ENV === 'production' 
    ? 'An internal error occurred' 
    : err.message;
  
  res.status(err.status || 500).json({ error: message });
});

// Initialize database and start server
const startServer = async () => {
  try {
    console.log('Attempting to connect to database...');
    console.log('DATABASE_URL present:', !!process.env.DATABASE_URL);
    console.log('POSTGRES_URL present:', !!process.env.POSTGRES_URL);
    console.log('NODE_ENV:', process.env.NODE_ENV);
    
    // Add retry logic for database connection with different SSL configurations
    let retries = 5;
    let connected = false;
    let lastError = null;
    
    while (retries > 0 && !connected) {
      try {
        await sequelize.authenticate();
        connected = true;
        console.log('Database connection established successfully.');
      } catch (error) {
        lastError = error;
        retries--;
        
        // Log detailed error information
        console.error(`Database connection attempt failed (${6 - retries}/5):`);
        console.error(`  Error code: ${error.code || 'N/A'}`);
        console.error(`  Error message: ${error.message}`);
        if (error.parent) {
          console.error(`  Parent error: ${error.parent.message || error.parent.code || 'N/A'}`);
        }
        
        if (retries > 0) {
          const waitTime = 3000; // Wait 3 seconds before retry
          console.log(`Retrying in ${waitTime/1000} seconds... (${retries} attempts remaining)`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    if (!connected) {
      console.error('All database connection attempts failed.');
      console.error('Last error details:', {
        code: lastError?.code,
        message: lastError?.message,
        parent: lastError?.parent?.message,
      });
      throw lastError;
    }
    
    // Database sync strategy:
    // - Development: Use sync to auto-create tables (convenient for dev)
    // - Production: Use migrations only (sync disabled for safety)
    // - Test: Use sync for test database
    if (process.env.NODE_ENV === 'production') {
      // In production, DO NOT use sync - use migrations instead
      // Tables should already exist from migrations
      console.log('Production mode: Skipping database sync. Ensure migrations are run.');
    } else if (process.env.NODE_ENV === 'test') {
      // In test, use sync to reset database
      await sequelize.sync({ force: false });
      console.log('Test database synchronized.');
    } else {
      // Development: Use sync for convenience (but without alter to avoid data loss)
      await sequelize.sync({ alter: false });
      console.log('Development database synchronized (tables created if needed).');
    }
    
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

      // Start deadline scheduler (only in production or if explicitly enabled)
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_SCHEDULER === 'true') {
        try {
          deadlineJob.start();
          console.log('Deadline scheduler started (node-cron)');
        } catch (err) {
          console.error('Deadline scheduler failed to start:', err.message, err.stack);
        }
      } else {
        console.log('Deadline scheduler disabled (set ENABLE_SCHEDULER=true to enable)');
      }

      // Start backup scheduler (weekly database backups, same guard as deadline scheduler)
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_SCHEDULER === 'true') {
        try {
          const { backupJob } = require('./schedulers/backupScheduler');
          backupJob.start();
          console.log('Backup scheduler started (weekly, Sundays 2am UTC)');
        } catch (err) {
          console.error('Backup scheduler failed to start:', err.message);
        }
      }

      // Start auto-promotion scheduler (promotes pending members after 24h)
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_SCHEDULER === 'true') {
        try {
          autoPromotionJob.start();
          console.log('Auto-promotion scheduler started (every 15 min)');
        } catch (err) {
          console.error('Auto-promotion scheduler failed to start:', err.message);
        }
      }

      // Start reminder scheduler (SMS reminders for upcoming events)
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_SCHEDULER === 'true') {
        try {
          reminderJob.start();
          console.log('Reminder scheduler started (every 5 min, SMS reminders)');
        } catch (err) {
          console.error('Reminder scheduler failed to start:', err.message);
        }
      }

      // Start BullMQ workers (only in production or if explicitly enabled)
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_WORKERS === 'true') {
        try {
          const { promptWorker, deadlineWorker, reminderWorker } = require('./workers');
          // Use the telemetry wrapper so the prompt-schedule sync at boot lands
          // in SchedulerRun and is visible to the anomaly sweep.
          const { syncPromptSchedulesWithTelemetry } = require('./schedulers/promptScheduler');
          syncPromptSchedulesWithTelemetry().catch(err => console.error('Failed to sync prompt schedules:', err.message));
        } catch (err) {
          console.error('BullMQ workers failed to start:', err.message, err.stack);
        }
      } else {
        console.log('BullMQ workers disabled (set ENABLE_WORKERS=true to enable)');
      }

      // Scheduler anomaly sweep (every 30 min, production + ENABLE_SCHEDULER only).
      // Sentry-pages when historically-non-zero jobs go silent. See
      // services/schedulerHealthService.js for the full criteria.
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_SCHEDULER === 'true') {
        try {
          const cron = require('node-cron');
          const { runAnomalySweep } = require('./services/schedulerHealthService');
          cron.schedule('*/30 * * * *', async () => {
            try {
              await runAnomalySweep();
            } catch (err) {
              console.error('Anomaly sweep error:', err.message);
            }
          }, { timezone: 'UTC' });
          console.log('Scheduler anomaly sweep started (every 30 min)');
        } catch (err) {
          console.error('Anomaly sweep failed to start:', err.message);
        }
      }

      // Mount Bull Board dashboard (only if workers are enabled)
      if (process.env.NODE_ENV === 'production' || process.env.ENABLE_WORKERS === 'true') {
        try {
          const mountBullBoard = require('./routes/bullBoard');
          mountBullBoard(app);
        } catch (err) {
          console.warn('Bull Board mount failed (Redis may not be available):', err.message);
        }
      }
    });
  } catch (error) {
    console.error('Unable to start server:', error);
    process.exit(1);
  }
};

startServer();