// tests/routes/users.emailChange.test.js
// -----------------------------------------------------------------------------
// Phase 88.8 plan 09 — the five self-only email-change routes.
//
// SPEC A12 / CONTEXT D-35: the NEW address is held ONLY on the token row and is
// never written into `Users.email` until a code mailed to it is typed back by
// the signed-in account holder. `Users.email` is the identity column: FOUR
// `invited_email` authorization sites (routes/invites.js:512-518, :593, :664,
// :757) and friend search (routes/friendships.js:146) all key on it.
//
// WHICH MAIL IS WHICH — no assertion in this file uses a bare call count:
//   CODE   (emailService.sendEmailChangeCode)  -> the NEW address, synchronous,
//                                                 surfaced as `verification_sent`
//   NOTICE (emailNoticeQueue.add)              -> the PRIOR address, queued,
//                                                 NEVER surfaced (D-40)
//
// THE MAIL MOCK'S RESOLVED VALUE IS EXPLICIT IN EVERY CASE, NEVER INHERITED.
// services/emailService.js:11-20 no-ops without RESEND_API_KEY and :45-47 returns
// `{ success: false }` rather than throwing, so the DEFAULT behaviour in any
// environment without a mail key is REFUSAL — and a refused row is excluded from
// the hourly count by `send_failed_at`. A cap or concurrency assertion written
// against the default therefore passes while the control does nothing.
// -----------------------------------------------------------------------------

// The route reports collisions, refused code mails and the D-41 gate skip through
// the shipped try-require Sentry idiom. Mock the module so those events are
// observable; addBreadcrumb is included because the timezone-backfill path in
// GET /:user_id calls it.
jest.mock('@sentry/node', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
}));

// The A13 notice lane. The manual mock at queues/__mocks__/index.js gives every
// queue a jest.fn `.add`, so the ENQUEUED JOB PAYLOAD is assertable without Redis.
jest.mock('../../queues');

// GET /:user_id delegates to the provisioning service, which reaches for the Auth0
// Management API on some arms. Simulate the not-configured behaviour (THROW) so no
// real network call fires — same stub shape tests/routes/users.test.js uses.
jest.mock('../../services/auth0Service', () => ({
  getUserById: jest.fn().mockRejectedValue(new Error('Auth0 Management API credentials not configured')),
  searchUsersByEmail: jest.fn().mockResolvedValue([]),
  extractUserDetails: jest.fn(() => ({ email: null, username: null, user_id: null })),
}));

const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const { Op } = require('sequelize');

const Sentry = require('@sentry/node');
const { emailNoticeQueue } = require('../../queues');
const emailService = require('../../services/emailService');
const userRoutes = require('../../routes/users');
const { stubAuth } = require('../helpers/authStub');
const {
  User,
  Group,
  UserGroup,
  GroupInvite,
  SingleUseToken,
  Feedback,
} = require('../../models');

const PURPOSE = 'email_change_verify';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeApp(user) {
  const a = express();
  a.use(express.json());
  a.use(stubAuth(user));
  a.use('/api/users', userRoutes);
  return a;
}

/** The default actor: sub-shaped param, a verified claim equal to the stored address. */
function actorFor(row, overrides = {}) {
  return {
    user_id: row.user_id,
    email: row.email,
    email_verified: true,
    ...overrides,
  };
}

