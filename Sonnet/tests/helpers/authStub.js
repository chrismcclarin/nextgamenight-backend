// tests/helpers/authStub.js
//
// req.user-injection middleware factory for authz/BOLA regression tests (D-01 / Pitfall 1).
//
// WHY THIS EXISTS:
//   The existing route tests (e.g. tests/routes/lists.test.js:8-10) mount a router with
//   NO auth middleware:
//       app.use(express.json());
//       app.use('/api/lists', listRoutes);   // <-- req.user is undefined
//   Because the production object-level authz checks derive the actor from
//   `req.user?.user_id` (the verified Auth0 JWT), an undefined `req.user` means EVERY
//   such check short-circuits at `if (!userId) return res.status(401)`. The
//   403-on-cross-actor branch is therefore never exercised, so a BOLA regression test
//   can never actually prove the 403 path works.
//
// HOW TO USE:
//   `stubAuth(user)` must be `app.use()`-mounted BEFORE the router under test so that
//   `req.user` is populated by the time the route handler runs. Vary the stubbed user
//   per-test to assert BOTH the self path (e.g. 200) and the cross-actor path (403):
//
//       const { stubAuth } = require('../helpers/authStub');
//       const app = express();
//       app.use(express.json());
//       app.use(stubAuth({ user_id: testUser1.user_id })); // MOUNT BEFORE THE ROUTER
//       app.use('/api/x', router);
//
//   NOTE: Auth0 user_id is a STRING (models/User.js:20-24), NOT a UUID. The stubbed
//   user shape mirrors what verifyAuth0Token sets: at minimum `{ user_id: '<auth0 sub>' }`.

/**
 * Build an Express middleware that injects a fixed `req.user` for authz tests.
 *
 * @param {{ user_id: string }} user - the verified-actor shape (Auth0 user_id is a STRING).
 * @returns {(req: import('express').Request, _res: import('express').Response, next: import('express').NextFunction) => void}
 */
function stubAuth(user) {
  return (req, _res, next) => {
    req.user = user;
    next();
  };
}

module.exports = { stubAuth };
