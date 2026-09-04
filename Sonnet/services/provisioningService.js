// services/provisioningService.js
// Phase 88.8 (BOPS-05, CONTEXT D-13) — the ONE home for just-in-time account
// provisioning and repair (SPEC R2, R3, R4 and the storage half of R11).
//
// This service owns the whole policy: which address may be written to Users.email,
// when the Auth0 Management API is consulted at all, how a username is derived, when an
// avatar is stored, and what gets reported when any of that falls back. routes/users.js
// (and, from plan 06, routes/events.js, routes/groups.js and routes/googleAuth.js) stay
// THIN handlers that resolve the caller from req.user.user_id and delegate here — the
// shape services/accountDeletionService.js:1-19 established (D-01).
//
// DECISION Phase 88.8 D-13: ONE service for all seven findOrCreate writers, chosen OVER
// adding the four claims-first branches inline at three or four route files. Rejected
// because duplication is never a peer option in this repo (CLAUDE.md) and because that
// duplication is the ROOT CAUSE this phase exists to remove: the verified-email check
// lives at exactly ONE of the seven writers today (routes/groups.js:806) and nowhere
// else, so a rule the SPEC states once is enforced at one site out of seven. Also
// rejected: a service covering users.js and events.js only with the rest deferred (the
// owner chose the full census), and a middleware (the in-route timezone validation is
// why a middleware was rejected at discuss). Undoing this means re-inlining the policy
// at seven call sites in four files — that is a decision, not a cleanup.
//
// KEYSPACE DISCIPLINE — this service touches BOTH user keyspaces and mixing them mints
// a ghost row. Use the correct key per surface EXACTLY:
//   - `sub`      (Auth0 sub STRING, e.g. 'auth0|abc' / 'google-oauth2|123')
//                -> Users.user_id, and the ONLY value that may key findOrCreate here.
//   - `user.id`  (UUID surrogate PK)
//                -> what callers serialize and what every other table joins on.
// A caller that passes a Users.id UUID as `sub` will MISS the user_id lookup and mint a
// brand-new UUID-keyed row — a class-2 hygiene row of exactly the kind plan 05's report
// exists to find, handed back to the caller as their own profile. routes/users.js keys
// on req.user.user_id (the TOKEN sub) for precisely this reason; its dual-keyspace
// self-gate has ALREADY proved the param is the caller in one keyspace or the other.
//
// Composes three verified in-repo idioms:
//   - the scoped findOrCreate                      (routes/users.js Phase 88-34 Rule 1)
//   - per-candidate username clamping              (utils/provisionedUsername.js)
//   - domain-only provisioning telemetry           (utils/provisioningReport.js, D-17)

const { User } = require('../models');
const { clampProvisionedUsername } = require('../utils/provisionedUsername');
const { SOCIAL_CONNECTION_STRATEGIES } = require('../config/auth0Claims');
const defaultAuth0Service = require('./auth0Service');
const { reportProvisioning, PROVISIONING_REASONS } = require('../utils/provisioningReport');

// The literal every machine-derived username chain falls back to. Also the value the
// repair path treats as "this row never got a real name".
const GENERIC_USERNAME = 'User';

// Users.picture_url is DataTypes.STRING, which Sequelize materialises as
// `character varying(255)` (in-repo precedent: Groups.profile_picture_url at
// migrations/00000000000000-baseline-pre-migration-schema.js:216). The cap here is the
// COLUMN's cap on purpose — a generic URL cap of 512/1024/2048 exceeds the column, so an
// over-long claim would sail past this guard and raise
// `value too long for type character varying(255)` inside findOrCreate, where the
// collision predicate returns false and the error is rethrown as a 500 on first login.
const PICTURE_URL_MAX_LENGTH = 255;

// BOTH email unique constraints. `Users_email_key` is the case-SENSITIVE baseline
// constraint; `users_email_lower_unique` is the UNIQUE index on LOWER(email) added by
// migrations/20260902000007 (mirrored at models/User.js:226) on an owner ruling of
// 2026-09-04. Plan 02 provoked a real case-variant collision and MEASURED the error:
// `err.parent.constraint` is `users_email_lower_unique` and `err.fields` is keyed
// `lower(email::text)`, so `err.fields.email` is undefined. A predicate that knows only
// one name matches NEITHER arm for that index.
// Plan 05 promotes this predicate to an exported `isEmailCollision` and replaces the
// placeholder handling below with the four SPEC R5 orphan branches.
const EMAIL_UNIQUE_CONSTRAINTS = Object.freeze(['Users_email_key', 'users_email_lower_unique']);

// Free-form-but-FROZEN telemetry vocabulary. `outcome` is the one-line summary of what
// the call did; `notes` is the itemised list, because several arms can fire on one call
// (a row can skip the email repair under D-36 while still gaining a username).
const PROVISIONING_OUTCOMES = Object.freeze({
  CREATED_FROM_VERIFIED_CLAIM: 'created_from_verified_claim',
  CREATED_FROM_MANAGEMENT: 'created_from_management',
  CREATED_SYNTHETIC: 'created_synthetic',
  CREATED_SYNTHETIC_AFTER_COLLISION: 'created_synthetic_after_collision',
  IDENTITY_GONE: 'identity_gone',
  REPAIRED: 'repaired',
  UNCHANGED: 'unchanged',
});

