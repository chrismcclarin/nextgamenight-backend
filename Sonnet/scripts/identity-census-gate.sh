#!/usr/bin/env bash
#
# scripts/identity-census-gate.sh
#
# Phase 87.5 (BINT-02, Req 12 / D-07) — the reproducible BE "closure proven by grep, not
# asserted" artifact. Greps the BE source for the two remaining Auth0-`sub` leak classes
# the identity migration converged away, and exits nonzero on any hit OUTSIDE the census
# §2 sanctioned allowlist (`.planning/research/IDENTITY-CENSUS.md`).
#
# NOT wired into CI (D-08): the permanent regression net is the existing BE wire-sweep
# (tests/routes/wire-sweep.test.js, empty allowlist) + the FE ci.yml compare-gate. This
# script is run at VERIFY TIME and its output recorded in VERIFICATION.md. It is safe to
# re-run any number of times.
#
# IDIOM (mirrors periodictabletop/.github/workflows/ci.yml compare-gate): grep with
# `|| true` (grep exits nonzero on NO MATCH — an EMPTY result is the PASS case here),
# filter full-line comments, and `exit 1` only when a non-allowlisted HIT survives.
#
# ALLOWLIST ANCHORING (critical — see census §2 warning): the census documents each
# sanctioned site with the LINE NUMBER it had when the census was taken, but this very
# phase's edits (Plans 05/06 gate swaps, comment corrections) shift line numbers throughout
# these files. A `file:line`-anchored allowlist entry silently stops matching the moment a
# line above it moves. So every allowlist entry below is anchored on FILE + a distinguishing
# EXPRESSION substring from that site — NOT on a line number — exactly as the FE ci.yml gate
# allowlists by structural shape rather than position. The three rekeyed-table WRITE files
# (availability.js, availabilityResponse.js, ballot.js) are deliberately NOT allowlisted:
# any raw-sub write into UserAvailability / AvailabilityResponse / EventBallotOption there
# must fail this gate.
#
# Run from the Sonnet/ package root:  bash scripts/identity-census-gate.sh
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
SRC_DIRS=(routes services middleware workers)

# strip grep's `path:line:` prefix and test if the remaining content is a full-line comment.
strip_comments() { grep -vE ':[0-9]+:[[:space:]]*(//|\*|/\*)' || true; }

FAIL=0

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 1 — unsanctioned self-param compares (the is-me bug class).
# Matches `req.params.<x>` compared (===/!==/==/!=, either operand order) against
# `req.user.user_id`. Plan 05 swapped all 11 sub-only self-param gates onto matchesSelf,
# so the ONLY surviving hits are the sanctioned getOrCreate / self-heal provisioning
# branches, where `req.params.user_id` genuinely IS the Auth0 sub (the /users/:user_id
# provisioning path) — comparing sub-to-sub is correct there.
# ─────────────────────────────────────────────────────────────────────────────
C1=$(grep -rnE \
  'req\.params\.[A-Za-z0-9_]+[[:space:]]*[!=]==?[[:space:]]*req\.user\??\.user_id|req\.user\??\.user_id[[:space:]]*[!=]==?[[:space:]]*req\.params\.[A-Za-z0-9_]+' \
  "${SRC_DIRS[@]}" 2>/dev/null | strip_comments \
  | grep -vE \
    `# ALLOWLIST §2 (provisioning/self-heal): the getOrCreate + email/username self-heal` \
    `# branches on /users/:user_id and /events/:user_id. req.params.user_id IS the Auth0 sub` \
    `# on the provisioning path; the '(!user|user) && req.user && sub === sub' guard only` \
    `# auto-creates/repairs the CALLER's own row. Correct-as-is (census §1 deliberately` \
    `# EXCLUDED these from the 11-gate swap list — the resource key here is the sub itself).` \
    'req\.user && req\.user\.user_id === req\.params\.user_id' \
  || true)

if [ -n "$C1" ]; then
  echo "::CENSUS-GATE FAIL:: unsanctioned self-param compare(s) against req.user.user_id"
  echo "  (the sub is not a Users.id UUID — use matchesSelf dual-accept, per census §1):"
  echo "$C1"
  FAIL=1
