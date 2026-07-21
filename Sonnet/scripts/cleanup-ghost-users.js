#!/usr/bin/env node
// scripts/cleanup-ghost-users.js
// Re-runnable ghost user cleanup script.
// Usage:
//   node scripts/cleanup-ghost-users.js          # Dry run: shows ghost users found
//   node scripts/cleanup-ghost-users.js --confirm # Deletes ghost users and associated records

const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');

const CONFIRM_FLAG = process.argv.includes('--confirm');

async function main() {
  console.log('=== Ghost User Cleanup ===');
  console.log(`Mode: ${CONFIRM_FLAG ? 'DELETE' : 'DRY RUN'}`);
  console.log('');

  try {
    // Verify database connection
    await sequelize.authenticate();
    console.log('Database connection established.');
    console.log('');

    // Query for ghost users: user_id does NOT start with auth0| or google-oauth2|
    const ghostUsers = await sequelize.query(`
      SELECT id, email, user_id
      FROM "Users"
      WHERE user_id NOT LIKE 'auth0|%'
        AND user_id NOT LIKE 'google-oauth2|%'
    `, { type: QueryTypes.SELECT });

    if (ghostUsers.length === 0) {
      console.log('No ghost users found. Database is clean.');
      await sequelize.close();
      process.exit(0);
    }

    console.log(`Found ${ghostUsers.length} ghost user(s):`);
    for (const ghost of ghostUsers) {
      console.log(`  - id=${ghost.id}, email=${ghost.email}, user_id=${ghost.user_id}`);
    }
    console.log('');

    if (!CONFIRM_FLAG) {
      console.log('Run with --confirm to delete these ghost users and their associated records.');
      await sequelize.close();
      process.exit(0);
    }

    // Proceed with deletion inside a transaction.
    // NOTE (Phase 87.5 Plan 07): the UserGroups and AvailabilityResponses deletes below were
    // re-keyed from the Auth0-string `user_id` column onto the UUID `user_uuid` FK column,
    // because those legacy sub columns are DROPPED by this milestone (UserGroups.user_id by
    // Plan 01's D-08 finalize; AvailabilityResponses.user_id by this plan's contract-drop).
    // All three child-table deletes now key on the ghost users' UUID PKs (`ghostIds`).
    const ghostIds = ghostUsers.map(g => g.id);

    const transaction = await sequelize.transaction();
    try {
      // 1. Delete from UserGroups (user_uuid UUID FK → Users.id, since 87.1; user_id dropped by D-08)
      const [, ugMeta] = await sequelize.query(`
        DELETE FROM "UserGroups" WHERE user_uuid IN (:ids)
      `, { replacements: { ids: ghostIds }, type: QueryTypes.DELETE, transaction });
      console.log(`Deleted UserGroup records for ghost users.`);

      // 2. Delete from EventParticipations (uses UUID id)
      const [, epMeta] = await sequelize.query(`
        DELETE FROM "EventParticipations" WHERE user_id IN (:ids)
      `, { replacements: { ids: ghostIds }, type: QueryTypes.DELETE, transaction });
      console.log(`Deleted EventParticipation records for ghost users.`);

      // 3. Delete from AvailabilityResponses (user_uuid UUID FK → Users.id, since 87.5; user_id dropped by Plan 07)
      const [, arMeta] = await sequelize.query(`
        DELETE FROM "AvailabilityResponses" WHERE user_uuid IN (:ids)
      `, { replacements: { ids: ghostIds }, type: QueryTypes.DELETE, transaction });
      console.log(`Deleted AvailabilityResponse records for ghost users.`);

      // 4. Delete the ghost users themselves
      const [, uMeta] = await sequelize.query(`
        DELETE FROM "Users" WHERE id IN (:ids)
      `, { replacements: { ids: ghostIds }, type: QueryTypes.DELETE, transaction });
      console.log(`Deleted ${ghostUsers.length} ghost user(s) from Users table.`);

      await transaction.commit();
      console.log('');
      console.log(`Cleaned ${ghostUsers.length} ghost user(s) and associated records.`);
    } catch (deleteError) {
      await transaction.rollback();
      console.error('Error during deletion, transaction rolled back:', deleteError.message);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

main();