let userSeq = 0;
async function seedUser(attrs = {}) {
  userSeq += 1;
  return User.create({
    user_id: attrs.user_id || `auth0|ec-${userSeq}`,
    username: attrs.username || `ecuser${userSeq}`,
    email: attrs.email || `ec${userSeq}@example.com`,
    email_changed_at: attrs.email_changed_at !== undefined ? attrs.email_changed_at : null,
  });
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Every code the CODE mail mock was handed, in call order. */
function sentCodes() {
  return emailService.sendEmailChangeCode.mock.calls.map(([, code]) => code);
}
function sentRecipients() {
  return emailService.sendEmailChangeCode.mock.calls.map(([address]) => address);
}

/** Mock the CODE mail to SUCCEED. State this in every describe that needs it. */
function mailSucceeds() {
  emailService.sendEmailChangeCode.mockResolvedValue({ success: true, id: 'mail-1' });
}
/** Mock the CODE mail to be REFUSED by the provider (the shipped no-key shape). */
function mailRefused() {
  emailService.sendEmailChangeCode.mockResolvedValue({ success: false, error: 'refused' });
}

async function tokensFor(sub) {
  return SingleUseToken.findAll({
    where: { purpose: PURPOSE, user_id: sub },
    order: [['createdAt', 'ASC']],
  });
}

beforeEach(async () => {
  jest.restoreAllMocks();
  Sentry.captureException.mockClear();
  Sentry.captureMessage.mockClear();
  emailNoticeQueue.add.mockClear();
  emailNoticeQueue.add.mockResolvedValue({ id: 'notice-job' });
  // Never reach the real provider. The resolved value is set PER DESCRIBE below.
  jest.spyOn(emailService, 'sendEmailChangeCode').mockResolvedValue({ success: false });
  jest.spyOn(emailService, 'sendEmailChangeNotice').mockResolvedValue({ success: true });
});

// ===========================================================================
// TASK 1 — request, resend, cancel
// ===========================================================================

describe('POST /api/users/:user_id/email — request a change (code mail SUCCEEDS)', () => {
  beforeEach(() => mailSucceeds());

  it('mints a code row for the normalised NEW address and mails the code to THAT address', async () => {
    const row = await seedUser({ email: 'old@example.com' });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: '  NEW@Example.COM ' })
      .expect(200);

    expect(res.body.outcome).toBe('code_sent');
    expect(res.body.verification_sent).toBe(true);
    expect(res.body.email).toBe('old@example.com');
    expect(res.body.pending_email_change).toMatchObject({ address: 'new@example.com' });
    expect(res.body.pending_email_change.expires_at).toBeTruthy();
    expect(res.body).toHaveProperty('email_changed_at', null);

    const tokens = await tokensFor(row.user_id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].target).toBe('new@example.com');
    expect(tokens[0].status).toBe('active');

    // The RECIPIENT is what matters — a bare call count would pass if the code
    // went to the wrong inbox.
    expect(sentRecipients()).toEqual(['new@example.com']);
  });

  it('leaves Users.email BYTE-UNCHANGED — re-read from the database, never inferred', async () => {
    const row = await seedUser({ email: 'old@example.com' });

    await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'new@example.com' })
      .expect(200);

    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('old@example.com');
    expect(after.email_changed_at).toBeNull();
  });

  it('stores sha256(code) in nonce, the normalised address in target, and a 30-minute expiry', async () => {
    const row = await seedUser();

    await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'target@example.com' })
      .expect(200);

    const [token] = await tokensFor(row.user_id);
    const code = sentCodes()[0];
    expect(token.nonce).not.toBe(code);
    expect(token.nonce).toBe(sha256(code.replace(/[\s-]/g, '').toUpperCase()));
    expect(token.target).toBe('target@example.com');
    const ttlMs = new Date(token.expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(28 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);
  });

  it('requesting a SECOND address revokes the first code row', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));

    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'first@example.com' }).expect(200);
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'second@example.com' }).expect(200);

    const tokens = await tokensFor(row.user_id);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].status).toBe('revoked');
    expect(tokens[1].status).toBe('active');
    expect(tokens[1].target).toBe('second@example.com');
  });

  it('requesting the address the user ALREADY has (case-insensitively, trimmed) returns unchanged and mints nothing', async () => {
    const row = await seedUser({ email: 'same@example.com' });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: '  SAME@Example.com  ' })
      .expect(200);

    expect(res.body.outcome).toBe('unchanged');
    expect(res.body.verification_sent).toBe(false);
    expect(await tokensFor(row.user_id)).toHaveLength(0);
    expect(emailService.sendEmailChangeCode).not.toHaveBeenCalled();
  });

  it('unchanged leaves an EXISTING pending change untouched', async () => {
    const row = await seedUser({ email: 'same@example.com' });
    const app = makeApp(actorFor(row));

    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'pending@example.com' }).expect(200);
    const res = await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'same@example.com' }).expect(200);

    expect(res.body.outcome).toBe('unchanged');
    expect(res.body.pending_email_change).toMatchObject({ address: 'pending@example.com' });
    const tokens = await tokensFor(row.user_id);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('active');
  });

  it('the path parameter may be the caller\'s Users.id UUID — the case that discriminates the scoped load from a req.selfUser memo reuse', async () => {
    const row = await seedUser({ email: 'uuid@example.com' });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.id}/email`)
      .send({ email: 'moved@example.com' })
      .expect(200);

    // A memo reuse would compare against a DEFAULT-scope row whose `email` is
    // undefined, so `email` would be missing from the body and the address
    // compare would run against undefined.
    expect(res.body.outcome).toBe('code_sent');
    expect(res.body.email).toBe('uuid@example.com');
    expect(res.body.pending_email_change).toMatchObject({ address: 'moved@example.com' });
  });
});

describe('POST /api/users/:user_id/email — refusals (nothing is stored)', () => {
  beforeEach(() => mailSucceeds());

  const badBodies = [
    ['a malformed address', { email: 'not-an-address' }],
    ['an address over the column length', { email: `${'a'.repeat(250)}@example.com` }],
    ['a missing body', {}],
    ['a plausible WRONG KEY', { email_address: 'new@example.com' }],
    ['a non-string address', { email: 42 }],
    ['an extra key alongside the right one', { email: 'new@example.com', pending: true }],
  ];

  it.each(badBodies)('%s returns the validation envelope and stores nothing', async (_label, body) => {
    const row = await seedUser();

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send(body)
      .expect(400);

    expect(res.body.code).toBe('validation');
    expect(await tokensFor(row.user_id)).toHaveLength(0);
    expect(emailService.sendEmailChangeCode).not.toHaveBeenCalled();
  });

  it('another user\'s sub in the path is refused before any read or write', async () => {
    const mine = await seedUser();
    const theirs = await seedUser();

    await request(makeApp(actorFor(mine)))
      .post(`/api/users/${theirs.user_id}/email`)
      .send({ email: 'attack@example.com' })
      .expect(403);

    expect(await tokensFor(mine.user_id)).toHaveLength(0);
    expect(await tokensFor(theirs.user_id)).toHaveLength(0);
    expect(emailService.sendEmailChangeCode).not.toHaveBeenCalled();
  });
});

describe('D-10 hourly cap — proved in BOTH directions', () => {
  it('THREE SUCCESSFUL SENDS refuse the fourth request with the 429 envelope and send no mail', async () => {
    mailSucceeds();
    const row = await seedUser();
    const app = makeApp(actorFor(row));

    for (let i = 0; i < 3; i += 1) {
      await request(app).post(`/api/users/${row.user_id}/email`).send({ email: `cap${i}@example.com` }).expect(200);
    }
    expect(emailService.sendEmailChangeCode).toHaveBeenCalledTimes(3);

    const res = await request(app)
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'cap3@example.com' })
      .expect(429);

    expect(res.body.code).toBe('rate_limited');
    expect(emailService.sendEmailChangeCode).toHaveBeenCalledTimes(3);
    expect(await tokensFor(row.user_id)).toHaveLength(3);
  });

  it('THE MIRROR: three PROVIDER-REFUSED sends do NOT trip the cap — send_failed_at excludes them', async () => {
    mailRefused();
    const row = await seedUser();
    const app = makeApp(actorFor(row));

    for (let i = 0; i < 3; i += 1) {
      await request(app).post(`/api/users/${row.user_id}/email`).send({ email: `ref${i}@example.com` }).expect(200);
    }

    const fourth = await request(app)
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'ref3@example.com' })
      .expect(200);

    expect(fourth.body.outcome).toBe('code_sent');
    const tokens = await tokensFor(row.user_id);
    expect(tokens).toHaveLength(4);
    expect(tokens.slice(0, 3).every((t) => t.send_failed_at !== null)).toBe(true);
  });

  it('the cap is a DATABASE count, so a row seeded outside the process still counts', async () => {
    mailSucceeds();
    const row = await seedUser();
    for (let i = 0; i < 3; i += 1) {
      await SingleUseToken.create({
        nonce: `seeded-nonce-${i}-${Date.now()}`,
        user_id: row.user_id,
        purpose: PURPOSE,
        target: `seeded${i}@example.com`,
        status: 'revoked',
        expires_at: new Date(Date.now() + 60000),
      });
    }

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'after@example.com' })
      .expect(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('CONCURRENCY: five requests fired without awaiting produce exactly three token rows and exactly three CODE mails', async () => {
    mailSucceeds();
    const row = await seedUser();
    const app = makeApp(actorFor(row));

    const flights = [0, 1, 2, 3, 4].map((i) =>
      request(app).post(`/api/users/${row.user_id}/email`).send({ email: `burst${i}@example.com` })
    );
    const results = await Promise.all(flights);

    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    expect(await tokensFor(row.user_id)).toHaveLength(3);
    expect(emailService.sendEmailChangeCode).toHaveBeenCalledTimes(3);
  });
});

describe('a PROVIDER-REFUSED code mail keeps its token (owner ruling 2026-09-04)', () => {
  beforeEach(() => mailRefused());

  it('answers 200 code_sent with verification_sent false and a POPULATED pending change', async () => {
    const row = await seedUser();

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'refused@example.com' })
      .expect(200);

    expect(res.body.outcome).toBe('code_sent');
    expect(res.body.verification_sent).toBe(false);
    expect(res.body.pending_email_change).toMatchObject({ address: 'refused@example.com' });
  });

  it('the token row SURVIVES, stays active, keeps target and nonce, and gains send_failed_at', async () => {
    const row = await seedUser();

    await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'refused@example.com' })
      .expect(200);

    const [token] = await tokensFor(row.user_id);
    expect(token).toBeTruthy();
    expect(token.status).toBe('active');
    expect(token.target).toBe('refused@example.com');
    expect(token.nonce).toBeTruthy();
    expect(token.send_failed_at).not.toBeNull();
  });

  it('reports ONE Sentry event tagged email-change/code-mail carrying the DOMAIN and not the local part', async () => {
    const row = await seedUser();

    await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email`)
      .send({ email: 'secretlocalpart@refused-domain.test' })
      .expect(200);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, context] = Sentry.captureException.mock.calls[0];
    expect(context.tags).toMatchObject({ feature: 'email-change', op: 'code-mail' });
    const payload = JSON.stringify(context);
    expect(payload).toContain('refused-domain.test');
    expect(payload).not.toContain('secretlocalpart');
    expect(payload).toContain(row.user_id);
  });

  it('after a refused send the row is STILL a live pending change (active AND unexpired)', async () => {
    // The WIRE half of this acceptance criterion — that the self READ hydrates it —
    // is asserted in the Task 3 block below, which is where toSelfWire gains the
    // key. This asserts the same fact at the layer this task owns: the live-pending
    // predicate (active + unexpired, and deliberately NO send_failed_at clause)
    // still matches the refused row.
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'refused@example.com' }).expect(200);

    const live = await SingleUseToken.findOne({
      where: {
        purpose: PURPOSE,
        user_id: row.user_id,
        status: 'active',
        expires_at: { [Op.gt]: new Date() },
      },
    });
    expect(live).toBeTruthy();
    expect(live.target).toBe('refused@example.com');
    expect(live.send_failed_at).not.toBeNull();
  });

  it('after a refused send RESEND still finds the row and re-sends for its stored target', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'refused@example.com' }).expect(200);

    emailService.sendEmailChangeCode.mockClear();
    mailSucceeds();

    const res = await request(app).post(`/api/users/${row.user_id}/email/resend`).send().expect(200);
    expect(res.body.outcome).toBe('code_sent');
    expect(sentRecipients()).toEqual(['refused@example.com']);
  });

  it('a refused send followed by a SUCCESSFUL resend leaves exactly ONE active row and consumes ONE budget unit', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'refused@example.com' }).expect(200);

    mailSucceeds();
    await request(app).post(`/api/users/${row.user_id}/email/resend`).send().expect(200);

    const tokens = await tokensFor(row.user_id);
    expect(tokens).toHaveLength(2);
    expect(tokens.filter((t) => t.status === 'active')).toHaveLength(1);
    // Exactly one row counts: the refused one carries send_failed_at.
    const counted = tokens.filter((t) => t.send_failed_at === null);
    expect(counted).toHaveLength(1);
  });
});

