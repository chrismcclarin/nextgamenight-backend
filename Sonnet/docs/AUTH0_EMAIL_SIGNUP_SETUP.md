# Auth0 Email/Password Signup Setup

## Enable Email Database Connection in Auth0

To allow users to sign up with email/password (instead of just Google), you need to enable the Email database connection in Auth0.

### Steps:

1. **Go to Auth0 Dashboard**
   - Visit https://manage.auth0.com
   - Log in with your Auth0 account

2. **Navigate to Database Connections**
   - In the left sidebar, click **Authentication**
   - Click **Database**

3. **Enable Email Connection**
   - You should see a connection called **"Username-Password-Authentication"** (this is Auth0's default email/password connection)
   - If you don't see it, click **+ Create Database Connection**
   - Name: `Username-Password-Authentication` (or any name you prefer)
   - Type: Database

4. **Enable the Connection for Your Application**
   - Click on the connection name
   - Scroll to **Applications** section
   - Find your frontend application and **toggle it ON**
   - This allows your app to use email/password authentication
   - Click **SAVE**

5. **Configure Email Settings** (Optional but Recommended)
   - In the connection settings, go to **Settings** tab
   - Configure:
     - **Password Policy**: Set minimum length and complexity requirements
     - **Disable Sign Ups**: Leave OFF (you want to allow signups)
     - **Requires Username**: Can be OFF (email-only is fine)
   - **Email Verification**:
     - Enable "Disable Sign Ups" = OFF (to allow signups)
     - Configure email verification settings as needed

6. **Configure Email Provider**
   - Go to **Branding → Email Provider** in Auth0 Dashboard
   - Choose email provider:
     - **SendGrid** (recommended, requires API key)
     - **AWS SES** (requires AWS credentials)
     - **Mandrill** (requires API key)
     - **Auth0's Default** (limited, good for testing only)
   - Configure SMTP settings if using custom provider
   - **For Testing**: Auth0's default email provider works but has rate limits

7. **Configure Email Templates** (Optional)
   - Go to **Branding → Email Templates**
   - Customize verification email template
   - Customize welcome email template
   - Customize password reset email template

8. **Update Application Settings**
   - Go to **Applications → Your Frontend App → Settings**
   - Under **Application Properties**, make sure:
     - Application Type: **Regular Web Application**
   - Under **Application URIs**, verify:
     - Allowed Callback URLs includes your frontend URL
     - Allowed Logout URLs includes your frontend URL
     - Allowed Web Origins includes your frontend URL

### Testing

1. Go to your landing page
2. Click "Get Started" (or go to `/api/auth/login`)
3. You should see options for:
   - Sign up with email/password
   - Sign in with email/password (if already have account)
   - Continue with Google
4. Try signing up with an email address
5. Check your email for verification link (if email verification is enabled)

## Troubleshooting 400 Error on Signup

If you get a `400 Bad Request` error when trying to sign up:

### Issue: Email Database Connection Not Enabled
**Solution**: Follow steps above to enable the connection and ensure your application is enabled for that connection.

### Issue: Application Not Allowed to Use Connection
**Solution**: 
- Go to Authentication → Database → [Your Connection]
- Make sure your application is listed and toggled ON in the Applications section

### Issue: Email Provider Not Configured
**Solution**:
- Go to Branding → Email Provider
- Configure at least Auth0's default email provider (or a custom one)
- Auth0's default provider has limitations but works for testing

### Issue: Email Verification Required But Not Sent
**Solution**:
- Check Auth0 Dashboard → Monitoring → Logs for email sending errors
- Verify email provider is configured correctly
- Check spam folder for verification emails

## Frontend Configuration

The frontend should already work with email signup once Auth0 is configured. The `/api/auth/login` route provided by `@auth0/nextjs-auth0` automatically shows Auth0's universal login page, which includes:

- Email/password signup form (if Email connection is enabled)
- Email/password login form (if Email connection is enabled)
- Social login buttons (Google, etc., if enabled)

You don't need to change the frontend code - it will automatically show the email signup option once Auth0 is configured.

## Environment Variables

No additional environment variables are needed for basic email/password authentication. Auth0 handles everything through their dashboard configuration.

However, if you want to use a custom email provider (like SendGrid), you'll need to configure those credentials in Auth0 Dashboard → Branding → Email Provider.

## Next Steps

After enabling email signup:
1. Test the signup flow
2. Test email verification (if enabled)
3. Test password reset functionality
4. Notification preferences are already shipped — the per-channel notification matrix on the user
   profile, backed by `migrations/20260109-add-email-notifications-enabled.js` and
   `migrations/20260328000001-add-notification-fields-to-users.js`. (This line previously said
   "consider implementing ... see FUTURE_FEATURES.md"; that file was a pre-GSD wishlist, deleted
   2026-07-25 as superseded by `.planning/ROADMAP.md` + `REQUIREMENTS.md`.)
