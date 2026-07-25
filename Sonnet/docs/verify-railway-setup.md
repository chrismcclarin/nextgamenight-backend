# Verify Railway Environment Variables Setup

## Steps to Verify Railway Has the Correct Variables

1. **Go to Railway Dashboard**
   - Navigate to your backend service

2. **Check Environment Variables**
   - Go to the "Variables" tab
   - Verify these three variables are set:
     - `AUTH0_DOMAIN` ✅ (you should already have this)
     - `AUTH0_MANAGEMENT_CLIENT_ID` ✅ (should match your local .env)
     - `AUTH0_MANAGEMENT_CLIENT_SECRET` ✅ (should match your local .env)

3. **Restart the Service** (CRITICAL!)
   - After adding/updating environment variables, Railway needs to restart
   - Either:
     - Click "Deploy" button to trigger a new deployment, OR
     - Go to "Settings" → Scroll down → Click "Restart Service"

4. **Verify Variables Are Applied**
   - Check the Railway logs after restart
   - You should see the backend starting successfully
   - If there are errors about missing AUTH0_MANAGEMENT variables, they weren't applied

## After Railway Restart

The backend should now:
- ✅ Successfully call Auth0 Management API when users sign up
- ✅ Extract correct username from signup
- ✅ Find users by email when adding members to groups
- ✅ Auto-fix existing users with incorrect username/email

## Testing

1. **Test New User Signup:**
   - Create a new user with email/password
   - Check their profile - username should be what they entered during signup

2. **Test Existing User:**
   - Have the existing user with "User" username visit their profile
   - It should auto-update to the correct username from Auth0

3. **Test Add Member:**
   - Try adding a member by email
   - It should find them in Auth0 and create them in your database with correct username