describe('POST /api/users/:user_id/email/resend (SPEC A11 / DR-F)', () => {
  beforeEach(() => mailSucceeds());

  it('re-mints and re-sends for the CURRENTLY PENDING address and takes no body', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'pending@example.com' }).expect(200);
    emailService.sendEmailChangeCode.mockClear();

    const res = await request(app)
      .post(`/api/users/${row.user_id}/email/resend`)
      // A body carrying an address must be IGNORED — a separate route cannot take
      // an address by construction.
      .send({ email: 'attacker@evil.test' })
      .expect(200);

    expect(res.body.outcome).toBe('code_sent');
    expect(res.body.pending_email_change).toMatchObject({ address: 'pending@example.com' });
    expect(sentRecipients()).toEqual(['pending@example.com']);
  });

  it('an EXPIRED-but-active row IS re-mintable — the predicate carries no expires_at clause (DR-F)', async () => {
    const row = await seedUser();
    await SingleUseToken.create({
      nonce: `expired-${Date.now()}`,
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'expired-pending@example.com',
      status: 'active',
      expires_at: new Date(Date.now() - 60 * 1000),
    });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/resend`)
      .send()
      .expect(200);

    expect(res.body.outcome).toBe('code_sent');
    expect(sentRecipients()).toEqual(['expired-pending@example.com']);
    const active = (await tokensFor(row.user_id)).filter((t) => t.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].target).toBe('expired-pending@example.com');
    expect(new Date(active[0].expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('a REVOKED row is NOT re-mintable — after a cancel, resend returns the validation envelope', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'discarded@example.com' }).expect(200);
    await request(app).post(`/api/users/${row.user_id}/email/cancel`).send().expect(200);

    const res = await request(app).post(`/api/users/${row.user_id}/email/resend`).send().expect(400);
    expect(res.body.code).toBe('validation');
  });

  it('a CONSUMED (used) row is NOT re-mintable either', async () => {
    const row = await seedUser();
    await SingleUseToken.create({
      nonce: `used-${Date.now()}`,
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'consumed@example.com',
      status: 'used',
      used_at: new Date(),
      expires_at: new Date(Date.now() + 60000),
    });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/resend`)
      .send()
      .expect(400);
    expect(res.body.code).toBe('validation');
  });

  it('returns the validation envelope when there is no active token of this purpose at all', async () => {
    const row = await seedUser();
    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/resend`)
      .send()
      .expect(400);
    expect(res.body.code).toBe('validation');
    expect(emailService.sendEmailChangeCode).not.toHaveBeenCalled();
  });

  it('still works, and leaves the pending row intact, when Users.email was repaired to EQUAL the pending address', async () => {
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'repaired@example.com' }).expect(200);

    // Plan 04's repair branch lands: Users.email now equals the pending address.
    await User.update({ email: 'repaired@example.com' }, { where: { id: row.id } });
    emailService.sendEmailChangeCode.mockClear();

    const res = await request(makeApp({ user_id: row.user_id, email: 'repaired@example.com', email_verified: true }))
      .post(`/api/users/${row.user_id}/email/resend`)
      .send()
      .expect(200);

    expect(res.body.outcome).toBe('code_sent');
    expect(sentRecipients()).toEqual(['repaired@example.com']);
    const active = (await tokensFor(row.user_id)).filter((t) => t.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].target).toBe('repaired@example.com');
  });

  it('resend mints count against the SAME hourly cap', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'cap@example.com' }).expect(200);
    await request(app).post(`/api/users/${row.user_id}/email/resend`).send().expect(200);
    await request(app).post(`/api/users/${row.user_id}/email/resend`).send().expect(200);

    const res = await request(app).post(`/api/users/${row.user_id}/email/resend`).send().expect(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('is self-only', async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    await SingleUseToken.create({
      nonce: `theirs-${Date.now()}`,
      user_id: theirs.user_id,
      purpose: PURPOSE,
      target: 'theirs@example.com',
      status: 'active',
      expires_at: new Date(Date.now() + 60000),
    });

    await request(makeApp(actorFor(mine)))
      .post(`/api/users/${theirs.user_id}/email/resend`)
      .send()
      .expect(403);
    expect(emailService.sendEmailChangeCode).not.toHaveBeenCalled();
  });
});

describe('POST /api/users/:user_id/email/cancel', () => {
  beforeEach(() => mailSucceeds());

  it('revokes every active code row, writes NOTHING to Users, and returns cancelled with pending null', async () => {
    const row = await seedUser({ email: 'stays@example.com' });
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'discard@example.com' }).expect(200);

    const res = await request(app).post(`/api/users/${row.user_id}/email/cancel`).send().expect(200);

    expect(res.body.outcome).toBe('cancelled');
    expect(res.body.pending_email_change).toBeNull();
    expect(res.body.verification_sent).toBe(false);
    expect(res.body.email).toBe('stays@example.com');

    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('stays@example.com');
    expect(after.email_changed_at).toBeNull();
    expect((await tokensFor(row.user_id)).every((t) => t.status === 'revoked')).toBe(true);
  });

  it('is IDEMPOTENT — a cancel with nothing pending is a success, not an error', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email/cancel`).send().expect(200);
    const res = await request(app).post(`/api/users/${row.user_id}/email/cancel`).send().expect(200);
    expect(res.body.outcome).toBe('cancelled');
  });

  it('MINTS nothing, so it neither adds to nor REFUNDS the hourly budget', async () => {
    mailSucceeds();
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    for (let i = 0; i < 3; i += 1) {
      await request(app).post(`/api/users/${row.user_id}/email`).send({ email: `c${i}@example.com` }).expect(200);
    }
    await request(app).post(`/api/users/${row.user_id}/email/cancel`).send().expect(200);

    // A refund reading would let this through. It must not.
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'after-cancel@example.com' }).expect(429);
  });

  it('is self-only', async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    await request(makeApp(actorFor(mine)))
      .post(`/api/users/${theirs.user_id}/email/cancel`)
      .send()
      .expect(403);
  });
});

// ===========================================================================
// SOURCE ASSERTIONS — the load rule, in the file itself
// ===========================================================================

