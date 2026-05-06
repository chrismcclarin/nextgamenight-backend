// migrations/20260506000002-add-poll-created-notification-key.js
// D-POLL-CREATE-08: introduce the `poll_created` notification channel.
//
// notification_preferences is JSONB — no DDL change needed. This migration is a
// traceability marker + a backfill: any user who has an explicit prefs row (non-null)
// gets `poll_created: { email: true, sms: false }` added so they don't accidentally
// opt-out by virtue of the key being missing. Users with NULL prefs are left alone —
// the resolver in services/notificationService.js applies defaults at read time.
//
// Mirrors the executable-script shape used by other Phase 50+ migrations.
const sequelize = require('../config/database');

async function up() {
  // Backfill: add poll_created to existing explicit prefs rows that don't have it.
  const [results] = await sequelize.query(`
    UPDATE "Users"
    SET notification_preferences = jsonb_set(
      notification_preferences,
      '{poll_created}',
      '{"email": true, "sms": false}'::jsonb,
      true
    )
    WHERE notification_preferences IS NOT NULL
      AND NOT (notification_preferences ? 'poll_created');
  `);
  console.log(`Backfilled poll_created prefs key on existing rows. Affected: ${results?.rowCount ?? 'unknown'}`);
}

async function down() {
  await sequelize.query(`
    UPDATE "Users"
    SET notification_preferences = notification_preferences - 'poll_created'
    WHERE notification_preferences IS NOT NULL
      AND notification_preferences ? 'poll_created';
  `);
  console.log('Removed poll_created prefs key from existing rows.');
}

if (require.main === module) {
  up().then(() => sequelize.close()).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { up, down };
