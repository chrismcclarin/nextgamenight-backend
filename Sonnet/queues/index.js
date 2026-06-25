// queues/index.js
// Lazy named-export registry (BTEST-04 / D-03 part 1).
//
// Previously this file opened a shared eager Redis connection at module top and
// exported a plain object of already-constructed Queue instances — so any require of this
// module (or any sub-queue it required) connected to Redis at import, throwing
// ECONNREFUSED 6379 in a Redis-less environment before any test ran.
//
// Now each named export resolves through an `Object.defineProperty` getter that
// calls the underlying queue module's lazy `getQueue()` ONLY when the property
// is ACCESSED. This preserves the exact same named-export shape consumers expect
// (`const { reminderQueue } = require('../queues'); reminderQueue.add(...)`)
// without constructing anything at import.
//
// IMPORTANT: the getter fires on property ACCESS, which means a module-top
// `const { reminderQueue } = require('../queues')` in a consumer STILL connects
// at that consumer's import time. The three known module-top destructurers
// (services/gcalCleanupService.js, routes/bullBoard.js, schedulers/promptScheduler.js)
// are therefore de-eagered to require the queue lazily inside their using
// function. (Pitfall 3 / review HIGH-3 / round-3 MEDIUM.)

module.exports = {};

const queueExports = [
  ['reminderQueue', './reminderQueue'],
  ['promptQueue', './promptQueue'],
  ['deadlineQueue', './deadlineQueue'],
  ['gcalSyncQueue', './gcalSyncQueue']
];

for (const [name, mod] of queueExports) {
  Object.defineProperty(module.exports, name, {
    get: () => require(mod).getQueue(),
    enumerable: true,
    configurable: true
  });
}

// `connection` historically exposed a DEDICATED admin/monitoring Redis
// connection (separate from the queues). It is now intentionally an ALIAS of the
// reminderQueue module's connection, resolved lazily so no Redis connects at
// import (WR-01). The pre-refactor connection's resilience/observability —
// retryStrategy (exp backoff, 20s cap) + error logging — now lives on each
// queue's getConnection(), so the alias retains that behavior. Trade-off: there
// is no longer a connection distinct from the producers, so quitting one affects
// the other. No current consumer reads this export, so the collapse is safe; if a
// future admin tool needs an isolated connection, build a dedicated lazy one here.
Object.defineProperty(module.exports, 'connection', {
  get: () => require('./reminderQueue').getConnection(),
  enumerable: true,
  configurable: true
});