describe('source: the five email-change handlers obey the load rule', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../../routes/users.js'), 'utf8');

  // COMMENT LINES ARE STRIPPED FIRST, mirroring this plan's own `grep -v '^\s*//'`
  // gates: the block's header comment names `req.selfUser` as the thing NOT to use,
  // and a prose mention must not be able to self-invalidate the gate.
  function emailChangeBlock() {
    const start = source.indexOf('EMAIL-CHANGE ROUTES (Phase 88.8 plan 09)');
    expect(start).toBeGreaterThan(-1);
    return source
      .slice(start)
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
  }

  it('contains no reference to req.selfUser', () => {
    expect(emailChangeBlock()).not.toContain('req.selfUser');
  });

  it('every User. model call inside them is scoped withContactInfo', () => {
    const lines = emailChangeBlock()
      .split('\n')
      .filter((l) => /\bUser\.(?!scope)/.test(l));
    expect(lines).toEqual([]);
  });

  it('registers request, resend and cancel', () => {
    for (const p of [
      "router.post('/:user_id/email'",
      "router.post('/:user_id/email/resend'",
      "router.post('/:user_id/email/cancel'",
    ]) {
      expect(source).toContain(p);
    }
  });

  it('attaches writeOperationLimiter PER ROUTE', () => {
    const block = emailChangeBlock();
    const registrations = block.match(/router\.post\('\/:user_id\/email[^']*',\s*writeOperationLimiter/g) || [];
    expect(registrations.length).toBeGreaterThanOrEqual(3);
  });
});

// ===========================================================================
// TASK 2 — verify and revert: the one transaction that overwrites the identity
// column, plus the D-41 invite move, the D-42 feedback move and the A13 notice.
// ===========================================================================

/** Request a change and hand back the raw code the CODE mail was given. */
async function requestChange(app, row, address) {
  emailService.sendEmailChangeCode.mockClear();
  const res = await request(app)
    .post(`/api/users/${row.user_id}/email`)
    .send({ email: address })
    .expect(200);
  const code = sentCodes()[0];
  return { res, code };
}

let groupSeq = 0;
async function seedGroup() {
  groupSeq += 1;
  return Group.create({ group_id: `ec-group-${groupSeq}-${Date.now()}`, name: `EC Group ${groupSeq}` });
}

let inviteSeq = 0;
async function seedPendingInvite(group, email) {
  inviteSeq += 1;
  return GroupInvite.create({
    group_id: group.id,
    invited_email: email,
    token: `ec-invite-token-${inviteSeq}-${Date.now()}`,
    status: 'pending',
  });
}

describe('POST /api/users/:user_id/email/verify — the happy path', () => {
  beforeEach(() => mailSucceeds());

  it('overwrites Users.email with the code row target, stamps email_changed_at, consumes the row', async () => {
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'new@example.com');

    const res = await request(app)
      .post(`/api/users/${row.user_id}/email/verify`)
      .send({ code })
      .expect(200);

    expect(res.body.outcome).toBe('verified');
    expect(res.body.email).toBe('new@example.com');
    expect(res.body.pending_email_change).toBeNull();
    expect(res.body.verification_sent).toBe(false);
    expect(res.body.email_changed_at).toBeTruthy();

    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('new@example.com');
    expect(after.email_changed_at).not.toBeNull();

    const [token] = await tokensFor(row.user_id);
    expect(token.status).toBe('used');
    expect(token.used_at).not.toBeNull();
  });

  it('accepts the code with its display dash and in lower case', async () => {
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'dashed@example.com');
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code: typed }).expect(200);
    expect(res.body.outcome).toBe('verified');
    expect(res.body.email).toBe('dashed@example.com');
  });

  it('THE OVERWRITE IS KEYED ON row.target, never on whatever is pending at flip time', async () => {
    // Two active rows, seeded directly so the revoke-then-mint does not collapse
    // them: X's code is the one typed, Y is the NEWEST pending. If the handler read
    // the pending address instead of the consumed row, Y would be written.
    const row = await seedUser({ email: 'old@example.com' });
    const codeX = 'ABCD2345';
    await SingleUseToken.create({
      nonce: sha256(codeX),
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'x@example.com',
      status: 'active',
      expires_at: new Date(Date.now() + 60000),
    });
    await SingleUseToken.create({
      nonce: sha256('ZZZZ9999'),
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'y@example.com',
      status: 'active',
      expires_at: new Date(Date.now() + 60000),
    });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/verify`)
      .send({ code: codeX })
      .expect(200);

    expect(res.body.outcome).toBe('verified');
    expect(res.body.email).toBe('x@example.com');
  });

  it('the stored row holds sha256(code); the code appears in NO response body and NO console output', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    const logs = [];
    for (const method of ['log', 'warn', 'error']) {
      jest.spyOn(console, method).mockImplementation((...args) => {
        logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      });
    }

    const { res: requestRes, code } = await requestChange(app, row, 'quiet@example.com');
    const verifyRes = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    const [token] = await tokensFor(row.user_id);
    // The mail carries the DISPLAY form (XXXX-XXXX); the nonce hashes the
    // normalised form, which is what entry produces.
    expect(token.nonce).toBe(sha256(code.replace(/-/g, '')));
    expect(JSON.stringify(requestRes.body)).not.toContain(code);
    expect(JSON.stringify(verifyRes.body)).not.toContain(code);
    expect(logs.join('\n')).not.toContain(code);
  });
});

describe('POST /api/users/:user_id/email/verify — the four-way fallback (DR-B)', () => {
  beforeEach(() => mailSucceeds());

  it('(i) the SAME code entered a second time is IDEMPOTENT: verified, with no write', async () => {
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'new@example.com');
    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    const first = await User.scope('withContactInfo').findByPk(row.id);
    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    expect(res.body.outcome).toBe('verified');
    const second = await User.scope('withContactInfo').findByPk(row.id);
    expect(second.email).toBe('new@example.com');
    expect(new Date(second.email_changed_at).getTime()).toBe(new Date(first.email_changed_at).getTime());
  });

  it('(i) is deliberately NOT gated on expires_at — a completed change stays true after the window', async () => {
    const row = await seedUser({ email: 'now@example.com' });
    const code = 'MNPQ2345';
    await SingleUseToken.create({
      nonce: sha256(code),
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'now@example.com',
      status: 'used',
      used_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      expires_at: new Date(Date.now() - 60 * 60 * 1000),
    });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/verify`)
      .send({ code })
      .expect(200);
    expect(res.body.outcome).toBe('verified');
  });

  it('(ii) an EXPIRED but still-active row returns expired, so the section can promote Resend', async () => {
    const row = await seedUser();
    const code = 'QRST2345';
    await SingleUseToken.create({
      nonce: sha256(code),
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'expired@example.com',
      status: 'active',
      expires_at: new Date(Date.now() - 1000),
    });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/verify`)
      .send({ code })
      .expect(200);
    expect(res.body.outcome).toBe('expired');
  });

  it('(iii) a USED row whose target is no longer the current address returns invalid', async () => {
    const row = await seedUser({ email: 'current@example.com' });
    const code = 'VWXY2345';
    await SingleUseToken.create({
      nonce: sha256(code),
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'stale@example.com',
      status: 'used',
      used_at: new Date(),
      expires_at: new Date(Date.now() + 60000),
    });

    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/verify`)
      .send({ code })
      .expect(200);
    expect(res.body.outcome).toBe('invalid');
    expect(res.body.email).toBe('current@example.com');
  });

  it('(iv) a code minted for a PREVIOUS pending address returns invalid — the later request revoked it', async () => {
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code: firstCode } = await requestChange(app, row, 'first@example.com');
    await requestChange(app, row, 'second@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code: firstCode }).expect(200);
    expect(res.body.outcome).toBe('invalid');
    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('old@example.com');
  });

  it('(iv) after a CANCEL the previously-mailed code returns invalid', async () => {
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'discard@example.com');
    await request(app).post(`/api/users/${row.user_id}/email/cancel`).send().expect(200);

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(res.body.outcome).toBe('invalid');
  });

  it('(iv) ANOTHER USER\'S valid code returns invalid and leaves that user\'s row active', async () => {
    const mine = await seedUser({ email: 'mine@example.com' });
    const theirs = await seedUser({ email: 'theirs@example.com' });
    const { code } = await requestChange(makeApp(actorFor(theirs)), theirs, 'their-new@example.com');

    const res = await request(makeApp(actorFor(mine)))
      .post(`/api/users/${mine.user_id}/email/verify`)
      .send({ code })
      .expect(200);

    expect(res.body.outcome).toBe('invalid');
    expect(res.body.email).toBe('mine@example.com');
    const [theirToken] = await tokensFor(theirs.user_id);
    expect(theirToken.status).toBe('active');
    const theirRow = await User.scope('withContactInfo').findByPk(theirs.id);
    expect(theirRow.email).toBe('theirs@example.com');
  });

  it('a WRONG code returns invalid and leaves the caller\'s pending row active', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'pending@example.com');

    const wrong = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code: 'ZZZZ2345' }).expect(200);
    expect(wrong.body.outcome).toBe('invalid');
    expect(wrong.body.pending_email_change).toMatchObject({ address: 'pending@example.com' });

    const right = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(right.body.outcome).toBe('verified');
  });

  it.each([
    ['no code', {}],
    ['an empty code', { code: '' }],
    ['a non-string code', { code: 12345678 }],
    ['a code of the wrong length', { code: 'ABC123' }],
    ['a code carrying an excluded Crockford symbol', { code: 'ABCDEFGU' }],
    ['a wrong body key', { verification_code: 'ABCD2345' }],
  ])('a malformed body (%s) returns the validation envelope', async (_label, body) => {
    const row = await seedUser();
    const res = await request(makeApp(actorFor(row)))
      .post(`/api/users/${row.user_id}/email/verify`)
      .send(body)
      .expect(400);
    expect(res.body.code).toBe('validation');
  });

  it('CONCURRENCY: two entries of the same code consume it exactly once and BOTH return verified', async () => {
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'raced@example.com');

    const [a, b] = await Promise.all([
      request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }),
      request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.outcome).toBe('verified');
    expect(b.body.outcome).toBe('verified');

    const consumed = (await tokensFor(row.user_id)).filter((t) => t.used_at !== null);
    expect(consumed).toHaveLength(1);
  });

  it('is self-only', async () => {
    const mine = await seedUser();
    const theirs = await seedUser();
    await request(makeApp(actorFor(mine)))
      .post(`/api/users/${theirs.user_id}/email/verify`)
      .send({ code: 'ABCD2345' })
      .expect(403);
  });
});

