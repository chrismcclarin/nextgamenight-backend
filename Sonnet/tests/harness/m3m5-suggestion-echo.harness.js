// Bare-node supertest harness for 87.4 code-review M-3 (GET suggestions filters
// participant_user_ids to UUID-shaped ids) and M-5 (POST/PATCH/toggle schedule
// echoes translate roster UUIDs back to Auth0 subs for PR-1 wire consistency).
// jest hangs locally on authenticate; CI suites are authoritative.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env.test') });
process.env.NODE_ENV = 'test';

// Patch the per-route auth middleware BEFORE requiring the suggestion router (which
// destructures verifyAuth0Token at require time).
let currentActor = null;
const auth0mw = require('../../middleware/auth0');
auth0mw.verifyAuth0Token = (req, _res, next) => { if (currentActor) req.user = { user_id: currentActor }; next(); };

const request = require('supertest');
const express = require('express');
const {
  sequelize,
  AvailabilityPrompt,
} = require('../../models');
const { makeUser, makeGroup, addToGroup, makeAvailabilitySuggestion } = require('../factories');
const suggestionRoutes = require('../../routes/availabilitySuggestion');
const gpsRoutes = require('../../routes/groupPromptSettings');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (currentActor) req.user = { user_id: currentActor }; next(); });
app.use('/api', suggestionRoutes);
app.use('/api/groups', gpsRoutes);

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}${extra ? ' :: ' + extra : ''}`); }
}
const OTHER = '99999999-9999-9999-9999-999999999999';

(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  const admin = await makeUser({ username: 'gps-admin' });
  const member = await makeUser({ username: 'gps-member' });
  const group = await makeGroup({ name: 'M3M5 Group' });
  await addToGroup(admin, group, 'owner');
  await addToGroup(member, group, 'member');
  currentActor = admin.user_id;

  // ---- M-3: GET suggestions filters participant_user_ids to UUID shape ----
  const prompt = await AvailabilityPrompt.create({
    group_id: group.id,
    prompt_date: new Date(),
    deadline: new Date(Date.now() + 72 * 3600 * 1000),
    status: 'closed',
    week_identifier: `2026-W08-${Math.random().toString(36).slice(2)}`,
  });
  await makeAvailabilitySuggestion(prompt, member, {
    participant_user_ids: [member.id, member.user_id, OTHER], // uuid + sub residue + bystander
    participant_count: 3,
  });

  let res = await request(app).get(`/api/prompts/${prompt.id}/suggestions`);
  check('M-3: GET suggestions -> 200', res.status === 200, String(res.status));
  const emitted = res.body.suggestions && res.body.suggestions[0] && res.body.suggestions[0].participant_user_ids;
  check('M-3: sub residue filtered out of participant_user_ids', Array.isArray(emitted) && !emitted.includes(member.user_id), JSON.stringify(emitted));
  check('M-3: UUID ids preserved', Array.isArray(emitted) && emitted.includes(member.id) && emitted.includes(OTHER), JSON.stringify(emitted));

  // ---- M-5: POST create echo translates roster UUID -> sub ----
  res = await request(app)
    .post(`/api/groups/${group.id}/prompt-settings/schedules`)
    .send({
      schedule_day_of_week: 3,
      schedule_time: '19:00',
      schedule_timezone: 'UTC',
      selected_member_ids: [member.id, OTHER], // client sends a roster UUID + a non-roster id
    });
  check('M-5 POST: create -> 201', res.status === 201, String(res.status));
  let echoed = res.body.schedule && res.body.schedule.selected_member_ids;
  check('M-5 POST: roster UUID echoed back as sub', Array.isArray(echoed) && echoed.includes(member.user_id) && !echoed.includes(member.id), JSON.stringify(echoed));
  check('M-5 POST: non-roster id passes through untranslated', Array.isArray(echoed) && echoed.includes(OTHER), JSON.stringify(echoed));
  const scheduleId = res.body.schedule.id;

  // ---- M-5: PATCH echo translates the stored (backfilled) UUID -> sub ----
  res = await request(app)
    .patch(`/api/groups/${group.id}/prompt-settings/schedules/${scheduleId}`)
    .send({ schedule_time: '20:00' }); // does NOT touch selected_member_ids
  check('M-5 PATCH: update -> 200', res.status === 200, String(res.status));
  echoed = res.body.schedule && res.body.schedule.selected_member_ids;
  check('M-5 PATCH: stored roster UUID echoed as sub', Array.isArray(echoed) && echoed.includes(member.user_id) && !echoed.includes(member.id), JSON.stringify(echoed));

  // ---- M-5: toggle echo translates too ----
  res = await request(app)
    .patch(`/api/groups/${group.id}/prompt-settings/schedules/${scheduleId}/toggle`)
    .send({});
  check('M-5 toggle: -> 200', res.status === 200, String(res.status));
  echoed = res.body.schedule && res.body.schedule.selected_member_ids;
  check('M-5 toggle: roster UUID echoed as sub', Array.isArray(echoed) && echoed.includes(member.user_id) && !echoed.includes(member.id), JSON.stringify(echoed));

  await sequelize.close();
  console.log(`\nM3/M5 HARNESS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
