# How to Verify Auth0 Management API Application Permissions

## Option 1: Check Existing "Auth0 Management API" Application

If you see a Machine-to-Machine application called "Auth0 Management API":

1. Go to Auth0 Dashboard → Applications → Applications
2. Click on "Auth0 Management API" (the Machine-to-Machine application)
3. Go to the "APIs" tab
4. Check if "Auth0 Management API" is listed there
5. If it is, click on it and verify:
   - The status shows "Authorized" or has a checkmark
   - Under "Permissions", make sure `read:users` is checked/enabled
6. If `read:users` is NOT enabled:
   - Click the toggle or checkbox to enable it
   - Click "Save" or "Update"

## Option 2: Create a New Machine-to-Machine Application (Recommended)

Creating a new one ensures you have full control and clarity:

1. Go to Auth0 Dashboard → Applications → Applications
2. Click "+ Create Application"
3. Select "Machine to Machine Applications"
4. Name it (e.g., "PeriodicTableTop Backend")
5. Click "Create"
6. When prompted, select "Auth0 Management API" from the dropdown
7. Enable `read:users` permission
8. Click "Authorize"
9. Go to the "Settings" tab
10. Copy the Client ID and Client Secret

## Important Notes

- The error (401 Invalid token) usually means:
  - The application doesn't have `read:users` permission, OR
  - The application isn't properly authorized for Management API
- You CAN use an existing application if it has the right permissions
- Creating a new one is safer if you're unsure