const PROVISIONING_NOTES = Object.freeze({
  EMAIL_REPAIR_SKIPPED_USER_SET: 'email_repair_skipped_user_set',
  EMAIL_REPAIRED_FROM_CLAIM: 'email_repaired_from_claim',
  EMAIL_REPAIRED_FROM_MANAGEMENT: 'email_repaired_from_management',
  EMAIL_LEFT_CLAIM_UNVERIFIED: 'email_left_claim_unverified',
  EMAIL_LEFT_MANAGEMENT_UNVERIFIED: 'email_left_management_unverified',
  EMAIL_REPAIR_COLLIDED: 'email_repair_collided',
  AUTH0_IDENTITY_GONE: 'auth0_identity_gone',
  MANAGEMENT_LOOKUP_FAILED: 'management_lookup_failed',
  USERNAME_REPAIRED: 'username_repaired',
  PICTURE_URL_UPDATED: 'picture_url_updated',
  RACED_TO_EXISTING_ROW: 'raced_to_existing_row',
});

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

/**
 * The ONE normalisation rule for a stored address: trim, then lowercase. Applied at
 * PERSISTENCE, and used for every address comparison in this file so a mixed-case IdP
 * address never issues a no-op UPDATE on every fetch.
 *
 * This is the writer half of the agreement plan 03 made on the reader side: friend
 * search compares `lower(email)` against the stored column (routes/friendships.js:198-210).
 * If you change the rule here, change it there — the two must be the same rule or an
 * address becomes findable by one path and not the other.
 */
function normaliseEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

// The broad at-auth0 guard, carried VERBATIM from routes/users.js:254-258. The second
// test is a substring of the first and is therefore redundant — it is kept because
// DECISION Phase 88.2 NIX-AUTH0 (services/groupOwnershipOfferService.js:97-115)
// deliberately keeps this guard broad. Narrowing it is a decision, not a cleanup.
function isSyntheticAddress(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return true;
  }
  return value.includes('@auth0.local') || value.includes('@auth0');
}

function isRealAddress(value) {
  return !isSyntheticAddress(value);
}

// The last-resort address, built exactly as every one of the four hand-written mints
// builds it today (routes/users.js:308, events.js, groups.js x2).
function syntheticEmailFor(sub) {
  return `${String(sub).replace(/[|:]/g, '-')}@auth0.local`;
}

function emailLocalPart(address) {
  return typeof address === 'string' ? address.split('@')[0] : null;
}

function isGenericUsername(value) {
  return value === GENERIC_USERNAME || !value || String(value).trim().length === 0;
}

/**
 * Whether an error is a violation of EITHER email unique constraint.
 * `parent.constraint` is the PRIMARY discriminator and `fields.email` the fast path,
 * in that order: Sequelize populates `fields` only when the Postgres `Key (col)=(val)`
 * DETAIL line parses, while `parent.constraint` comes off the wire unconditionally —
 * and `fields.email` is never present for the LOWER(email) index at all.
 */
function isEmailUniqueViolation(err) {
  if (!err || err.name !== 'SequelizeUniqueConstraintError') {
    return false;
  }
  const constraint = err.parent && err.parent.constraint;
  if (typeof constraint === 'string' && EMAIL_UNIQUE_CONSTRAINTS.includes(constraint)) {
    return true;
  }
  return Boolean(err.fields && err.fields.email);
}

// ---------------------------------------------------------------------------
// The username chain
// ---------------------------------------------------------------------------