describe('T-88.8-78 — NEITHER email unique constraint may surface as a 500', () => {
  beforeEach(() => mailSucceeds());

  it('an EXACT collision answers 200 address_taken, writes nothing, and leaves the code row ACTIVE', async () => {
    await seedUser({ email: 'taken@example.com' });
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'taken@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    expect(res.body.outcome).toBe('address_taken');
    expect(res.body.email).toBe('old@example.com');
    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('old@example.com');
    expect(after.email_changed_at).toBeNull();
    const [token] = await tokensFor(row.user_id);
    expect(token.status).toBe('active');
  });

  it('a CASE-VARIANT collision — the users_email_lower_unique arm — also answers address_taken, not 500', async () => {
    // The occupying row holds a MIXED-CASE address, so `Users_email_key`
    // (case-sensitive) does NOT fire; only the LOWER(email) unique index does, and
    // its err.fields is keyed `lower(email::text)` with err.fields.email undefined.
    // A predicate written against one constraint name rethrows here and 500s.
    await seedUser({ email: 'Mixed@Example.com' });
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'mixed@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(res.body.outcome).toBe('address_taken');
    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('old@example.com');
  });

  it('reports ONE Sentry event tagged email-change/collision with the sub and the DOMAIN only', async () => {
    await seedUser({ email: 'occupied@collide-domain.test' });
    const row = await seedUser({ email: 'old@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'occupied@collide-domain.test');
    Sentry.captureException.mockClear();

    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, context] = Sentry.captureException.mock.calls[0];
    expect(context.tags).toMatchObject({ feature: 'email-change', op: 'collision' });
    const payload = JSON.stringify(context);
    expect(payload).toContain('collide-domain.test');
    expect(payload).not.toContain('occupied@');
  });
});

describe('D-41 — the pending-invite move, and the gate on it', () => {
  beforeEach(() => mailSucceeds());

  it('MIRROR 1: a row whose email_changed_at is non-null ON ENTRY DOES move its pending invites', async () => {
    const row = await seedUser({ email: 'proved@example.com', email_changed_at: new Date() });
    const group = await seedGroup();
    const invite = await seedPendingInvite(group, 'proved@example.com');
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'moved@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(res.body.outcome).toBe('verified');

    await invite.reload();
    expect(invite.invited_email).toBe('moved@example.com');
  });

  it('MIRROR 2: a row whose previousEmail EQUALS the verified claim DOES move its pending invites', async () => {
    const row = await seedUser({ email: 'claimed@example.com', email_changed_at: null });
    const group = await seedGroup();
    const invite = await seedPendingInvite(group, 'claimed@example.com');
    // The auth claim equals the stored address AND is verified — the gate's second arm.
    const app = makeApp({ user_id: row.user_id, email: 'Claimed@Example.com', email_verified: true });
    const { code } = await requestChange(app, row, 'moved2@example.com');

    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    await invite.reload();
    expect(invite.invited_email).toBe('moved2@example.com');
  });

  it('SKIP 1: email_changed_at null AND the claim is a DIFFERENT address — the change succeeds, the invite is byte-unchanged', async () => {
    const row = await seedUser({ email: 'victim@example.com', email_changed_at: null });
    const group = await seedGroup();
    const invite = await seedPendingInvite(group, 'victim@example.com');
    // Mallory's claim is her OWN address; the row holds victim@ she never proved.
    const app = makeApp({ user_id: row.user_id, email: 'mallory@evil.test', email_verified: true });
    const { code } = await requestChange(app, row, 'mallory@evil.test');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    // The change itself completes normally — the response is byte-identical to an
    // ungated successful verify, and there is NO ninth outcome literal.
    expect(res.body.outcome).toBe('verified');
    expect(res.body.email).toBe('mallory@evil.test');
    expect(res.body.email_changed_at).toBeTruthy();

    await invite.reload();
    expect(invite.invited_email).toBe('victim@example.com');
  });

  it('SKIP 2: email_verified false with the claim EQUAL to the stored address — the arm that proves the gate reads the flag', async () => {
    const row = await seedUser({ email: 'unverified@example.com', email_changed_at: null });
    const group = await seedGroup();
    const invite = await seedPendingInvite(group, 'unverified@example.com');
    const app = makeApp({ user_id: row.user_id, email: 'unverified@example.com', email_verified: false });
    const { code } = await requestChange(app, row, 'proven@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(res.body.outcome).toBe('verified');

    await invite.reload();
    expect(invite.invited_email).toBe('unverified@example.com');
  });

  it('a SKIP emits telemetry tagged invite-move-skipped with the sub, the DOMAIN only and the count left behind', async () => {
    const row = await seedUser({ email: 'left@skip-domain.test', email_changed_at: null });
    const group = await seedGroup();
    await seedPendingInvite(group, 'left@skip-domain.test');
    const app = makeApp({ user_id: row.user_id, email: 'other@evil.test', email_verified: true });
    const { code } = await requestChange(app, row, 'other@evil.test');
    Sentry.captureMessage.mockClear();

    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    // Selects its OWN event rather than counting every capture: since 2026-09-05 the
    // D-42 feedback move shares this gate, so an unproved old address closes BOTH and
    // emits two skip events. A bare toHaveBeenCalledTimes(1) here would fail for the
    // right reason and read as a regression.
    const skips = Sentry.captureMessage.mock.calls.filter(
      ([, ctx]) => ctx && ctx.tags && ctx.tags.op === 'invite-move-skipped'
    );
    expect(skips).toHaveLength(1);
    const [, context] = skips[0];
    expect(context.tags).toMatchObject({ feature: 'email-change', op: 'invite-move-skipped' });
    expect(context.extra).toMatchObject({ sub: row.user_id, pendingInvitesLeftBehind: 1 });
    const payload = JSON.stringify(context);
    expect(payload).toContain('skip-domain.test');
    expect(payload).not.toContain('left@');
  });

  it('the eight-value outcome enum is CLOSED — no ninth literal is ever emitted', async () => {
    const ALLOWED = [
      'code_sent', 'unchanged', 'cancelled', 'verified',
      'expired', 'invalid', 'address_taken', 'reverted',
    ];
    expect(ALLOWED).toHaveLength(8);

    const row = await seedUser({ email: 'enum@example.com', email_changed_at: null });
    const group = await seedGroup();
    await seedPendingInvite(group, 'enum@example.com');
    const app = makeApp({ user_id: row.user_id, email: 'elsewhere@evil.test', email_verified: true });
    const { code } = await requestChange(app, row, 'elsewhere@evil.test');
    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(ALLOWED).toContain(res.body.outcome);
  });

  it('a COLLIDING pending invite is SKIPPED, the non-colliding one moves, and the change still succeeds', async () => {
    const row = await seedUser({ email: 'movable@example.com', email_changed_at: new Date() });
    const groupA = await seedGroup();
    const groupB = await seedGroup();
    const movable = await seedPendingInvite(groupA, 'movable@example.com');
    const colliding = await seedPendingInvite(groupB, 'movable@example.com');
    // groupB ALREADY has a pending invite to the NEW address — a blanket UPDATE
    // would violate group_invites_pending_unique and abort the whole transaction.
    const blocker = await seedPendingInvite(groupB, 'landing@example.com');

    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'landing@example.com');
    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    expect(res.body.outcome).toBe('verified');
    await movable.reload();
    await colliding.reload();
    await blocker.reload();
    expect(movable.invited_email).toBe('landing@example.com');
    expect(colliding.invited_email).toBe('movable@example.com');
    expect(blocker.invited_email).toBe('landing@example.com');
  });

  it('matches the old address CASE-INSENSITIVELY and only touches PENDING rows', async () => {
    const row = await seedUser({ email: 'mixed@example.com', email_changed_at: new Date() });
    const group = await seedGroup();
    const pending = await seedPendingInvite(group, 'Mixed@Example.COM');
    const accepted = await GroupInvite.create({
      group_id: group.id,
      invited_email: 'mixed@example.com',
      token: `ec-accepted-${Date.now()}`,
      status: 'accepted',
    });

    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'newmixed@example.com');
    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    await pending.reload();
    await accepted.reload();
    expect(pending.invited_email).toBe('newmixed@example.com');
    expect(accepted.invited_email).toBe('mixed@example.com');
  });

  it('never touches ANOTHER user\'s pending invite', async () => {
    const row = await seedUser({ email: 'me@example.com', email_changed_at: new Date() });
    const other = await seedUser({ email: 'other@example.com' });
    const group = await seedGroup();
    const theirs = await seedPendingInvite(group, other.email);

    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'menew@example.com');
    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    await theirs.reload();
    expect(theirs.invited_email).toBe('other@example.com');
  });
});

