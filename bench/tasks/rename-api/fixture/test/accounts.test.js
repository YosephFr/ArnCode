import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUser } from '../lib/admin.js';
import { monthlyCharge } from '../lib/billing.js';
import { usersCsv } from '../lib/export.js';
import { recipient } from '../lib/notify.js';
import { orderFor } from '../lib/orders.js';
import { planReport } from '../lib/reports.js';
import { searchUsers } from '../lib/search.js';
import { getUserData } from '../lib/users.js';

test('users are copied, not shared', () => {
  const user = getUserData('u1');
  user.name = 'changed';
  assert.equal(getUserData('u1').name, 'Ada Lovelace');
});

test('modules read users the same way', () => {
  assert.equal(orderFor('u2', ['mug']).buyer.username, 'alan');
  assert.equal(monthlyCharge('u1'), 1200);
  assert.equal(monthlyCharge('u3'), 0);
  assert.equal(recipient('u1').greeting, 'Hi Ada,');
  assert.deepEqual(planReport(), { pro: 1, free: 1 });
  assert.equal(describeUser('u3'), 'u3: Grace Hopper <grace> (pro, inactive)');
  assert.deepEqual(searchUsers('TURING'), ['u2']);
  assert.match(usersCsv(), /^u1,Ada Lovelace,ada,pro,true$/m);
});
