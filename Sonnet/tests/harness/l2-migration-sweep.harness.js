// Bare-node harness for 87.4 code-review L-2: the participant_user_ids sweep migration
// must PRESERVE already-UUID elements in a mixed row (drop only unresolvable subs) and
// stay idempotent. The migrate-cli-replay CI job is the authoritative gate; this proves
// the remap CTE logic against real Postgres (jest hangs locally on authenticate).
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env.test') });
process.env.NODE_ENV = 'test';

const {
  sequelize,
  AvailabilityPrompt,
  AvailabilitySuggestion,
} = require('../../models');
const { makeUser, makeGroup } = require('../factories');
const migration = require('../../migrations/20260716000001-sweep-participant-user-ids-uuid.js');

let passed = 0, failed = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}${extra ? ' :: ' + extra : ''}`); }
}

(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });
  const qi = sequelize.getQueryInterface();

  const userA = await makeUser({ user_id: 'google-oauth2|A', username: 'A' });
  const userC = await makeUser({ user_id: 'google-oauth2|C', username: 'C' });
  const group = await makeGroup({ name: 'L2 Group' });
  const prompt = await AvailabilityPrompt.create({
    group_id: group.id, prompt_date: new Date(),
    deadline: new Date(Date.now() + 72 * 3600 * 1000), status: 'closed',
    week_identifier: `2026-W09-${Math.random().toString(36).slice(2)}`,
  });
  const mk = (arr) => AvailabilitySuggestion.create({
    prompt_id: prompt.id, suggested_start: new Date(), suggested_end: new Date(Date.now() + 2 * 3600 * 1000),
    participant_user_ids: arr, participant_count: arr.length, preferred_count: 0, meets_minimum: false, score: arr.length,
  });

  // Row A: pure sub — one resolvable, one orphan -> [userA.id]
  const rowA = await mk([userA.user_id, 'google-oauth2|departed-999']);
  // Row B: MIXED — a resolvable sub + an already-UUID element (L-2: must be preserved)
  const rowB = await mk([userA.user_id, userC.id]);
  // Row C: already-swept pure UUID (no `|`) -> guard must SKIP it (idempotency)
  const rowC = await mk([userA.id, userC.id]);

  await migration.up(qi);

  const a1 = await AvailabilitySuggestion.findByPk(rowA.id);
  check('Row A: orphan sub dropped, resolvable sub -> UUID', eq(a1.participant_user_ids, [userA.id]), JSON.stringify(a1.participant_user_ids));
  check('Row A: participant_count recomputed to 1', a1.participant_count === 1, String(a1.participant_count));

  const b1 = await AvailabilitySuggestion.findByPk(rowB.id);
  check('Row B (L-2): already-UUID element PRESERVED alongside remapped sub',
    b1.participant_user_ids.includes(userA.id) && b1.participant_user_ids.includes(userC.id) && b1.participant_user_ids.length === 2,
    JSON.stringify(b1.participant_user_ids));

  const c1 = await AvailabilitySuggestion.findByPk(rowC.id);
  check('Row C: pure-UUID row untouched by the guard', eq(c1.participant_user_ids, [userA.id, userC.id]), JSON.stringify(c1.participant_user_ids));

  // Idempotency: a second run changes nothing.
  const snapA = JSON.stringify(a1.participant_user_ids);
  const snapB = JSON.stringify(b1.participant_user_ids);
  await migration.up(qi);
  const a2 = await AvailabilitySuggestion.findByPk(rowA.id);
  const b2 = await AvailabilitySuggestion.findByPk(rowB.id);
  check('Idempotent: Row A unchanged on replay', JSON.stringify(a2.participant_user_ids) === snapA, JSON.stringify(a2.participant_user_ids));
  check('Idempotent: Row B unchanged on replay', JSON.stringify(b2.participant_user_ids) === snapB, JSON.stringify(b2.participant_user_ids));

  await sequelize.close();
  console.log(`\nL-2 HARNESS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
