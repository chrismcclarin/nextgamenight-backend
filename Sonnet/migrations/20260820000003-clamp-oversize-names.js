'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// Phase 88 plan 88-34 Task 4 (fork D + fork E, owner-ruled 2026-08-20) — one-time clamp of
// pre-existing over-length names across the FIVE carriers that gain a length rule in this plan.
//
// WHY IT EXISTS. This plan adds a 1..50 guest-name cap on event create AND update, a
// User.username len[1,50] model backstop and a Group.name len[1,40] one. Any row that already
// exceeds those bounds would start FAILING on its next save — and for events that is not a
// cosmetic failure. The Edit Event surface resubmits the WHOLE custom_participants array and the
// update route replaces the column wholesale, so ONE legacy oversize guest name would 400 every
// future edit of that event, PERMANENTLY, including the guest-removal edit. This migration
// clamps those rows once so the new rules have nothing to trip over.
//
// WHY ALL THREE EVENT CARRIERS GET THE **SAME** 50 (fork E — the load-bearing part). A guest
// name lives in three places on an Event: custom_participants[].username (JSONB),
// winner_name, and picked_by_name. The FE re-links a winner/picked-by back to a guest by EXACT
// STRING EQUALITY. Clamping only the JSONB copy, or clamping the columns to a DIFFERENT length,
// makes the two sides unequal by a few bytes and the re-link silently stops matching —
// attribution is erased with no error anywhere. So all three truncate to LEFT(_, 50) and stay
// byte-identical afterwards.
//
// WHY THE JSONB IS REBUILT ELEMENT-WISE, not replaced. Order and every sibling field (score,
// faction, is_new_player, placement) must survive — only an oversize `username` is touched.
// jsonb_agg over jsonb_array_elements WITH ORDINALITY preserves order; jsonb_set replaces just
// the one key.
//
// IDEMPOTENT BY CONSTRUCTION (Task 1's pattern). Every statement's WHERE clause is the exact
// negation of its post-condition (`char_length(col) > n`), so a second run matches zero rows.
//
// DOWN IS A NO-OP, on purpose: the pre-truncation text is not recorded anywhere, so there is
// nothing to restore. This is a data repair, not reversible schema.
//
// CENSUS (2026-08-20, local test DB — the deploy-time prod run uses the same SQL, recorded in
// 88-34-SUMMARY.md): zero rows on all five carriers, zero empty/whitespace-only values, zero
// guest arrays over the new 50-element cap. The empty-value and over-count checks are a STOP
// condition, NOT something this migration repairs — inventing a placeholder name or dropping
// guests is a product decision, so if prod's census returns non-zero on those, surface it to the
// owner before deploying rather than "fixing" it here.
const GUEST_NAME_MAX = 50;
const GROUP_NAME_MAX = 40;

const STATEMENTS = [
  {
    label: 'Users.username',
    sql: `UPDATE "Users" SET username = LEFT(username, ${GUEST_NAME_MAX})
           WHERE char_length(username) > ${GUEST_NAME_MAX};`,
  },
  {
    label: 'Groups.name',
    sql: `UPDATE "Groups" SET name = LEFT(name, ${GROUP_NAME_MAX})
           WHERE char_length(name) > ${GROUP_NAME_MAX};`,
  },
  {
    label: 'Events.custom_participants[].username',
    sql: `
      UPDATE "Events" e
         SET custom_participants = rebuilt.arr
        FROM (
          SELECT src.id,
                 jsonb_agg(
                   CASE
                     WHEN jsonb_typeof(el.value->'username') = 'string'
                      AND char_length(el.value->>'username') > ${GUEST_NAME_MAX}
                     THEN jsonb_set(el.value, '{username}',
                            to_jsonb(LEFT(el.value->>'username', ${GUEST_NAME_MAX})))
                     ELSE el.value
                   END
                   ORDER BY el.ord
                 ) AS arr
            FROM "Events" src,
                 LATERAL jsonb_array_elements(src.custom_participants) WITH ORDINALITY AS el(value, ord)
           WHERE jsonb_typeof(src.custom_participants) = 'array'
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(src.custom_participants) AS probe
                WHERE jsonb_typeof(probe->'username') = 'string'
                  AND char_length(probe->>'username') > ${GUEST_NAME_MAX}
             )
           GROUP BY src.id
        ) AS rebuilt
       WHERE e.id = rebuilt.id;`,
  },
  {
    label: 'Events.winner_name',
    sql: `UPDATE "Events" SET winner_name = LEFT(winner_name, ${GUEST_NAME_MAX})
           WHERE char_length(winner_name) > ${GUEST_NAME_MAX};`,
  },
  {
    label: 'Events.picked_by_name',
    sql: `UPDATE "Events" SET picked_by_name = LEFT(picked_by_name, ${GUEST_NAME_MAX})
           WHERE char_length(picked_by_name) > ${GUEST_NAME_MAX};`,
  },
];

module.exports = {
  async up(queryInterface) {
    for (const { label, sql } of STATEMENTS) {
      const [, metadata] = await queryInterface.sequelize.query(sql);
      const clamped = metadata && typeof metadata.rowCount === 'number' ? metadata.rowCount : 0;
      console.log(`[88-34/fork-E] clamped ${label}: ${clamped} row(s)`);
    }
  },

  async down() {
    // Intentional no-op — the pre-truncation values were never recorded, so there is nothing
    // to restore, and re-lengthening is impossible by construction.
  },
};
