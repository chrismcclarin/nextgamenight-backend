// middleware/auth0.js
// Auth0 JWT verification middleware
const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { sendError } = require('../utils/errors');

// Check for required environment variables
if (!process.env.AUTH0_DOMAIN) {
  console.warn('⚠️  WARNING: AUTH0_DOMAIN not set. JWT verification will fail.');
}

// Initialize JWKS client
const client = jwksClient({
  jwksUri: `https://${process.env.AUTH0_DOMAIN || 'your-tenant.us.auth0.com'}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 86400000, // 24 hours
  rateLimit: true,
  jwksRequestsPerMinute: 5
});

// Function to get signing key
function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      return callback(err);
    }
    const signingKey = key.publicKey || key.rsaPublicKey;
    callback(null, signingKey);
  });
}

/**
 * Auth0 JWT verification middleware
 * Verifies the JWT token from Authorization header and extracts user info
 */
const verifyAuth0Token = (req, res, next) => {
  // Get token from Authorization header
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // Status STAYS 401 (Pitfall 2). One generic 'unauthorized' message across all
    // three reject paths — no header/format/token enumeration (ASVS V2, T-85-08).
    return sendError(res, 'unauthorized');
  }

  // Extract token (format: "Bearer <token>")
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return sendError(res, 'unauthorized');
  }

  const token = parts[1];

  // Verify token
  // Use AUTH0_AUDIENCE if available (recommended), otherwise fall back to AUTH0_CLIENT_ID
  const audience = process.env.AUTH0_AUDIENCE || process.env.AUTH0_CLIENT_ID;
  if (!audience) {
    return res.status(500).json({ error: 'AUTH0_AUDIENCE or AUTH0_CLIENT_ID must be set' });
  }
  
  jwt.verify(
    token,
    getKey,
    {
      audience: audience,
      issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      algorithms: ['RS256']
    },
    (err, decoded) => {
      if (err) {
        // Don't log specific error details in production (could leak info)
        if (process.env.NODE_ENV === 'development') {
          console.error('JWT verification error:', err.message);
        } else {
          console.error('JWT verification failed');
        }
        // Call-site emit (Pitfall 1: never a bare async/callback throw). Status
        // STAYS 401; generic 'unauthorized' prose — no token-state enumeration.
        return sendError(res, 'unauthorized');
      }

      // Attach user info to request object
      // Extract all available user information from the token
      // For email/password users: username field contains what they entered during signup
      // For Google OAuth users: name field contains their Google name
      req.user = {
        user_id: decoded.sub, // Auth0 user ID (sub claim) - this proves they exist in Auth0
        email: decoded.email || decoded['https://your-api-identifier/email'], // Standard email or custom claim
        email_verified: decoded.email_verified || false,
        username: decoded.username, // For email/password users, this is what they entered during signup
        name: decoded.name || decoded.nickname || decoded.given_name || decoded.family_name,
        nickname: decoded.nickname,
        picture: decoded.picture,
        given_name: decoded.given_name,
        family_name: decoded.family_name,
        // Include any other claims you need
      };

      // Log available token claims in development for debugging
      if (process.env.NODE_ENV === 'development' && !req.user.email) {
        console.log('Available token claims:', Object.keys(decoded));
        console.log('Email not found in token. Available fields:', {
          email: decoded.email,
          email_verified: decoded.email_verified,
          name: decoded.name,
          nickname: decoded.nickname,
          given_name: decoded.given_name,
          family_name: decoded.family_name,
        });
      }

      next();
    }
  );
};

/**
 * Optional middleware - verifies token but doesn't require it
 * Useful for endpoints that work with or without authentication
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    // No auth header, continue without user
    req.user = null;
    return next();
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    // Invalid format, continue without user
    req.user = null;
    return next();
  }

  const token = parts[1];

    // Use AUTH0_AUDIENCE if available (recommended), otherwise fall back to AUTH0_CLIENT_ID
    const audience = process.env.AUTH0_AUDIENCE || process.env.AUTH0_CLIENT_ID;
    
    jwt.verify(
    token,
    getKey,
    {
      audience: audience,
      issuer: `https://${process.env.AUTH0_DOMAIN}/`,
      algorithms: ['RS256']
    },
    (err, decoded) => {
      if (err) {
        // Invalid token, continue without user
        req.user = null;
        return next();
      }

      req.user = {
        user_id: decoded.sub,
        email: decoded.email || decoded['https://your-api-identifier/email'],
        email_verified: decoded.email_verified || false,
        name: decoded.name || decoded.nickname || decoded.given_name || decoded.family_name,
        nickname: decoded.nickname,
        picture: decoded.picture,
        given_name: decoded.given_name,
        family_name: decoded.family_name,
      };

      next();
    }
  );
};

module.exports = {
  verifyAuth0Token,
  optionalAuth
};