describe('D-42 — the feedback move', () => {
  beforeEach(() => mailSucceeds());

  it('moves Feedback rows whose user_email equals the OLD address, case-insensitively', async () => {
    const row = await seedUser({ email: 'writer@example.com' });
    const mine = await Feedback.create({
      type: 'bug', subject: 'S', description: 'D', user_email: 'Writer@Example.com', user_id: null,
    });
    const someoneElse = await Feedback.create({
      type: 'bug', subject: 'S2', description: 'D2', user_email: 'stranger@example.com', user_id: null,
    });

    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'writernew@example.com');
    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    await mine.reload();
    await someoneElse.reload();
    expect(mine.user_email).toBe('writernew@example.com');
    expect(someoneElse.user_email).toBe('stranger@example.com');
  });

  // INVERTED 2026-09-05 (code review HIGH-4, owner ruling). This test previously
  // asserted that the feedback move runs even when the D-41 invite gate is CLOSED —
  // i.e. that the two were independent. They are not, and being independent was the
  // defect: both columns are keyed on the same address, and `user_email` is
  // CLIENT-SUPPLIED on both writers (the public one takes no bearer at all), so an
  // ungated move let an account holding an unproven address drag a stranger's
  // feedback rows onto its own new address — and out of the victim's deletion scrub.
  it('is GATED OFF with the invite move when the old address was never proved — a stranger\'s rows cannot be dragged along', async () => {
    const row = await seedUser({ email: 'gated@example.com', email_changed_at: null });
    const fb = await Feedback.create({
      type: 'bug', subject: 'S', description: 'D', user_email: 'gated@example.com', user_id: null,
    });
    // The claim is Mallory's OWN address; the row holds gated@ she never proved.
    const app = makeApp({ user_id: row.user_id, email: 'elsewhere@evil.test', email_verified: true });
    const { code } = await requestChange(app, row, 'elsewhere@evil.test');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    // The change itself still completes normally — the gate never changes the outcome.
    expect(res.body.outcome).toBe('verified');
    expect(res.body.email).toBe('elsewhere@evil.test');

    await fb.reload();
    expect(fb.user_email).toBe('gated@example.com');
  });

  it('still runs when the old address WAS proved — the gate is not simply always closed', async () => {
    const row = await seedUser({ email: 'proved@example.com', email_changed_at: null });
    const fb = await Feedback.create({
      type: 'bug', subject: 'S', description: 'D', user_email: 'proved@example.com', user_id: null,
    });
    // A VERIFIED claim equal to the stored address is exactly what "proved" means.
    const app = makeApp({ user_id: row.user_id, email: 'proved@example.com', email_verified: true });
    const { code } = await requestChange(app, row, 'movedon@example.com');
    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    await fb.reload();
    expect(fb.user_email).toBe('movedon@example.com');
  });

  it('a SKIP emits telemetry tagged feedback-move-skipped with the sub, the DOMAIN only and the count left behind', async () => {
    const row = await seedUser({ email: 'writer@fb-skip-domain.test', email_changed_at: null });
    await Feedback.create({
      type: 'bug', subject: 'S', description: 'D', user_email: 'writer@fb-skip-domain.test', user_id: null,
    });
    const app = makeApp({ user_id: row.user_id, email: 'other@evil.test', email_verified: true });
    const { code } = await requestChange(app, row, 'other@evil.test');
    Sentry.captureMessage.mockClear();

    await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    const skips = Sentry.captureMessage.mock.calls.filter(
      ([, context]) => context && context.tags && context.tags.op === 'feedback-move-skipped'
    );
    expect(skips).toHaveLength(1);
    const [, context] = skips[0];
    expect(context.tags).toMatchObject({ feature: 'email-change', op: 'feedback-move-skipped' });
    expect(context.extra).toMatchObject({ sub: row.user_id, feedbackRowsLeftBehind: 1 });
    const payload = JSON.stringify(context);
    expect(payload).toContain('fb-skip-domain.test');
    expect(payload).not.toContain('writer@');
  });
});

