'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 87.4 (BINT-02, Plan 03 — D-05) — insurance sweep for the
// AvailabilitySuggestion.participant_user_ids JSONB keyspace flip (Auth0 sub → Users.id
// UUID). The writer (heatmapService) and all three readers flip in the same PR-1 deploy;
// this migration converts rows that already exist at deploy time so a suggestion that is
// never refreshed/closed again still holds UUIDs.
//
// GUARDED + IDEMPOTENT: the UPDATE is gated by an EXISTS clause that only matches rows
// still holding a provider-prefixed (sub-shaped, `LIKE '%|%'`) element. Once a row is
// swept its elements are all UUIDs (no `|`), so re-running is a no-op.
//
// ORPHAN DROP + LOG (D-08): each element is remapped to its Users.id via a LATERAL
// JOIN to "Users" on `u.user_id = elem`. An element whose sub has no Users row (a
// departed member) has no join match and DROPS OUT of the aggregate. When EVERY element
// is an orphan the inner JOIN yields zero rows and `jsonb_agg` returns SQL NULL — so we
// COALESCE the aggregate to an empty JSONB array `[]`, NEVER NULL (a NULL
// participant_user_ids would poison the id-keyed readers and break
// participant_count/meets_minimum). Orphan drops are logged by a count-diff of total
// element lengths before/after (count only; no raw subs).
//
// RECOMPUTE (canonical formula — accountDeletionService.js:270-281; Don't-Hand-Roll):
//   participant_count = jsonb_array_length(remapped array)   (0 for an all-orphan row)
//   meets_minimum     = (len >= COALESCE(g.min_players, 2))  via AvailabilityPrompts→Games
//   score             = (len * 1.0 + preferred_count * 0.5)  (no meets_minimum boost)
//
// DEPENDENCY-FREE (MANDATORY): migrations must never import app code (isUuid, models,
// utils) — app code can move/change and would break a historical replay. This sweep is
// PURE SQL; the sub-shape test is the inline `LIKE '%|%'` literal, not an imported check.
//
// down(): IRREVERSIBLE data migration — the pre-sweep sub keyspace is not restorable
// (orphan subs were dropped and the sub→UUID remap is one-way). Documented no-op down.
module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;
    const { QueryTypes } = require('sequelize');

    await sequelize.transaction(async (t) => {
      // (1) Total participant elements in the to-be-swept rows BEFORE the sweep
      //     (only rows still holding a sub-shaped element — the same guard the UPDATE uses).
      const beforeRows = await sequelize.query(
        `SELECT COALESCE(SUM(jsonb_array_length(participant_user_ids)), 0)::int AS total
           FROM "AvailabilitySuggestions" s
          WHERE EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(s.participant_user_ids) e(v)
            WHERE v LIKE '%|%'
          )`,
        { type: QueryTypes.SELECT, transaction: t }
      );
      const beforeTotal = beforeRows[0] ? beforeRows[0].total : 0;

      // (2) SWEEP: remap each sub element to its Users.id UUID (dropping orphans),
      //     COALESCE an all-orphan array to '[]' (never NULL), and recompute the
      //     denormalized ranking columns with the canonical formula.
      //     The remap is computed in a CTE (where `s` is the CTE's own FROM table, so a
      //     LATERAL over its JSONB is legal) — the UPDATE target cannot be referenced
      //     inside a LATERAL in the UPDATE...FROM clause. The CTE's LEFT JOIN to Users
      //     drops orphan subs; an all-orphan row aggregates to SQL NULL under the FILTER
      //     and COALESCEs to '[]' (never NULL). The prompt/game join mirrors
      //     accountDeletionService.js:270-281 (canonical recompute).
      const swept = await sequelize.query(
        `WITH remap AS (
           SELECT s.id AS sugg_id,
                  COALESCE(jsonb_agg(u.id) FILTER (WHERE u.id IS NOT NULL), '[]'::jsonb) AS arr
             FROM "AvailabilitySuggestions" s
             LEFT JOIN LATERAL jsonb_array_elements_text(s.participant_user_ids) AS elem(sub) ON TRUE
             LEFT JOIN "Users" u ON u.user_id = elem.sub
            WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(s.participant_user_ids) e(v)
              WHERE v LIKE '%|%'
            )
            GROUP BY s.id
         )
         UPDATE "AvailabilitySuggestions" AS s
            SET participant_user_ids = remap.arr,
                participant_count    = jsonb_array_length(remap.arr),
                meets_minimum        = (jsonb_array_length(remap.arr) >= COALESCE(g.min_players, 2)),
                score                = (jsonb_array_length(remap.arr) * 1.0 + s.preferred_count * 0.5)
           FROM remap,
                "AvailabilityPrompts" AS ap
                LEFT JOIN "Games" AS g ON g.id = ap.game_id
          WHERE s.id = remap.sugg_id
            AND ap.id = s.prompt_id
        RETURNING jsonb_array_length(s.participant_user_ids) AS newlen`,
        { type: QueryTypes.SELECT, transaction: t }
      );

      const rowsSwept = Array.isArray(swept) ? swept.length : 0;
      const afterTotal = Array.isArray(swept)
        ? swept.reduce((acc, r) => acc + (r.newlen || 0), 0)
        : 0;
      const orphansDropped = beforeTotal - afterTotal;

      console.log(
        `[PU-UUID-SWEEP] rows swept: ${rowsSwept}; participant elements before: ${beforeTotal}, ` +
        `after: ${afterTotal}; orphan subs dropped: ${orphansDropped} (count only; no subs logged).`
      );
    });
  },

  async down() {
    // IRREVERSIBLE data migration (no-op down). The pre-sweep Auth0-sub keyspace cannot
    // be reconstructed: orphan subs were dropped, and Users.id → user_id is not a stored
    // reverse mapping on the suggestion row. Rolling the writer/readers back is the
    // recovery path, not a DB down-migration.
  },
};
