// scripts/lib/seed-users.js
// quick-261119-nv0: the seed's user table, moved out of scripts/seed-sample-data.js so its
// rules (which sub, which address, which one user may receive texts) can be tested without a
// database (tests/unit/seed-users.test.js).
//
// Dependency-free on purpose: the only require is the guard module, which itself requires
// nothing. tests/scripts/seedSampleData.test.js re-requires the seed under
// jest.isolateModules with the models mocked, and relies on the seed's lib helpers being
// safe to re-evaluate.

const { parseStagingEmailBase } = require('./assert-not-production-db');

// Sample data arrays
// NOTE: user_id should match your Auth0 'sub' claim value
// To get your Auth0 sub: Log in to the app and check browser console
// Or check Auth0 Dashboard > Users > [User] > User ID field
// You can also set these via environment variables:
//   AUTH0_ALICE_SUB, AUTH0_BOB_SUB, etc.
// Alice's fallback sub, used when AUTH0_ALICE_SUB is unset. Named (quick 261103-glx,
// scoped-check WR-02) so the RSVP-link notice at the end can compare the sub Alice was
// actually seeded on against it; exported for the seed's tests.
const ALICE_PLACEHOLDER_SUB = 'auth0|6959f749afc6f7d1e7fb1635';

// One row per seed user, in the order the seed creates them (users[0] is Alice everywhere in
// the seed). `tag` is the local part of the user's default address; it is also the plus tag
// when SEED_EMAIL_BASE is set, and the value SEED_SMS_USER names. `subVariable` is the
// environment variable that overrides the fallback sub.
const SEED_USERS = [
  { tag: 'alice', username: 'Alice', subVariable: 'AUTH0_ALICE_SUB', fallbackSub: ALICE_PLACEHOLDER_SUB },
  { tag: 'bob', username: 'Bob', subVariable: 'AUTH0_BOB_SUB', fallbackSub: 'auth0|695a019d225a2081ca41297b' },
  { tag: 'charlie', username: 'Charlie', subVariable: 'AUTH0_CHARLIE_SUB', fallbackSub: 'auth0|695a0258225a2081ca4129d5' },
  { tag: 'diana', username: 'Diana', subVariable: 'AUTH0_DIANA_SUB', fallbackSub: 'auth0|695a02a92c3ca58370cd94c0' },
  { tag: 'eve', username: 'Eve', subVariable: 'AUTH0_EVE_SUB', fallbackSub: 'auth0|695a02f2f066d9582838c311' },
  { tag: 'frank', username: 'Frank', subVariable: 'AUTH0_FRANK_SUB', fallbackSub: 'auth0|695a0327b7305395a05774dc' },
  // Phase 88.9 round 1b (walk fixtures): a member who owns NO games, with a name
  // long enough to wrap the 375px profile title (walk rows W152 / #29). The
  // local walk signs in as this user for those two captures (the Alice-login
  // runbook's repoint); nothing else references the account. CAUTION (quick
  // 261103-glx): any repoint that moves Alice's sub breaks the RSVP links the seed
  // prints — they carry and are signed over the sub as seeded — so walk the RSVP
  // rows first, or reseed afterwards.
  // The tag is the full first name, and the sub variable is AUTH0_BART_SUB: the two differ on
  // purpose (the variable name predates the tag), so do not "align" them.
  {
    tag: 'bartholomew',
    username: 'Bartholomew Featherstonehaugh-Cholmondeley',
    subVariable: 'AUTH0_BART_SUB',
    fallbackSub: 'auth0|695a0399c0ffee0000000001',
  },
];

const SEED_USER_TAGS = SEED_USERS.map((user) => user.tag);

// The reserved domain every seeded address uses when SEED_EMAIL_BASE is not set (RFC 2606:
// mail to it goes nowhere, so local and CI seeds can never email a real person).
const DEFAULT_SEED_EMAIL_DOMAIN = 'example.com';

