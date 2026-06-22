'use strict';

/** @type {import('sequelize-cli').Migration} */
//
// D-02 / BSEC-02 — add the DB-only `is_platform_admin` flag to Users and seed
// the operator's own row to true. Uses the sequelize-cli up(queryInterface,
// Sequelize) signature so it runs under the prod `migrate:apply` runner
// (Railway preDeployCommand → `npx sequelize-cli db:migrate`) and is tracked in
// SequelizeMeta. The self-invoking `node migrations/x.js` style is a prod no-op.
//
// Fail-safe: the column defaults false. The operator seed sources the Auth0 sub
// from an env var (AUTH0_ALICE_SUB / AUTH0_OPERATOR_SUB) rather than hardcoding
// the secret; if the var is absent the UPDATE matches zero rows and every user
// remains a non-admin.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'is_platform_admin', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // Seed the operator's own row. Sub is supplied via env (never hardcoded).
    const operatorSub = process.env.AUTH0_ALICE_SUB || process.env.AUTH0_OPERATOR_SUB || '';
    await queryInterface.sequelize.query(
      'UPDATE "Users" SET is_platform_admin = true WHERE user_id = :sub',
      { replacements: { sub: operatorSub } }
    );
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('Users', 'is_platform_admin');
  }
};
