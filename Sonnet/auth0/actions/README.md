# The post-login Action — what it is, and how to put it into Auth0

> **This file supersedes `docs/AUTH0_EMAIL_IN_TOKEN.md:36-52`.** That older procedure used a
> placeholder namespace (`https://your-api-identifier/`) that the backend no longer reads. Follow
> the steps here instead. The old document is kept only for history.

## What the Action does, and why it exists

When somebody signs in, Auth0 hands our backend an **access token** — a signed slip of paper that
proves who they are. By default that slip carries very little: the user's Auth0 ID, and not much
else. It does **not** reliably carry their email address.

Until now, the backend worked around that by phoning the Auth0 **Management API** the first time it
saw a new person, to ask "what is this person's email?". That phone call has been failing with a
403 since April 2026, so instead of a real email address the app invented a fake one that looks like
`auth0-6a29...@auth0.local`. That is why a real person could not be found by their email address.

This Action fixes the cause rather than the symptom: it writes the seven facts we actually need
**onto the access token itself**, at login time. The backend then reads them straight off the token
and never has to make the phone call at all.

The seven claims it writes:

| Claim name | Where it comes from |
| --- | --- |
| `https://nextgamenight.app/email` | the user's email address |
| `https://nextgamenight.app/email_verified` | whether Auth0 has confirmed that address |
| `https://nextgamenight.app/picture` | their avatar URL (Google users) |
| `https://nextgamenight.app/name` | their display name |
| `https://nextgamenight.app/nickname` | their nickname |
| `https://nextgamenight.app/username` | the username they typed at signup (email/password users) |
| `https://nextgamenight.app/connection` | how they signed in (`google-oauth2` or `auth0`) |

The long `https://nextgamenight.app/...` prefixes are not decoration — Auth0 **requires** custom
claims on an access token to be full URLs, and silently drops short ones.

## Dashboard paste procedure

The Action is deployed by hand, from the dashboard. It is deliberately not deployed by CI: doing
that would mean giving CI a credential that can change the Auth0 tenant, and this repo holds no
such credential today.

1. Open the [Auth0 Dashboard](https://manage.auth0.com).
2. Go to **Actions -> Library -> Custom**, and click **Build from scratch**.
3. Name it `post-login-claims`. For **Trigger**, choose **Login / Post Login**. Leave the runtime
   at the default Node version. Click **Create**.
4. Open `auth0/actions/post-login-claims.js` from this repo, copy its **entire contents**, and
   paste it into the editor, replacing whatever template code is there.
5. Click **Deploy** (top right).
6. Go to **Actions -> Flows -> Login**. Drag `post-login-claims` from the right-hand panel into the
   flow, between **Start** and **Complete**. Click **Apply**.
7. Come back to `auth0/actions/post-login-claims.js` in the repo, and note the commit you pasted on
   the `SOURCE: ... @ <commit>` line in its header, so a future reader can tell whether the
   deployed Action has fallen behind the file.

### If the editor complains about the last two lines

The file ends with two extra exports (`exports.CLAIMS` and `exports.SOCIAL_CONNECTION_STRATEGIES`).
They exist so the backend and the Action share one list of claim names and cannot drift apart. The
Actions editor is expected to accept them, but this has not been proven against a live tenant. If it
refuses to deploy because of them, that is a known, planned-for outcome — say so, and the fallback
is a small code change on our side (move those two constants into `config/auth0Claims.js`). Do not
hand-edit the claim names in the dashboard to work around it; that is exactly the drift this design
prevents.

## Smoke test 1 — the dashboard **Try** button

While still in the Action editor, click the **Try** button (the play icon on the left rail). Auth0
runs the Action against a synthetic user and shows you the result.

**Healthy output** looks like a block listing the access token's custom claims, and all seven of the
`https://nextgamenight.app/...` names above are present. Some of the *values* will be empty or
`null` for the synthetic test user — that is fine and expected. What you are checking is that the
seven **keys** appear and that no error is thrown.

**Unhealthy output** is a red error box, or a claim list that is empty or missing the
`https://nextgamenight.app/` names entirely.

## Smoke test 2 — a real, fresh login (this is the one that matters)

The Try button only proves the Action runs. To prove it reaches the real backend you must
**log out of nextgamenight.app, and log back in.**

**Reloading the page is not enough, and proves nothing.** Here is why: the frontend never asks Auth0
for a refresh token (`offline_access` is not requested), so an existing browser session keeps
holding the **old** access token — the one minted before the Action existed, with none of the new
claims on it — until that token expires on its own. Reloading hands the backend the same stale slip
of paper. Only a full log-out and log-in mints a new token that goes through the Login flow, and
therefore through this Action.

So:

1. Log out of the app completely.
2. Log back in.
3. Decode the new access token to confirm the claims arrived. The simplest way: open the browser
   devtools **Network** tab, find a request to the API, copy the long string after `Bearer ` in its
   `Authorization` header, and paste it into <https://jwt.io>. The decoded payload on the right
   should contain the seven `https://nextgamenight.app/...` keys.

If the seven keys are there on a freshly-minted token, the Action is live and working.
