// scripts/audit-event-timezones.js
//
// Read-only audit of Event TZ storage integrity (Phase 62 Plan 01, Task 1).
//
// Purpose: Before changing edit-form behavior in Plan 02, confirm whether the
// bug lives in the read/write code path (likely) or in stored data (unlikely).
// Per Phase 62 CONTEXT.md migration decision: "audit first, likely no migration."
//
// Reports:
//   1. Total event count
//   2. Events with null/unparseable start_date
//   3. Events with null duration_minutes
//   4. Events whose start_date does not round-trip cleanly through toISOString()
//   5. 10 random sample rows for human spot-check
//   6. Cross-TZ wall-clock rendering of first sample event in 3 timezones
//
// READ-ONLY: no write calls of any kind. Output to stdout only.
//
// Usage: npm run audit:tz   (or: node scripts/audit-event-timezones.js)

require('dotenv').config();
const { sequelize, Event } = require('../models');

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function roundTripsAsIso(rawStartDate) {
  // rawStartDate as returned by Sequelize is typically a Date object (or string).
  // We check that converting to a Date and back to ISO yields a parseable ISO string.
  if (rawStartDate == null) return false;
  const d = rawStartDate instanceof Date ? rawStartDate : new Date(rawStartDate);
  if (!isValidDate(d)) return false;
  const iso = d.toISOString();
  // Sanity: re-parse the ISO and confirm it matches the original instant.
  const reparsed = new Date(iso);
  return isValidDate(reparsed) && reparsed.getTime() === d.getTime();
}

function pickRandomSamples(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (copy.length && out.length < n) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function renderWallClock(date, timeZone) {
  if (!isValidDate(date)) return '<invalid date>';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).format(date);
  } catch (err) {
    return `<format error: ${err.message}>`;
  }
}

async function auditEventTimezones() {
  console.log('========================================');
  console.log('  Event Timezone Storage Audit');
  console.log('  Phase 62 Plan 01 / Task 1 (read-only)');
  console.log('========================================\n');

  console.log('Connecting to database...');
  await sequelize.authenticate();
  console.log('Database connection established.\n');

  // Section 1: total count (across the entire table, not just the 200-row window)
  const totalAll = await Event.count();

  // Pull most recent 200 events for the deeper checks + samples.
  const events = await Event.findAll({
    order: [['start_date', 'DESC']],
    limit: 200,
  });

  console.log('--- Section 1: Total event count ---');
  console.log(`Total events in DB:        ${totalAll}`);
  console.log(`Events sampled (most recent): ${events.length}\n`);

  // Section 2: null / unparseable start_date
  let nullOrInvalidStart = 0;
  for (const ev of events) {
    const raw = ev.start_date;
    if (raw == null) {
      nullOrInvalidStart += 1;
      continue;
    }
    const d = raw instanceof Date ? raw : new Date(raw);
    if (!isValidDate(d)) nullOrInvalidStart += 1;
  }

  console.log('--- Section 2: null / unparseable start_date ---');
  console.log(`Events with null or invalid start_date (in sampled ${events.length}): ${nullOrInvalidStart}\n`);

  // Section 3: null duration_minutes
  let nullDuration = 0;
  for (const ev of events) {
    if (ev.duration_minutes == null) nullDuration += 1;
  }
  console.log('--- Section 3: null duration_minutes ---');
  console.log(`Events with null duration_minutes (in sampled ${events.length}): ${nullDuration}\n`);

  // Section 4: start_date does not round-trip through toISOString()
  let nonIsoCount = 0;
  for (const ev of events) {
    if (!roundTripsAsIso(ev.start_date)) nonIsoCount += 1;
  }
  console.log('--- Section 4: start_date round-trip integrity ---');
  console.log(`Events whose start_date does NOT round-trip cleanly to ISO: ${nonIsoCount}`);
  console.log('(0 = healthy: every stored timestamp parses and re-serializes as a UTC ISO instant.)\n');

  // Section 5: 10 random sample rows
  const samples = pickRandomSamples(events, Math.min(10, events.length));
  console.log('--- Section 5: 10 sample rows for spot-check ---');
  if (samples.length === 0) {
    console.log('(no events to sample)\n');
  } else {
    samples.forEach((ev, i) => {
      const raw = ev.start_date;
      const d = raw instanceof Date ? raw : (raw != null ? new Date(raw) : null);
      const iso = isValidDate(d) ? d.toISOString() : '<n/a>';
      console.log(
        `[${i + 1}] id=${ev.id} group_id=${ev.group_id} ` +
        `start_date(raw)=${raw} start_date(iso)=${iso} duration_minutes=${ev.duration_minutes}`
      );
    });
    console.log('');
  }

  // Section 6: cross-TZ render of first sample
  console.log('--- Section 6: cross-TZ wall-clock render of first sample event ---');
  const firstWithValidDate = samples.find((ev) => {
    const raw = ev.start_date;
    const d = raw instanceof Date ? raw : (raw != null ? new Date(raw) : null);
    return isValidDate(d);
  });

  if (!firstWithValidDate) {
    console.log('(no sample event with a valid start_date — cannot render)\n');
  } else {
    const raw = firstWithValidDate.start_date;
    const d = raw instanceof Date ? raw : new Date(raw);
    console.log(`Source UTC instant: ${d.toISOString()}`);
    console.log(`  America/Denver:      ${renderWallClock(d, 'America/Denver')}`);
    console.log(`  America/Los_Angeles: ${renderWallClock(d, 'America/Los_Angeles')}`);
    console.log(`  UTC:                 ${renderWallClock(d, 'UTC')}`);
    console.log('\n(If these three wall-clocks are consistent with the same physical moment ');
    console.log(' across timezones, viewer-anchor rendering is mathematically sound. The bug ');
    console.log(' is then in the read/write code path, not stored data.)\n');
  }

  // Final verdict scaffold
  console.log('========================================');
  console.log('  Verdict (manual review):');
  console.log(`    null/invalid start_date: ${nullOrInvalidStart}`);
  console.log(`    null duration_minutes:   ${nullDuration}`);
  console.log(`    non-ISO round-trip:      ${nonIsoCount}`);
  console.log('  If all three are 0, stored data is HEALTHY → Plan 02 is a code-only fix.');
  console.log('  If any are non-zero, stored data is BROKEN → Plan 02 needs a migration.');
  console.log('========================================\n');

  await sequelize.close();
  process.exit(0);
}

auditEventTimezones().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