// DECISION quick-261119-nv0 E1: every seeded address comes from ONE base address
// (SEED_EMAIL_BASE), with the seed tag as its plus tag. Chosen OVER one variable per user
// (seven variables to keep in step, and one typo sends a reminder to the wrong mailbox) and
// OVER writing the owner's address into this file (this repository is public). With the
// variable unset the addresses are the reserved-domain ones the seed has always written, so
// local development, CI and the e2e job are unchanged. The plus form is exactly what lock 4
// of the staging guard accepts, and cannot drift from it, because both sides read the base
// through the same parseStagingEmailBase (owner ruling S2).
//
// DECISION quick-261119-nv0 E3: the pending group invite follows the base too (tag
// pending-invitee), chosen OVER leaving it on the reserved domain. On staging no seeded
// address then points at a mailbox nobody reads, and accepting or resending the invite lands
// in the owner's own mailbox.
/**
 * The address the seed writes for one tag.
 *
 * @param {string} tag one of SEED_USER_TAGS, or 'pending-invitee'
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] defaults to process.env
 * @returns {string}
 * @throws when SEED_EMAIL_BASE is set but is not one plain address
 */
function seedAddress(tag, env = process.env) {
  const base = parseStagingEmailBase(env && env.SEED_EMAIL_BASE);
  if (!base) return `${tag}@${DEFAULT_SEED_EMAIL_DOMAIN}`;
  return `${base.local}+${tag}@${base.domain}`;
}

// Which seed user, if any, SEED_SMS_USER names. The message never repeats the value: someone
// could paste a phone number into this variable, and the message reaches a log.
function resolveSmsUserTag(env) {
  const raw = env && env.SEED_SMS_USER;
  if (raw === undefined || raw === null) return null;
  const tag = String(raw).trim().toLowerCase();
  if (tag === '') return null;
  if (!SEED_USER_TAGS.includes(tag)) {
    throw new Error(
      'SEED_SMS_USER is set but does not name a seed user. It must be exactly one of: ' +
        `${SEED_USER_TAGS.join(', ')}. Remove it to seed no SMS-entitled user.`
    );
  }
  return tag;
}

// DECISION quick-261119-nv0 E2: sms_enabled is written for exactly ONE seed user, the one
// SEED_SMS_USER names, and false for the other six (all seven false when it is unset), so
// the owner's "does a text arrive" check on staging has one entitled user and no more.
// sms_enabled is otherwise an admin-only flag: routes/users.js ("only the admin flips it via
// direct DB access") and models/User.js ("never written by code") both say so. This is
// consistent with them, not an exception to them: the seed is the admin's fixture tool on a
// disposable database, the same class of writer as the admin's direct DB access, and no
// route or service gains a write here.
// NO phone number is seeded, chosen OVER a phone variable. The owner adds his phone in the
// app, which sends the real verification text and exercises the path real users take, and his
// number never sits in an environment variable. The cost is known and accepted: after each
// reseed he adds and verifies the phone again.
/**
 * The seven seed users as the seed writes them: sub, name, address, and the SMS flag.
 * Reads AUTH0_<NAME>_SUB, SEED_EMAIL_BASE and SEED_SMS_USER from `env`.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] defaults to process.env
 * @returns {{ user_id: string, username: string, email: string, sms_enabled: boolean }[]}
 * @throws when SEED_EMAIL_BASE is malformed or SEED_SMS_USER names no seed user
 */
function buildSampleUsers(env = process.env) {
  const source = env || {};
  const smsTag = resolveSmsUserTag(source);
  return SEED_USERS.map((user) => ({
    user_id: source[user.subVariable] || user.fallbackSub,
    username: user.username,
    email: seedAddress(user.tag, source),
    sms_enabled: user.tag === smsTag,
  }));
}

module.exports = {
  ALICE_PLACEHOLDER_SUB,
  SEED_USER_TAGS,
  seedAddress,
  buildSampleUsers,
};
