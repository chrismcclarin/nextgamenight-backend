# Ensuring Email is Available in Auth0 Access Tokens

## The Issue

When users log in with Google, their email should be available in the Auth0 token. However, by default, Auth0 includes email in the **ID token** but may not include it in the **access token** (which we use for API authentication).

## Solution: Configure Auth0 API to Include Email

### Step 1: Go to Auth0 Dashboard
1. Navigate to **APIs** → Your API (the one matching `AUTH0_AUDIENCE`)
2. Click on your API

### Step 2: Enable Email in Access Token
1. Go to the **Settings** tab
2. Scroll down to **Token Settings**
3. Look for **"Include email in access token"** or similar option
4. Enable it if available

### Step 3: Add Email as a Custom Claim (Alternative Method)

If the above option isn't available, you can add email as a custom claim:

1. In your Auth0 API settings, go to **Rules** or **Actions** (depending on your Auth0 plan)
2. Create a new Rule/Action that adds email to the access token:

**For Rules (Legacy):**
```javascript
function addEmailToAccessToken(user, context, callback) {
  const namespace = 'https://your-api-identifier/';
  context.accessToken[namespace + 'email'] = user.email;
  context.accessToken[namespace + 'email_verified'] = user.email_verified;
  callback(null, user, context);
}
```

**For Actions (Recommended):**
1. Go to **Actions** → **Flows** → **Login**
2. Create a new Action
3. Add code to include email in the access token:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  const namespace = 'https://your-api-identifier/';
  if (event.user.email) {
    api.accessToken.setCustomClaim(namespace + 'email', event.user.email);
    api.accessToken.setCustomClaim(namespace + 'email_verified', event.user.email_verified);
  }
};
```

4. Deploy the Action
5. Add it to the Login flow

### Step 4: Verify Email is in Token

After configuration, the email should be available in the access token. The backend middleware will extract it from:
- `decoded.email` (standard claim)
- `decoded['https://your-api-identifier/email']` (custom claim)

## Testing

1. Log in with Google
2. Check Railway logs for the warning message (if email is missing)
3. The logs will show what fields are available in the token
4. If email is still missing, check Auth0 API configuration

## Notes

- The email should always be available for Google sign-in users
- If email is missing, check that the Auth0 API is configured correctly
- The backend will fall back to generating an email from user_id if needed, but this should be rare