/**
 * Build a per-candidate picker that clamps AND refuses any candidate which normalises to
 * one of `rejectedAddresses`. The array is read live, so a caller may push the
 * Management-returned address onto it after the picker is built.
 *
 * DECISION Phase 88.8 (review round 2, verified 2026-09-03): reject, per candidate, any
 * value that normalises to the RAW CLAIM email — applied HERE, at the chain inside this
 * service.
 *
 * Why this exists at all: for an Auth0 DATABASE (username-password) connection,
 * `event.user.name` defaults to the user's EMAIL ADDRESS and `nickname` to its local
 * part. The repo already encodes that as known behaviour at services/auth0Service.js:162
 * ("Auth0 structure: name = email, email = email"). DECLARED UNVERIFIED: Auth0's formal
 * reference docs do not document the default, so the claim rests on staff statements and
 * could change. Nothing leaks TODAY because the only reader of those values is
 * auth0Service.extractUserDetails, whose chain rejects an email-valued candidate with a
 * strict `!==` at services/auth0Service.js:176 — and claims-first deliberately STOPS
 * CALLING that function. Consequence if this filter is removed: `username` is PUBLIC —
 * routes/friendships.js:21/:26 project ['id','username'] as the entire non-id payload,
 * and that projection pair appears 30 times across routes/.
 *
 * Rejected alternatives, all three:
 *  (a) Putting the check inside clampProvisionedUsername. That helper carries
 *      `DECISION Phase 88 wave-12 code review HIGH #2 (owner-approved 2026-08-21)` with
 *      an explicit scope boundary — "This clamps DISPLAY usernames only"
 *      (utils/provisionedUsername.js:18-19). Moving an identity check in there overturns
 *      a recorded decision.
 *  (b) Relying on services/auth0Service.js:172-182. Its `!==` at :176 is the only thing
 *      stopping this today, and it is exactly what claims-first bypasses.
 *  (c) Comparing against the RESOLVED address rather than the raw claim. Under the
 *      three-way rule a present-but-UNVERIFIED claim resolves to the synthetic
 *      <sub>@auth0.local, so a filter bound to the resolved value never fires for the
 *      unverified population — the population most at risk.
 *
 * Also deliberate: the compare is NORMALISED on both sides (trim + lowercase), which
 * SUPERSEDES rather than copies the strict unnormalised `!==` at auth0Service.js:176 —
 * that one lets "  ALICE@Example.COM  " through. And the `String(name ?? '')` coercion
 * from utils/provisionedUsername.js:26 is preserved: a bare `.trim()` on a non-string
 * claim is a TypeError, i.e. a 500 on first login, which is the exact failure class the
 * 88-34 clamp block below exists to prevent.
 */
function makeUsernamePicker(rejectedAddresses) {
  return function pick(candidate) {
    const asText = String(candidate ?? '').trim().toLowerCase();
    if (asText.length > 0) {
      for (const address of rejectedAddresses) {
        if (typeof address === 'string' && address.trim().toLowerCase() === asText) {
          return null;
        }
      }
    }
    return clampProvisionedUsername(candidate);
  };
}

