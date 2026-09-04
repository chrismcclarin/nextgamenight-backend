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

  it('after a refused send the self read STILL hydrates pending_email_change', async () => {
    const row = await seedUser();
    const app = makeApp(actorFor(row));
    await request(app).post(`/api/users/${row.user_id}/email`).send({ email: 'refused@example.com' }).expect(200);

    const self = await request(app).get(`/api/users/${row.user_id}`).expect(200);
    expect(self.body.pending_email_change).toMatchObject({ address: 'refused@example.com' });
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

  function emailChangeBlock() {
    const start = source.indexOf('EMAIL-CHANGE ROUTES (Phase 88.8 plan 09)');
    expect(start).toBeGreaterThan(-1);
    return source.slice(start);
  }

  it('contains no reference to req.selfUser', () => {
    expect(emailChangeBlock()).not.toContain('req.selfUser');
  });

  it('every User. model call inside them is scoped withContactInfo', () => {
    const block = emailChangeBlock();
    const lines = block.split('\n').filter((l) => /\bUser\.(?!scope)/.test(l) && !/^\s*(\/\/|\*)/.test(l));
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
