import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrg, depthOf, directReports, canDelegate, renderOrg } from '../src/org.js';

const MEMBERS = {
  coo: { agent: 'claude' },
  'eng-lead': { agent: 'claude', reports_to: 'coo' },
  implementer: { agent: 'codex', reports_to: 'eng-lead' },
  reviewer: { agent: 'grok', reports_to: 'eng-lead' },
  designer: { agent: 'claude', reports_to: 'coo' }
};

test('reports are derived from reports_to, sorted, and roots have no parent', () => {
  const org = buildOrg(MEMBERS);
  assert.deepEqual(org.roots, ['coo']);
  assert.equal(org.parentOf.coo, null);
  assert.deepEqual(org.reportsOf['eng-lead'], ['implementer', 'reviewer']);
  assert.deepEqual(org.reportsOf.coo, ['designer', 'eng-lead']);
  assert.deepEqual(org.reportsOf.implementer, []);
});

test('more than one root is allowed', () => {
  const org = buildOrg({ coo: { agent: 'a' }, advisor: { agent: 'b' } });
  assert.deepEqual(org.roots, ['advisor', 'coo']);
});

test('an unknown manager is a config error', () => {
  assert.throws(
    () => buildOrg({ a: { agent: 'x', reports_to: 'ghost' } }),
    /reports_to "ghost" is not a configured member/
  );
});

test('reporting to yourself is a config error', () => {
  assert.throws(() => buildOrg({ a: { agent: 'x', reports_to: 'a' } }), /reports_to itself/);
});

test('a reporting cycle is a config error', () => {
  assert.throws(
    () => buildOrg({
      a: { agent: 'x', reports_to: 'b' },
      b: { agent: 'x', reports_to: 'c' },
      c: { agent: 'x', reports_to: 'a' }
    }),
    /reporting cycle/
  );
});

test('depthOf counts ancestors', () => {
  const org = buildOrg(MEMBERS);
  assert.equal(depthOf(org, 'coo'), 0);
  assert.equal(depthOf(org, 'eng-lead'), 1);
  assert.equal(depthOf(org, 'implementer'), 2);
});

test('only a member with reports can delegate', () => {
  const org = buildOrg(MEMBERS);
  assert.equal(canDelegate(org, 'eng-lead'), true);
  assert.equal(canDelegate(org, 'reviewer'), false);
  assert.deepEqual(directReports(org, 'reviewer'), []);
});

test('renderOrg indents each level under its manager', () => {
  const out = renderOrg(buildOrg(MEMBERS));
  assert.match(out, /^coo$/m);
  assert.match(out, /^ {2}eng-lead$/m);
  assert.match(out, /^ {4}implementer$/m);
});

test('directReports returns a copy, not the internal array', () => {
  const org = buildOrg(MEMBERS);
  const reports = directReports(org, 'eng-lead');
  reports.push('intruder');
  assert.deepEqual(directReports(org, 'eng-lead'), ['implementer', 'reviewer']);
  assert.deepEqual(org.reportsOf['eng-lead'], ['implementer', 'reviewer']);
});

test('depthOf throws on an unknown member', () => {
  const org = buildOrg(MEMBERS);
  assert.throws(() => depthOf(org, 'ghost'), /unknown member: ghost/);
});

test('a name colliding with Object.prototype is treated as unknown, not inherited', () => {
  const org = buildOrg(MEMBERS);
  assert.throws(() => depthOf(org, 'toString'), /unknown member: toString/);
  assert.deepEqual(directReports(org, 'toString'), []);
  assert.equal(canDelegate(org, 'toString'), false);
});

test('reports_to "toString" is refused as a clean config error, not a TypeError', () => {
  assert.throws(
    () => buildOrg({ ceo: { agent: 'x' }, a: { agent: 'y', reports_to: 'toString' } }),
    (err) => {
      assert.match(err.message, /reports_to "toString" is not a configured member/);
      assert.notEqual(err.constructor.name, 'TypeError');
      return true;
    }
  );
});

test('reports_to "constructor" is refused as a clean config error, not a TypeError', () => {
  assert.throws(
    () => buildOrg({ ceo: { agent: 'x' }, a: { agent: 'y', reports_to: 'constructor' } }),
    (err) => {
      assert.match(err.message, /reports_to "constructor" is not a configured member/);
      assert.notEqual(err.constructor.name, 'TypeError');
      return true;
    }
  );
});

test('reports_to "hasOwnProperty" is refused as a clean config error, not a TypeError', () => {
  assert.throws(
    () => buildOrg({ ceo: { agent: 'x' }, a: { agent: 'y', reports_to: 'hasOwnProperty' } }),
    (err) => {
      assert.match(err.message, /reports_to "hasOwnProperty" is not a configured member/);
      assert.notEqual(err.constructor.name, 'TypeError');
      return true;
    }
  );
});

test('reports_to "valueOf" is refused as a clean config error, not a TypeError', () => {
  assert.throws(
    () => buildOrg({ ceo: { agent: 'x' }, a: { agent: 'y', reports_to: 'valueOf' } }),
    (err) => {
      assert.match(err.message, /reports_to "valueOf" is not a configured member/);
      assert.notEqual(err.constructor.name, 'TypeError');
      return true;
    }
  );
});

test('a real member named toString still works', () => {
  const org = buildOrg({ ...MEMBERS, toString: { agent: 'claude', reports_to: 'coo' } });
  assert.equal(depthOf(org, 'toString'), 1);
  assert.deepEqual(directReports(org, 'toString'), []);
  assert.equal(canDelegate(org, 'toString'), false);
  assert.equal(canDelegate(org, 'coo'), true);
  assert.deepEqual(directReports(org, 'coo'), ['designer', 'eng-lead', 'toString']);
});
