# BoardGameGeek XML API Compliance Guide

## Overview
This document outlines the requirements from [BGG's XML API documentation](https://boardgamegeek.com/using_the_xml_api) and what needs to be implemented to ensure compliance.

## Critical Requirements

### 1. Application Registration (REQUIRED)
**Status: ⚠️ NOT YET COMPLETED**

- **Action Required**: Register your application at https://boardgamegeek.com/applications
- **Process**: 
  1. Click "Create Application"
  2. Fill out the application form
  3. Wait for approval (may take a week or more)
  4. Once approved, create an Application Token
- **License Type**: Determine if your application is:
  - **Commercial**: If for-profit, monetized, shows ads, or offers paid benefits
  - **Non-commercial**: Purely non-commercial use
- **Note**: Applications that compete with BGG's business may be denied

### 2. Authorization Header (REQUIRED)
**Status: ✅ CODE READY - NEEDS TOKEN**

The code has been updated to support the Authorization header. Once you have an Application Token, add it to your `.env` file and it will automatically be included in all API requests.

**Implementation**: ✅ COMPLETED
- `bggService.js` now includes `getHeaders()` method that adds Authorization header when token is available
- Token is read from `process.env.BGG_APPLICATION_TOKEN`
- Format is correct: `Authorization: Bearer <token>` (space after Bearer, no colon)

**Next Steps**:
1. Register application at https://boardgamegeek.com/applications
2. Obtain Application Token
3. Add `BGG_APPLICATION_TOKEN=your-token-here` to `.env` file
4. Restart backend server

**Important Format Notes**:
- Use "Bearer" followed by a **space** (no colon!)
- Token format: a UUID, e.g. `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` (the real value lives ONLY in `.env` as `BGG_APPLICATION_TOKEN` — never commit it)
- Must use HTTPS
- Must use `boardgamegeek.com` (NO leading `www`)

### 3. "Powered by BGG" Logo (REQUIRED for Public Apps)
**Status: ✅ IMPLEMENTED - NEEDS ACTUAL LOGO IMAGE**

The logo component has been created and added to the application. Currently using a text placeholder that needs to be replaced with the actual BGG logo image.

**Implementation**: ✅ COMPLETED
- Created `BGGLogo` component (`src/app/components/BGGLogo.js`)
- Added to landing page footer
- Added to main layout footer (appears on all pages)
- Logo links to https://boardgamegeek.com
- Accessible with proper ARIA labels

**Next Steps**:
1. Download "Powered by BGG" logo from: https://drive.google.com/drive/folders/1k3VgEIpNEY59iTVnpTibt31JcO0rEaSw?usp=drive_link
2. Save logo to `public/bgg-logo.png` (or appropriate format)
3. Uncomment the `<img>` tag in `BGGLogo.js` and remove the placeholder text
4. Verify logo text is legible at all screen sizes

**Requirements**:
- ✅ Logo is displayed prominently (footer on all pages)
- ✅ Logo links to https://boardgamegeek.com
- ⚠️ Logo text must remain easily legible (needs actual image)
- Logo files available at: https://drive.google.com/drive/folders/1k3VgEIpNEY59iTVnpTibt31JcO0rEaSw?usp=drive_link

### 4. Usage Limits & Best Practices
**Status: ✅ PARTIALLY IMPLEMENTED**

**Current Implementation**:
- ✅ Requests are made server-side (backend)
- ✅ Rate limiting in place (2 second minimum between requests)
- ⚠️ No caching implemented yet
- ✅ Retry logic with exponential backoff

**Recommendations**:
- Implement caching for frequently accessed game data
- Monitor usage at https://boardgamegeek.com/applications (after registration)
- Keep request count to minimum
- Cache results on server to avoid repeated API calls

### 5. Client-Side Requests
**Status: ✅ COMPLIANT**

- All BGG API requests are made from the backend server
- No client-side requests to BGG API
- This is the recommended approach per BGG documentation

## Implementation Checklist

### Backend (`bggService.js`)
- [x] Update `bggService.js` to support Authorization header (✅ COMPLETED)
- [ ] Register application at https://boardgamegeek.com/applications
- [ ] Obtain Application Token
- [ ] Add `BGG_APPLICATION_TOKEN` to `.env` file
- [ ] Test API calls with token
- [ ] Implement caching for game data (optional but recommended)

### Frontend
- [x] Create `BGGLogo` component (✅ COMPLETED)
- [x] Add logo to landing page (✅ COMPLETED)
- [x] Add logo to main layout footer (✅ COMPLETED)
- [x] Ensure logo links to https://boardgamegeek.com (✅ COMPLETED)
- [ ] Download "Powered by BGG" logo from Google Drive link
- [ ] Replace placeholder text with actual BGG logo image
- [ ] Verify logo text is legible at all screen sizes

## Environment Variables

Add to `.env` file:
```env
BGG_APPLICATION_TOKEN=your-token-here
```

## Testing

After implementing the Authorization header:
1. Test BGG search functionality
2. Test game import from BGG
3. Monitor API usage at https://boardgamegeek.com/applications
4. Verify no 401/403 errors (unless rate limited)

## Important Notes

- **Rate Limiting**: BGG may rate limit requests. Our current retry logic handles this, but excessive requests could result in license suspension.
- **Token Security**: Keep your Application Token secure. If exposed, generate a new one immediately.
- **Policy Changes**: BGG's API policies are subject to change. Monitor the [Geek Tools News forum](https://boardgamegeek.com/forum/1182517/geek-tools/news) for updates.
- **No Technical Support**: BGG does not provide technical support. Use the [Geek Tools Guild](https://boardgamegeek.com/guild/1229) for questions.

## Current Error Handling

The current implementation handles:
- 401/403 errors (likely rate limiting or missing token)
- Timeout errors
- Network errors
- Retry logic with exponential backoff

Once the Authorization header is added, 401/403 errors should be significantly reduced.

