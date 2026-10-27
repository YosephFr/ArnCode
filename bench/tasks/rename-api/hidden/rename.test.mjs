import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const users = await import(pathToFileURL(path.join(process.cwd(), 'lib/users.js')).href);

test('loadUser returns a copy of the record', () => {
  const user = users.loadUser('u2');
  assert.equal(user.username, 'alan');
  user.username = 'changed';
  assert.equal(users.loadUser('u2').username, 'alan');
  assert.equal(users.loadUser('nobody'), undefined);
});

test('getUserData still works and warns once that it is deprecated', () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal(users.getUserData('u1').name, 'Ada Lovelace');
    assert.equal(users.getUserData('u3').name, 'Grace Hopper');
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /loadUser/);
});
