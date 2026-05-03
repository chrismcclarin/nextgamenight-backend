/**
 * Profile getGroupHeatmap end-to-end against the local database.
 *
 * Picks the largest group available, runs getGroupHeatmap twice (cold + warm),
 * and prints the timing breakdown emitted by the temporary [heatmap profile]
 * console.log lines in services/availabilityService.js.
 *
 * Usage:
 *   cd periodictabletopbackend_v2/Sonnet
 *   node scripts/profile-heatmap.js
 *
 * Optional env:
 *   GROUP_ID   - explicit group UUID to profile (otherwise picks largest)
 *   WEEK_START - YYYY-MM-DD Monday (default: this week's Monday in UTC)
 *   TZ_PARAM   - timezone passed to getGroupHeatmap (default: America/Denver)
 *
 * This script is intentionally narrow-purpose: HEAT-03 profiling only.
 * Removed in Task 2 once the timing log is collapsed to a single line.
 */
require('dotenv').config();

const availabilityService = require('../services/availabilityService');
const { sequelize, Group, UserGroup } = require('../models');

function thisMondayUTC() {
  const d = new Date();
  // ISO Monday in UTC
  const dow = d.getUTCDay() || 7; // Sun -> 7
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

async function pickGroup() {
  if (process.env.GROUP_ID) return process.env.GROUP_ID;

  // Pick the group with the most members
  const groups = await Group.findAll({
    include: [{ model: require('../models').User, through: UserGroup, attributes: ['id'] }],
  });
  if (groups.length === 0) throw new Error('No groups in DB');
  const ranked = groups
    .map(g => ({ id: g.id, name: g.name, count: (g.Users || []).length }))
    .sort((a, b) => b.count - a.count);
  console.log('\n[profile] Group candidates (top 5):');
  ranked.slice(0, 5).forEach(g => console.log(`  - ${g.name} (${g.count} members) ${g.id}`));
  console.log('');
  return ranked[0].id;
}

async function main() {
  const weekStart = process.env.WEEK_START || thisMondayUTC();
  const tz = process.env.TZ_PARAM || 'America/Denver';
  const groupId = await pickGroup();

  console.log(`[profile] === Cold load ===`);
  console.log(`[profile] groupId=${groupId} weekStart=${weekStart} tz=${tz}`);
  const t1 = Date.now();
  const result1 = await availabilityService.getGroupHeatmap(groupId, weekStart, tz);
  console.log(`[profile] === Cold total wall: ${Date.now() - t1}ms ===`);
  console.log(`[profile] result.totalGroupMembers=${result1.totalGroupMembers} totalMembers=${result1.totalMembers} slots=${result1.slots.length}`);

  // Warm load -- same args, run immediately. Sequelize and any in-memory caches
  // will be hot. Postgres should already have the pages in shared_buffers.
  console.log(`\n[profile] === Warm load ===`);
  const t2 = Date.now();
  await availabilityService.getGroupHeatmap(groupId, weekStart, tz);
  console.log(`[profile] === Warm total wall: ${Date.now() - t2}ms ===`);

  await sequelize.close();
}

main().catch(err => {
  console.error('[profile] ERROR:', err);
  process.exit(1);
});