// DECISION Phase 88-34 Task 4 (fork D, owner-ruled 2026-08-20): CLAMP the derived
// username at this writer, over dropping the User.username len[1,50] model backstop.
//
// This is the ONE writer that legitimately receives input it does not control: the value
// below comes from Auth0 (token claims, then the Management API, then given_name +
// family_name which OVERRIDES everything). Real people have full names longer than 50
// characters. With the model backstop and without this clamp, their very FIRST LOGIN
// 500s and they can never get an account — an outage with no user-side workaround.
//
// Clamp rather than reject, because a human's legal name is not invalid input; and clamp
// HERE rather than widening/removing the backstop, because the backstop is what protects
// every OTHER (human-entered, already route-validated) write path. Trim first so the 50
// characters are 50 real characters, not padding.
//
// Applies to BOTH write paths — the findOrCreate defaults AND the repair branch.
// Test-pinned (a >50-char Auth0 full name must provision successfully with a 50-char
// username).
//
// AMENDED (wave-12 review HIGH #2, owner-approved 2026-08-21): the chain clamps
// PER-CANDIDATE via the shared utils/provisionedUsername.js helper — the review found 8
// more unclamped machine-derived writers shipping the same outage this comment warns
// about, so the mechanism moved to a util applied at every one. The final clamp below
// stays as the belt for this writer.
//
// MOVED HERE by Phase 88.8 plan 04 (D-13) from routes/users.js:274-302, WITH the code it
// describes. This comment is an explicit do-not-clean-this-up marker; losing it in a
// refactor is exactly the failure the CLAUDE.md Evidence Rule warns about.
function buildProvisionedUsername({ claims, rejectedAddresses, managementUsername, resolvedEmail }) {
  const pick = makeUsernamePicker(rejectedAddresses);
  const rawClaimEmail = typeof claims.email === 'string' ? claims.email : null;

  // The chain, moved verbatim from routes/users.js:210-215, with ONE addition: pick()
  // refuses a candidate that IS the user's own address. The email LOCAL PART candidate
  // is deliberately NOT filtered — deriving a display name from an address is not
  // adopting an address, and SPEC R2 says the chain is otherwise unchanged. It reads the
  // claim's local part even when that claim is UNVERIFIED, which is also unchanged.
  let userName =
    pick(claims.username) ||
    pick(claims.name) ||
    pick(claims.nickname) ||
    pick(claims.given_name) ||
    clampProvisionedUsername(emailLocalPart(rawClaimEmail)) ||
    GENERIC_USERNAME;

  // The Management API's signup username wins over the claim chain when it is not the
  // generic literal — routes/users.js:291-294, critical for email/password users who
  // entered a username at signup.
  if (managementUsername) {
    const fromManagement = pick(managementUsername);
    if (fromManagement && fromManagement !== GENERIC_USERNAME) {
      userName = fromManagement;
    }
  }

  // Rescue from the resolved address when nothing else produced a name
  // (routes/users.js:312-315). A synthetic address never reaches here.
  if (userName === GENERIC_USERNAME && isRealAddress(resolvedEmail)) {
    userName = clampProvisionedUsername(emailLocalPart(resolvedEmail)) || userName;
  }

  // given_name + family_name OVERRIDES everything (routes/users.js:317-323).
  if (claims.given_name || claims.family_name) {
    const fullName = [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim();
    if (fullName) {
      userName = pick(fullName) || userName;
    }
  }

  return clampProvisionedUsername(userName) || GENERIC_USERNAME;
}

// ---------------------------------------------------------------------------
// picture_url (D-26 + D-27, SPEC R11 storage half)
// ---------------------------------------------------------------------------

/**
 * Resolve what, if anything, to write to Users.picture_url for this login.
 *
 * @returns {undefined|null|string} undefined = DO NOT WRITE (leave the stored value
 *   alone); null = write null; a string = write it.
 *
 * D-27: an avatar is stored ONLY for a SOCIAL-connection login. The strategy set is
 * imported from config/auth0Claims.js, never inlined — if the tenant ever renames or
 * replaces the Google connection, the social-only rules fail visibly in ONE place
 * instead of silently degrading at each call site. Database/password logins keep null
 * and get the app's own initials fallback (src/components/ui/UserChip.tsx:67). No
 * hostname allowlist by design — D-27 rejected it as brittle.
 *
 * D-26 cadence: an ABSENT picture claim leaves the stored value ALONE, because a
 * Management-fallback login (which carries no claims at all) must never wipe an avatar.
 * A claim that is present but empty, non-string, over the column's length, or not https
 * stores null. A vendor-supplied `null` is treated as ABSENT rather than as "present and
 * empty": Auth0 omitting a value and Auth0 asserting "no picture" are indistinguishable
 * on the wire, and the non-destructive reading is the one D-26's own rationale asks for.
 *
 * The protocol-allowlist precedent is src/lib/safeBgImageStyle.ts:6-20.
 */
function resolvePictureClaim(claims) {
  if (!SOCIAL_CONNECTION_STRATEGIES.includes(claims.connection_strategy)) {
    return undefined;
  }
  const raw = claims.picture;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > PICTURE_URL_MAX_LENGTH) {
    return null;
  }
  try {
    if (new URL(raw).protocol !== 'https:') {
      return null;
    }
  } catch (_notAUrl) {
    return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// The public entry point
// ---------------------------------------------------------------------------

/**
 * Provision the caller's Users row, or repair the one they already have.
 *
 * @param {{ sub: string, claims?: object, detectedTimezone?: string|null }} args
 *   sub = req.user.user_id (the Auth0 sub from the TOKEN — never a route param; see the
 *   KEYSPACE DISCIPLINE block at the top of this file).
 *   claims = the req.user bag the middleware built from the namespaced access-token
 *   claims. `{}` and `undefined` are both legitimate (the OAuth-URL writer passes
 *   neither) and mean "the claims are ABSENT".
 * @param {{ auth0Service?: object }} [overrides] Boundary override for deterministic
 *   tests only; production uses the real service. The seam is what makes the plan-06
 *   route tests cheap.
 * @returns {Promise<{ status: 'provisioned'|'identity_gone', user: object|null,
 *   created: boolean, changed: boolean, outcome: string, reason: string|null,
 *   notes: string[] }>}
 */
async function provisionOrRepair({ sub, claims, detectedTimezone } = {}, overrides = {}) {
  const auth0 = overrides.auth0Service || defaultAuth0Service;
  const claimBag = claims || {};

  // Definitions, stated once and used everywhere below.
  // A claim email is PRESENT when it is a non-empty string that is not itself a
  // synthetic at-auth0 address. Anything else — including claims being {} or undefined,
  // which is what the OAuth callback passes — is ABSENT.
  const rawClaimEmail = typeof claimBag.email === 'string' ? claimBag.email : null;
  const claimEmailIsPresent = rawClaimEmail !== null && isRealAddress(rawClaimEmail);
  // `=== true` is load-bearing: an ABSENT verification claim must read as UNVERIFIED
  // (SPEC Edge Coverage `adjacency dagger / R2`), and no other truthy shape counts as
  // proof. The middleware already defaults the claim to false, so this is belt and braces.
  const claimEmailIsVerified = claimEmailIsPresent && claimBag.email_verified === true;

  const picture = resolvePictureClaim(claimBag);

  const existing = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
  if (existing) {
    return repairExistingRow({
      row: existing, sub, claimBag, rawClaimEmail,
      claimEmailIsPresent, claimEmailIsVerified, picture, auth0, notes: [],
    });
  }

  return createRow({
    sub, claimBag, rawClaimEmail, claimEmailIsPresent, claimEmailIsVerified,
    picture, detectedTimezone, auth0,
  });
}

// ---------------------------------------------------------------------------
// CREATE path
// ---------------------------------------------------------------------------

async function createRow({
  sub, claimBag, rawClaimEmail, claimEmailIsPresent, claimEmailIsVerified,
  picture, detectedTimezone, auth0,
}) {
  const notes = [];
  // Read live by the username picker, so an address the Management API returns can be
  // added to the reject set after the fact.
  const rejectedAddresses = [rawClaimEmail];

  let resolvedEmail = null;
  let managementUsername = null;
  let reason = null;
  let outcome = null;
  let fallbackError = null;

  // -------------------------------------------------------------------------
  // DECISION Phase 88.8 (SPEC R2/R3): the THREE-WAY email rule — a present claim NEVER
  // calls the Auth0 Management API, verified or not. Only an ABSENT claim does.
  //
  // Chosen OVER "adopt when verified, otherwise ask the Management API". The rejected
  // alternative keeps the vendor on the first-login critical path for exactly the
  // population whose token already answered the question, which is the dependency
  // BOPS-05 exists to remove — that call has been 403ing since 2026-04 and is why every
  // account provisioned between 2026-04 and 2026-09 holds a synthetic address.
  //
  // NAMED TRADE-OFF, recorded rather than glossed: the Phase 87.2 SPEC Req 6
  // identity-gone 410 lives INSIDE the Management lookup, so it cannot fire on ANY path
  // where the token carries an email claim. A token carrying claims proves the identity
  // existed at mint time, so the exposure is an identity deleted from the Auth0 dashboard
  // AFTER its token was minted and within that token's remaining lifetime; such a row is
  // created with its own real verified address (no privilege gain) or with the synthetic
  // one (strictly less exposure than today), and is listed by the R6 hygiene script's
  // "Auth0 identity gone" class. The residual is accepted in writing at threat register
  // T-88.8-02 and pinned by a test in tests/routes/accountDeletion.test.js, not merely
  // excused here. The tombstone guard (PendingAuth0Deletion.isTombstoned) runs in the
  // route on BOTH paths and is untouched.
  //
  // A further consequence, stated because it is easy to read as a bug: a session still
  // holding its PRE-verification token stays synthetic until the next login mints a
  // verified claim. SPEC R3 defines that upgrade via claims, and it replaces today's
  // every-fetch Management lookup for such rows.
  //
  // Changing this is a decision, not a cleanup.
  // -------------------------------------------------------------------------
  if (claimEmailIsPresent) {
    if (claimEmailIsVerified) {
      resolvedEmail = rawClaimEmail;
      outcome = PROVISIONING_OUTCOMES.CREATED_FROM_VERIFIED_CLAIM;
    } else {
      // A present-but-unverified claim is not a reason to phone the vendor: the token
      // already told us the answer, and it must never land in Users.email.
      reason = PROVISIONING_REASONS.EMAIL_UNVERIFIED;
    }
  } else {
    try {
      const auth0User = await auth0.getUserById(sub);
      if (auth0User === null) {
        // services/auth0Service.js:102-103 returns null ONLY on a hard 404 — the Auth0
        // identity is GONE. Refuse to re-materialise the row (Phase 87.2 SPEC Req 6);
        // the caller maps this onto the pinned 410 account_deleted envelope.
        return {
          status: 'identity_gone',
          user: null,
          created: false,
          changed: false,
          outcome: PROVISIONING_OUTCOMES.IDENTITY_GONE,
          reason: null,
          notes: [PROVISIONING_NOTES.AUTH0_IDENTITY_GONE],
        };
      }
      if (auth0User) {
        const details = auth0.extractUserDetails(auth0User) || {};
        if (typeof details.email === 'string') {
          // The Management address must not win the username chain either. This is an
          // ADDITION to the raw-claim comparison, never a substitute for it — see the
          // rejected alternative (c) on makeUsernamePicker.
          rejectedAddresses.push(details.email);
        }
        if (isRealAddress(details.email)) {
          if (details.email_verified === true) {
            resolvedEmail = details.email;
            outcome = PROVISIONING_OUTCOMES.CREATED_FROM_MANAGEMENT;
          } else {
            // NEW in Phase 88.8: routes/users.js:230-237 adopted this address without
            // checking, which is the SPEC R3 gap on the fallback path.
            reason = PROVISIONING_REASONS.EMAIL_UNVERIFIED;
          }
        } else {
          reason = PROVISIONING_REASONS.CLAIMS_MISSING;
        }
        managementUsername = details.username;
      } else {
        reason = PROVISIONING_REASONS.CLAIMS_MISSING;
      }
    } catch (managementFailed) {
      // The Management API is unavailable (not a 404 — those resolve null above).
      reason = PROVISIONING_REASONS.MGMT_API_FAILED;
      fallbackError = managementFailed;
    }
  }

  // Last resort, on every path above that did not adopt an address.
  if (!isRealAddress(resolvedEmail)) {
    resolvedEmail = syntheticEmailFor(sub);
    if (!reason) {
      reason = PROVISIONING_REASONS.CLAIMS_MISSING;
    }
    outcome = PROVISIONING_OUTCOMES.CREATED_SYNTHETIC;
  }

  const clampedUserName = buildProvisionedUsername({
    claims: claimBag, rejectedAddresses, managementUsername, resolvedEmail,
  });

  const emailToPersist = normaliseEmail(resolvedEmail);
  const defaults = {
    user_id: sub,
    email: emailToPersist,
    username: clampedUserName,
    // TZ-01: persist the browser-detected timezone on first creation if supplied. When
    // detectedTimezone is null we DELIBERATELY omit the key so Sequelize applies the
    // model defaultValue (null per migration 78-01) — sending `timezone: null`
    // explicitly would risk a future model default of 'UTC' sneaking back in
    // undetected. Absence is the safest signal. D-26's absent-vs-empty rule for
    // picture_url below is the same idiom, for the same reason.
    ...(detectedTimezone ? { timezone: detectedTimezone } : {}),
    ...(picture !== undefined ? { picture_url: picture } : {}),
  };

  let row;
  let created;
  try {
    // Phase 88-34 (Rule 1, found by the fork-D !created test): this was a bare
    // `User.findOrCreate`, so the returned instance came back under the DEFAULT SCOPE —
    // which EXCLUDES `email` (models/User.js defaultScope, BSEC-01 D-03). The repair
    // branch then evaluated `newUser.email.includes('@auth0.local')` on `undefined` and
    // THREW, so that entire fix-a-wrong-email/username path was dead: every run fell
    // into the catch, re-fetched, and returned the row unrepaired. NEVER use a bare
    // findOrCreate here.
    [row, created] = await User.scope('withContactInfo').findOrCreate({
      where: { user_id: sub },
      defaults,
    });
  } catch (createFailed) {
    // The concurrency backstop first: another request for the same sub may have won the
    // race between our findOne and this insert.
    const raced = await User.scope('withContactInfo').findOne({ where: { user_id: sub } });
    if (raced) {
      row = raced;
      created = false;
    } else if (isEmailUniqueViolation(createFailed)) {
      // PLACEHOLDER, and deliberately narrow — plan 05 replaces this with the four SPEC
      // R5 orphan branches (look up the occupant, release a dead identity's address,
      // report genuine_conflict otherwise). Until then this is the shipped graceful tail
      // from routes/groups.js:834-847: retry with the synthetic address so a legitimate
      // first-time user still provisions instead of hitting a raw 500. D-13 requires it
      // for tests/routes/groups.test.js:236-252 to stay green when plan 06 routes the
      // join path through here.
      reason = PROVISIONING_REASONS.UNIQUE_EMAIL_COLLISION;
      outcome = PROVISIONING_OUTCOMES.CREATED_SYNTHETIC_AFTER_COLLISION;
      notes.push(PROVISIONING_NOTES.EMAIL_REPAIR_COLLIDED);
      [row, created] = await User.scope('withContactInfo').findOrCreate({
        where: { user_id: sub },
        defaults: { ...defaults, email: syntheticEmailFor(sub) },
      });
    } else {
      throw createFailed;
    }
  }

  if (!created) {
    // We lost the race. Hand the row to the repair rules rather than re-deriving the
    // create-path answer onto a row somebody else already populated.
    return repairExistingRow({
      row, sub, claimBag, rawClaimEmail,
      claimEmailIsPresent, claimEmailIsVerified, picture, auth0,
      notes: [PROVISIONING_NOTES.RACED_TO_EXISTING_ROW],
    });
  }

  // Phase 88-34 (r3 triage #7): log the row ID, never the identity.
  console.log(`[users:provision] auto-created user ${row.id}`);

  // Reporting happens AFTER the row is persisted and never alters the return value
  // (SPEC R4 ordering). Nothing is reported when nothing fell back.
  if (reason) {
    reportProvisioning({ sub, reason, email: emailToPersist, err: fallbackError });
  }

  return {
    status: 'provisioned',
    user: row,
    created: true,
    changed: false,
    outcome,
    reason,
    notes,
  };
}

// ---------------------------------------------------------------------------
// REPAIR path
// ---------------------------------------------------------------------------

async function repairExistingRow({
  row, sub, claimBag, rawClaimEmail, claimEmailIsPresent, claimEmailIsVerified,
  picture, auth0, notes,
}) {
  const changes = {};
  const rejectedAddresses = [rawClaimEmail];
  let reason = null;
  let fallbackError = null;
  let managementUsername = null;

  // -------------------------------------------------------------------------
  // DECISION Phase 88.8 D-36 — THE FIRST RULE, EVALUATED BEFORE EVERY OTHER REPAIR RULE.
  //
  // A non-null `email_changed_at` means the user themselves set that address and proved
  // control of it with a mailed code (plan 09). Overwriting it from an Auth0 claim would
  // silently undo a deliberate user action — on an ordinary self fetch, with no notice
  // and no trace. So the EMAIL arm is skipped entirely for such a row: no compare, no
  // Management call on account of the email, no UPDATE, no Sentry event.
  //
  // And we say NOTHING (D-37). If the person's Google account address later changes, or
  // is taken over and changed, we observe that and stay silent. That is an
  // ACCEPTED-FOREVER record under the milestone-tenet rule — the owner accepted it
  // knowingly as noise not worth a send path — NOT deferred debt.
  //
  // Rejected: (a) repairing anyway and notifying the app address on a claim change —
  // rejected as noise; that is the accepted-forever record above. (b) DISQUALIFIED, not
  // merely rejected: deriving "the user set it" by comparing the stored address against
  // the claim. That comparison cannot distinguish "the user set it" from "the claim
  // changed", which is the ONLY distinction this guard exists to make, and it would
  // refuse to repair exactly the synthetic rows this phase exists to repair.
  //
  // SCOPE THE SKIP PRECISELY — it suppresses the EMAIL arm ONLY. The username repair,
  // the picture_url cadence and every other rule below still run for this row. A user
  // who changed their address has not opted out of getting an avatar.
  //
  // Verified safe at plan time: the Auth0 deletion sweep keys on `sub` ONLY
  // (services/pendingAuth0DeletionSweep.js:120, and :47 records that the email column
  // "serves no further purpose"), so nothing downstream of provisioning depends on
  // Users.email tracking the claim.
  // -------------------------------------------------------------------------
  const emailIsUserSet = row.email_changed_at !== null && row.email_changed_at !== undefined;
  if (emailIsUserSet) {
    notes.push(PROVISIONING_NOTES.EMAIL_REPAIR_SKIPPED_USER_SET);
  }

  const storedEmailIsSynthetic = isSyntheticAddress(row.email);
  const usernameIsGeneric = isGenericUsername(row.username);
  const emailIsRepairable = !emailIsUserSet;

  // --- EMAIL arm, claims half -------------------------------------------------
  if (emailIsRepairable && claimEmailIsPresent) {
    if (claimEmailIsVerified) {
      // Repair whenever the normalised claim differs from the normalised stored value —
      // a synthetic stored value, OR a real one that differs (SPEC Edge Coverage
      // `adjacency / R3`, the verify-after-signup upgrade). Zero Management calls.
      const candidate = normaliseEmail(rawClaimEmail);
      if (candidate !== normaliseEmail(row.email)) {
        changes.email = candidate;
        notes.push(PROVISIONING_NOTES.EMAIL_REPAIRED_FROM_CLAIM);
      }
    } else {
      // Leave the stored address alone. Never overwrite a real stored address with a
      // synthetic one (the plan-01 data-loss fix, commit fb29685, preserved here), and
      // never adopt an unverified address. Zero Management calls.
      //
      // DECISION Phase 88.8 (review round 4): leaving a real-but-UNVERIFIED stored
      // address in place is a deliberate, owner-visible choice, NOT an oversight, and it
      // is backed by plan 05's hygiene class 5. Users.email is an AUTHORIZATION gate,
      // not just contact data — the three invite-acceptance handlers refuse with 403
      // unless user.email.toLowerCase() === invite.invited_email.toLowerCase()
      // (routes/invites.js:593, :664, :757), and routes/groups.js:800-808 states the
      // threat in shipped prose. Meanwhile routes/users.js:216 persisted the raw token
      // email with NO email_verified check on every JIT provision, so the shipped
      // population can already hold addresses their owner never proved control of. This
      // phase fixes that FORWARD only. Repairing such a row automatically was REJECTED —
      // it would overwrite a real address the user may legitimately hold — so it is
      // routed to a human decision via scripts/report-account-hygiene.js class 5 ("email
      // never proved by Auth0"). Deleting that report class without replacing the route
      // to the owner is a decision, not a cleanup: it would re-freeze the population and
      // make it invisible again, while plan 03 simultaneously makes those same addresses
      // more reliably matchable.
      notes.push(PROVISIONING_NOTES.EMAIL_LEFT_CLAIM_UNVERIFIED);
    }
  }

  // --- Management fallback, gated ---------------------------------------------
  // Carried VERBATIM from routes/users.js:433-434: the vendor is consulted only when the
  // stored email is synthetic OR the stored username is generic/blank. A healthy row
  // with an absent claim makes ZERO Management calls and emits nothing.
  //
  // This gate matters for the deploy window plan 14 records: the backend merges BEFORE
  // the Auth0 Action is deployed, and every existing session keeps its claim-less token
  // until expiry — so for that window every self fetch (useSelfIdentity, staleTime:
  // Infinity, once per session plus every invalidate) would otherwise become a
  // synchronous 10-second-timeout vendor call for every healthy user.
  const needsManagementLookup =
    !claimEmailIsPresent && ((storedEmailIsSynthetic && emailIsRepairable) || usernameIsGeneric);

  if (needsManagementLookup) {
    try {
      const auth0User = await auth0.getUserById(sub);
      if (auth0User === null) {
        // DECISION Phase 88.8: on the REPAIR path a null Management result NEVER yields
        // identity_gone. Leave the row untouched, record it in notes, emit NO Sentry
        // event. Chosen OVER returning a 410 here. The rejected alternative would have
        // useSelfIdentity.ts:109-113 sign the user out and tell them their account was
        // deleted while their row, groups and events still exist — and it would do it on
        // an ordinary profile fetch. Today's routes/users.js:443 silently skips this null
        // (`if (auth0User)`); preserving that is the deliberate choice. No capture here
        // either: a per-fetch capture on this row would be the unthrottled hot-path
        // telemetry class, and the R6 hygiene script is the detector for it.
        notes.push(PROVISIONING_NOTES.AUTH0_IDENTITY_GONE);
      } else if (auth0User) {
        const details = auth0.extractUserDetails(auth0User) || {};
        if (typeof details.email === 'string') {
          rejectedAddresses.push(details.email);
        }
        if (emailIsRepairable && storedEmailIsSynthetic && isRealAddress(details.email)) {
          if (details.email_verified === true) {
            const candidate = normaliseEmail(details.email);
            if (candidate !== normaliseEmail(row.email)) {
              changes.email = candidate;
              notes.push(PROVISIONING_NOTES.EMAIL_REPAIRED_FROM_MANAGEMENT);
            }
          } else {
            // The R3 gap this phase closes: routes/users.js:449-451 wrote this address
            // onto the row with no verification check at all, silently undoing the rule
            // the create branch enforces. Not reported — it re-derives the SAME outcome
            // on every fetch, which is the unthrottled-telemetry shape SPEC R4's
            // ordering rule forbids; the R6 hygiene script owns detection.
            notes.push(PROVISIONING_NOTES.EMAIL_LEFT_MANAGEMENT_UNVERIFIED);
          }
        }
        managementUsername = details.username;
      }
    } catch (managementFailed) {
      // A repair was ATTEMPTED and FAILED — that is the one repair-path shape SPEC R4
      // asks to be reported, and it is bounded to unhealthy rows by the gate above.
      reason = PROVISIONING_REASONS.MGMT_API_FAILED;
      fallbackError = managementFailed;
      notes.push(PROVISIONING_NOTES.MANAGEMENT_LOOKUP_FAILED);
    }
  }

  // --- USERNAME arm -----------------------------------------------------------
  // Only when the stored username is the generic literal or blank (unchanged from
  // routes/users.js:435 / :456).
  if (usernameIsGeneric) {
    const repairedUsername = buildProvisionedUsername({
      claims: claimBag,
      rejectedAddresses,
      managementUsername,
      resolvedEmail: changes.email || row.email,
    });
    if (repairedUsername !== GENERIC_USERNAME && repairedUsername !== row.username) {
      changes.username = repairedUsername;
      notes.push(PROVISIONING_NOTES.USERNAME_REPAIRED);
    }
  }

  // --- picture_url arm --------------------------------------------------------
  if (picture !== undefined) {
    const stored = row.picture_url === undefined ? null : row.picture_url;
    // Guarded by inequality so a login that changes nothing issues no UPDATE.
    if (picture !== stored) {
      changes.picture_url = picture;
      notes.push(PROVISIONING_NOTES.PICTURE_URL_UPDATED);
    }
  }

  // --- ONE guarded UPDATE per repair ------------------------------------------
  let changed = false;
  if (Object.keys(changes).length > 0) {
    try {
      await row.update(changes);
      changed = true;
      // Phase 88-34 (r3 triage #7), COMPLETED here: routes/users.js:459 printed
      // `updateData` — a real email address and username — to stdout and into Railway's
      // log retention on every repair. The rule, not the line: a provisioning log may
      // interpolate a row id, a frozen reason/outcome literal, or a pre-computed list of
      // changed FIELD NAMES. Never a field VALUE. Test-pinned by the source scan in
      // tests/services/provisioningService.test.js.
      console.log(`[users:provision] repaired user ${row.id} fields=${Object.keys(changes).sort().join(',')}`);
    } catch (repairFailed) {
      if (isEmailUniqueViolation(repairFailed)) {
        // PLACEHOLDER — plan 05 replaces this with the four SPEC R5 orphan branches.
        // Until then the difference from today is that this REPORTS rather than being
        // swallowed by a console warning (routes/users.js:472-478), so a real user whose
        // address is held by a dead row is at least visible.
        reason = PROVISIONING_REASONS.UNIQUE_EMAIL_COLLISION;
        notes.push(PROVISIONING_NOTES.EMAIL_REPAIR_COLLIDED);
        // The instance holds the rejected values in memory after a failed save; reload
        // so the caller is handed the row as it actually is in the database.
        await row.reload();
      } else {
        throw repairFailed;
      }
    }
  }

  if (reason) {
    reportProvisioning({ sub, reason, email: row.email, err: fallbackError });
  }

  return {
    status: 'provisioned',
    user: row,
    created: false,
    changed,
    outcome: changed ? PROVISIONING_OUTCOMES.REPAIRED : PROVISIONING_OUTCOMES.UNCHANGED,
    reason,
    notes,
  };
}

module.exports = {
  provisionOrRepair,
  PROVISIONING_OUTCOMES,
  PROVISIONING_NOTES,
};
