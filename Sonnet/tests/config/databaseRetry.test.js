// tests/config/databaseRetry.test.js
//
// Phase 88.8 (wave-8 CI, 2026-09-05): the DATABASE_URL branch of config/database.js is
// the PRODUCTION branch (Railway sets DATABASE_URL) and the CI branch — and NOT the local
// branch, which uses DB_* vars and has no `retry` block. It shipped `retry: { max: 3 }`
// with no `match`, which Sequelize + retry-as-promised read as "retry EVERY failing
// statement", turning every in-transaction unique violation into a 25P02 and every
// collision handler into a 500 — in production only. The full backend suite cannot
// exercise that branch (it runs on DB_*), so this pin reads the SOURCE: a `retry` block
// on that branch must name a `match` list, and the list must be the connection-error
// base class and nothing wider. CI's own test job (DATABASE_URL) is the behavioural half.
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');

describe('config/database.js — the DATABASE_URL branch never retries blindly', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../config/database.js'), 'utf8');
  const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('reads a real config file (anti-vacuity)', () => {
    expect(codeOnly).toContain('new Sequelize(databaseUrl');
    expect(codeOnly).toContain('retry:');
  });

  it('every `retry:` block carries a `match:` — an empty match means retry-as-promised retries EVERYTHING', () => {
    const blocks = [...codeOnly.matchAll(/retry:\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const body of blocks) {
      expect(body).toMatch(/match:\s*\[/);
    }
  });

  it('the match list is exactly the connection-error base class (retried BEFORE a statement executes, so a write can never double-run)', () => {
    const blocks = [...codeOnly.matchAll(/retry:\s*\{([^}]*)\}/g)].map((m) => m[1]);
    for (const body of blocks) {
      const list = /match:\s*\[([^\]]*)\]/.exec(body);
      expect(list).not.toBeNull();
      const entries = list[1].split(',').map((e) => e.trim()).filter(Boolean);
      expect(entries).toEqual(['Sequelize.ConnectionError']);
    }
    // The class the source names really is the base class of every connection failure.
    for (const sub of [
      Sequelize.ConnectionRefusedError,
      Sequelize.HostNotFoundError,
      Sequelize.HostNotReachableError,
      Sequelize.InvalidConnectionError,
      Sequelize.ConnectionTimedOutError,
    ]) {
      expect(Object.prototype.isPrototypeOf.call(Sequelize.ConnectionError.prototype, sub.prototype)).toBe(true);
    }
    // ...and a unique violation is NOT one of them, which is the whole point.
    expect(Object.prototype.isPrototypeOf.call(Sequelize.ConnectionError.prototype, Sequelize.UniqueConstraintError.prototype)).toBe(false);
  });
});