describe('D-40 / A13 — the security notice to the PRIOR address', () => {
  beforeEach(() => mailSucceeds());

  it('a successful verify enqueues exactly one job addressed to the PRIOR address', async () => {
    const row = await seedUser({ email: 'prior@example.com' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'after@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);

    expect(emailNoticeQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = emailNoticeQueue.add.mock.calls[0];
    expect(payload).toMatchObject({
      to: 'prior@example.com',
      sub: row.user_id,
      action: 'changed',
      newAddress: 'after@example.com',
    });
    // Nothing about the notice appears in the response body (D-40).
    expect(JSON.stringify(res.body)).not.toContain('notice');
  });

  it('a rejected .add() leaves the 200 unchanged and reports to Sentry', async () => {
    const row = await seedUser({ email: 'prior@notice-domain.test' });
    const app = makeApp(actorFor(row));
    const { code } = await requestChange(app, row, 'after@example.com');
    emailNoticeQueue.add.mockRejectedValueOnce(new Error('redis down'));
    Sentry.captureException.mockClear();

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(res.body.outcome).toBe('verified');
    expect(res.body.email).toBe('after@example.com');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, context] = Sentry.captureException.mock.calls[0];
    expect(context.tags).toMatchObject({ feature: 'email-change', op: 'notice-enqueue' });
    const payload = JSON.stringify(context);
    expect(payload).toContain('notice-domain.test');
    expect(payload).not.toContain('prior@');
  });

  it('a SYNTHETIC prior address enqueues nothing — there is no inbox, and refusing would lock out the repair population', async () => {
    const row = await seedUser({ email: 'google-oauth2-1|abc@auth0.local' });
    const app = makeApp({ user_id: row.user_id, email: 'google-oauth2-1|abc@auth0.local', email_verified: true });
    const { code } = await requestChange(app, row, 'real@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/verify`).send({ code }).expect(200);
    expect(res.body.outcome).toBe('verified');
    expect(res.body.email).toBe('real@example.com');
    expect(emailNoticeQueue.add).not.toHaveBeenCalled();
  });
});

describe('POST /api/users/:user_id/email/revert (D-38)', () => {
  beforeEach(() => mailSucceeds());

  async function changedUser(claimEmail = 'claim@example.com') {
    const row = await seedUser({ email: 'changed@example.com', email_changed_at: new Date() });
    return { row, app: makeApp({ user_id: row.user_id, email: claimEmail, email_verified: true }) };
  }

  it('writes the verified claim back, clears email_changed_at, revokes any pending code, returns reverted', async () => {
    const { row, app } = await changedUser();
    await SingleUseToken.create({
      nonce: `pending-${Date.now()}`,
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'somethingelse@example.com',
      status: 'active',
      expires_at: new Date(Date.now() + 60000),
    });

    const res = await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(200);

    expect(res.body.outcome).toBe('reverted');
    expect(res.body.email).toBe('claim@example.com');
    expect(res.body.email_changed_at).toBeNull();
    expect(res.body.pending_email_change).toBeNull();

    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('claim@example.com');
    expect(after.email_changed_at).toBeNull();
    expect((await tokensFor(row.user_id)).every((t) => t.status === 'revoked')).toBe(true);
  });

  it('normalises the claim before writing it', async () => {
    const { row, app } = await changedUser('  Claim@Example.COM ');
    await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(200);
    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('claim@example.com');
  });

  it('passes the D-41 gate BY CONSTRUCTION — its pending invites DO move', async () => {
    const { row, app } = await changedUser();
    const group = await seedGroup();
    const invite = await seedPendingInvite(group, 'changed@example.com');
    const fb = await Feedback.create({
      type: 'bug', subject: 'S', description: 'D', user_email: 'changed@example.com', user_id: null,
    });

    await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(200);

    await invite.reload();
    await fb.reload();
    expect(invite.invited_email).toBe('claim@example.com');
    expect(fb.user_email).toBe('claim@example.com');
  });

  it('enqueues a notice to the PRIOR address with the reverted action', async () => {
    const { row, app } = await changedUser();
    await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(200);

    expect(emailNoticeQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = emailNoticeQueue.add.mock.calls[0];
    expect(payload).toMatchObject({
      to: 'changed@example.com',
      action: 'reverted',
      newAddress: 'claim@example.com',
    });
  });

  it('D-40: with the hourly budget exhausted it STILL reverts and SKIPS the notice', async () => {
    const { row, app } = await changedUser();
    for (let i = 0; i < 3; i += 1) {
      await SingleUseToken.create({
        nonce: `budget-${i}-${Date.now()}`,
        user_id: row.user_id,
        purpose: PURPOSE,
        target: `b${i}@example.com`,
        status: 'revoked',
        expires_at: new Date(Date.now() + 60000),
      });
    }

    const res = await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(200);
    expect(res.body.outcome).toBe('reverted');
    expect(res.body.email).toBe('claim@example.com');
    expect(emailNoticeQueue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['email_changed_at is null', { changed: false, claim: 'claim@example.com', verified: true }],
    ['the claim is absent', { changed: true, claim: undefined, verified: true }],
    ['the claim is not verified', { changed: true, claim: 'claim@example.com', verified: false }],
    ['the claim is SYNTHETIC (@auth0, broad test)', { changed: true, claim: 'google-oauth2-1|x@auth0.local', verified: true }],
    ['the claim is @auth0 without .local', { changed: true, claim: 'x@auth0.example.com', verified: true }],
  ])('refuses with the validation envelope when %s', async (_label, { changed, claim, verified }) => {
    const row = await seedUser({
      email: 'current@example.com',
      email_changed_at: changed ? new Date() : null,
    });
    const app = makeApp({ user_id: row.user_id, email: claim, email_verified: verified });

    const res = await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(400);
    expect(res.body.code).toBe('validation');
    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('current@example.com');
  });

  it('a revert that would COLLIDE returns address_taken and writes nothing', async () => {
    await seedUser({ email: 'claim@example.com' });
    const { row, app } = await changedUser('claim@example.com');

    const res = await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(200);
    expect(res.body.outcome).toBe('address_taken');
    const after = await User.scope('withContactInfo').findByPk(row.id);
    expect(after.email).toBe('changed@example.com');
    expect(after.email_changed_at).not.toBeNull();
  });

  it('is self-only', async () => {
    const mine = await seedUser();
    const theirs = await seedUser({ email: 'theirs@example.com', email_changed_at: new Date() });
    await request(makeApp(actorFor(mine)))
      .post(`/api/users/${theirs.user_id}/email/revert`)
      .send()
      .expect(403);
  });
});

describe('source: verify and revert are ordinary authenticated routes', () => {
  const fs = require('fs');
  const path = require('path');
  const usersSource = fs.readFileSync(path.join(__dirname, '../../routes/users.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  // EXACTLY the plan's own gate shape — `grep -v '^\s*//'`, i.e. LINE comments only.
  // Block-comment lines survive on purpose: that is where the DECISION markers live,
  // and it is the only way a marker can satisfy a gate that strips its own prose.
  const stripLineComments = (src) =>
    src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('all FIVE routes are registered, each behind writeOperationLimiter', () => {
    const block = usersSource.slice(usersSource.indexOf('EMAIL-CHANGE ROUTES (Phase 88.8 plan 09)'));
    const registrations = block.match(/router\.post\('\/:user_id\/email[^']*',\s*writeOperationLimiter/g) || [];
    expect(registrations).toHaveLength(5);
    for (const p of ['/:user_id/email/verify', '/:user_id/email/revert']) {
      expect(block).toContain(`router.post('${p}', writeOperationLimiter`);
    }
  });

  it('server.js carries NO email/verify registration — the retired public-link design stays retired', () => {
    expect(stripLineComments(serverSource)).not.toContain('email/verify');
  });

  it('routes/users.js carries NO magicTokenLimiter', () => {
    expect(stripLineComments(usersSource)).not.toContain('magicTokenLimiter');
  });

  it('the D-38 revert rationale survives a line-comment-stripping grep', () => {
    expect(stripLineComments(usersSource)).toContain('DECISION Phase 88.8 D-38');
  });
});

// ===========================================================================
// TASK 3 — D-39 hydration: pending_email_change on the self read, without
// breaking the three write echoes.
// ===========================================================================

describe('round 2 HIGH-B — revert_available is SERVER-computed and asks the revert route\'s own question', () => {
  beforeEach(() => mailSucceeds());

  it('TRUE on the self read when email_changed_at is set AND the claim is verified and real', async () => {
    const row = await seedUser({ email: 'changed@example.com', email_changed_at: new Date() });
    const res = await request(makeApp(actorFor(row, { email: 'signin@example.com' })))
      .get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body.revert_available).toBe(true);
  });

  it('FALSE when email_changed_at is null — nothing to revert to', async () => {
    const row = await seedUser({ email: 'never@example.com', email_changed_at: null });
    const res = await request(makeApp(actorFor(row))).get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body.revert_available).toBe(false);
  });

  it.each([
    ['the claim is UNVERIFIED', { email: 'signin@example.com', email_verified: false }],
    ['the claim is SYNTHETIC', { email: 'auth0-x@auth0.local', email_verified: true }],
    ['there is NO email claim', { email: undefined, email_verified: true }],
    ['the claim is not a valid address', { email: 'not-an-address', email_verified: true }],
  ])('FALSE when %s — exactly the refusal the revert route would answer with', async (_label, claimOverrides) => {
    const row = await seedUser({ email: 'changed@example.com', email_changed_at: new Date() });
    const app = makeApp(actorFor(row, claimOverrides));
    const res = await request(app).get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body.revert_available).toBe(false);
    // The wire and the route agree: the same actor is refused by the route.
    await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(400);
  });

  it('the key is PRESENT on a default-scope write echo and is null there (the column is not loaded)', async () => {
    const row = await seedUser({ email: 'echo@example.com', email_changed_at: new Date() });
    const res = await request(makeApp(actorFor(row)))
      .put(`/api/users/${row.user_id}/username`).send({ username: 'echoed' }).expect(200);
    expect(Object.prototype.hasOwnProperty.call(res.body, 'revert_available')).toBe(true);
    expect(res.body.revert_available).toBeNull();
  });

  it('the email-change body carries it: TRUE after a verify stamps email_changed_at, FALSE after a revert clears it', async () => {
    const row = await seedUser({ email: 'before@example.com' });
    const app = makeApp(actorFor(row));
    await requestChange(app, row, 'after@example.com');
    const verified = await request(app)
      .post(`/api/users/${row.user_id}/email/verify`).send({ code: sentCodes()[0] }).expect(200);
    expect(verified.body.outcome).toBe('verified');
    expect(verified.body.revert_available).toBe(true);

    const reverted = await request(app).post(`/api/users/${row.user_id}/email/revert`).send().expect(200);
    expect(reverted.body.outcome).toBe('reverted');
    expect(reverted.body.email_changed_at).toBeNull();
    expect(reverted.body.revert_available).toBe(false);
  });
});

describe('D-39 — toSelfWire hydration', () => {
  beforeEach(() => mailSucceeds());

  it('the self GET returns { address, expires_at } when an active unexpired code exists', async () => {
    const row = await seedUser({ email: 'self@example.com' });
    const app = makeApp(actorFor(row));
    await requestChange(app, row, 'pending@example.com');

    const res = await request(app).get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body.pending_email_change).toMatchObject({ address: 'pending@example.com' });
    expect(res.body.pending_email_change.expires_at).toBeTruthy();
  });

  it('the self read carries email AND email_changed_at — what plan 13 keys the revert affordance on', async () => {
    const stamped = new Date();
    const row = await seedUser({ email: 'self@example.com', email_changed_at: stamped });
    const res = await request(makeApp(actorFor(row))).get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body.email).toBe('self@example.com');
    expect(new Date(res.body.email_changed_at).getTime()).toBe(stamped.getTime());
  });

  it('AFTER A PROVIDER-REFUSED SEND the self read STILL hydrates the pending change', async () => {
    // The wire half of Task 1's acceptance criterion. The live-pending predicate
    // deliberately carries NO send_failed_at clause: a refused mail is still a live
    // pending change, and filtering it out here would restore the dead end from the
    // other direction.
    mailRefused();
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'refused@example.com' }).expect(200);

    const res = await request(app).get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body.pending_email_change).toMatchObject({ address: 'refused@example.com' });
  });

  it.each([
    ['EXPIRED', { status: 'active', expires_at: new Date(Date.now() - 1000) }],
    ['REVOKED', { status: 'revoked', expires_at: new Date(Date.now() + 60000) }],
    ['USED', { status: 'used', used_at: new Date(), expires_at: new Date(Date.now() + 60000) }],
  ])('an %s code produces pending_email_change: null', async (label, attrs) => {
    const row = await seedUser();
    await SingleUseToken.create({
      nonce: `hydrate-${label}-${Date.now()}`,
      user_id: row.user_id,
      purpose: PURPOSE,
      target: 'nothydrated@example.com',
      ...attrs,
    });

    const res = await request(makeApp(actorFor(row))).get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body.pending_email_change).toBeNull();
  });

  it('another user\'s pending change is NEVER visible — the lookup is keyed on the caller\'s own user_id', async () => {
    const mine = await seedUser({ email: 'mine@example.com' });
    const theirs = await seedUser({ email: 'theirs@example.com' });
    await requestChange(makeApp(actorFor(theirs)), theirs, 'their-pending@example.com');

    const res = await request(makeApp(actorFor(mine))).get(`/api/users/${mine.user_id}`).expect(200);
    expect(res.body.pending_email_change).toBeNull();
  });

  it('the KEY IS ALWAYS PRESENT on the three write echoes, valued null, with NO extra query', async () => {
    const row = await seedUser({ email: 'echo@example.com', phone: null });
    const app = makeApp(actorFor(row));
    // A live pending change exists — the echoes must still serialise null, and the
    // frontend treats those three responses as PARTIAL patches for exactly that
    // reason (userProfile/page.js:655-668, :858-866).
    await requestChange(app, row, 'pending@example.com');

    const findOne = jest.spyOn(SingleUseToken, 'findOne');

    const username = await request(app)
      .put(`/api/users/${row.user_id}/username`)
      .send({ username: 'echoed' })
      .expect(200);
    const prefs = await request(app)
      .patch(`/api/users/${row.user_id}/notification-preferences`)
      .send({ preferences: { reminder: { email: true, sms: false } } })
      .expect(200);
    const phone = await request(app).delete(`/api/users/${row.user_id}/phone`).expect(200);

    for (const echo of [username, prefs, phone]) {
      expect(echo.body).toHaveProperty('pending_email_change', null);
    }
    expect(findOne).not.toHaveBeenCalled();
  });

  it('a self read with NOTHING pending returns the key with value null', async () => {
    const row = await seedUser();
    const res = await request(makeApp(actorFor(row))).get(`/api/users/${row.user_id}`).expect(200);
    expect(res.body).toHaveProperty('pending_email_change', null);
  });

  it('source: toSelfWire stays SYNCHRONOUS and pure, and carries the D-39 marker', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../routes/users.js'), 'utf8');
    // AMENDED round 2 HIGH-B (2026-09-05): a third parameter, `reqUser`, carries the
    // caller's claims so `revert_available` can be computed WITHOUT a lookup. The
    // property this test protects is unchanged — synchronous and pure — so the pin
    // now also proves the body awaits nothing.
    expect(source).toContain('const toSelfWire = (user, pendingEmailChange = null, reqUser = null) =>');
    expect(source).not.toContain('const toSelfWire = async');
    const start = source.indexOf('const toSelfWire = (');
    const body = source.slice(start, source.indexOf('return json;\n};', start));
    expect(body).not.toMatch(/\bawait\b/);
    expect(body).toContain('json.revert_available = revertAvailability(user, reqUser);');
    expect(
      source.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
    ).toContain('DECISION Phase 88.8 D-39');
  });
});
