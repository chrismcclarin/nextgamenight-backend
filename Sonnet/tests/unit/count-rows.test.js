// tests/unit/count-rows.test.js
// quick-261119-nv0 (NV0-8): scripts/count-rows.js is the owner's proof that seeding staging
// left production alone. He runs it in PRODUCTION before and after the first staging seed and
// compares four numbers.
//
// WHY THIS FILE EXISTS. A script that is run against production on purpose has to be provably
// read-only. Two things are pinned here:
//   - behaviour (R1, R2): it sends one counting SELECT per table and nothing else;
//   - text (R3): the file contains no writing verb at all, in code OR in comments, so a later
//     edit that adds one fails here even if no test happens to execute that line.
// If R3 goes red, do NOT relax the token list: a script meant for production gained a way to
// write. That is the finding.
//
// DB-free lane: sequelize is a stub and the script's connection code runs only when the file
// is executed directly, never when it is required.

const fs = require('fs');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'count-rows.js');
const { COUNTED_TABLES, countRows } = require('../../scripts/count-rows');

function makeSequelize(countFor = () => '0') {
  const seen = [];
  return {
    seen,
    QueryTypes: { SELECT: 'SELECT' },
    query: jest.fn(async (sql, options) => {
      seen.push({ sql, options });
      const table = (sql.match(/FROM "([^"]+)"/) || [])[1];
      return [{ count: countFor(table) }];
    }),
  };
}

describe('scripts/count-rows.js: counts four tables and only reads', () => {
  test('R1: the counted tables are Users, Groups, UserGroups and Events, in that order', () => {
    expect(COUNTED_TABLES).toEqual(['Users', 'Groups', 'UserGroups', 'Events']);
  });

  test('R1: one counting query per table, in order, returning numeric counts', async () => {
    // Postgres returns count(*) as a string (it is a bigint); the script must hand back numbers.
    const counts = { Users: '7', Groups: '12', UserGroups: '31', Events: '15' };
    const sequelize = makeSequelize((table) => counts[table]);

    const result = await countRows(sequelize);

    expect(result).toEqual([
      { table: 'Users', count: 7 },
      { table: 'Groups', count: 12 },
      { table: 'UserGroups', count: 31 },
      { table: 'Events', count: 15 },
    ]);
    expect(sequelize.query).toHaveBeenCalledTimes(4);
    expect(sequelize.seen.map((call) => call.sql)).toEqual([
      'SELECT count(*) AS count FROM "Users"',
      'SELECT count(*) AS count FROM "Groups"',
      'SELECT count(*) AS count FROM "UserGroups"',
      'SELECT count(*) AS count FROM "Events"',
    ]);
    for (const call of sequelize.seen) {
      expect(call.options).toEqual({ type: 'SELECT' });
    }
  });

  test('R2: every statement it sends starts with SELECT', async () => {
    const sequelize = makeSequelize();

    await countRows(sequelize);

    expect(sequelize.seen.length).toBeGreaterThan(0); // anti-vacuity
    for (const { sql } of sequelize.seen) {
      expect(sql.startsWith('SELECT ')).toBe(true);
      expect(sql).not.toMatch(/;/); // one statement per call, nothing chained after it
    }
  });

  test('a count that is not a number is an error, never a silent zero', async () => {
    await expect(countRows(makeSequelize(() => 'not-a-number'))).rejects.toThrow(/Users/);
    await expect(countRows(makeSequelize(() => undefined))).rejects.toThrow(/Users/);

    const empty = makeSequelize();
    empty.query.mockResolvedValue([]);
    await expect(countRows(empty)).rejects.toThrow(/Users/);
  });

  test('a failing query rejects: the script never reports partial numbers as complete', async () => {
    const sequelize = makeSequelize();
    sequelize.query.mockRejectedValueOnce(new Error('connection refused'));

    await expect(countRows(sequelize)).rejects.toThrow(/connection refused/);
  });
});

describe('R3: the source of scripts/count-rows.js holds no writing verb', () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

  test('does not load the models (loading them is what the seed does before it writes)', () => {
    expect(source).not.toMatch(/require\(\s*['"]\.\.\/models['"]\s*\)/);
    expect(source).not.toMatch(/require\(\s*['"]\.\.\/models\//);
  });

  test.each(['.sync(', '.destroy(', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE', 'ALTER'])(
    'contains no %s (any letter case, comments included)',
    (token) => {
      expect(source.length).toBeGreaterThan(200); // anti-vacuity: the file was really read
      expect(source.toLowerCase().includes(token.toLowerCase())).toBe(false);
    }
  );

  test('prints counts only: no line prints a row, and the error path prints no driver message', () => {
    const logLines = source.split('\n').filter((line) => /console\.(log|error|warn)\(/.test(line));

    expect(logLines.length).toBeGreaterThan(1); // anti-vacuity
    for (const line of logLines) {
      // The driver's own message can carry a user name or a host, so it is never printed.
      expect({ line, printsMessage: /\.message|\.stack|\.sql|\.parameters/.test(line) }).toEqual({
        line,
        printsMessage: false,
      });
      // Nothing from the environment is printed except the guard's database line.
      expect({ line, printsEnv: /process\.env/.test(line) }).toEqual({ line, printsEnv: false });
    }
  });
});
