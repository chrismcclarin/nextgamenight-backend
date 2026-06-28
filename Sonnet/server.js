// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { sequelize } = require('./models');
const { buildAllowedOrigins } = require('./config/allowedOrigins');
const { formatEnvelope } = require('./utils/errors');

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

// =====================================================================
// DEFAULT-DENY AUTHENTICATION LAYER (D-01 / BSEC-01)
// =====================================================================
//
// SECURITY-CRITICAL. Replaces the previous per-router opt-in `verifyAuth0Token`
// mounts AND the four removed conditional-auth closures that special-cased the
// groups/events invite-preview GETs, the Google OAuth callback, and the invite
// info GET. Those public GETs now live in the allow-list below. A single
// authn gate runs FIRST for every `/api/*` request: unless the request matches
// the EXPLICIT public allow-list below, a valid Auth0 JWT is REQUIRED. "Public"
// is now a deliberate, visible act; the default is locked.
//
// Mounted on `/api` (NOT app root): `/health` (below) and `/admin/queues`
// (Bull Board, mounted at app root via mountBullBoard, gated by
// requirePlatformAdmin from 83-03) live OUTSIDE `/api` and are intentionally
// NOT touched by this layer. `/api/admin/metrics` IS under `/api`: this layer
// proves authn, then the in-handler requirePlatformAdmin (83-03) proves authz —
// no double-`verifyAuth0Token` because this is the ONLY authn mount.
//
// The allow-list matches on EXACT method + path (mount-relative, i.e. with the
// `/api` prefix already stripped). It is NOT a `startsWith` prefix for the
// game-search routes — `GET /games/:id` is public but `GET /games/for-event/...`
// is NOT, so it stays gated (Task 1 BOLA audit). The prefix entries below are
// reserved for routers that are wholly public (webhooks, magic-auth) or
// self-authenticate via a magic token inside the handler.
//
// MUST include `GET /api/auth/google/callback` — Google redirects the OAuth
// flow back here carrying NO Auth0 bearer token; omitting it would 401 the
// callback under default-deny and break Google Calendar login (REVIEW HIGH).

// Exact (method, path-regex) public routes — path is mount-relative to `/api`.
const PUBLIC_EXACT = [
  // Game search (public) — `/games/:id` and `/games/search-all` are single
  // dynamic segments; `/games/for-event/:group_id/:user_id` (3 segments) is
  // deliberately NOT matched and stays gated.
  { method: 'GET', re: /^\/games$/ },
  { method: 'GET', re: /^\/games\/bgg\/search$/ },
  { method: 'GET', re: /^\/games\/[^/]+$/ },
  // Google OAuth callback — Google redirects here with no Auth0 token.
  { method: 'GET', re: /^\/auth\/google\/callback$/ },
  // RSVP magic-link response (HMAC-token authed inside the handler).
  { method: 'GET', re: /^\/rsvp\/respond$/ },
  // QR invite previews / invite info (token in the path; public by design).
  { method: 'GET', re: /^\/groups\/invite-preview(\/|$)/ },
  { method: 'GET', re: /^\/events\/invite-preview(\/|$)/ },
  { method: 'GET', re: /^\/invites\/info(\/|$)/ },
];

// Wholly-public prefixes (router self-authenticates via magic token, is an
// external webhook surface, or is public-with-optional-auth). Mount-relative
// to `/api`.
//
// `/feedback` is allow-listed here so anonymous `POST /api/feedback` reaches the
// router; the router runs `optionalAuth` (populating req.user-if-present) and
// gates `GET /api/feedback` with `requirePlatformAdmin` (83-03 / BE-099). The
// gate passing it through is correct — the ROUTER, not the gate, enforces the
// admin check on the read.
const PUBLIC_PREFIX = [
  '/feedback',
  '/webhooks',
  '/magic-auth',
  '/availability-responses',
  '/availability-prefill',
];

const isPublicApiRequest = (req) => {
  const p = req.path; // mount-relative (the `/api` prefix is already stripped)
  if (PUBLIC_PREFIX.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) {
    return true;
  }
  return PUBLIC_EXACT.some((entry) => req.method === entry.method && entry.re.test(p));
};

