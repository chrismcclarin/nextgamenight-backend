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

---

## The two alarms that point you back here

`middleware/auth0.js` watches every verified access token for signs that this Action is not
doing its job, and both alarm messages name this README — so this is where the answer has to
be. Both are **production only** (`NODE_ENV === 'production'`), both go to `console.warn` **and**
Sentry `captureMessage` at `level: 'warning'`, and both are throttled to **one report per
process per hour**, on **separate** timers so neither can silence the other. Neither one ever
touches the request: no user is refused because of them.

Every event carries `tags.feature = 'auth0-claims'`; the `op` tag is what tells them apart.

### `op: 'claims-absent'` — the Action is not running at all

> `[auth0] post-login Action claims ABSENT from the access token — is the Action deployed and bound to the Login flow?`

Fires when the token carries **none** of the seven `https://nextgamenight.app/...` claims. That is
the signature of an Action that was never pasted in, was deleted, or is not attached to the flow.
Extra field: `hasBareEmail` — whether the bare OIDC `email` claim happened to be present.

What to check in Auth0, in order:

1. **Actions → Library** — does the Action still exist, and is its code the current contents of
   `post-login-claims.js`?
2. **Actions → Triggers → post-login** — is the Action actually **dragged into the flow** and is
   the flow **applied**? A saved-but-unbound Action produces exactly this signature.
3. If both look right, the reporter may simply be holding an **old token**: see Smoke test 2 above
   — reloading the page proves nothing, only a full log-out and log-in mints a token through this
   flow. Confirm with a fresh login before touching anything.

### `op: 'claims-partial'` — the Action runs, but the email claims are missing

> `[auth0] post-login Action claims are PARTIAL — the email / email_verified claim is missing from the access token while other namespaced claims are present.`

Fires when **some** namespaced claims arrive but `email` or `email_verified` does not. This is the
failure with real user impact and it is otherwise completely silent: `email_verified` gates
`revertClaimAddress` and `wasOldAddressProved`, so losing it makes "Use my sign-in address" vanish,
makes every revert refuse, and makes the invite/feedback moves on an email change silently skip.
It fails **closed** — nothing is bypassed — which is why it is a monitoring alarm, not an incident.

The event carries four discriminators (booleans and a connection strategy — never an address or a
user id). Read them first, because they say which of two very different things happened:

| `hasNamespacedEmail` | `hasNamespacedEmailVerified` | What it means |
| --- | --- | --- |
| `true` | `false` | The Action was **edited** and the `email_verified` line was dropped or its claim name misspelled. Fix the Action. |
| `false` | `true` | The Action was **edited** and the `email` line was dropped or misspelled. Fix the Action. |
| `false` | `false` | Ambiguous, and accepted as such: either both lines were dropped, **or** this person genuinely has no email address on their Auth0 profile. Check `connection` and the user in Auth0 before assuming a defect. |

What to check in Auth0:

1. **Actions → Library → the post-login Action** — diff the pasted body against
   `post-login-claims.js`. The claim names come from the `CLAIMS` table at the top of that file;
   a hand-edited namespace string is the usual cause.
2. **User Management → Users → the reporting user** (identify them from the Sentry event's own
   user context, not from these `extra` fields — they deliberately carry no identifiers). Does the
   profile have an `email` at all? An email-less user produces the third row above and is not a
   defect.
3. Use the `connection` field as a prior, not as proof: this tenant's only social connection is
   `google-oauth2` (`SOCIAL_CONNECTION_STRATEGIES`), and its database connection uses the address
   as the login identifier — so an email-less profile is unlikely on either, and a `false/false`
   is more likely the Action than the profile. Confirm it against the actual user in step 2
   rather than concluding from the connection alone.
