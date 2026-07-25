# Auth0 JWT Verification Middleware Setup

## Overview
The backend now uses Auth0 JWT verification middleware to secure all API endpoints. User IDs are extracted from verified JWT tokens instead of trusting client input.

## Environment Variables Required

Add these to your backend `.env` file:

```env
# Auth0 Configuration - REQUIRED
AUTH0_DOMAIN=your-tenant.us.auth0.com

# Choose ONE of the following:
# Option 1 (RECOMMENDED): If you created an Auth0 API
AUTH0_AUDIENCE=your-api-identifier

# Option 2: If you don't have a separate API, use your application's Client ID
# AUTH0_CLIENT_ID=your-client-id
```

**Important:**
- `AUTH0_DOMAIN` is **REQUIRED** - Always include this
- Use `AUTH0_AUDIENCE` if you created an Auth0 API (recommended for production)
- Use `AUTH0_CLIENT_ID` only if you don't have a separate API (less secure, not recommended)
- **Do NOT set both** - The middleware will use `AUTH0_AUDIENCE` if available, otherwise `AUTH0_CLIENT_ID`

## Setting Up Auth0 API

1. **Go to Auth0 Dashboard**: https://manage.auth0.com
2. **Navigate to Applications → APIs**
3. **Create a new API** (if you don't have one):
   - Click "Create API"
   - **Name**: Your API name (e.g., "Periodic Tabletop API")
   - **Identifier**: This is your `AUTH0_AUDIENCE` (e.g., `https://api.periodictabletop.com`)
   - **Signing Algorithm**: RS256 (default)
   - Click "Create"

4. **Get your Auth0 Domain**:
   - Go to **Applications → Settings**
   - Your domain is shown at the top (e.g., `your-tenant.us.auth0.com`)
   - This is your `AUTH0_DOMAIN`

5. **Update your Next.js Application**:
   - Go to **Applications → Applications**
   - Select your Next.js application
   - Go to **Settings**
   - Scroll to **Application URIs**
   - Add your API identifier to **Allowed Callback URLs** if needed
   - Scroll to **Advanced Settings → Grant Types**
   - Ensure **Authorization Code** and **Refresh Token** are enabled

## Frontend Configuration

The frontend has been updated to automatically send Auth0 access tokens in the `Authorization` header for all API calls.

The `apiFetch` function now:
1. Automatically retrieves the access token from `/api/auth/token`
2. Adds it to the `Authorization: Bearer <token>` header
3. Sends it with all API requests

## Backend Middleware

The middleware (`middleware/auth0.js`):
1. Extracts the token from the `Authorization` header
2. Verifies it using Auth0's JWKS (JSON Web Key Set)
3. Extracts user information (user_id, email, name) from the token
4. Attaches it to `req.user` for use in routes

## Route Updates

All protected routes now:
- Use `req.user.user_id` instead of `req.params.user_id` or `req.body.user_id`
- Verify that the authenticated user matches the requested resource
- Return 401 (Unauthorized) if no token is provided
- Return 403 (Forbidden) if user tries to access another user's data

## Testing

1. **Start both servers**:
   ```bash
   # Backend
   cd periodictabletopbackend_v2/Sonnet
   npm start
   
   # Frontend
   cd periodictabletop
   npm run dev
   ```

2. **Log in** to the frontend
3. **Check browser console** - API calls should now include Authorization headers
4. **Test an endpoint** - Should work with authentication
5. **Test without auth** - Should return 401 Unauthorized

## Troubleshooting

### Error: "No authorization header provided"
**Solution**: Make sure the frontend is sending the token. Check browser DevTools → Network tab → Headers to see if `Authorization: Bearer <token>` is present.

### Error: "Invalid or expired token"
**Solution**: 
- Check that `AUTH0_DOMAIN` is correct in `.env`
- Check that `AUTH0_AUDIENCE` matches your API identifier
- Verify the token hasn't expired (tokens typically expire after 24 hours)

### Error: "JWT verification error"
**Solution**:
- Ensure your Auth0 API is configured correctly
- Check that the signing algorithm is RS256
- Verify the JWKS endpoint is accessible: `https://YOUR_DOMAIN/.well-known/jwks.json`

### Frontend: "No access token available"
**Solution**:
- Make sure you're logged in
- Check that your Auth0 application has the correct API permissions
- Verify the API is enabled in your Auth0 application settings

## Security Improvements

✅ **User IDs are now verified** - Cannot impersonate other users
✅ **All endpoints are protected** - Requires valid Auth0 token
✅ **Token verification** - Uses Auth0's JWKS for secure verification
✅ **Automatic token refresh** - Frontend handles token refresh automatically

## Next Steps

1. Add rate limiting to prevent abuse
2. Add request logging/auditing
3. Implement role-based access control (RBAC) if needed
4. Add API key authentication for service-to-service calls (if needed)

