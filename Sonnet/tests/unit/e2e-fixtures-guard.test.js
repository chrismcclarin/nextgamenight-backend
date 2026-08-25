// tests/unit/e2e-fixtures-guard.test.js
// Phase 88.1-21 (owner ruling `guard`; security O-05 / T-88.1-61 residual): prove that
// scripts/e2e-fixtures.js calls the shared assert-not-production-db guard ITSELF, before it
// touches a single row.
//
// WHY THIS FILE EXISTS AT ALL. e2e-fixtures.js mass-deletes and force-destroys rows against
// whatever database the env resolves, and it is a runnable entry point. Until this phase its
// only protection was TRANSITIVE — ci.yml happened to run it after a step that had already
// established a local target. That is protection by step ordering in a file the script does
// not own, and it evaporates the moment someone runs the script by hand with a remote
// DATABASE_URL exported, or reorders the workflow. O-05 is exactly that residual.
//
// WHY A SOURCE-ORDER ASSERTION IS THE RIGHT SHAPE. The property being protected is ORDERING:
// the guard must run before the first destructive statement. Two things rule out executing the
// script here. (a) It cannot be imported without a live DB — the module's top-level
// `require('../models')` opens a Sequelize connection, and this is the DB-FREE `test:unit`
// lane (jest.unit.config.js: no globalSetup, no tests/setup.js, no Postgres). (b) Even with a
// DB, a behavioural test would have to actually let the destructive path run to prove the
// guard precedes it. A text scan sees the ordering directly and costs milliseconds. This is
// the same argument tests/unit/assert-migrate-db-empty.test.js makes for text-asserting SQL
// that its lane cannot execute.
//
// If this test goes red, do NOT relax it — the script has lost its own guard, which is the
// finding, not the gate.

const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'e2e-fixtures.js');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

describe('scripts/e2e-fixtures.js — fails closed on a non-local database', () => {
  test('requires the SHARED guard helper, not a local reimplementation', () => {
    // The path is asserted, not just the symbol: a second copy of the host-resolution logic
    // would drift from config/database.js's env-var order and check a different database
    // than the one the destroys hit. That drift risk is why the helper is shared.
    expect(source).toMatch(
      /require\(\s*['"]\.\/lib\/assert-not-production-db['"]\s*\)/
    );
    expect(source).toMatch(/assertNotProductionDb/);
  });

  test('calls the guard BEFORE the first destructive statement', () => {
    const callIndex = source.indexOf('assertNotProductionDb(');
    const firstDestroyIndex = source.indexOf('.destroy(');

    // ANTI-VACUITY. Without these two, a future rename that removes every `.destroy(` would
    // make the ordering assertion below pass against nothing (-1 < -1 is false, but
    // callIndex < -1 would also be false — and a removed CALL with destroys still present
    // would read as "-1 < n", i.e. PASS). Both indices must actually be found.
    expect(callIndex).toBeGreaterThan(-1);
    expect(firstDestroyIndex).toBeGreaterThan(-1);

    expect(callIndex).toBeLessThan(firstDestroyIndex);
  });

  test('calls the guard as the FIRST statement of main(), before the pre-destroy writes', () => {
    // First-statement placement, not first-destroy placement, is the deliberate contract:
    // main() does an `alice.update(...)` and an `Event.create(...)` well before its first
    // destroy, and a guard that lets a write through is not a guard.
    const mainIndex = source.indexOf('async function main()');
    expect(mainIndex).toBeGreaterThan(-1);

    const callIndex = source.indexOf('assertNotProductionDb(', mainIndex);
    expect(callIndex).toBeGreaterThan(-1);

    for (const mutator of ['.update(', '.create(', '.upsert(', '.bulkCreate(']) {
      const mutatorIndex = source.indexOf(mutator, mainIndex);
      if (mutatorIndex > -1) {
        expect(callIndex).toBeLessThan(mutatorIndex);
      }
    }
  });
});
