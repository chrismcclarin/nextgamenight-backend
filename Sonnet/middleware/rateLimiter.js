// middleware/rateLimiter.js
// Rate limiting middleware to prevent abuse and DDoS attacks
const rateLimit = require('express-rate-limit');
const { formatEnvelope } = require('../utils/errors');

// Build a rate_limited envelope BODY for a limiter's `message` option. Keeps the
// stable wire code `rate_limited` (429) while letting each limiter keep its own
// human-readable prose via a messageOverride. The serializer also emits the
// legacy `error` (= message) alias the FE still reads.
const rateLimitedBody = (message) => formatEnvelope('rate_limited', undefined, message).body;

// Adjust rate limits based on environment
const isDevelopment = process.env.NODE_ENV !== 'production';

// API_LIMIT — global apiLimiter ceiling (IP-keyed, mounted PRE-auth at server.js).
//
// INTERIM raise (Phase 86 / T-86-07): the Phase-86 BFF makes ALL authenticated
// traffic originate from ONE Vercel egress IP, so this IP-keyed limiter collapses
// into a single shared bucket for the entire authenticated userbase. The old
// per-user budget of 300/15min would 429-storm the moment the BFF ships. Raise the
// production ceiling to ~ the old per-user budget (300) x a conservative ~100
// concurrent-active-user launch estimate = 30000/15min. This still bounds gross
// abuse (a single scraper cannot exceed 30k/15min) while absorbing normal shared-IP
// load. The DURABLE per-client/per-user fix (real-client-IP resolution or Auth0-sub
// identity keying via a NEW post-auth limiter) is DEFERRED to Phase 91 / BOPS-02 —
// see .planning/deferred/phase-91.md — after which this ceiling should be lowered
// back to a per-client-appropriate value. Dev is unaffected (no BFF egress sharing).
const API_LIMIT = isDevelopment ? 1000 : 30000;
// WRITE_LIMIT — strictLimiter/writeOperationLimiter ceiling (IP-keyed, mounted on
// every authenticated write route group at server.js).
//
// INTERIM raise (Phase 86 / T-86-07, same rationale as API_LIMIT above): under the
// Phase-86 BFF, ALL authenticated writes (POST/PUT/PATCH/DELETE) also originate from
// ONE Vercel egress IP, so this IP-keyed limiter collapses into a single shared
// bucket for the entire authenticated userbase. The old per-user budget of 100/15min
// would 429-storm every user's writes the moment the BFF ships. Raise the production
// ceiling to ~ the old per-user write budget (100) x a conservative ~100 concurrent-
// active-user launch estimate = 10000/15min. This still bounds gross write abuse while
// absorbing normal shared-IP write load. The DURABLE per-user keying fix (Auth0-sub
// keyGenerator on a post-auth limiter) is DEFERRED to Phase 91 / BOPS-02 — see
// .planning/deferred/phase-91.md — after which this ceiling should be lowered back to
// a per-client-appropriate value. Dev is unaffected (no BFF egress sharing).
const WRITE_LIMIT = isDevelopment ? 500 : 10000;
const AUTH_LIMIT = isDevelopment ? 50 : 5;
const FEEDBACK_LIMIT = isDevelopment ? 20 : 5;

// General API rate limiter - Higher limit in development
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: API_LIMIT, // Limit each IP to API_LIMIT requests per windowMs
  message: rateLimitedBody('Too many requests from this IP, please try again later.'),
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip rate limiting for localhost in development
  skip: (req) => isDevelopment && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'),
});

// Stricter rate limiter for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: AUTH_LIMIT, // Limit each IP to AUTH_LIMIT requests per windowMs
  message: rateLimitedBody('Too many authentication attempts, please try again later.'),
  skipSuccessfulRequests: true, // Don't count successful requests
  skip: (req) => isDevelopment && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'),
});

// Stricter rate limiter for feedback endpoint (prevent spam)
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: FEEDBACK_LIMIT, // Limit each IP to FEEDBACK_LIMIT feedback submissions per hour
  message: rateLimitedBody('Too many feedback submissions, please try again later.'),
  skip: (req) => isDevelopment && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'),
});

// Very strict rate limiter for sensitive operations (create/update/delete)
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: WRITE_LIMIT, // Limit each IP to WRITE_LIMIT write operations per 15 minutes
  message: rateLimitedBody('Too many write operations, please try again later.'),
  skip: (req) => isDevelopment && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'),
});

// Magic token validation rate limiter (per TOKEN-04)
// 5 failed attempts per 15 minutes per IP+token prefix
const MAGIC_TOKEN_LIMIT = isDevelopment ? 50 : 5;

// Helper to normalize IP addresses (IPv6 loopback variants -> consistent format)
const normalizeIp = (ip) => {
  if (!ip) return 'unknown';
  // Normalize IPv6 loopback and IPv4-mapped-IPv6 to IPv4
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1';
  // Strip IPv4-mapped IPv6 prefix if present
  if (ip.startsWith('::ffff:')) return ip.substring(7);
  return ip;
};

const magicTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,      // 15 minutes
  max: MAGIC_TOKEN_LIMIT,
  skipSuccessfulRequests: true,   // Only count failures
  message: rateLimitedBody('Too many attempts. Please try again later.'),
  standardHeaders: true,
  legacyHeaders: false,
  // Key by normalized IP + first 16 chars of token (prevents brute force across tokens)
  keyGenerator: (req) => {
    const token = req.query.token || req.body.token || '';
    const tokenPrefix = token.substring(0, 16);
    const normalizedIp = normalizeIp(req.ip);
    return `magic:${normalizedIp}:${tokenPrefix}`;
  },
  skip: (req) => isDevelopment && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'),
  // Disable keyGenerator IP validation since we handle IPv6 normalization manually
  validate: { default: true, keyGeneratorIpFallback: false },
});

// Middleware that only applies strict limiter to write operations (POST, PUT, DELETE)
// GET requests will use the general apiLimiter instead
const writeOperationLimiter = (req, res, next) => {
  // Only apply strict limiter to write operations
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return strictLimiter(req, res, next);
  }
  // For GET requests, skip this limiter (apiLimiter will handle it)
  next();
};

// SMS inbound webhook rate limiter (per phone number)
// 10 replies per phone per hour -- excess silently dropped (empty TwiML)
const smsInboundLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 10,                    // 10 replies per phone per hour
  keyGenerator: (req) => `sms-inbound:${req.body && req.body.From ? req.body.From : 'unknown'}`,
  handler: (req, res) => {
    // Silent drop -- return empty TwiML (never expose rate limit info to SMS sender)
    res.type('text/xml').send('<Response/>');
  },
  skip: (req) => isDevelopment && (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1'),
  // Disable IP-based key validation since we use phone number as key
  validate: { default: true, keyGeneratorIpFallback: false },
});

module.exports = {
  apiLimiter,
  authLimiter,
  feedbackLimiter,
  strictLimiter,
  writeOperationLimiter,
  magicTokenLimiter,
  smsInboundLimiter,
};

