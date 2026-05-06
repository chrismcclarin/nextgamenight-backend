// tests/routes/ballot-routes.test.js
// TDD RED: Tests for ballot route module structure and validators

describe('Ballot route module', () => {
  it('should export an Express router', () => {
    const ballot = require('../../routes/ballot');
    expect(ballot).toBeDefined();
    expect(typeof ballot).toBe('function'); // Express routers are functions
    // Express routers have a .stack property with route layers
    expect(ballot.stack).toBeDefined();
    expect(Array.isArray(ballot.stack)).toBe(true);
  });

  it('should have GET /:eventId route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const getRoute = routes.find(r => r.path === '/:eventId' && r.methods.includes('get'));
    expect(getRoute).toBeDefined();
  });

  it('should have POST /:eventId/options route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const postRoute = routes.find(r => r.path === '/:eventId/options' && r.methods.includes('post'));
    expect(postRoute).toBeDefined();
  });

  it('should have PUT /:eventId/options route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const putRoute = routes.find(r => r.path === '/:eventId/options' && r.methods.includes('put'));
    expect(putRoute).toBeDefined();
  });

  it('should have POST /:eventId/vote route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const voteRoute = routes.find(r => r.path === '/:eventId/vote' && r.methods.includes('post'));
    expect(voteRoute).toBeDefined();
  });

  it('should have POST /:eventId/resolve-tie route', () => {
    const ballot = require('../../routes/ballot');
    const routes = ballot.stack
      .filter(layer => layer.route)
      .map(layer => ({
        path: layer.route.path,
        methods: Object.keys(layer.route.methods),
      }));
    const tieRoute = routes.find(r => r.path === '/:eventId/resolve-tie' && r.methods.includes('post'));
    expect(tieRoute).toBeDefined();
  });
});

describe('Ballot validators', () => {
  it('should export validateBallotOptions', () => {
    const validators = require('../../middleware/validators');
    expect(validators.validateBallotOptions).toBeDefined();
    expect(Array.isArray(validators.validateBallotOptions)).toBe(true);
  });

  it('should export validateBallotVote', () => {
    const validators = require('../../middleware/validators');
    expect(validators.validateBallotVote).toBeDefined();
    expect(Array.isArray(validators.validateBallotVote)).toBe(true);
  });
});

describe('Server mounts ballot routes', () => {
  it('should reference ballot route in server.js', () => {
    const fs = require('fs');
    const path = require('path');
    const serverCode = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    expect(serverCode).toContain("require('./routes/ballot')");
    expect(serverCode).toContain("/api/ballot");
  });
});

describe('Frontend ballotAPI client', () => {
  it('should have ballotAPI export in api.js', () => {
    const fs = require('fs');
    const path = require('path');
    const apiCode = fs.readFileSync(
      path.join(__dirname, '../../../../periodictabletop/src/lib/api.js'),
      'utf-8'
    );
    expect(apiCode).toContain('ballotAPI');
    expect(apiCode).toContain('getBallot');
    expect(apiCode).toContain('setBallotOptions');
    expect(apiCode).toContain('updateBallotOptions');
    expect(apiCode).toContain('toggleVote');
    expect(apiCode).toContain('resolveTie');
  });
});

// POLL-06 (Phase 71-03): gate-coverage tests on the vote handler.
// Verifies the belt-and-suspenders gate is structurally present in
// the ballot route source so future refactors do not silently drop it.
describe('POLL-06 vote gate coverage (structural)', () => {
  const fs = require('fs');
  const path = require('path');
  const ballotSource = fs.readFileSync(
    path.join(__dirname, '../../routes/ballot.js'),
    'utf-8'
  );

  // Isolate the POST /:eventId/vote handler body (between its declaration
  // and the next route declaration) so we don't accidentally match
  // gates from sibling handlers.
  const voteHandlerStart = ballotSource.indexOf("router.post('/:eventId/vote'");
  expect(voteHandlerStart).toBeGreaterThan(-1);
  const afterVote = ballotSource.indexOf("router.post('/:eventId/resolve-tie'", voteHandlerStart);
  const voteHandler = ballotSource.slice(voteHandlerStart, afterVote);

  it('vote handler enforces the event-scoped surface predicate (H-D edge case)', () => {
    // Phase 71.1 widened the gate from isActiveMember to
    // canReadEventScopedSurface so game-only participants can vote on the
    // event they joined. The H-D edge case (stale EventRsvp without any
    // current scope membership) is still closed because the helper returns
    // allowed=false when neither isActiveMember nor isEventParticipant
    // resolves true.
    expect(voteHandler).toMatch(/canReadEventScopedSurface\s*\(\s*userId\s*,\s*eventId\s*\)/);
    // Must 403 when not allowed by the event-scoped helper
    expect(voteHandler).toMatch(/Only event participants can vote on the ballot/);
  });

  it('vote handler enforces the yes/maybe RSVP predicate (D-BALLOT-02)', () => {
    // The gate must check status is in ['yes', 'maybe'] explicitly.
    // After the 71-03 patch the lookup is unconditional and the membership
    // check is in code (not in the SQL where-clause), so both shapes are
    // acceptable: predicate-in-where OR predicate-in-code.
    const inSqlWhere = /status:\s*\{\s*\[Op\.in\]\s*:\s*\[\s*'yes'\s*,\s*'maybe'\s*\]/.test(voteHandler);
    const inCode = /\['yes'\s*,\s*'maybe'\]\s*\.includes\s*\(\s*rsvp\.status\s*\)/.test(voteHandler);
    expect(inSqlWhere || inCode).toBe(true);
    // 403 message must communicate the predicate to the user
    expect(voteHandler).toMatch(/Only attendees who RSVPed Yes or Maybe can vote/);
  });

  it('vote handler 403 message includes the user\'s actual RSVP status (UX clarity)', () => {
    // After the 71-03 patch, the 403 message includes the status (or 'not set')
    // so users understand WHY they were rejected.
    expect(voteHandler).toMatch(/your RSVP is currently/);
  });

  it('vote handler runs the gate BEFORE EventBallotVote.create (no race)', () => {
    // Phase 71.1: predicate is now canReadEventScopedSurface, not
    // isActiveMember. The structural invariant is the same — both the
    // surface gate and the RSVP gate must run before any vote write.
    const createIdx = voteHandler.indexOf('EventBallotVote.create');
    const surfaceIdx = voteHandler.indexOf('canReadEventScopedSurface');
    const rsvpIdx = voteHandler.indexOf('EventRsvp.findOne');
    expect(createIdx).toBeGreaterThan(-1);
    expect(surfaceIdx).toBeGreaterThan(-1);
    expect(rsvpIdx).toBeGreaterThan(-1);
    expect(surfaceIdx).toBeLessThan(createIdx);
    expect(rsvpIdx).toBeLessThan(createIdx);
  });

  it('only ONE EventBallotVote.create site exists in the ballot route', () => {
    // Ensure no future patch silently adds an ungated parallel write path.
    const matches = ballotSource.match(/EventBallotVote\.(create|upsert|findOrCreate|bulkCreate)/g) || [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe('EventBallotVote.create');
  });
});
