// Bare-node real-Postgres harness for 87.4 code-review M-1 (participant_user_ids +
// selected_member_ids both-keyspace scrub) and M-2 (5c GroupPromptSettings load
// scoped to the deleting user's groups). Drives the exported applyDispositions(user, t)
// directly inside a real transaction — no external services, no jest (which hangs
// locally on authenticate). CI's mocked + integration suites are authoritative.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env.test') });
process.env.NODE_ENV = 'test';

const {
  sequelize,
  AvailabilityPrompt,
  AvailabilitySuggestion,
  GroupPromptSettings,
} = require('../../models');
const { makeUser, makeGroup, addToGroup, makeAvailabilitySuggestion } = require('../factories');
const { applyDispositions } = require('../../services/accountDeletionService');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}${extra ? ' :: ' + extra : ''}`); }
}
const OTHER = '99999999-9999-9999-9999-999999999999';

(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  // Owner keeps the group alive (target is a plain member -> not auto-deleted by step 1).
  const owner = await makeUser({ username: 'owner' });
  const target = await makeUser({ username: 'target' });
  const group = await makeGroup({ name: 'M1M2 Group' });
  await addToGroup(owner, group, 'owner');
  await addToGroup(target, group, 'member');

  // An unrelated group the target is NOT a member of, whose settings stray-hold the
  // target UUID. M-2 scoping means this row must NOT be loaded/scrubbed.
  const unrelatedGroup = await makeGroup({ name: 'Unrelated Group' });
  await addToGroup(owner, unrelatedGroup, 'owner');

  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 72 * 3600 * 1000),
    status: 'closed',
    week_identifier: `2026-W07-${Math.random().toString(36).slice(2)}`,
  });

  // Suggestion holds BOTH target keyspaces + a bystander UUID. count/score deliberately
  // stale-inflated so the recompute is observable.
  const suggestion = await makeAvailabilitySuggestion(prompt, target, {
    participant_user_ids: [target.id, target.user_id, OTHER],
    participant_count: 3,
    preferred_count: 0,
    score: 3.0,
    meets_minimum: true,
  });

  // Settings in the target's group: schedule holds both target keyspaces.
  const gps = await GroupPromptSettings.create({
    group_id: group.id,
    created_by_user_id: owner.id,
    template_config: {
      schedules: [
        { id: 's0', selected_member_ids: [target.id, target.user_id, OTHER] },
        { id: 's1', selected_member_ids: [OTHER] },
      ],
    },
  });

  // Settings in the unrelated group: stray target UUID that M-2 must leave alone.
  const strayGps = await GroupPromptSettings.create({
    group_id: unrelatedGroup.id,
    created_by_user_id: owner.id,
    template_config: {
      schedules: [{ id: 'x0', selected_member_ids: [target.id, OTHER] }],
    },
  });

  await sequelize.transaction(async (t) => {
    await applyDispositions(target, t);
  });

  // ---- M-1: participant_user_ids scrub (both shapes) + recompute ----
  const sAfter = await AvailabilitySuggestion.findByPk(suggestion.id);
  const pids = sAfter.participant_user_ids || [];
  check('5a: target UUID removed from participant_user_ids', !pids.includes(target.id), JSON.stringify(pids));
  check('5a: target SUB removed from participant_user_ids', !pids.includes(target.user_id), JSON.stringify(pids));
  check('5a: bystander UUID preserved', pids.includes(OTHER), JSON.stringify(pids));
  check('5a: participant_count recomputed to 1', sAfter.participant_count === 1, String(sAfter.participant_count));
  check('5a: score recomputed to 1.0', Number(sAfter.score) === 1.0, String(sAfter.score));
  check('5a: meets_minimum recomputed false (1 < 2)', sAfter.meets_minimum === false, String(sAfter.meets_minimum));

  // ---- M-1 5c belt-and-braces: both shapes scrubbed from selected_member_ids ----
  const gpsAfter = await GroupPromptSettings.findByPk(gps.id);
  const s0 = gpsAfter.template_config.schedules.find((s) => s.id === 's0');
  check('5c: target UUID removed from selected_member_ids', !s0.selected_member_ids.includes(target.id), JSON.stringify(s0.selected_member_ids));
  check('5c: target SUB removed from selected_member_ids', !s0.selected_member_ids.includes(target.user_id), JSON.stringify(s0.selected_member_ids));
  check('5c: bystander UUID preserved in s0', s0.selected_member_ids.includes(OTHER));

  // ---- M-2: unrelated-group settings NOT scrubbed (scoping) ----
  const strayAfter = await GroupPromptSettings.findByPk(strayGps.id);
  const x0 = strayAfter.template_config.schedules.find((s) => s.id === 'x0');
  check('M-2: unrelated group settings left untouched (scoping)', x0.selected_member_ids.includes(target.id), JSON.stringify(x0.selected_member_ids));

  await sequelize.close();
  console.log(`\nM1/M2 HARNESS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