// The single global authn gate. Public allow-list short-circuits; everything
// else must carry a valid Auth0 JWT (verifyAuth0Token 401s a missing/invalid
// token before any handler or DB read runs).
app.use('/api', (req, res, next) => {
  if (isPublicApiRequest(req)) return next();
  return verifyAuth0Token(req, res, next);
});

// Routes
// ---- Public / optional-auth routers ----
app.use('/api/feedback', feedbackLimiter, optionalAuth, feedbackRoutes); // GET / gated by requirePlatformAdmin inside
app.use('/api/webhooks', webhooksRoutes); // External service webhooks
app.use('/api/magic-auth', magicAuthRoutes); // Magic link validation (no Auth0 required)
app.use('/api/availability-responses', availabilityResponseRoutes); // Magic-token authed
app.use('/api/availability-prefill', availabilityPrefillRoutes); // Magic-token authed
app.use('/api/games', gameRoutes); // Search GETs public (allow-list); writes + for-event gated by the layer / per-route
app.use('/api/rsvp', writeOperationLimiter, rsvpRoutes); // GET /respond public (allow-list); POST/GET/DELETE authed by the layer
app.use('/api/event-brings', writeOperationLimiter, eventBringRoutes);

// ---- Authed routers (the global `/api` layer already required a valid JWT) ----
// Per-router `verifyAuth0Token` args removed (would double-run authn); the
// rate limiters and route-specific limiters are preserved.
app.use('/api/users', userRoutes);
app.use('/api/groups', writeOperationLimiter, groupRoutes); // invite-preview GET allow-listed at the layer
app.use('/api/groups', writeOperationLimiter, groupPromptSettingsRoutes);
app.use('/api/events', writeOperationLimiter, eventRoutes); // invite-preview GET allow-listed at the layer
app.use('/api/lists', listRoutes);
app.use('/api/game-reviews', writeOperationLimiter, gameReviewRoutes);
app.use('/api/user-games', writeOperationLimiter, userGameRoutes);
app.use('/api/auth', authLimiter, googleAuthRoutes); // google/callback GET allow-listed at the layer
app.use('/api/availability', writeOperationLimiter, availabilityRoutes);
// Availability suggestion routes (authz in the route handlers)
app.use('/api', writeOperationLimiter, availabilitySuggestionRoutes);
// Availability prompt routes (respondent list, reminders)
app.use('/api', writeOperationLimiter, availabilityPromptRoutes);
// Admin metrics dashboard — authn by the layer, then requirePlatformAdmin (83-03) in-handler
app.use('/api', adminMetricsRoutes);
// Token analytics
app.use('/api/tokens', tokenRoutes);
app.use('/api/invites', writeOperationLimiter, inviteRoutes); // GET /info allow-listed at the layer
// Friendships (social graph: friend requests, accept, decline, remove)
app.use('/api/friendships', writeOperationLimiter, friendshipRoutes);
// Ballot routes (game voting)
app.use('/api/ballot', writeOperationLimiter, ballotRoutes);
// Suggestion routes (smart game suggestions based on group collections)
app.use('/api/suggestions', suggestionRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Global error handler (catch-all for unhandled errors).
// Formats any thrown / next(err) error via the canonical envelope (BAPI-01) and
// escalates ONLY 5xx to Sentry (DSN-gated, BAPI-02) — no double-capture, no over-capture.
// NOTE: the legacy v7-style Sentry request/error handler blocks were removed — that API is
// undefined in @sentry/node 8.55.0 and crashed boot when SENTRY_DSN was set (Pitfall 3). The
// v8 express-error-handler setup is intentionally NOT added here (it would re-introduce
// double-capture; deferred to Phase 91).
app.use((err, req, res, next) => {
  const { httpStatus, body } = formatEnvelope(err);

  // Escalate ONLY 5xx, route-PATTERN tagged (never req.originalUrl — it carries
  // path-embedded PII like emails/player_names; ASVS V7). req.route may be unpopulated
  // in the global handler, hence the 'unmatched' fallback.
  if (Sentry && httpStatus >= 500) {
    Sentry.captureException(err, {
      tags: {
        route: (req.route && ((req.baseUrl || '') + req.route.path)) || 'unmatched',
        method: req.method,
      },
    });
  }

  res.status(httpStatus).json(body);
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