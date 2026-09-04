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

// `sequelize` is imported for exactly two things, both in the SPEC R5 collision path:
// the `lower(email)` occupant lookup and the one managed transaction that releases a
// dead identity's address. Nothing else in this service opens a transaction.
const { User, sequelize } = require('../models');
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
//
// The SET is what makes the constraint arm work at all, and it is deliberately a set
// rather than the single name CONTEXT D-15 wrote down before plan 02's index existed.
// What proves the two names are the SAME on the migration-built and the sync-built
// database is not assertion but CI: scripts/ci/schema-drift-diff.js compares UNIQUE
// constraints and indexes BY NAME between the two, with an EMPTY accepted-drift
// allowlist, so a rename on either side is a red `migrate-cli-replay`.
const EMAIL_UNIQUE_CONSTRAINTS = Object.freeze(['Users_email_key', 'users_email_lower_unique']);

// Free-form-but-FROZEN telemetry vocabulary. `outcome` is the one-line summary of what
// the call did; `notes` is the itemised list, because several arms can fire on one call
// (a row can skip the email repair under D-36 while still gaining a username).
const PROVISIONING_OUTCOMES = Object.freeze({
  CREATED_FROM_VERIFIED_CLAIM: 'created_from_verified_claim',
  CREATED_FROM_MANAGEMENT: 'created_from_management',
  CREATED_SYNTHETIC: 'created_synthetic',
  CREATED_SYNTHETIC_AFTER_COLLISION: 'created_synthetic_after_collision',
  // SPEC R5 branch (b) on the CREATE path: the address was held by a row whose Auth0
  // identity is gone, that row was released, and the caller got the real address.
  CREATED_AFTER_ORPHAN_RELEASE: 'created_after_orphan_release',
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
  // The five SPEC R5 collision outcomes. EMAIL_REPAIR_COLLIDED above still fires on
  // every collision ("a collision happened here"); exactly one of these says how it
  // RESOLVED, so the two are not redundant.
  COLLISION_SAME_SUB: 'collision_same_sub',
  COLLISION_ORPHAN_RELEASED: 'collision_orphan_released',
  COLLISION_ALREADY_RELEASED: 'collision_already_released',
  COLLISION_GENUINE_CONFLICT: 'collision_genuine_conflict',
  COLLISION_MANAGEMENT_UNAVAILABLE: 'collision_management_unavailable',
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
 * Whether a `fields` key from a UniqueConstraintError names the email column, in either
 * the plain-column spelling (`email`, from `Users_email_key`) or the index-expression
 * spelling (`lower(email::text)`, from `users_email_lower_unique`).
 */
function isEmailUniqueField(key) {
  if (typeof key !== 'string') {
    return false;
  }
  const normalised = key.replace(/\s+/g, '').toLowerCase();
  return normalised === 'email' || normalised.startsWith('lower(email');
}

/**
 * Whether an error is a violation of EITHER email unique constraint.
 *
 * MEASURED 2026-09-04 against the real database, all five shapes, because the ordering
 * this predicate needs is NOT the one CONTEXT D-15 (as amended) and plan 05's plan text
 * describe. They say `parent.constraint` is the primary discriminator and "the only arm
 * that carries the lower index". That is true for `Model.create` and `instance.update`,
 * and FALSE for `findOrCreate` — which is the call every one of the seven provisioning
 * writers uses:
 *
 *   call form              parent.constraint            fields keys
 *   ---------------------  ---------------------------  ----------------------
 *   findOrCreate / lower   undefined                    ['lower(email::text)']
 *   findOrCreate / exact   undefined                    ['email']
 *   instance.update/lower  'users_email_lower_unique'   ['lower(email::text)']
 *   instance.update/exact  'Users_email_key'            ['email']
 *   create / lower         'users_email_lower_unique'   ['lower(email::text)']
 *
 * findOrCreate sets `options.exception = true` (sequelize/lib/model.js, findOrCreate),
 * which wraps the INSERT in a PL/pgSQL block; the error is then reconstructed from the
 * raised exception's `code` + `detail` only, so `parent` carries `sql, parameters, code,
 * detail` and NO `constraint`. Plan 02 measured a bare `User.create`, which is why the
 * recorded shape is incomplete rather than wrong.
 *
 * So BOTH arms are load-bearing and neither alone is sufficient: the field-KEY arm is
 * what covers findOrCreate, and the constraint-NAME arm is what covers an error whose
 * DETAIL line did not parse into `fields`. Note the field arm must recognise the
 * index-expression key, not just `email` — `err.fields.email` is undefined for the lower
 * index, which is the trap CONTEXT D-15's original one-name predicate fell into.
 *
 * PROMOTED BY PLAN 05 (2026-09-04) from the plan-04 internal `isEmailCollision` to
 * this exported `isEmailCollision`, with the predicate itself UNCHANGED. The rename is
 * the whole promotion: plan 05's plan text asked for the predicate to be re-derived with
 * `parent.constraint` as the "primary discriminator" and `fields.email` as a fast path,
 * and the matrix above is the measurement that says that ordering is wrong for
 * findOrCreate — the call shape all seven provisioning writers use. Re-deriving it would
 * have 500'd a first-time user on a collision, which is the exact failure plan 05 exists
 * to remove. So: promote, do not re-derive.
 *
 * THE ONE THING THAT COULD NOT BE VERIFIED (carried forward from CONTEXT D-15's own
 * UNVERIFIED note, and the reason both arms are kept): whether Postgres always emits the
 * `Key (col)=(val)` DETAIL line for this application's database role. Nothing in the
 * repo can falsify it — both local Postgres instances need passwords that live in files
 * CLAUDE.md forbids reading. What IS proven, from the installed source, is that the
 * no-DETAIL branch exists and what it produces: postgres/query.js `formatError` case
 * '23505' takes a second `return` with NO `fields` argument when the DETAIL line is
 * absent or does not match, and `UniqueConstraintError`'s constructor then makes
 * `this.fields` an EMPTY OBJECT (`options.fields ?? {}`) — not an absent key, which is
 * what plan 05's text said. That shape is unreachable from a real provoked collision, so
 * it is pinned by hand-built errors in tests/unit/provisioningCollision.test.js. An
 * untested fallback arm is decorative.
 *
 * Both reads are optional-chained: this runs inside a catch block, and an error object
 * missing either shape must never make the handler itself throw.
 */
function isEmailCollision(err) {
  if (!err || err.name !== 'SequelizeUniqueConstraintError') {
    return false;
  }
  const constraint = err.parent?.constraint;
  if (typeof constraint === 'string' && EMAIL_UNIQUE_CONSTRAINTS.includes(constraint)) {
    return true;
  }
  const fields = err.fields;
  if (!fields || typeof fields !== 'object') {
    return false;
  }
  return Object.keys(fields).some(isEmailUniqueField);
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
// SPEC R5 — the four collision branches (plan 05)
// ---------------------------------------------------------------------------

// The five outcomes of looking up who is holding a colliding address. Four are SPEC
// R5's (a)-(d); OCCUPANT_VANISHED is the fifth real state — the constraint fired but by
// the time we looked, nobody holds the address any more.
const COLLISION_BRANCHES = Object.freeze({
  SAME_SUB: 'same_sub',                            // (a)
  IDENTITY_GONE: 'identity_gone',                  // (b)
  GENUINE_CONFLICT: 'genuine_conflict',            // (c)
  MANAGEMENT_UNAVAILABLE: 'management_unavailable', // (d)
  OCCUPANT_VANISHED: 'occupant_vanished',
});

// -------------------------------------------------------------------------
// DECISION Phase 88.8 D-15: collision detection is REACTIVE — catch the UNIQUE
// violation, THEN look up the occupant. Chosen OVER a `SELECT ... WHERE email = ?`
// pre-check before the write.
//
// The rejected pre-check is a TOCTOU window: two concurrent FIRST fetches for two
// different subs carrying the same verified address both read "free", both write, and
// one of them 500s anyway — so the pre-check costs a query per login and does not
// remove the case it exists to remove. The UNIQUE constraint is the only atomic
// arbiter of who owns an address, so the constraint firing IS the detector.
//
// And DECISION Phase 88.8 D-15 (second half): branch (d) FAILS SAFE — when the
// Management API cannot confirm the occupant's identity is gone, the address is NOT
// released. Chosen OVER optimistically releasing it. Releasing on a guess would take a
// LIVE user's address away and hand it to a different account; `Users.email` is an
// AUTHORIZATION gate here, not just contact data (routes/invites.js:593/:664/:757
// accept an invite only when the addresses match), so a wrong release is a
// cross-account grant, not an inconvenience. The cost of failing safe is that a real
// user keeps a synthetic address until the vendor answers again, and the R6 hygiene
// script is what makes that visible. Both halves are decisions, not cleanups.
//
// NOT A CONTRADICTION of the three-way claims-first rule above: that rule is about the
// CALLER's own identity, which their token already answered. This lookup asks about a
// DIFFERENT row's identity, which no token can answer, and it runs only after a
// collision — never on the ordinary login path.
// -------------------------------------------------------------------------

/**
 * Who holds `collidingEmail`, and is their Auth0 identity still alive?
 *
 * Looked up case-INSENSITIVELY (`lower(email)`), because the violation may have come
 * from either constraint and `users_email_lower_unique` matches rows an `=` compare
 * would miss. Same rule as the writer half (normaliseEmail) and the reader half
 * (routes/friendships.js:210).
 *
 * Exported for tests: branch (a) is unreachable end-to-end (see resolveRepairCollision).
 *
 * @returns {Promise<{ branch: string, occupant: object|null, error: Error|null }>}
 */
async function classifyEmailCollision({ sub, collidingEmail, auth0 }) {
  const normalised = normaliseEmail(collidingEmail);
  if (!normalised) {
    return { branch: COLLISION_BRANCHES.OCCUPANT_VANISHED, occupant: null, error: null };
  }

  // Scoped `withContactInfo`: the default scope EXCLUDES `email`, so a default-scope
  // read returns an instance whose `email` is undefined — the exact defect
  // routes/users.js:304-315 records, and it would make every comparison below false.
  const occupant = await User.scope('withContactInfo').findOne({
    where: sequelize.where(sequelize.fn('lower', sequelize.col('email')), normalised),
  });

  if (!occupant) {
    return { branch: COLLISION_BRANCHES.OCCUPANT_VANISHED, occupant: null, error: null };
  }
  if (occupant.user_id === sub) {
    // (a) It is us. Never ask the vendor about our own identity here.
    return { branch: COLLISION_BRANCHES.SAME_SUB, occupant, error: null };
  }

  try {
    const identity = await auth0.getUserById(occupant.user_id);
    // services/auth0Service.js:194-196 returns null ONLY on a hard 404 — the identity
    // is GONE. Anything else means it exists.
    return {
      branch: identity === null ? COLLISION_BRANCHES.IDENTITY_GONE : COLLISION_BRANCHES.GENUINE_CONFLICT,
      occupant,
      error: null,
    };
  } catch (lookupFailed) {
    // (d) We cannot tell (b) from (c). Fail safe.
    return { branch: COLLISION_BRANCHES.MANAGEMENT_UNAVAILABLE, occupant, error: lookupFailed };
  }
}

/**
 * Branch (b): release a dead identity's address and complete the real user's work in
 * ONE transaction, so the address is never briefly unowned for a third writer.
 *
 * Locking idiom copied from services/accountDeletionService.js:117-141 /:596-607: take
 * `FOR UPDATE` on the row we are about to mutate and hold it for the rest of the
 * transaction.
 *
 * THE IN-LOCK RE-READ, and why it is NOT the pre-check D-15 forbids: the identity-gone
 * decision above was taken on an UNLOCKED read, and two requests for the same caller can
 * both reach it before either commits (plan 04's concurrency backstop fires two
 * provisionOrRepair calls for one sub, and the frontend self-fetch has several mount
 * points). So we re-read the occupant UNDER THE LOCK and abort if it no longer holds the
 * address. D-15 forbids a SELECT taken BEFORE the constraint fires, as a substitute for
 * it; this is a re-check AFTER it fired, with the row locked. Different thing, opposite
 * direction.
 *
 * @param {{ occupantId: string, collidingEmail: string,
 *           complete: (t: import('sequelize').Transaction) => Promise<any> }} args
 * @returns {Promise<{ released: boolean, completed: any }>}
 */
async function releaseOrphanAndComplete({ occupantId, collidingEmail, complete }) {
  return sequelize.transaction(async (t) => {
    const locked = await User.scope('withContactInfo').findOne({
      where: { id: occupantId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!locked || normaliseEmail(locked.email) !== normaliseEmail(collidingEmail)) {
      // Another request released it first (or it moved). Do not release twice.
      return { released: false, completed: null };
    }

    await locked.update(
      {
        // ITS OWN synthetic address, built by the same helper every other mint uses —
        // never a random value, so the row stays identifiable and idempotent.
        email: syntheticEmailFor(locked.user_id),
        orphaned_at: new Date(),
        // DECISION Phase 88.8 D-36 (the 2026-09-03 replan's seam): the release CLEARS
        // email_changed_at in the same UPDATE. Chosen OVER leaving it set and treating
        // the row as user-owned.
        //
        // After SPEC A12 the address we are overwriting may be one the USER set
        // themselves (plan 09), in which case this marker is non-null. Leaving it set
        // would assert "the user chose this address" about a <sub>@auth0.local value
        // nobody chose — and plan 04's repair guard READS this marker to decide whether
        // it may repair a row at all (see the D-36 block in repairExistingRow), so the
        // row would become permanently unrepairable and would sit in the R6 hygiene
        // report's synthetic class forever with no path out.
        //
        // This is not a policy claim about the user's intent; it is keeping the marker's
        // meaning TRUE. The occupant is by definition a row whose Auth0 identity is
        // gone, so nobody can sign in to object.
        email_changed_at: null,
      },
      { transaction: t }
    );

    // TOUCH NOTHING ELSE. SPEC R5's prohibition and the owner's ruling are "release the
    // address, keep the data": no group, event, membership, participation or friendship
    // row may be deleted, archived or reassigned. This service references none of those
    // models at all, which is the strongest form of that guarantee, and a source scan in
    // tests/services/provisioningService.test.js asserts it.
    const completed = await complete(t);
    return { released: true, completed };
  });
}

/**
 * The collision resolver for the REPAIR path. Returns what the caller should report;
 * it never throws for a collision it understands.
 *
 * Exported for tests. Branch (a) cannot be reached end-to-end: `Users.user_id` is
 * unique, so a repair UPDATE cannot collide with the caller's OWN row (Postgres does
 * not raise 23505 when a row keeps or re-takes its own key). It is a defensive outcome
 * of the occupant lookup, reachable only if the database moves under us — and the
 * honest way to test it is the real classifier against real rows, not a fabricated
 * 23505 that would encode the assumption under test.
 *
 * @returns {Promise<{ reason: string|null, changed: boolean }>}
 */
async function resolveRepairCollision({ row, sub, changes, auth0, notes }) {
  const collidingEmail = changes.email;

  // Defensive: a unique-email violation on an UPDATE that carried no email change is a
  // collision we did not cause and cannot resolve. Report it rather than guessing.
  if (!collidingEmail) {
    await row.reload();
    notes.push(PROVISIONING_NOTES.COLLISION_GENUINE_CONFLICT);
    return { reason: PROVISIONING_REASONS.GENUINE_CONFLICT, changed: false };
  }

  // Retry the repair once — used when the address turns out to be free after all.
  const retryOnce = async () => {
    try {
      await row.reload();
      await row.update(changes);
      notes.push(PROVISIONING_NOTES.COLLISION_ALREADY_RELEASED);
      return { reason: null, changed: true };
    } catch (retryFailed) {
      if (!isEmailCollision(retryFailed)) {
        throw retryFailed;
      }
      await row.reload();
      notes.push(PROVISIONING_NOTES.COLLISION_GENUINE_CONFLICT);
      return { reason: PROVISIONING_REASONS.GENUINE_CONFLICT, changed: false };
    }
  };

  const { branch, occupant, error } = await classifyEmailCollision({ sub, collidingEmail, auth0 });

  if (branch === COLLISION_BRANCHES.SAME_SUB) {
    // (a) Nothing to resolve. No write, no report — nothing fell back.
    await row.reload();
    notes.push(PROVISIONING_NOTES.COLLISION_SAME_SUB);
    return { reason: null, changed: false };
  }

  if (branch === COLLISION_BRANCHES.OCCUPANT_VANISHED) {
    return retryOnce();
  }

  if (branch === COLLISION_BRANCHES.IDENTITY_GONE) {
    try {
      const { released } = await releaseOrphanAndComplete({
        occupantId: occupant.id,
        collidingEmail,
        complete: async (t) => {
          // Re-read inside the transaction so Sequelize issues a real UPDATE rather
          // than reasoning from the in-memory values the failed save left behind.
          await row.reload({ transaction: t });
          await row.update(changes, { transaction: t });
        },
      });

      if (released) {
        notes.push(PROVISIONING_NOTES.COLLISION_ORPHAN_RELEASED);
        return { reason: PROVISIONING_REASONS.ORPHAN_RELEASED, changed: true };
      }

      // Someone else released it first. If they also completed OUR repair (the two
      // concurrent callers case), we are done and there is nothing to report — a second
      // orphan_released event would double-count one release.
      await row.reload();
      if (normaliseEmail(row.email) === normaliseEmail(collidingEmail)) {
        notes.push(PROVISIONING_NOTES.COLLISION_ALREADY_RELEASED);
        return { reason: null, changed: false };
      }
      return retryOnce();
    } catch (releaseFailed) {
      if (!isEmailCollision(releaseFailed)) {
        throw releaseFailed;
      }
      // A collision raised INSIDE the collision handler must never become a 500. Treat
      // it exactly as branch (c): both rows keep what they have.
      await row.reload();
      notes.push(PROVISIONING_NOTES.COLLISION_GENUINE_CONFLICT);
      return { reason: PROVISIONING_REASONS.GENUINE_CONFLICT, changed: false };
    }
  }

  // (c) and (d): both rows untouched, the caller keeps what it has.
  await row.reload();
  if (branch === COLLISION_BRANCHES.MANAGEMENT_UNAVAILABLE) {
    notes.push(PROVISIONING_NOTES.COLLISION_MANAGEMENT_UNAVAILABLE);
    return { reason: PROVISIONING_REASONS.MGMT_API_FAILED, changed: false, error };
  }
  notes.push(PROVISIONING_NOTES.COLLISION_GENUINE_CONFLICT);
  return { reason: PROVISIONING_REASONS.GENUINE_CONFLICT, changed: false };
}

/**
 * The same four branches on the CREATE path.
 *
 * The tail after (c) and (d) is today's SHIPPED graceful behaviour
 * (routes/groups.js:834-847, pinned by tests/routes/groups.test.js:236-252): retry with
 * the synthetic address so a legitimate first-time user still gets an account. It must
 * stay observable even before plan 06 rewires that route.
 *
 * @returns {Promise<{ row: object, created: boolean, reason: string|null,
 *                     outcome: string|null, error: Error|null }>}
 *   `outcome: null` means "the caller's original outcome still stands".
 */
async function resolveCreateCollision({ sub, defaults, collidingEmail, auth0, notes }) {
  const withRealAddress = async () => {
    const [r, c] = await User.scope('withContactInfo').findOrCreate({
      where: { user_id: sub },
      defaults,
    });
    return { row: r, created: c };
  };

  const syntheticTail = async (reason, error) => {
    const [r, c] = await User.scope('withContactInfo').findOrCreate({
      where: { user_id: sub },
      defaults: { ...defaults, email: syntheticEmailFor(sub) },
    });
    return {
      row: r,
      created: c,
      reason,
      outcome: PROVISIONING_OUTCOMES.CREATED_SYNTHETIC_AFTER_COLLISION,
      error: error || null,
    };
  };

  const retryOnce = async () => {
    try {
      const { row, created } = await withRealAddress();
      notes.push(PROVISIONING_NOTES.COLLISION_ALREADY_RELEASED);
      return { row, created, reason: null, outcome: null, error: null };
    } catch (retryFailed) {
      if (!isEmailCollision(retryFailed)) {
        throw retryFailed;
      }
      notes.push(PROVISIONING_NOTES.COLLISION_GENUINE_CONFLICT);
      return syntheticTail(PROVISIONING_REASONS.GENUINE_CONFLICT);
    }
  };

  const { branch, occupant, error } = await classifyEmailCollision({ sub, collidingEmail, auth0 });

  // (a) on the create path means a row for this sub appeared between the concurrency
  // backstop's re-find and here. There is nothing to release — take the address if it
  // is free, and let the !created path hand the row to the repair rules.
  if (branch === COLLISION_BRANCHES.SAME_SUB || branch === COLLISION_BRANCHES.OCCUPANT_VANISHED) {
    return retryOnce();
  }

  if (branch === COLLISION_BRANCHES.IDENTITY_GONE) {
    try {
      const { released, completed } = await releaseOrphanAndComplete({
        occupantId: occupant.id,
        collidingEmail,
        complete: async (t) =>
          User.scope('withContactInfo').findOrCreate({
            where: { user_id: sub },
            defaults,
            transaction: t,
          }),
      });

      if (released) {
        const [r, c] = completed;
        notes.push(PROVISIONING_NOTES.COLLISION_ORPHAN_RELEASED);
        return {
          row: r,
          created: c,
          reason: PROVISIONING_REASONS.ORPHAN_RELEASED,
          outcome: PROVISIONING_OUTCOMES.CREATED_AFTER_ORPHAN_RELEASE,
          error: null,
        };
      }
      return retryOnce();
    } catch (releaseFailed) {
      if (!isEmailCollision(releaseFailed)) {
        throw releaseFailed;
      }
      notes.push(PROVISIONING_NOTES.COLLISION_GENUINE_CONFLICT);
      return syntheticTail(PROVISIONING_REASONS.GENUINE_CONFLICT);
    }
  }

  if (branch === COLLISION_BRANCHES.MANAGEMENT_UNAVAILABLE) {
    notes.push(PROVISIONING_NOTES.COLLISION_MANAGEMENT_UNAVAILABLE);
    return syntheticTail(PROVISIONING_REASONS.MGMT_API_FAILED, error);
  }
  notes.push(PROVISIONING_NOTES.COLLISION_GENUINE_CONFLICT);
  return syntheticTail(PROVISIONING_REASONS.GENUINE_CONFLICT);
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
    } else if (isEmailCollision(createFailed)) {
      // SPEC R5, all four branches (plan 05). The address we tried to take is
      // `emailToPersist`; who holds it decides what happens next.
      notes.push(PROVISIONING_NOTES.EMAIL_REPAIR_COLLIDED);
      const resolved = await resolveCreateCollision({
        sub, defaults, collidingEmail: emailToPersist, auth0, notes,
      });
      row = resolved.row;
      created = resolved.created;
      reason = resolved.reason;
      // null means "the outcome computed above still stands" (the retry took the real
      // address, so nothing fell back).
      outcome = resolved.outcome || outcome;
      fallbackError = resolved.error || fallbackError;
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
      if (isEmailCollision(repairFailed)) {
        // SPEC R5, all four branches (plan 05). Before this, routes/users.js:472-478
        // swallowed this in a console warning, so a real user whose address was held by
        // a dead row kept the synthetic address forever with no signal anywhere.
        //
        // Every arm below reloads the row: the instance holds the REJECTED values in
        // memory after a failed save, so the caller must never be handed it unreloaded.
        notes.push(PROVISIONING_NOTES.EMAIL_REPAIR_COLLIDED);
        const resolved = await resolveRepairCollision({ row, sub, changes, auth0, notes });
        reason = resolved.reason;
        changed = resolved.changed;
        fallbackError = resolved.error || fallbackError;
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
  // The PUBLIC collision predicate (plan 05 promoted it from plan 04's internal
  // `isEmailUniqueViolation` without changing a line of its logic — see the measured
  // matrix on the function). Pinned by the shape matrix in
  // tests/services/provisioningService.test.js and by the no-DETAIL fallback cases in
  // tests/unit/provisioningCollision.test.js.
  isEmailCollision,
  EMAIL_UNIQUE_CONSTRAINTS,
  // The broad at-auth0 guard, exported so scripts/report-account-hygiene.js's class 1
  // asks the SAME question the provisioner asks rather than carrying a tenth copy of a
  // predicate that already exists at nine sites. If this guard is ever narrowed (see
  // DECISION Phase 88.2 NIX-AUTH0 on the function), the report narrows with it, which is
  // the point — a report keyed on a different definition of "synthetic" than the writer
  // would list rows the writer does not consider synthetic, and miss ones it does.
  isSyntheticAddress,
  // Exported for tests ONLY. Branch (a) of SPEC R5 is unreachable end-to-end under the
  // one-row-per-sub invariant (see the resolveRepairCollision header), so the only
  // honest way to pin it is to call the resolver against real rows. No production
  // caller outside this file may use either of these — the entry point is
  // provisionOrRepair.
  resolveRepairCollision,
  classifyEmailCollision,
  COLLISION_BRANCHES,
  PROVISIONING_OUTCOMES,
  PROVISIONING_NOTES,
};
