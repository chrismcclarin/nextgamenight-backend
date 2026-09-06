// utils/publicUserAttrs.js
//
// DECISION Phase 88.8 plan 08 (D-23, SPEC R11 as amended by A6): the chip
// projection lives in ONE place — over eleven hand-copied `['id','username',
// 'picture_url']` literals, which is precisely how a widened select list drifts
// (the fail-closed member-PII allow-list in services/authorizationService.js
// carried THREE entries naming columns that never existed on models/User.js —
// that is what unmaintained duplication of a field list looks like after a few
// phases). The duplication tenet forbids the copy-it-N-times option outright.
//
// ---------------------------------------------------------------------------
// SCOPE BOUNDARY — this is the important half. READ IT BEFORE REUSING THIS.
// ---------------------------------------------------------------------------
// This constant is for CHIP SURFACES ONLY: the twelve projections that render a
// roster/participant/RSVP/friends/brings row as a person with a face. Those are
// (Phase 88.8 census, 2026-09-04):
//   routes/groups.js      x2  — both group roster includes
//   routes/events.js      x5  — the five EventParticipation -> User includes
//   routes/rsvp.js        x2  — the write echo include AND the roster include
//   routes/friendships.js x2  — the shared Requester / Addressee includes
//   routes/eventBrings.js x1  — the brings User include
//
// Every OTHER user projection in this codebase MUST NOT adopt it. There are 32
// real `['id','username']` code sites; 20 of them stay written out literally as
// the id-and-username pair, ON PURPOSE. The must-NOT list is therefore visible
// BY ABSENCE: a reader grepping for PUBLIC_USER_ATTRS sees exactly which
// surfaces show an avatar, and a literal pair at any other site is a deliberate
// statement that this one does not.
//
// MUST NOT be adopted by (named, not exhaustive-by-luck):
//   * routes/friendships.js GET /search — THE one to never touch. It is a
//     LOOKUP, not a roster: you supply an email address and it returns the one
//     matching person. Widening it turns an identity oracle into an enumeration
//     surface (R10 / T-88.8-38). Its projection is PINNED in both repos — an
//     exact toEqual(['id','username']) in tests/routes/friendships.test.js and
//     the frontend identity contract test — so adopting this constant there is
//     a red test, by construction and by intent.
//   * the `Winner` / `PickedBy` aliased includes in routes/events.js and
//     routes/lists.js — attribution labels, not people-chips.
//   * game reviews, lists, availability + availability-prompt, prompt settings,
//     the suggestion/availability services, and the internal notification
//     projections in routes/events.js (those feed SENDERS, not a UI).
//   * routes/groups.js's member-lookup in the group-games handler — it hydrates
//     rows into a username-only map before anything reaches the response, so
//     widening it would put nothing on the wire and would only make this census
//     harder to read.
//
// PII BOUNDARY: picture_url is the ONLY user field Phase 88.8 adds across the
// user boundary. `email`, `phone` and `email_changed_at` are excluded by the
// models/User.js defaultScope and MUST stay off every payload here; the wire
// sweep (tests/routes/wire-sweep.test.js) asserts all three absent at any depth
// on all six widened payloads, and asserts picture_url PRESENT on each.
//
// REJECTED ALTERNATIVE — a Sequelize model scope (e.g. User.scope('publicChip')).
// It reads tidier but Sequelize's behaviour for a scope combined with an
// association ALIAS (`as: 'Requester'`) and include-level `attributes` is not
// documented, and the friendships search projection is pinned by an exact
// toEqual — a scope that silently won or lost against include-level attributes
// would either break that pin or, worse, satisfy it while changing a different
// site. A plain frozen array has no resolution order to get wrong.
//
// USAGE — always spread at the call site: `attributes: [...PUBLIC_USER_ATTRS]`.
// The export is frozen so nothing can widen the shared list at a distance, and
// Sequelize is free to mutate the per-query array it is handed (it unshifts
// primary keys onto include-level attribute lists in some paths). Handing it
// the frozen array itself would either throw or — worse, in sloppy mode — fail
// silently. The spread costs one token and removes the whole question.

const PUBLIC_USER_ATTRS = Object.freeze(['id', 'username', 'picture_url']);

module.exports = { PUBLIC_USER_ATTRS };