fi

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 2 — raw-sub OBJECT WRITES (`user_id: <sub-shaped>`), census §2 closure.
# Catches object-property `user_id:` writes whose VALUE is sub-shaped (`X.user_id`,
# `X.sub`, bare `userId`, `req.auth?.sub`, `<x> || null`). Same-line `where:` reads
# (Users sub→UUID resolvers) and `user_uuid` are excluded. Every SURVIVING hit must be a
# census §2 sanctioned site; anything else — including a sub write into a rekeyed table —
# fails. UUID wire-aliases (field named user_id, VALUE is a Users.id UUID) are sanctioned
# per §2's "all product user_id wire fields already alias to the UUID".
# ─────────────────────────────────────────────────────────────────────────────
C2=$(grep -rnE \
  '(^|[{,(])[[:space:]]*user_id:[[:space:]]*([A-Za-z_][A-Za-z0-9_]*\.(user_id|sub)|userId|req\.auth\?\.sub|[A-Za-z0-9_]+[[:space:]]*\|\|[[:space:]]*null)' \
  "${SRC_DIRS[@]}" 2>/dev/null \
  | grep -vE 'user_uuid|where[[:space:]]*:' | strip_comments \
  `# ── ALLOWLIST (census §2 + §4 sanctioned raw-sub sites, file + expression anchored) ──` \
  `# §2/§4 Users identity-anchor writes: user_id IS the Auth0 sub == Users.user_id, the` \
  `#        auth boundary (accepted-forever). Users.findOrCreate / provisioning upserts.` \
  | grep -vE 'routes/users\.js:.*user_id: (userDetails|user)\.user_id' \
  | grep -vE 'routes/groups\.js:.*user_id: userId' \
  | grep -vE 'services/auth0Service\.js:.*user_id: auth0User\.user_id' \
  `# §2 Feedback sub store: Feedback.user_id holds the sub (or client value), inert, never` \
  `#     emitted, DB-internal by owner disposition (census §4).` \
  | grep -vE 'routes/feedback\.js:.*user_id: (req\.auth\?\.sub|user_id) \|\| null' \
  `# §4 auth-flow token internals (accepted-forever auth boundary): the verifyAuth0Token` \
  `#     middleware builds req.user.user_id from the JWT sub claim — THE identity boundary;` \
  `#     MagicToken + SingleUseToken key on the sub by design.` \
  | grep -vE 'middleware/auth0\.js:.*user_id: decoded\.sub' \
  | grep -vE 'services/magicTokenService\.js:.*user_id: user\.user_id' \
  | grep -vE 'routes/rsvp\.js:.*user_id: userId' \
  `# §2 UUID wire-aliases (field NAME user_id, VALUE is a Users.id UUID): EventParticipation` \
  `#     is UUID-keyed; groups owner + availability heatmap serializers emit the UUID.` \
  | grep -vE 'routes/events\.js:.*user_id: p\.user_id' \
  | grep -vE 'routes/groups\.js:.*user_id: ug\.user_id' \
  | grep -vE 'services/availabilityService\.js:.*user_id: (m\.user_id|userId)' \
  `# §2 notification/email TEMPLATE payloads (not a DB table write): the sub travels in` \
  `#     notification data, consumed by the email renderer, never persisted to a rekeyed table.` \
  | grep -vE 'services/promptInvitationService\.js:.*user_id: user\.user_id' \
  | grep -vE 'workers/(promptWorker|reminderWorker)\.js:.*user_id: user\.user_id' \
  || true)

if [ -n "$C2" ]; then
  echo "::CENSUS-GATE FAIL:: unsanctioned raw-sub \`user_id:\` write outside the census §2 allowlist"
  echo "  (a sub written into a rekeyed table — key on user_uuid instead):"
  echo "$C2"
  FAIL=1
fi

# ─────────────────────────────────────────────────────────────────────────────
# CHECK 3 — any `created_by` (non-uuid) reference. EventBallotOptions is the ONLY table
# with a created_by column, and Plan 04 flipped every read/write onto created_by_uuid;
# Plan 07 drops the legacy created_by column. So ANY surviving non-uuid `created_by`
# reference is a regression against a dropped column. No allowlist.
# ─────────────────────────────────────────────────────────────────────────────
C3=$(grep -rnE '\bcreated_by\b' "${SRC_DIRS[@]}" 2>/dev/null \
  | grep -vE 'created_by_uuid' | strip_comments || true)

if [ -n "$C3" ]; then
  echo "::CENSUS-GATE FAIL:: \`created_by\` (non-uuid) reference — EventBallotOptions.created_by is dropped in Plan 07; key on created_by_uuid:"
  echo "$C3"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "identity-census-gate: PASS — zero unsanctioned sub self-param compares, zero raw-sub"
  echo "  writes outside the census §2 allowlist, zero non-uuid created_by references."
fi
exit "$FAIL"
